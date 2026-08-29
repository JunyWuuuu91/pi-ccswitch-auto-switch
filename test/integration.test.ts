import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
    })
    await handlers.get('session_start')?.({}, ctx)
    handlers.get('input')?.({ source: 'interactive', text: 'fix it' }, ctx)
    handlers.get('after_provider_response')?.({ status: 429, headers: {} }, ctx)
    await handlers.get('turn_end')?.({ message: { role: 'assistant', provider: 'provider-a', model: 'coder', content: [], stopReason: 'error', errorMessage: 'rate limit' } }, ctx)
    await handlers.get('agent_settled')?.({}, ctx)
    assert.deepEqual(selected, ['provider-b/coder'])
    assert.deepEqual(sent, ['fix it'])
    assert.equal(activeModel.provider, 'provider-b')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})
