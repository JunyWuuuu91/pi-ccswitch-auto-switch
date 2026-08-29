import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, parseRetryAfter } from '../classify.ts'
import { candidateSnapshot, chooseCandidate, effectiveCandidates, summarizeCandidateHealth } from '../candidates.ts'
import { endpointKey } from '../health.ts'
import type { ModelRef } from '../types.ts'

const a: ModelRef = { provider: 'a', id: 'coder', contextWindow: 128000, reasoning: true, input: ['text'] }
const a2: ModelRef = { provider: 'a', id: 'small', contextWindow: 128000, reasoning: true, input: ['text'] }
const b: ModelRef = { provider: 'b', id: 'coder', contextWindow: 128000, reasoning: true, input: ['text'] }
const big: ModelRef = { provider: 'b', id: 'big', contextWindow: 256000, reasoning: true, input: ['text'] }
const health = { schemaVersion: 2 as const, updatedAt: 0, models: {}, providers: {}, endpoints: {} }

test('classifies provider-wide failures before model failures', () => {
  assert.deepEqual(classifyFailure({ status: 429, message: 'rate limited' }).scope, 'provider')
  assert.deepEqual(classifyFailure({ status: 403, message: 'forbidden' }).kind, 'auth')
  assert.deepEqual(classifyFailure({ message: 'quota exceeded' }).scope, 'provider')
  assert.deepEqual(classifyFailure({ status: 404, message: 'model not found' }).scope, 'model')
})

test('does not poison global health for content or context failures', () => {
  assert.equal(classifyFailure({ message: 'content_filter' }).roundOnly, true)
  assert.equal(classifyFailure({ message: 'context window exceeded' }).roundOnly, true)
})

test('prefers the same model on another provider over another local model', () => {
  const next = chooseCandidate([a, a2, b], { current: a, tried: new Set(['a/coder']), health })
  assert.equal(next?.provider, 'b')
})

test('skips a provider whose breaker is open', () => {
  const blocked = { ...health, providers: { a: { consecutiveFailures: 1, totalFailures: 1, cooldownUntil: Date.now() + 60_000 } } }
  const next = chooseCandidate([a, a2, b], { current: a, tried: new Set(['a/coder']), health: blocked })
  assert.equal(next?.provider, 'b')
})

test('context failure only selects larger contexts', () => {
  const next = chooseCandidate([a2, b, big], { current: a, tried: new Set(['a/coder']), health, failureKind: 'context_overflow' })
  assert.equal(next?.id, 'big')
})

test('uses scoped models when supplied', () => {
  assert.deepEqual(effectiveCandidates([{ model: b }], [a, b]).map(model => model.provider), ['b'])
})

test('reports raw scoped entries separately from unique models', () => {
  const snapshot = candidateSnapshot([{ model: a }, { model: a }, { model: b }], [big])
  assert.equal(snapshot.source, 'scoped')
  assert.equal(snapshot.sourceEntries, 3)
  assert.equal(snapshot.models.length, 2)
})

test('counts models affected by a provider breaker instead of breaker records', () => {
  const now = Date.now()
  const affected = {
    ...health,
    models: { 'b/coder': { consecutiveFailures: 0, totalFailures: 0, disabled: true } },
    providers: { a: { consecutiveFailures: 1, totalFailures: 1, cooldownUntil: now + 60_000 } },
  }
  assert.deepEqual(summarizeCandidateHealth([a, a2, b], affected, now), {
    total: 3,
    healthy: 0,
    cooling: 2,
    disabled: 1,
    breakerRecords: 1,
  })
})

test('parses numeric and HTTP-date retry-after headers', () => {
  assert.equal(parseRetryAfter('12'), 12000)
  assert.equal(parseRetryAfter('bad header'), undefined)
})

test('skips sibling models sharing the same isolated endpoint (BaseURL)', () => {
  // 三个模型同 BaseURL 但 provider/id 不同，模拟同一端点平台下的多个模型
  const ep1: ModelRef = { provider: 'x', id: 'm1', baseUrl: 'https://api.example.com/v1', contextWindow: 128000 }
  const ep1b: ModelRef = { provider: 'x', id: 'm2', baseUrl: 'https://api.example.com/v1', contextWindow: 128000 }
  const other: ModelRef = { provider: 'y', id: 'm3', baseUrl: 'https://api.other.com/v1', contextWindow: 128000 }
  const isolated = new Set([endpointKey(ep1)])
  const next = chooseCandidate([ep1, ep1b, other], { current: ep1, tried: new Set(['x/m1']), health, avoidEndpoints: isolated })
  assert.equal(next?.provider, 'y')
})

test('still selects a sibling on the same endpoint when it is not isolated', () => {
  const ep1: ModelRef = { provider: 'x', id: 'm1', baseUrl: 'https://api.example.com/v1', contextWindow: 128000 }
  const ep1b: ModelRef = { provider: 'x', id: 'm2', baseUrl: 'https://api.example.com/v1', contextWindow: 128000 }
  const next = chooseCandidate([ep1, ep1b], { current: ep1, tried: new Set(['x/m1']), health, avoidEndpoints: new Set() })
  assert.equal(next?.id, 'm2')
})

test('same baseURL on different providers are independent endpoints (copy-vendor semantics)', () => {
  // b-ai 与复制的 b-ai-copy 共享 baseURL，但必须视为独立端点，互不连坐
  const bai: ModelRef = { provider: 'b-ai', id: 'deepseek-v4-flash', baseUrl: 'https://api.b.ai/v1', contextWindow: 128000 }
  const baiCopy: ModelRef = { provider: 'b-ai-copy', id: 'deepseek-v4-flash', baseUrl: 'https://api.b.ai/v1', contextWindow: 128000 }
  assert.notEqual(endpointKey(bai), endpointKey(baiCopy))
  // 隔离 b-ai 端点后，b-ai-copy 仍是健康候选
  const next = chooseCandidate([bai, baiCopy], { current: bai, tried: new Set(['b-ai/deepseek-v4-flash']), health, avoidEndpoints: new Set([endpointKey(bai)]) })
  assert.equal(next?.provider, 'b-ai-copy')
})
