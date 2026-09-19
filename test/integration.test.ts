import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extension from '../index.ts'
import { endpointKey } from '../health.ts'
import type { ExtensionContext, ModelRef } from '../types.ts'

const a: ModelRef = { provider: 'provider-a', id: 'coder', contextWindow: 128000, input: ['text'], reasoning: true }
const a2: ModelRef = { provider: 'provider-a', id: 'small', contextWindow: 128000, input: ['text'], reasoning: true }
const b: ModelRef = { provider: 'provider-b', id: 'coder', contextWindow: 128000, input: ['text'], reasoning: true }

test('provider failure moves directly to another provider rather than sibling model', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-integration-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const sent: unknown[] = []
  const appended: Array<{ customType: string, data: Record<string, unknown> }> = []
  let activeModel: ModelRef = a
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a, a2, b] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: content => sent.push(content),
      appendEntry: (customType, data) => appended.push({ customType, data }),
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'fix it' }, ctx)
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, ['provider-b/coder'])
    assert.deepEqual(sent, ['fix it'])
    assert.equal(activeModel.provider, 'provider-b')
    // 切换成功后应当记录一次成功切换（session 计数 + entry 触发 TUI 重绘）
    assert.equal(appended.length, 1, 'switch should emit an appendEntry to refresh the footer')
    assert.equal(appended[0].customType, 'ccswitch-switch')
    assert.equal(appended[0].data.from, 'provider-a/coder')
    assert.equal(appended[0].data.to, 'provider-b/coder')
    // 持久化状态应记录累计切换数
    const state = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    assert.equal(state.switches, 1)
    assert.equal(state.switchLog?.length, 1)
    assert.equal(state.switchLog?.[0].to, 'provider-b/coder')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('RPC protocol emits switch, complete, and exhausted terminal entries', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-rpc-protocol-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const appended: Array<{ customType: string, data: Record<string, unknown> }> = []
  const ctx: ExtensionContext = {
    mode: 'rpc', hasUI: false, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a, b] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler), registerCommand: () => {},
      setModel: async model => { ctx.model = model; return true }, sendUserMessage: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'rpc', text: 'retry me' }, ctx)
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: a.provider, model: a.id, content: [], stopReason: 'error', errorMessage: 'rate limit' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: b.provider, model: b.id, content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }, ctx)
    assert.deepEqual(appended.map(entry => entry.customType), ['ccswitch-switch', 'ccswitch-complete'])
    assert.equal(appended[0].data.protocolVersion, 1)
    assert.equal(appended[0].data.roundId, appended[1].data.roundId)
    assert.equal(appended[1].data.model, 'provider-b/coder')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})


test('/new session resets the session switch counter but keeps failures and cooldowns', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-newsession-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const appended: Array<{ customType: string, data: Record<string, unknown> }> = []
  let activeModel: ModelRef = a
  // 只有一个模型可选：失败后没有健康候选 → round 失败但不切换成功，provider 冷却保留
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; return true },
      sendUserMessage: () => {},
      appendEntry: (customType, data) => appended.push({ customType, data }),
    })
    // session 1：provider-a 429 失败，没有健康候选 → 不切换（appended 为空），冷却落盘
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'first session' }, ctx)
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.equal(appended.length, 0, 'no candidate -> no successful switch in session 1')
    await handlers.get('session_shutdown')?.({}, ctx)

    // session 2：/new 后扩展工厂重跑 → 新闭包 session 计数归零，但 provider 冷却/失败保留
    const handlers2 = new Map<string, (event: any, ctx: ExtensionContext) => any>()
    const appended2: Array<{ customType: string, data: Record<string, unknown> }> = []
    extension({
      on: (name, handler) => handlers2.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; return true },
      sendUserMessage: () => {},
      appendEntry: (customType, data) => appended2.push({ customType, data }),
    })
    await handlers2.get('session_start')?.({}, ctx)
    const stateAfterNew = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    assert.ok(stateAfterNew.providers['provider-a']?.cooldownUntil > Date.now(), 'provider cooldown must survive /new')
    assert.equal(stateAfterNew.providers['provider-a']?.consecutiveFailures, 1, 'failure count must survive /new')
    assert.equal(stateAfterNew.switches ?? 0, 0, 'no successful switch happened, lifetime switches stays 0')

    // session 2 中放开第二个模型候选，让切换成功 → session 计数从 1 开始（本 session 首切）
    ctx.modelRegistry.getAvailable = () => [a, b]
    handlers2.get('input')?.({ source: 'interactive', text: 'second session' }, ctx)
    handlers2.get('after_provider_response')?.({ status: 403, headers: {} }, ctx)
    await handlers2.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'forbidden' } }, ctx)
    await handlers2.get('agent_settled')?.({}, ctx)
    assert.equal(appended2.length, 1, 'session 2 should switch successfully')
    assert.equal(appended2[0].data.sessionSwitches, 1, 'session counter restarts at 1 in new session, not 2')
    const finalState = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    assert.equal(finalState.switches, 1, 'lifetime switches reflects this one successful switch')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('content_policy failure switches to another model and records health', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-contentpolicy-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const glm: ModelRef = { ...a, id: 'glm-4.5' }
  const glmSibling: ModelRef = { ...b, id: 'zai-org/GLM-4.6' }
  const unrestricted: ModelRef = { provider: 'provider-c', id: 'qwen3-coder', contextWindow: 128000, input: ['text'], reasoning: true }
  const secondFallback: ModelRef = { provider: 'provider-d', id: 'claude-sonnet', contextWindow: 128000, input: ['text'], reasoning: true }
  let activeModel: ModelRef = glm
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: glm, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [glm, glmSibling, unrestricted, secondFallback] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'ask something' }, ctx)
    handlers.get('after_provider_response')?.({ status: 200, headers: {} }, ctx)
    // sensitive 内容审查：应避开所有 GLM 系列，而不是切到另一个 Provider 的 GLM。
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'glm-4.5', content: [], stopReason: 'error', errorMessage: 'Provider finish_reason: sensitive' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, ['provider-c/qwen3-coder'], 'content policy should skip the entire rejected model family')

    // 新一轮内容审查故障转移仍会读取本 session 的 glm 约束，同时累计本轮新发现的 qwen 约束。
    handlers.get('input')?.({ source: 'interactive', text: 'ask another sensitive question' }, ctx)
    handlers.get('after_provider_response')?.({ status: 200, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: unrestricted.provider, model: unrestricted.id, content: [], stopReason: 'error', errorMessage: 'content_filter' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, ['provider-c/qwen3-coder', 'provider-d/claude-sonnet'], 'later policy failover should keep avoiding previously learned GLM models')
    // 台账只记录 model 级失败（冷却），系列约束保留在 session 内存。
    const state = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    assert.ok(state.models['provider-a/glm-4.5']?.cooldownUntil > Date.now(), 'model should be cooling after content policy failure')
    assert.equal(state.contentPolicyFamilies, undefined, 'policy families must not be persisted')
    assert.equal(state.switches, 2)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('all non-user-cancel error classes reach normal failover', { concurrency: false }, async () => {
  const cases: Array<{ name: string, status?: number, error: string, rawStopReason?: string }> = [
    { name: 'auth', status: 401, error: 'unauthorized' },
    { name: 'quota', status: 402, error: 'payment required' },
    { name: 'rate limit', status: 429, error: 'rate limited' },
    { name: 'server', status: 503, error: 'service unavailable' },
    { name: 'request timeout', status: 408, error: 'request timeout' },
    { name: 'transport', error: 'read ECONNRESET' },
    { name: 'model config', status: 404, error: 'model not found' },
    { name: 'context overflow', error: 'context window exceeded' },
    { name: 'unknown', error: 'unexpected provider exception' },
  ]

  for (const failure of cases) {
    const dir = await mkdtemp(join(tmpdir(), `ccswitch-${failure.name.replace(/\s+/g, '-')}-`))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    const source: ModelRef = { ...a, baseUrl: 'https://provider-a.example/v1', contextWindow: 64_000 }
    const fallback: ModelRef = { ...b, baseUrl: 'https://provider-b.example/v1', contextWindow: 256_000 }
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
    const selected: string[] = []
    const ctx: ExtensionContext = {
      mode: 'tui', hasUI: true, model: source, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
      modelRegistry: { refresh: async () => {}, getAvailable: () => [source, fallback] },
      ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
    }
    try {
      extension({
        on: (name, handler) => handlers.set(name, handler),
        registerCommand: () => {},
        setModel: async model => { ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
        sendUserMessage: () => {},
      })
      await handlers.get('session_start')?.({}, ctx)
      handlers.get('input')?.({ source: 'interactive', text: `trigger ${failure.name}` }, ctx)
      handlers.get('after_provider_response')?.({ status: failure.status ?? 200, headers: {} }, ctx)
      await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: source.provider, model: source.id, content: [], stopReason: 'error', rawStopReason: failure.rawStopReason, errorMessage: failure.error } }, ctx)
      await handlers.get('agent_settled')?.({}, ctx)
      assert.deepEqual(selected, ['provider-b/coder'], `${failure.name} should switch to the healthy fallback`)
      if (['server', 'request timeout', 'transport'].includes(failure.name)) {
        const state = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
        assert.ok(state.endpoints[endpointKey(source)], `${failure.name} should retain BaseURL metadata and open the correct endpoint breaker`)
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('a user cancellation is the only aborted turn that does not fail over', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-user-cancel-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a, b] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'cancel me' }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: a.provider, model: a.id, content: [], stopReason: 'aborted' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, [])
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('exhausted phase renders stop indicator in the status bar', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-exhausted-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  let activeModel: ModelRef = a
  const statuses: string[] = []
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a] },
    ui: { notify: () => {}, setStatus: (_key, text) => { if (text) statuses.push(text) }, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    assert.match(statuses[statuses.length - 1] ?? '', /CCS v\d+\.\d+\.\d+/, 'status bar should show the extension version')
    handlers.get('input')?.({ source: 'interactive', text: 'trigger round' }, ctx)
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    // 唯一候选也已冷却 → agent_settled 时 failover 无候选 → exhaust
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    const last = statuses[statuses.length - 1] ?? ''
    assert.match(last, /停止/, 'exhausted phase should render a stop indicator')
    assert.match(last, /provider-a\/coder/, 'stop indicator should carry the last active model')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('input with images proactively switches to multimodal candidate', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-modality-input-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const sent: unknown[] = []
  const appended: Array<{ customType: string, data: Record<string, unknown> }> = []
  const textOnly: ModelRef = { provider: 'provider-a', id: 'text-only', contextWindow: 128000, input: ['text'] }
  const vision: ModelRef = { provider: 'provider-b', id: 'vision', contextWindow: 128000, input: ['text', 'image'] }
  let activeModel: ModelRef = textOnly
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: textOnly, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [textOnly, vision] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: content => sent.push(content),
      appendEntry: (customType, data) => appended.push({ customType, data }),
    })
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('input')?.({ source: 'interactive', text: 'read this screenshot', images: [{ type: 'image', data: 'mock', mimeType: 'image/png' }] }, ctx)
    // 应切换到多模态模型，不重发消息
    assert.deepEqual(selected, ['provider-b/vision'], 'should switch to multimodal model')
    assert.equal(sent.length, 0, 'should NOT re-send message (no sendUserMessage for proactive switch)')
    assert.equal(activeModel.provider, 'provider-b')
    assert.equal(activeModel.id, 'vision')
    // 应记录切换（reason modality）
    assert.equal(appended.length, 1, 'switch should emit appendEntry')
    assert.equal(appended[0].customType, 'ccswitch-switch')
    assert.equal(appended[0].data.reason, 'modality')
    assert.equal(appended[0].data.from, 'provider-a/text-only')
    assert.equal(appended[0].data.to, 'provider-b/vision')
    // 持久化状态应有 switchLog
    const state = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    assert.equal(state.switches, 1)
    assert.equal(state.switchLog?.[0]?.to, 'provider-b/vision')
    assert.equal(state.switchLog?.[0]?.reason, 'modality')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('input with images but no multimodal candidate does nothing', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-modality-none-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const notifications: string[] = []
  const textOnlyA: ModelRef = { provider: 'provider-a', id: 'model-a', contextWindow: 128000, input: ['text'] }
  const textOnlyB: ModelRef = { provider: 'provider-b', id: 'model-b', contextWindow: 128000, input: ['text'] }
  let activeModel: ModelRef = textOnlyA
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: textOnlyA, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [textOnlyA, textOnlyB] },
    ui: { notify: (msg) => { notifications.push(msg) }, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('input')?.({ source: 'interactive', text: 'read this screenshot', images: [{ type: 'image', data: 'mock', mimeType: 'image/png' }] }, ctx)
    // 应保持原模型，无切换，通知用户
    assert.deepEqual(selected, [], 'should NOT switch when no multimodal candidate')
    assert.ok(notifications.some(n => n.includes('没有可用的多模态候选') || n.includes('无可用的多模态候选')), 'should notify user about no multimodal candidate')
    assert.equal(activeModel.provider, 'provider-a')
    const { HealthStore } = await import('../health.ts')
    const store = new HealthStore(dir)
    await store.load()
    assert.equal(store.snapshot.switches ?? 0, 0, 'no switch should have occurred')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('input with images and current model already multimodal does not switch', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-modality-already-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const vision: ModelRef = { provider: 'provider-a', id: 'vision', contextWindow: 128000, input: ['text', 'image'] }
  let activeModel: ModelRef = vision
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: vision, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [vision] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('input')?.({ source: 'interactive', text: 'read this', images: [{ type: 'image', data: 'mock', mimeType: 'image/png' }] }, ctx)
    assert.deepEqual(selected, [], 'should NOT switch when current model is already multimodal')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool result with image proactively switches to multimodal candidate', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-modality-tool-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const textOnly: ModelRef = { provider: 'provider-a', id: 'text-only', contextWindow: 128000, input: ['text'] }
  const vision: ModelRef = { provider: 'provider-b', id: 'vision', contextWindow: 128000, input: ['text', 'image'] }
  let activeModel: ModelRef = textOnly
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: textOnly, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [textOnly, vision] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    // 先建立 round（通过 input 事件，不带图片）
    handlers.get('input')?.({ source: 'interactive', text: 'read the image file' }, ctx)
    // 模拟工具执行：read 图片文件返回含 image content 的结果
    handlers.get('tool_execution_start')?.({ toolCallId: 't1', toolName: 'read', args: { path: '/screenshot.png' } }, ctx)
    await handlers.get('tool_execution_end')?.({ toolCallId: 't1', toolName: 'read', result: { content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: 'base64mock', mimeType: 'image/png' }] }, isError: false }, ctx)
    // 应切换到多模态模型
    assert.deepEqual(selected, ['provider-b/vision'], 'tool image result should trigger switch to multimodal model')
    assert.equal(activeModel.provider, 'provider-b')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

// --- 回归：pi.setModel() 内部会 emit model_select（pi core _emitModelSelect(source="set")），
// 扩展自己的切换不得清空本轮故障转移状态，否则 exhaust 报告“已尝试”为空。
test("extension's own setModel (model_select source=set) must not wipe round failover state", { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-selfswitch-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const notifications: string[] = []
  let activeModel: ModelRef = a
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a, b] },
    ui: { notify: (msg) => { notifications.push(msg) }, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      // 模拟 pi core：setModel 成功后 emit model_select（与真实 agent-session 行为一致）
      setModel: async model => {
        const previousModel = activeModel
        activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`)
        await handlers.get('model_select')?.({ model, previousModel, source: 'set' }, ctx)
        return true
      },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'trigger' }, ctx)
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, ['provider-b/coder'], 'first failure switches to provider-b')
    // provider-b 也失败（换错误消息以便区分）
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-b', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit 2' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    // 两个 provider 都已冷却 → 无健康候选 → exhaust；报告必须列出两个都试过的模型
    const report = readFileSync(join(dir, 'ccswitch-failure-report.md'), 'utf8')
    assert.match(report, /- provider-a\/coder — rate limit/, 'report must list provider-a with its error (not wiped by model_select)')
    assert.match(report, /- provider-b\/coder — rate limit 2/, 'report must list provider-b with its error')
    assert.ok(notifications.some(n => n.includes('provider-b/coder')), 'exhaust notification should name the last failing model')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

// --- 回归：同平台（同 BaseURL 不同 provider 副本）连续失败 3 次应隔离整个平台，
// 不再把同平台剩余副本逐个试一遍（每个候选最多烧一个 FIRST_RESPONSE_TIMEOUT）。
test('same-platform provider copies are isolated as one platform after repeated failures', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-platform-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const p1: ModelRef = { provider: 'p1', id: 'm', baseUrl: 'https://same-platform.example/v1', contextWindow: 128000, input: ['text'] }
  const p2: ModelRef = { provider: 'p2', id: 'm', baseUrl: 'https://same-platform.example/v1', contextWindow: 128000, input: ['text'] }
  const p3: ModelRef = { provider: 'p3', id: 'm', baseUrl: 'https://same-platform.example/v1', contextWindow: 128000, input: ['text'] }
  const p4: ModelRef = { provider: 'p4', id: 'm', baseUrl: 'https://same-platform.example/v1', contextWindow: 128000, input: ['text'] }
  const p5: ModelRef = { provider: 'p5', id: 'm', baseUrl: 'https://other-platform.example/v1', contextWindow: 128000, input: ['text'] }
  let activeModel: ModelRef = p1
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: p1, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [p1, p2, p3, p4, p5] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { activeModel = model; ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'trigger platform isolation' }, ctx)
    // unknown 类失败只冷却 model 级（2min），不会阻断同平台兄弟副本 —— 只有平台隔离能跳过它们
    const failOn = async (provider: string) => {
      handlers.get('after_provider_response')?.({ status: 500, headers: {} }, ctx)
      await handlers.get('turn_end')?.({ message: { role: 'assistant', provider, model: 'm', content: [], stopReason: 'error', errorMessage: 'unexpected provider exception' } }, ctx)
      await handlers.get('agent_settled')?.({}, ctx)
    }
    // p1 → p2 → p3 同平台连续失败 3 次 → 平台被隔离 → 跳过同平台未试过的 p4，直接选跨平台的 p5
    await failOn('p1')
    await failOn('p2')
    await failOn('p3')
    assert.deepEqual(selected, ['p2/m', 'p3/m', 'p5/m'], 'platform isolation must skip the remaining same-platform copy p4 and pick the cross-platform p5')
    assert.equal(activeModel.provider, 'p5', 'round continues on the cross-platform fallback')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

// --- 回归：ROUND_LIMIT 耗尽前，最后一个失败必须先落健康台账（否则下一轮还会重试同一个刚失败的模型）
test('final failure is recorded to health even when the round time limit is exceeded', { concurrency: false }, async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-timelimit-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.CCSWITCH_ROUND_LIMIT_MS = '1'
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const notifications: string[] = []
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a, b] },
    ui: { notify: (msg) => { notifications.push(msg) }, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'trigger' }, ctx)
    now += 2 // deterministic expiry; do not depend on filesystem latency
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    // 轮时限已耗尽但本轮还没切过 → 第一次兜底必须执行（窗口只限制连续切换 churn）
    assert.deepEqual(selected, ['provider-b/coder'], 'first fallback must run even when the round window already expired')
    // 第二次失败时窗口自上次切换起再次耗尽（attempts > 0）→ exhaust；但失败必须先落台账
    now += 2
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-b', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit 2' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    const state = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    assert.ok(state.providers['provider-b']?.cooldownUntil > Date.now(), 'provider failure must be recorded before the time-limit exhaust')
    const report = readFileSync(join(dir, 'ccswitch-failure-report.md'), 'utf8')
    assert.match(report, /- provider-a\/coder — rate limit/, 'tried list must contain the first failing model')
    assert.match(report, /- provider-b\/coder — rate limit 2/, 'tried list must contain the second failing model')
    assert.ok(notifications.some(n => n.includes('超过本轮时间限制') && n.includes('provider-b/coder')), 'notification should name the failing model')
    assert.deepEqual(selected, ['provider-b/coder'], 'no further switch after the time-limit exhaust')
  } finally {
    delete process.env.CCSWITCH_ROUND_LIMIT_MS
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

for (const source of ['input', 'tool', 'retry-tool']) {
  test(`image requirements survive subsequent failures: ${source}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccswitch-image-round-'))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
    const models: ModelRef[] = [
      { provider: 'a', id: 'coder', input: ['text'] },
      { provider: 'b', id: 'coder', input: ['text'] },
      { provider: 'c', id: 'vision', input: ['text', 'image'] },
      { provider: 'd', id: 'vision', input: ['text', 'image'] },
      { provider: 'e', id: 'unknown' },
    ]
    const selected: string[] = []
    const ctx: ExtensionContext = {
      mode: 'rpc', hasUI: false, model: models[0], scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
      modelRegistry: { refresh: async () => {}, getAvailable: () => models },
      ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
    }
    const fail = async () => {
      await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: ctx.model!.provider, model: ctx.model!.id, stopReason: 'error', errorMessage: 'unknown failure', content: [] } }, ctx)
      await handlers.get('agent_settled')?.({}, ctx)
    }
    try {
      extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {},
        setModel: async model => { await Promise.resolve(); ctx.model = model; selected.push(model.provider); return true }, sendUserMessage: () => {} })
      await handlers.get('session_start')?.({}, ctx)
      await handlers.get('input')?.({ source: 'rpc', text: 'read image', images: source === 'input' ? [{ type: 'image', data: 'mock' }] : undefined }, ctx)
      if (source === 'retry-tool') { await fail(); assert.equal(ctx.model?.provider, 'b') }
      if (source !== 'input') {
        await handlers.get('tool_execution_start')?.({}, ctx)
        // Parallel tools may complete together; they must share one switch.
        const toolsFinished = Promise.all([1, 2].map(() => handlers.get('tool_execution_end')?.({ result: { content: [{ type: 'image', data: 'mock' }] } }, ctx)))
        await toolsFinished
        assert.equal(ctx.model?.provider, 'c', 'awaited tool completion must select vision before request preparation')
        const preparedModel = ctx.model
        const selectionCount = selected.length
        await handlers.get('before_provider_request')?.({}, ctx)
        assert.equal(ctx.model, preparedModel)
        assert.equal(selected.length, selectionCount, 'before-provider must not switch a prepared request')
      }
      assert.equal(ctx.model?.provider, 'c')
      assert.equal(selected.filter(p => p === 'c').length, 1)
      await fail()
      assert.equal(ctx.model?.provider, 'd', 'next failure must still choose a vision model')
      await fail()
      assert.equal(ctx.model?.provider, 'd', 'unknown metadata and text-only models cannot handle remaining image round')
    } finally {
      await handlers.get('session_shutdown')?.({}, ctx)
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('429 account-quota failure parks the provider with quota cooldown instead of 5min rate-limit', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-429-quota-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const selected: string[] = []
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a, b] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
  }
  try {
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
      setModel: async model => { ctx.model = model; selected.push(`${model.provider}/${model.id}`); return true },
      sendUserMessage: () => {},
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'trigger' }, ctx)
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: '429: {"code":"AccountQuotaExceeded","message":"You have exceeded the 5-hour usage quota. It will reset at 2026-09-19 13:50:43 +0800 CST.","type":"TooManyRequests"}' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, ['provider-b/coder'], 'account quota should fail over to the healthy provider')
    const state = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    const record = state.providers['provider-a']
    assert.equal(record.lastClass, 'quota', '429 quota body must not be classified as rate_limit')
    const cooldown = record.cooldownUntil - record.lastFailureAt
    assert.ok(cooldown >= 30 * 60_000, `account quota must park the provider for the quota cooldown tier, got ${cooldown}ms`)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('starting another extension session cannot clear local policy families', { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-session-policy-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const models: ModelRef[] = [
    { provider: 'a', id: 'glm-4.5', input: ['text'] },
    { provider: 'b', id: 'glm-4.6', input: ['text'] },
    { provider: 'c', id: 'qwen3', input: ['text'] },
    { provider: 'd', id: 'claude-sonnet', input: ['text'] },
  ]
  const makeSession = () => {
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
    const commands = new Map<string, any>()
    const messages: string[] = []
    const ctx: ExtensionContext = {
      mode: 'rpc', hasUI: true, model: models[0], scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
      modelRegistry: { refresh: async () => {}, getAvailable: () => models },
      ui: { notify: message => messages.push(message), setStatus: () => {}, setWorkingMessage: () => {} },
    }
    extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
      setModel: async model => { ctx.model = model; return true }, sendUserMessage: () => {} })
    return { handlers, commands, messages, ctx }
  }
  const a = makeSession(), b = makeSession()
  const emit = async (session: ReturnType<typeof makeSession>, event: string, data = {}) => session.handlers.get(event)?.(data, session.ctx)
  const reject = async (session: ReturnType<typeof makeSession>) => {
    await emit(session, 'input', { source: 'rpc', text: 'question' })
    await emit(session, 'turn_end', { message: { role: 'assistant', provider: session.ctx.model!.provider, model: session.ctx.model!.id, stopReason: 'error', errorMessage: 'content_filter', content: [] } })
    await emit(session, 'agent_settled')
  }
  try {
    await emit(a, 'session_start'); await reject(a)
    assert.equal(a.ctx.model?.provider, 'c')
    await emit(b, 'session_start')
    await a.commands.get('ccswitch').handler('status', a.ctx)
    assert.match(a.messages.at(-1)!, /审查约束系列 1/)
    await b.commands.get('ccswitch-test').handler('', b.ctx)
    assert.match(b.messages.at(-1)!, /审查约束系列 0/)
    await reject(a)
    assert.equal(a.ctx.model?.provider, 'd', 'session A still avoids healthy GLM sibling after session B starts')
    await emit(a, 'session_start')
    await a.commands.get('ccswitch-test').handler('', a.ctx)
    assert.match(a.messages.at(-1)!, /审查约束系列 0/)
  } finally {
    await emit(a, 'session_shutdown'); await emit(b, 'session_shutdown')
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('before-provider never starts a late switch when vision appears after input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-no-late-switch-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const vision: ModelRef = { provider: 'vision', id: 'vision', input: ['text', 'image'] }
  let available = [a], switches = 0
  const ctx: ExtensionContext = { mode: 'rpc', hasUI: false, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => available },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} } }
  try {
    extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {}, sendUserMessage: () => {},
      setModel: async model => { ctx.model = model; switches++; return true } })
    await handlers.get('session_start')?.({}, ctx)
    await handlers.get('input')?.({ source: 'rpc', text: 'image', images: [{ type: 'image', data: 'mock' }] }, ctx)
    available = [a, vision]
    await handlers.get('before_provider_request')?.({}, ctx)
    assert.equal(switches, 0)
    assert.equal(ctx.model, a)
  } finally {
    await handlers.get('session_shutdown')?.({}, ctx)
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

for (const surface of ['panel', 'command-model', 'command-all']) {
  for (const unsupported of [false, true]) {
    test(`recovery ${surface} reports persisted result (unsupported=${unsupported})`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccswitch-recovery-ui-'))
      const previous = process.env.PI_CODING_AGENT_DIR
      process.env.PI_CODING_AGENT_DIR = dir
      const handlers = new Map<string, any>(), commands = new Map<string, any>()
      const notices: Array<{ message: string, type: string | undefined }> = []
      const file = join(dir, 'ccswitch-auto-switch-state.json')
      const ctx: ExtensionContext = { mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
        modelRegistry: { refresh: async () => {}, getAvailable: () => [a] },
        ui: { setStatus: () => {}, setWorkingMessage: () => {}, select: async () => '重新激活当前模型',
          notify: (message, type) => {
            notices.push({ message, type })
            if (message.startsWith('已重新激活')) {
              const state = JSON.parse(readFileSync(file, 'utf8'))
              assert.equal(state.providers[a.provider].cooldownUntil, undefined, 'success notification must follow disk commit')
            }
          } } }
      try {
        extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
          setModel: async () => true, sendUserMessage: () => {} })
        await handlers.get('session_start')({}, ctx)
        const original = JSON.stringify({ schemaVersion: unsupported ? 99 : 3, updatedAt: 0, models: {}, endpoints: {},
          providers: { [a.provider]: { consecutiveFailures: 1, totalFailures: 1, cooldownUntil: Date.now() + 60000 } } })
        await writeFile(file, original)
        const args = surface === 'panel' ? 'status' : surface === 'command-all' ? 'reactivate all' : `reactivate ${a.provider}/${a.id}`
        await commands.get('ccswitch').handler(args, ctx)
        if (unsupported) {
          assert.ok(notices.some(n => n.type === 'error' && n.message.includes('重新激活失败')))
          assert.equal(notices.some(n => n.message.startsWith('已重新激活')), false)
          assert.equal(readFileSync(file, 'utf8'), original)
        } else assert.ok(notices.some(n => n.message.startsWith('已重新激活')))
      } finally {
        await handlers.get('session_shutdown')?.({}, ctx)
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
}

test('RPC image input fails closed when no image model can be selected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-image-required-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
  const entries: Array<{type: string, data: any}> = []
  const ctx: ExtensionContext = { mode: 'rpc', hasUI: false, model: a, scopedModels: [], isIdle: () => true,
    hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a] },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} } }
  try {
    extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {},
      sendUserMessage: () => {}, appendEntry: (type, data) => entries.push({type, data}) })
    await handlers.get('session_start')?.({}, ctx)
    const result = await handlers.get('input')?.({source: 'rpc', text: 'read', images: [{type: 'image', data: 'fixture'}]}, ctx)
    assert.equal(result.action, 'handled')
    assert.ok(entries.some(e => e.type === 'ccswitch-exhausted' && /image/.test(e.data.reason)))
  } finally {
    await handlers.get('session_shutdown')?.({}, ctx)
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, {recursive: true, force: true})
  }
})
