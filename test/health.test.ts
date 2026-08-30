import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HealthStore, agentDir } from '../health.ts'
import type { ModelRef } from '../types.ts'

const model: ModelRef = { provider: 'provider-a', id: 'model-a', baseUrl: 'https://example.test/v1?token=never-store' }

test('persists a provider breaker and restores it from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-health-'))
  try {
    const first = new HealthStore(dir)
    await first.load()
    first.recordFailure('provider', model.provider, 'quota', 'quota exceeded: sk-this-must-not-be-saved')
    await first.flush()
    assert.equal(first.isBlocked(model), true)

    const second = new HealthStore(dir)
    await second.load()
    assert.equal(second.isBlocked(model), true)
    assert.doesNotMatch(second.snapshot.providers[model.provider].lastError ?? '', /sk-this-must-not-be-saved/)

    second.reactivate(model)
    await second.flush()
    assert.equal(second.isBlocked(model), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('honors an explicit Pi configuration directory on every platform', () => {
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: 'C:\\Users\\测试 用户\\.pi\\agent' }), 'C:\\Users\\测试 用户\\.pi\\agent')
})

test('recordSwitch persists cumulative count and a capped switch log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-switchlog-'))
  try {
    const store = new HealthStore(dir)
    await store.load()
    assert.equal(store.snapshot.switches ?? 0, 0)
    store.recordSwitch('a/model-a', 'b/model-b', 'rate_limit')
    store.recordSwitch('b/model-b', 'c/model-c', 'quota')
    await store.flush()

    const reloaded = new HealthStore(dir)
    await reloaded.load()
    assert.equal(reloaded.snapshot.switches, 2)
    assert.equal(reloaded.snapshot.switchLog?.length, 2)
    assert.equal(reloaded.snapshot.switchLog?.[1].to, 'c/model-c')

    // 超过 20 条时环形保留最近 20 条
    for (let index = 0; index < 25; index += 1) store.recordSwitch(`p${index}/m`, 'q/model', 'endpoint')
    await store.flush()
    const capped = new HealthStore(dir)
    await capped.load()
    assert.equal(capped.snapshot.switchLog?.length, 20)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('persists learned content-policy family constraints and reset all really clears them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-policy-family-'))
  const glm: ModelRef = { provider: 'zhipu', id: 'glm-4.5' }
  try {
    const first = new HealthStore(dir)
    await first.load()
    first.recordContentPolicyConstraint('glm', glm, 'sensitive sk-this-must-not-be-saved')
    await first.flush()

    const reloaded = new HealthStore(dir)
    await reloaded.load()
    const constraint = reloaded.snapshot.contentPolicyFamilies?.glm
    assert.equal(constraint?.observations, 1)
    assert.equal(constraint?.lastModel, 'zhipu/glm-4.5')
    assert.ok((constraint?.avoidUntil ?? 0) > Date.now())
    assert.doesNotMatch(constraint?.lastError ?? '', /sk-this-must-not-be-saved/)

    reloaded.reset('all')
    await reloaded.flush()
    const reset = new HealthStore(dir)
    await reset.load()
    assert.deepEqual(reset.snapshot.contentPolicyFamilies, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
