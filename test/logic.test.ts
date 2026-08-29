import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, parseRetryAfter } from '../classify.ts'
import { chooseCandidate, effectiveCandidates } from '../candidates.ts'
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

test('parses numeric and HTTP-date retry-after headers', () => {
  assert.equal(parseRetryAfter('12'), 12000)
  assert.equal(parseRetryAfter('bad header'), undefined)
})
