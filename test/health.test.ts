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
