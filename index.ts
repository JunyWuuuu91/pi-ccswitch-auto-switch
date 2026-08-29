import type { ExtensionAPI, ExtensionContext, FailureObservation, ModelRef } from './types.ts'
import { classifyFailure, parseRetryAfter } from './classify.ts'
import { candidateSnapshot, effectiveCandidates, chooseCandidate } from './candidates.ts'
import { HealthStore, endpointKey, modelKey } from './health.ts'

const FIRST_RESPONSE_TIMEOUT = 90_000
const STREAM_IDLE_TIMEOUT = 120_000
const MAX_ATTEMPTS = 5
const ROUND_LIMIT = 8 * 60_000

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
}

function key(model: ModelRef | undefined): string | undefined { return model && modelKey(model) }
function canRetry(ctx: ExtensionContext): boolean { return ctx.mode === 'tui' || ctx.mode === 'rpc' }

export default function (pi: ExtensionAPI) {
  const health = new HealthStore()
  let round: Round | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastStatus: { status?: number, retryAfterMs?: number } = {}

  const clearWatchdog = () => { if (timer) clearTimeout(timer); timer = undefined }
  const armWatchdog = (ctx: ExtensionContext, ms: number, roundId: number) => {
    clearWatchdog()
    timer = setTimeout(() => {
      if (!round || round.id !== roundId || (!ctx.isIdle() && !round.inTool)) {
        round && (round.watchdog = true)
        ctx.abort()
      }
    }, ms)
    timer.unref?.()
  }
  const status = (ctx: ExtensionContext) => {
    const state = health.snapshot
    const { models } = candidateSnapshot(ctx.scopedModels, ctx.modelRegistry.getAvailable())
    const now = Date.now()
    const disabled = Object.values(state.models).filter(item => item.disabled).length
    const cooling = [...Object.values(state.models), ...Object.values(state.providers), ...Object.values(state.endpoints)]
      .filter(item => item.cooldownUntil && item.cooldownUntil > now).length
    const unhealthy = models.filter(model => health.isBlocked(model)).length
    const healthy = Math.max(0, models.length - unhealthy)
    const plain = round?.phase === 'switching' ? `CCS ↻${round.attempts}/${MAX_ATTEMPTS} ${round.model ? modelKey(round.model) : ''}` :
      cooling || disabled ? `CCS ✓${healthy}/${models.length} · ⏳${cooling} · ⛔${disabled}` : `CCS ✓${models.length}`
    const theme = ctx.ui.theme
    ctx.ui.setStatus('ccswitch-ha', theme ? theme.fg(cooling || disabled ? 'warning' : 'success', plain) : plain)
  }
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
      '/ccswitch reset <provider/model|all> — 清除健康历史（需确认）',
      '/ccswitch-test — 自检候选模型，不实际切换',
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
    const healthy = candidates.filter(model => !health.isBlocked(model)).length
    const rows = candidates.slice(0, 10).map(model => {
      const record = state.models[modelKey(model)] ?? state.providers[model.provider]
      const suffix = record?.disabled ? '禁用' : record?.cooldownUntil && record.cooldownUntil > Date.now() ? `冷却 ${Math.ceil((record.cooldownUntil - Date.now()) / 60_000)}m` : '健康'
      return `${modelKey(model)}  ${suffix}`
    })
    if (!ctx.ui.select) {
      const source = snapshot.source === 'scoped' ? `Pi scope ${snapshot.sourceEntries} 条` : `Pi 注册表 ${snapshot.sourceEntries} 条`
      notify(ctx, `CCSwitch：${source} · 唯一模型 ${candidates.length} · 健康 ${healthy}`, 'info')
      return
    }
    const scopeLabel = snapshot.source === 'scoped' ? `Pi scope：${snapshot.sourceEntries} 条` : `Pi 可用注册表：${snapshot.sourceEntries} 条`
    const action = await ctx.ui.select(`CCSwitch 健康面板\n当前：${key(ctx.model) ?? '无'}\n${scopeLabel} · 唯一模型：${candidates.length} · 健康：${healthy}\n${rows.join('\n') || '没有可用模型'}`, ['刷新', '重新激活当前模型', '禁用当前模型', '重置当前模型历史', '关闭'])
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
    notify(ctx, `CCSwitch：自动切换停止（${reason}），请用 /ccswitch 查看详情`, 'error')
    status(ctx)
  }
  const failover = async (ctx: ExtensionContext) => {
    if (!round || !round.observation || !round.model || !canRetry(ctx)) return
    if (round.attempts >= MAX_ATTEMPTS || Date.now() - round.startedAt >= ROUND_LIMIT) return exhaust(ctx, '达到本轮切换上限')
    const classification = classifyFailure(round.observation)
    if (round.observation.aborted && !round.observation.watchdog) { round.phase = 'idle'; clearWatchdog(); status(ctx); return }
    round.phase = 'switching'
    round.tried.add(modelKey(round.model))
    if (!classification.roundOnly && classification.scope) health.recordFailure(classification.scope, classification.scope === 'model' ? modelKey(round.model) : classification.scope === 'provider' ? round.model.provider : endpointKey(round.model), classification.kind, round.observation.message, classification.retryAfterMs)
    await health.flush()
    await refresh(ctx)
    const candidates = effectiveCandidates(ctx.scopedModels, ctx.modelRegistry.getAvailable())
    let next = chooseCandidate(candidates, { current: round.model, tried: round.tried, failureKind: classification.kind, health: health.snapshot })
    while (next) {
      if (!await health.claimProvider(next)) { round.tried.add(modelKey(next)); next = chooseCandidate(candidates, { current: round.model, tried: round.tried, failureKind: classification.kind, health: health.snapshot }); continue }
      round.attempts++
      ctx.ui.setWorkingMessage(`模型异常，正在切换到 ${modelKey(next)}…`)
      const set = await pi.setModel(next).catch(() => false)
      if (!set) {
        health.recordFailure('model', modelKey(next), 'model_config', 'Pi refused model selection')
        round.tried.add(modelKey(next)); await health.flush()
        next = chooseCandidate(candidates, { current: round.model, tried: round.tried, failureKind: classification.kind, health: health.snapshot })
        continue
      }
      round.model = next
      round.phase = 'redispatching'
      notify(ctx, `CCSwitch：已切换至 ${modelKey(next)}（${round.attempts}/${MAX_ATTEMPTS}）`, 'info')
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

  pi.on('session_start', async (_event, ctx) => { await health.load(); await refresh(ctx); await health.log('extension started') })
  pi.on('session_shutdown', async (_event, ctx) => { clearWatchdog(); ctx.ui.setWorkingMessage(); await health.flush() })
  pi.on('input', (event, ctx) => {
    if (event.source === 'extension') return { action: 'continue' }
    clearWatchdog()
    lastStatus = {}
    round = { id: (round?.id ?? 0) + 1, phase: 'monitoring', startedAt: Date.now(), text: event.text, images: event.images, tried: new Set(), attempts: 0, hadTool: false, inTool: false, hadOutput: false, watchdog: false, cleanRetry: false, model: ctx.model }
    status(ctx)
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
  pi.on('tool_execution_end', () => { if (round) round.inTool = false })
  pi.on('turn_end', async (event, ctx) => {
    const message = event.message
    if (message?.role !== 'assistant' || !round) return
    clearWatchdog()
    round.model = { provider: message.provider, id: message.model }
    round.hadOutput ||= Boolean(message.content?.length)
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      round.phase = 'settled-error'
      round.observation = { message: message.errorMessage, rawStopReason: message.rawStopReason, status: lastStatus.status, retryAfterMs: lastStatus.retryAfterMs, watchdog: round.watchdog, aborted: message.stopReason === 'aborted' }
      await health.log(`turn failed ${modelKey(round.model)}: ${message.errorMessage ?? message.stopReason}`)
    } else {
      health.recordSuccess(round.model); await health.flush()
      round.phase = 'idle'; round.observation = undefined; ctx.ui.setWorkingMessage(); status(ctx)
    }
  })
  pi.on('agent_settled', async (_event, ctx) => {
    if (!round || round.phase !== 'settled-error') return
    if (!ctx.isIdle()) return
    if (!canRetry(ctx) && round.observation && round.model) {
      const classification = classifyFailure(round.observation)
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
    const healthy = snapshot.models.filter(model => !health.isBlocked(model)).length
    const source = snapshot.source === 'scoped' ? `Pi scope ${snapshot.sourceEntries} 条` : `Pi 注册表 ${snapshot.sourceEntries} 条`
    notify(ctx, `CCSwitch 自检：${source} · 唯一模型 ${snapshot.models.length} · 健康 ${healthy}`, snapshot.models.length ? 'info' : 'warning')
  }})
}
