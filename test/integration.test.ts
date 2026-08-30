import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extension from '../index.ts'
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
  let activeModel: ModelRef = a
  const ctx: ExtensionContext = {
    mode: 'tui', hasUI: true, model: a, scopedModels: [], isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
    modelRegistry: { refresh: async () => {}, getAvailable: () => [a, b] },
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
    // sensitive 内容审查：应视为模型失败并切换到 provider-b，而不是原样重试
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'Provider finish_reason: sensitive' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, ['provider-b/coder'], 'content policy should trigger a switch')
    // 台账应记录 model 级失败（冷却）
    const state = JSON.parse(readFileSync(join(dir, 'ccswitch-auto-switch-state.json'), 'utf8'))
    assert.ok(state.models['provider-a/coder']?.cooldownUntil > Date.now(), 'model should be cooling after content policy failure')
    assert.equal(state.switches, 1)
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
