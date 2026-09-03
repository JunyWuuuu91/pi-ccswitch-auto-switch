import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext, FailureObservation, ModelRef } from './types.ts'
import { classifyFailure, parseRetryAfter } from './classify.ts'
import { candidateSnapshot, effectiveCandidates, chooseCandidate, multimodalCandidates, modelFamily, summarizeCandidateHealth } from './candidates.ts'
import { HealthStore, endpointKey, modelKey, type HealthState } from './health.ts'

const FIRST_RESPONSE_TIMEOUT = 90_000
const STREAM_IDLE_TIMEOUT = 120_000
const MAX_ATTEMPTS = 5
const ROUND_LIMIT = 8 * 60_000
const RPC_PROTOCOL_VERSION = 1
const EXTENSION_VERSION = '0.3.6'
// 同端点（BaseURL 相同）连续失败达到该次数即隔离该端点，避免同一个平台的多个模型逐个试错耗尽本轮切换
const ENDPOINT_FAIL_THRESHOLD = 3

interface EndpointFailTracker {
  failed: Map<string, number>
  isolated: Set<string>
}

type Phase = 'idle' | 'monitoring' | 'settled-error' | 'switching' | 'redispatching' | 'verifying' | 'exhausted'
interface Round {
  id: number
  phase: Phase
  startedAt: number
  text: string
  images?: Array<Record<string, unknown>>
  tried: Set<string>
  attempts: number
  hadTool: boolean
  inTool: boolean
  hadOutput: boolean
  watchdog: boolean
  cleanRetry: boolean
  observation?: FailureObservation
  model?: ModelRef
  endpointFails?: EndpointFailTracker
  /** 本轮内容审查故障转移中必须避开的模型系列（包含持久化学到的约束）。 */
  avoidFamilies?: Set<string>
  /** 本轮内最后一次成功切换的时间；用于刷新 ROUND_LIMIT 窗口，避免供应商内部重试耗时导致误判“达到上限” */
  lastSwitchAt?: number
}

function key(model: ModelRef | undefined): string | undefined { return model && modelKey(model) }
function canRetry(ctx: ExtensionContext): boolean { return ctx.mode === 'tui' || ctx.mode === 'rpc' }
function activePolicyFamilies(state: HealthState, now = Date.now()): Set<string> {
  return new Set(Object.entries(state.contentPolicyFamilies ?? {})
    .filter(([, record]) => record.avoidUntil > now)
    .map(([family]) => family))
}

function resolveModel(ctx: ExtensionContext, provider: string, id: string, previous?: ModelRef): ModelRef {
  // 优先使用注册表/scope 中的完整元数据，避免 turn_end 消息只有 provider/id 时丢失 BaseURL、
  // 上下文窗口和输入模态；previous/ctx.model 作为注册表未命中时的后备。
  const refs = [...ctx.scopedModels.map(item => item.model), ...ctx.modelRegistry.getAvailable(), previous, ctx.model]
  return refs.find(model => model?.provider === provider && model.id === id) ?? { provider, id }
}

/**
 * 判断工具执行结果是否包含图片内容（如 read 工具读取图片文件后返回的
 * { content: [{ type: 'image', ... }] } 结构）。递归查找，兼容各种 result 形状。
 */
function resultContainsImage(result: unknown): boolean {
  if (Array.isArray(result)) return result.some(part => resultContainsImage(part))
  if (!result || typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  if (record.type === 'image') return true
  if (Array.isArray(record.content)) return record.content.some(part => resultContainsImage(part))
  return false
}

export default function (pi: ExtensionAPI) {
  const health = new HealthStore()
  let round: Round | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastStatus: { status?: number, retryAfterMs?: number } = {}
  // 本次 pi session 内成功切换的模型数量（用于衡量插件的有效程度）
  let sessionSwitches = 0

  const clearWatchdog = () => { if (timer) clearTimeout(timer); timer = undefined }
  const armWatchdog = (ctx: ExtensionContext, ms: number, roundId: number) => {
    clearWatchdog()
    timer = setTimeout(() => {
      if (!round || round.id !== roundId || ctx.isIdle() || round.inTool) return
      round.watchdog = true
      ctx.abort()
    }, ms)
    timer.unref?.()
  }
  // 当前生效模型名（provider/id）；过长时压缩，避免撑爆状态栏
  const modelTag = (model: ModelRef | undefined) => {
    if (!model) return ''
    const full = modelKey(model)
    return full.length > 30 ? `${model.provider}/${model.id?.slice(0, 24)}…` : full
  }
  const status = (ctx: ExtensionContext) => {
    const state = health.snapshot
    const { models } = candidateSnapshot(ctx.scopedModels, ctx.modelRegistry.getAvailable())
    const counts = summarizeCandidateHealth(models, state)
    const activeModel = round?.model ?? ctx.model
    // 恒显完整状态：健康/总数 · 冷却 · 禁用 · 本session切换 · 当前模型（均为 0 时也显示，便于确认扩展在监控中）
    const prefix = `CCS v${EXTENSION_VERSION}`
    const plain = round?.phase === 'switching' ? `${prefix} ↻${round.attempts}/${MAX_ATTEMPTS} ${modelTag(round.model)}` :
      round?.phase === 'exhausted' ? `${prefix} ⏸切换停止 ${modelTag(round.model ?? ctx.model)}` :
      `${prefix} ✓${counts.healthy}/${counts.total} · ⏳${counts.cooling} · ⛔${counts.disabled}${switchSuffix()} · ${modelTag(activeModel)}`
    const theme = ctx.ui.theme
    const tone = round?.phase === 'exhausted' ? 'error' : counts.cooling || counts.disabled ? 'warning' : 'success'
    ctx.ui.setStatus('ccswitch-ha', theme ? theme.fg(tone, plain) : plain)
  }
  // 本次 session 成功切换计数：始终显示 🔄N（N=0 也显示，用于确认扩展在监控中）；累计切换数在面板/自检中可见
  const switchSuffix = () => ` · 🔄${sessionSwitches}`
  const notify = (ctx: ExtensionContext, message: string, type: 'info' | 'warning' | 'error' = 'info') => {
    if (ctx.hasUI) ctx.ui.notify(message, type)
  }
  const showHelp = (ctx: ExtensionContext) => {
    notify(ctx, [
      'CCSwitch 命令：',
      '/ccswitch 或 /ccswitch status — 查看健康面板',
      '/ccswitch help — 显示此帮助',
      '/ccswitch refresh — 刷新 Pi 模型注册表和状态',
      '/ccswitch reactivate <provider/model|all> — 解除熔断，保留历史',
      '/ccswitch disable <provider/model> — 手动禁用模型',
      '/ccswitch reset <provider/model|all> — 清除健康历史；all 也会清除已学习的审查约束（需确认）',
      '/ccswitch-test — 自检候选模型，不实际切换',
      '/ccswitch-doctor — 诊断 runner.mjs 可解析性和安装情况',
    ].join('\n'), 'info')
  }
  const refresh = async (ctx: ExtensionContext) => {
    try { await ctx.modelRegistry.refresh() } catch (error) { await health.log(`registry refresh failed: ${String(error)}`); notify(ctx, 'CCSwitch：Pi 模型注册表刷新失败，继续使用上次快照', 'warning') }
    status(ctx)
  }
  const showPanel = async (ctx: ExtensionContext) => {
    const state = health.snapshot
    const snapshot = candidateSnapshot(ctx.scopedModels, ctx.modelRegistry.getAvailable())
    const candidates = snapshot.models
    const counts = summarizeCandidateHealth(candidates, state)
    const now = Date.now()
    const policyFamilies = activePolicyFamilies(state, now)
    const rows = candidates.slice(0, 10).map(model => {
      const modelRecord = state.models[modelKey(model)]
      const records = [modelRecord, state.providers[model.provider], state.endpoints[endpointKey(model)]]
      const blockedUntil = Math.max(0, ...records.flatMap(record => [record?.cooldownUntil ?? 0, record?.leaseUntil ?? 0]))
      const policySuffix = policyFamilies.has(modelFamily(model)) ? ' · 内容审查约束' : ''
      const baseSuffix = modelRecord?.disabled ? '手动禁用' : blockedUntil > now ? `自动冷却 ${Math.max(1, Math.ceil((blockedUntil - now) / 60_000))}m` : '健康'
      const suffix = `${baseSuffix}${policySuffix}`
      return `${modelKey(model)}  ${suffix}`
    })
    if (!ctx.ui.select) {
      const source = snapshot.source === 'scoped' ? `Pi scope ${snapshot.sourceEntries} 条` : `Pi 注册表 ${snapshot.sourceEntries} 条`
      notify(ctx, `CCSwitch：${source} · 唯一模型 ${counts.total} · 健康 ${counts.healthy} · 自动冷却 ${counts.cooling} · 手动禁用 ${counts.disabled} · 审查约束系列 ${policyFamilies.size} · 本session切换 ${sessionSwitches} · 累计切换 ${state.switches ?? 0}`, 'info')
      return
    }
    const scopeLabel = snapshot.source === 'scoped' ? `Pi scope：${snapshot.sourceEntries} 条` : `Pi 可用注册表：${snapshot.sourceEntries} 条`
    const switchSummary = `本session切换：${sessionSwitches} · 累计切换：${state.switches ?? 0}`
    const recentSwitches = (state.switchLog ?? []).slice(0, 5).map(entry => {
      const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return `  ${time} ${entry.from} 🔄 ${entry.to}`
    })
    const switchPanel = recentSwitches.length ? `\n最近切换：\n${recentSwitches.join('\n')}` : ''
    const policySummary = policyFamilies.size ? [...policyFamilies].join(', ') : '无'
    const action = await ctx.ui.select(`CCSwitch 健康面板\n当前：${key(ctx.model) ?? '无'}\n${scopeLabel} · 唯一模型：${counts.total} · 健康：${counts.healthy} · 自动冷却：${counts.cooling} · 手动禁用：${counts.disabled}\n熔断记录：${counts.breakerRecords} · 审查约束系列：${policySummary}\n${switchSummary}${switchPanel}\n${rows.join('\n') || '没有可用模型'}`, ['刷新', '重新激活当前模型', '禁用当前模型', '重置当前模型历史', '关闭'])
    if (action === '刷新') await refresh(ctx)
    if (action === '重新激活当前模型' && ctx.model) { health.reactivate(ctx.model); await health.flush(); status(ctx); notify(ctx, '已重新激活当前模型') }
    if (action === '禁用当前模型' && ctx.model) { health.disable(modelKey(ctx.model), true); await health.flush(); status(ctx); notify(ctx, '已禁用当前模型', 'warning') }
    if (action === '重置当前模型历史' && ctx.model) {
      const ok = !ctx.ui.confirm || await ctx.ui.confirm('重置健康历史', `删除 ${modelKey(ctx.model)} 的记录？`)
      if (ok) { health.reset(modelKey(ctx.model)); await health.flush(); status(ctx) }
    }
  }
  const exhaust = async (ctx: ExtensionContext, reason: string) => {
    if (!round) return
    round.phase = 'exhausted'
    clearWatchdog()
    ctx.ui.setWorkingMessage()
    await health.report(`# CCSwitch 自动故障转移失败\n\n时间：${new Date().toISOString()}\n原因：${reason}\n\n已尝试：\n${[...round.tried].map(item => `- ${item}`).join('\n')}\n\n可使用 /ccswitch status 查看状态，/ccswitch reactivate <provider/model> 重新激活。`)
    await health.log(`round exhausted: ${reason}; tried=${[...round.tried].join(',')}`)
    // RPC runner relies on an explicit terminal signal instead of guessing from
    // agent_settled. Keep this RPC-only so ordinary TUI transcripts stay quiet.
    if (ctx.mode === 'rpc') {
      const lastFailure = round.observation ? classifyFailure(round.observation).kind : undefined
      try {
        pi.appendEntry?.('ccswitch-exhausted', {
          protocolVersion: RPC_PROTOCOL_VERSION,
          roundId: round.id,
          reason,
          lastFailure,
          model: key(round.model),
          attempts: round.attempts,
          tried: [...round.tried],
          sessionSwitches,
        })
      } catch { /* reporting must not prevent the regular exhausted path */ }
    }
    notify(ctx, `CCSwitch：自动切换停止（${reason}），请用 /ccswitch 查看详情`, 'error')
    status(ctx)
  }
  /**
   * 模态预检主动切换：当前模型不支持图片但本轮输入/工具结果带图时，
   * 主动切到一个健康的多模态候选（不等失败）。无候选时通知并保持原模型。
   */
  const proactiveModalitySwitch = async (ctx: ExtensionContext, round: Round): Promise<void> => {
    const current = round.model ?? ctx.model
    if (!current || !canRetry(ctx) || round.phase !== 'monitoring') return
    if (current.input?.includes('image')) return
    const candidates = effectiveCandidates(ctx.scopedModels, ctx.modelRegistry.getAvailable())
    const next = multimodalCandidates(candidates, current, health.snapshot)[0]
    if (!next) {
      await health.log(`modality precheck: no multimodal candidate, staying on ${modelKey(current)}`)
      notify(ctx, 'CCSwitch：当前模型不支持图片，且没有可用的多模态候选模型，已保持原模型', 'warning')
      status(ctx)
      return
    }
    const previousModel = current
    const set = await pi.setModel(next).catch(() => false)
    if (!set) {
      await health.log(`modality precheck: Pi refused model selection ${modelKey(next)}`)
      notify(ctx, `CCSwitch：多模态候选 ${modelKey(next)} 切换失败，已保持原模型`, 'warning')
      status(ctx)
      return
    }
    round.model = next
    round.lastSwitchAt = Date.now()
    sessionSwitches += 1
    health.recordSwitch(modelKey(previousModel), modelKey(next), 'modality')
    await health.flush()
    try {
      pi.appendEntry?.('ccswitch-switch', {
        protocolVersion: RPC_PROTOCOL_VERSION,
        roundId: round.id,
        from: modelKey(previousModel),
        to: modelKey(next),
        reason: 'modality',
        sessionSwitches,
      })
    } catch { /* appendEntry 失败不影响切换 */ }
    await health.log(`modality precheck switch: ${modelKey(previousModel)} -> ${modelKey(next)}`)
    notify(ctx, `CCSwitch：检测到图片输入，已切换至多模态模型 ${modelKey(next)}`, 'info')
    status(ctx)
  }

  const failover = async (ctx: ExtensionContext) => {
    if (!round || !round.observation || !round.model || !canRetry(ctx)) return
    // 窗口从上一次成功切换（或本轮开始）起算：供应商内部重试耗时不应消耗整轮限额
    const windowStart = Math.max(round.startedAt, round.lastSwitchAt ?? 0)
    if (round.attempts >= MAX_ATTEMPTS || Date.now() - windowStart >= ROUND_LIMIT) return exhaust(ctx, '达到本轮切换上限')
    const classification = classifyFailure(round.observation)
    if (round.observation.aborted && !round.observation.watchdog) { round.phase = 'idle'; clearWatchdog(); status(ctx); return }
    round.phase = 'switching'
    round.tried.add(modelKey(round.model))
    // 跟踪同端点失败：BaseURL 相同的模型同属一个端点平台，连续失败到阈值后隔离整个端点，
    // 避免同一平台下的多个模型逐个试错（它们往往共享同一故障根源）
    const failTracker = round.endpointFails ??= { failed: new Map(), isolated: new Set() }
    const ep = endpointKey(round.model)
    const epFails = (failTracker.failed.get(ep) ?? 0) + 1
    failTracker.failed.set(ep, epFails)
    if (epFails >= ENDPOINT_FAIL_THRESHOLD) {
      failTracker.isolated.add(ep)
      await health.log(`endpoint ${ep} failed ${epFails} times this round, isolating endpoint`)
    }
    if (classification.kind === 'content_policy') {
      health.recordContentPolicyConstraint(modelFamily(round.model), round.model, round.observation.message)
      round.avoidFamilies ??= new Set()
      for (const family of activePolicyFamilies(health.snapshot)) round.avoidFamilies.add(family)
    }
    if (!classification.roundOnly && classification.scope) health.recordFailure(classification.scope, classification.scope === 'model' ? modelKey(round.model) : classification.scope === 'provider' ? round.model.provider : endpointKey(round.model), classification.kind, round.observation.message, classification.retryAfterMs)
    await health.flush()
    await refresh(ctx)
    const candidates = effectiveCandidates(ctx.scopedModels, ctx.modelRegistry.getAvailable())
    const candidateOptions = () => ({
      current: round!.model,
      tried: round!.tried,
      failureKind: classification.kind,
      health: health.snapshot,
      avoidEndpoints: failTracker.isolated,
      avoidFamilies: round!.avoidFamilies,
      requiredInputs: round!.images?.length ? ['text', 'image'] : ['text'],
    })
    let next = chooseCandidate(candidates, candidateOptions())
    while (next) {
      if (!await health.claimProvider(next)) { round.tried.add(modelKey(next)); next = chooseCandidate(candidates, candidateOptions()); continue }
      round.attempts++
      ctx.ui.setWorkingMessage(`模型异常，正在切换到 ${modelKey(next)}…`)
      const previousModel = round.model
      const set = await pi.setModel(next).catch(() => false)
      if (!set) {
        health.recordFailure('model', modelKey(next), 'model_config', 'Pi refused model selection')
        round.tried.add(modelKey(next)); await health.flush()
        next = chooseCandidate(candidates, candidateOptions())
        continue
      }
      round.model = next
      round.phase = 'redispatching'
      // 刷新本轮切换时间窗：成功切换后重新起算 ROUND_LIMIT，避免长重试轮被误判为“达到上限”
      round.lastSwitchAt = Date.now()
      // 本次 session 成功切换计数 + 持久化累计/日志（衡量扩展有效程度）
      sessionSwitches += 1
      const fromKey = key(previousModel ?? ctx.model)
      health.recordSwitch(fromKey ?? '', modelKey(next), classification.kind)
      await health.flush()
      notify(ctx, `CCSwitch：已切换至 ${modelKey(next)}（${round.attempts}/${MAX_ATTEMPTS}）`, 'info')
      // 触发 TUI 底栏/界面重绘：appendEntry 会发出 entry_appended 事件进入 session.subscribe 流，
      // interactive-mode 收到后执行 footer.invalidate() + requestRender()，footer 从 session.state.model 重新读取，
      // 从而让右下角模型名同步显示新模型（setModel 只改 state，不直接触发 footer 刷新）。
      try {
        pi.appendEntry?.('ccswitch-switch', {
          protocolVersion: RPC_PROTOCOL_VERSION,
          roundId: round.id,
          from: fromKey ?? '',
          to: modelKey(next),
          reason: classification.kind,
          attempts: round.attempts,
          sessionSwitches,
        })
      } catch { /* appendEntry 失败不影响切换 */ }
      const continuation = round.hadTool || round.hadOutput
        ? '请从当前会话状态继续完成上一条请求；不要重复已经完成的工具操作。'
        : round.images?.length ? [{ type: 'text', text: round.text }, ...round.images] : round.text
      round.cleanRetry = !round.hadTool && !round.hadOutput
      round.observation = undefined
      round.watchdog = false
      round.phase = 'verifying'
      pi.sendUserMessage(continuation as any)
      status(ctx)
      return
    }
    await exhaust(ctx, '没有健康的候选模型')
  }

  pi.on('session_start', async (_event, ctx) => {
    await health.load()
    sessionSwitches = 0
    // 新 session 可能处理不涉及审查内容的任务，上一 session 学到的模型系列审查约束
    // 不跨 session 继承；若本 session 再次遇到 content_policy 失败会重新学习并在本轮避开。
    health.clearContentPolicyConstraints()
    await health.flush()
    await refresh(ctx)
    await health.log('extension started')
  })
  pi.on('session_shutdown', async (_event, ctx) => { clearWatchdog(); ctx.ui.setWorkingMessage(); if (sessionSwitches > 0) await health.log(`session ended with ${sessionSwitches} successful switches`); await health.flush() })
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return { action: 'continue' }
    clearWatchdog()
    lastStatus = {}
    round = { id: (round?.id ?? 0) + 1, phase: 'monitoring', startedAt: Date.now(), text: event.text, images: event.images, tried: new Set(), attempts: 0, hadTool: false, inTool: false, hadOutput: false, watchdog: false, cleanRetry: false, model: ctx.model, endpointFails: undefined, avoidFamilies: undefined }
    status(ctx)
    // 模态预检：输入带图片但当前模型不支持图片（非多模态）→ 主动切换到多模态模型，
    // 避免 Pi 静默剥图后模型只回答“看不到图片”（此类情况不会触发 failover）。
    if (event.images?.length && round.phase === 'monitoring') await proactiveModalitySwitch(ctx, round)
    return { action: 'continue' }
  })
  pi.on('before_provider_request', (_event, ctx) => { lastStatus = {}; if (round) { round.inTool = false; armWatchdog(ctx, FIRST_RESPONSE_TIMEOUT, round.id) } })
  pi.on('after_provider_response', (event, ctx) => {
    lastStatus = { status: event.status, retryAfterMs: parseRetryAfter(event.headers?.['retry-after']) }
    if (round && event.status >= 200 && event.status < 300) armWatchdog(ctx, STREAM_IDLE_TIMEOUT, round.id)
  })
  pi.on('message_update', (_event, ctx) => { if (round) armWatchdog(ctx, STREAM_IDLE_TIMEOUT, round.id) })
  pi.on('context', (event) => {
    if (!round?.cleanRetry) return
    round.cleanRetry = false
    let removed = false
    return {
      messages: event.messages.filter((message: any) => {
        if (!removed && message?.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted')) { removed = true; return false }
        return true
      }),
    }
  })
  pi.on('tool_execution_start', () => { if (round) { round.hadTool = true; round.inTool = true; clearWatchdog() } })
  pi.on('tool_execution_end', async (_event, ctx) => {
    if (!round) return
    round.inTool = false
    // 工具结果含图片（如 read 图片文件）且当前模型不支持 → 主动切换多模态模型，
    // 确保下一轮 LLM 调用使用新模型，工具结果中的图片不被 Pi 静默剥除。
    if (round.phase === 'monitoring' && resultContainsImage(_event.result)) await proactiveModalitySwitch(ctx, round)
  })
  pi.on('turn_end', async (event, ctx) => {
    const message = event.message
    if (message?.role !== 'assistant' || !round) return
    clearWatchdog()
    round.model = resolveModel(ctx, message.provider, message.model, round.model)
    round.hadOutput ||= Boolean(message.content?.length)
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      round.phase = 'settled-error'
      round.observation = { message: message.errorMessage, rawStopReason: message.rawStopReason, status: lastStatus.status, retryAfterMs: lastStatus.retryAfterMs, watchdog: round.watchdog, aborted: message.stopReason === 'aborted' }
      await health.log(`turn failed ${modelKey(round.model)}: ${message.errorMessage ?? message.stopReason}`)
    } else {
      health.recordSuccess(round.model); await health.flush()
      round.phase = 'idle'; round.observation = undefined; ctx.ui.setWorkingMessage(); status(ctx)
      // agent_settled is also emitted after intermediate failed turns. An
      // explicit terminal entry lets the headless RPC runner return only after
      // this final successful assistant turn has settled.
      if (ctx.mode === 'rpc') {
        try {
          pi.appendEntry?.('ccswitch-complete', {
            protocolVersion: RPC_PROTOCOL_VERSION,
            roundId: round.id,
            model: key(round.model),
            attempts: round.attempts,
            sessionSwitches,
          })
        } catch { /* completion reporting is best-effort */ }
      }
    }
  })
  pi.on('agent_settled', async (_event, ctx) => {
    if (!round || round.phase !== 'settled-error') return
    if (!ctx.isIdle()) return
    if (!canRetry(ctx) && round.observation && round.model) {
      const classification = classifyFailure(round.observation)
      if (classification.kind === 'content_policy') health.recordContentPolicyConstraint(modelFamily(round.model), round.model, round.observation.message)
      if (!classification.roundOnly && classification.scope) {
        const domain = classification.scope === 'model' ? modelKey(round.model) : classification.scope === 'provider' ? round.model.provider : endpointKey(round.model)
        health.recordFailure(classification.scope, domain, classification.kind, round.observation.message, classification.retryAfterMs)
        await health.flush()
      }
      round.phase = 'idle'
      status(ctx)
      return
    }
    await failover(ctx)
  })
  pi.on('model_select', (_event, ctx) => status(ctx))

  pi.registerCommand('ccswitch', { description: '查看和管理 CCSwitch 自动故障转移健康状态', handler: async (args, ctx) => {
    const [verb, target] = args.trim().split(/\s+/, 2)
    if (!verb || verb === 'status') return showPanel(ctx)
    if (verb === 'help') return showHelp(ctx)
    if (verb === 'refresh') return refresh(ctx)
    if (!target && verb !== 'reset') { notify(ctx, '请指定 provider/model 或 all', 'warning'); return }
    if (verb === 'disable' && target) { health.disable(target, true); await health.flush(); status(ctx); return }
    if (verb === 'reactivate' && target) {
      if (target === 'all') health.reactivateAll()
      else { const [provider, ...rest] = target.split('/'); health.reactivate({ provider, id: rest.join('/') }) }
      await health.flush(); status(ctx); return
    }
    if (verb === 'reset' && target) {
      const ok = !ctx.ui.confirm || await ctx.ui.confirm('重置健康历史', `删除 ${target} 的健康记录？`)
      if (ok) { health.reset(target === 'all' ? 'all' : target); await health.flush(); status(ctx) }
      return
    }
    showHelp(ctx)
  }})
  pi.registerCommand('ccswitch-test', { description: '检查 CCSwitch 候选模型和健康状态（不切换模型）', handler: async (_args, ctx) => {
    await refresh(ctx)
    const snapshot = candidateSnapshot(ctx.scopedModels, ctx.modelRegistry.getAvailable())
    const counts = summarizeCandidateHealth(snapshot.models, health.snapshot)
    const state = health.snapshot
    const policyFamilies = activePolicyFamilies(state)
    const source = snapshot.source === 'scoped' ? `Pi scope ${snapshot.sourceEntries} 条` : `Pi 注册表 ${snapshot.sourceEntries} 条`
    notify(ctx, `CCSwitch 自检：${source} · 唯一模型 ${counts.total} · 健康 ${counts.healthy} · 自动冷却 ${counts.cooling} · 手动禁用 ${counts.disabled} · 熔断记录 ${counts.breakerRecords} · 审查约束系列 ${policyFamilies.size} · 本session切换 ${sessionSwitches} · 累计切换 ${state.switches ?? 0}`, counts.total ? 'info' : 'warning')
  }})
  pi.registerCommand('ccswitch-doctor', { description: '诊断 runner.mjs 可解析性和安装情况', handler: async (_args, ctx) => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const localRunner = join(__dirname, 'runner.mjs')
    const hasLocal = existsSync(localRunner)
    let resolvable = false
    let resolvedPath = ''
    try {
      const cRequire = createRequire(import.meta.url)
      resolvedPath = cRequire.resolve('pi-ccswitch-auto-switch/runner.mjs')
      resolvable = true
    } catch { /* not resolvable — expected when extension is in git checkout */ }

    // 检查 npm 全局安装版本
    let npmVersion = ''
    const npmPkgDir = join(homedir(), '.pi/agent/npm/node_modules/pi-ccswitch-auto-switch')
    const npmPkgJson = join(npmPkgDir, 'package.json')
    if (existsSync(npmPkgJson)) {
      try {
        npmVersion = JSON.parse(readFileSync(npmPkgJson, 'utf-8')).version
      } catch { /* ignore */ }
    }
    const hasNpmRunner = npmVersion && existsSync(join(npmPkgDir, 'runner.mjs'))

    const lines = [
      `CCSwitch 诊断 v${EXTENSION_VERSION}`,
      '',
      `扩展加载目录：${__dirname}`,
      `本地 runner.mjs：${hasLocal ? '✅ 存在' : '❌ 缺失'}`,
      `resolve('pi-ccswitch-auto-switch/runner.mjs')：${resolvable ? '✅ 可解析' : '❌ 不可解析'}`,
      '',
    ]
    if (npmVersion) {
      lines.push(`npm 全局安装版本：${npmVersion}${hasNpmRunner ? ' ✅ 含 runner.mjs' : ' ❌ 不含 runner.mjs（版本过旧）'}`)
      lines.push('')
    }
    lines.push('--- 下游消费方正确安装方式 ---',
      'pi-ccswitch-auto-switch 是 Pi 扩展，`pi install` 只装到 Pi 全局目录，',
      '下游项目 require.resolve() 在自己的 node_modules 路径上解析不到。',
      '',
      '正确做法：在消费方项目内安装本包',
      '  npm i github:JunyWuuuu91/pi-ccswitch-auto-switch',
      '  或 npm i pi-ccswitch-auto-switch@latest',
      '',
    )
    if (npmVersion && !hasNpmRunner) {
      lines.push('--- 版本锁定修复 ---',
        `npm 全局版本 ${npmVersion} 不含 runner.mjs，因为 ^0.1.x 的 caret 语义只匹配 0.1.x。`, 
        '需手动升级 npm 侧版本：',
        '  cd ~/.pi/agent/npm && npm install pi-ccswitch-auto-switch@latest',
        '',
      )
    }
    lines.push('也可通过 NODE_PATH 或全局路径引用：',
      `  ${__dirname}/runner.mjs`,
    )
    notify(ctx, lines.join('\n'), 'info')
  }})
}
