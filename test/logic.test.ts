import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, parseRetryAfter } from '../classify.ts'
import { candidateSnapshot, chooseCandidate, effectiveCandidates, modelFamily, summarizeCandidateHealth } from '../candidates.ts'
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

test('does not poison global health for context failures; content policy flags the model for switch', () => {
  // context overflow 是内容本身超长：roundOnly，切换模型无益（且 chooseCandidate 有更大上下文过滤）
  assert.equal(classifyFailure({ message: 'context window exceeded' }).roundOnly, true)
  // 内容审查/敏感拦截是按模型的失败：应记台账、冷却并触发切换，而不是原样重试
  assert.deepEqual(classifyFailure({ message: 'content_filter' }), {
    kind: 'content_policy', scope: 'model', roundOnly: false,
  })
  assert.deepEqual(classifyFailure({ message: 'Provider finish_reason: sensitive' }).scope, 'model')
  assert.equal(classifyFailure({ message: '该请求包含政治敏感内容，安全审核未通过' }).kind, 'content_policy')
})

test('classifies common non-policy failures into a switchable failure domain', () => {
  assert.deepEqual(classifyFailure({ status: 402, message: 'payment required' }).scope, 'provider')
  assert.deepEqual(classifyFailure({ status: 408, message: 'request timeout' }), { kind: 'timeout', scope: 'endpoint', roundOnly: false })
  assert.equal(classifyFailure({ message: 'read ECONNRESET' }).scope, 'endpoint')
  assert.equal(classifyFailure({ message: 'upstream server overloaded' }).scope, 'endpoint')
  assert.deepEqual(classifyFailure({ message: 'unexpected provider exception' }), { kind: 'unknown', scope: 'model', roundOnly: false })
})

test('normalizes GLM variants to one family and avoids the whole family after policy rejection', () => {
  const glm45: ModelRef = { provider: 'zhipu', id: 'glm-4.5', contextWindow: 128000, input: ['text'] }
  const glm46: ModelRef = { provider: 'proxy', id: 'zai-org/GLM-4.6', contextWindow: 128000, input: ['text'] }
  const chatglm: ModelRef = { provider: 'local', id: 'THUDM/chatglm3-6b', contextWindow: 128000, input: ['text'] }
  const qwen: ModelRef = { provider: 'other', id: 'qwen3-coder', contextWindow: 128000, input: ['text'] }
  assert.equal(modelFamily(glm45), 'glm')
  assert.equal(modelFamily(glm46), 'glm')
  assert.equal(modelFamily(chatglm), 'glm')
  const next = chooseCandidate([glm45, glm46, qwen], {
    current: glm45,
    tried: new Set(['zhipu/glm-4.5']),
    health,
    failureKind: 'content_policy',
    avoidFamilies: new Set(['glm']),
    requiredInputs: ['text'],
  })
  assert.equal(next?.id, 'qwen3-coder')
})

test('a learned policy constraint does not exclude that family during an ordinary failover', () => {
  const glm: ModelRef = { provider: 'proxy', id: 'glm-4.6', contextWindow: 128000, input: ['text'] }
  const learned = {
    ...health,
    contentPolicyFamilies: {
      glm: { observations: 1, lastObservedAt: Date.now(), avoidUntil: Date.now() + 60_000, lastModel: 'zhipu/glm-4.5' },
    },
  }
  const next = chooseCandidate([glm], {
    current: a,
    tried: new Set(['a/coder']),
    health: learned,
    failureKind: 'endpoint',
    requiredInputs: ['text'],
  })
  assert.equal(next?.id, 'glm-4.6')
})

test('does not route an image request to a model that explicitly only accepts text', () => {
  const textOnly: ModelRef = { provider: 'b', id: 'coder', contextWindow: 128000, input: ['text'] }
  const vision: ModelRef = { provider: 'c', id: 'vision', contextWindow: 128000, input: ['text', 'image'] }
  const next = chooseCandidate([textOnly, vision], {
    current: { ...a, input: ['text', 'image'] },
    tried: new Set(['a/coder']),
    health,
    requiredInputs: ['text', 'image'],
  })
  assert.equal(next?.id, 'vision')
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
  // vendor-copy 与复制品共享 baseURL，但必须视为独立端点，互不连坐
  const bai: ModelRef = { provider: 'my-provider', id: 'model-a', baseUrl: 'https://api.example.com/v1', contextWindow: 128000 }
  const baiCopy: ModelRef = { provider: 'my-provider-copy', id: 'model-a', baseUrl: 'https://api.example.com/v1', contextWindow: 128000 }
  assert.notEqual(endpointKey(bai), endpointKey(baiCopy))
  // 隔离 my-provider 端点后，my-provider-copy 仍是健康候选
  const next = chooseCandidate([bai, baiCopy], { current: bai, tried: new Set(['my-provider/model-a']), health, avoidEndpoints: new Set([endpointKey(bai)]) })
  assert.equal(next?.provider, 'my-provider-copy')
})
