import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HealthStore, agentDir, endpointKey, modelKey } from '../health.ts'
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

    await second.reactivate(model)
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

test('content-policy constraints stay in the owning instance and reset clears them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-policy-family-'))
  const glm: ModelRef = { provider: 'zhipu', id: 'glm-4.5' }
  try {
    const first = new HealthStore(dir)
    await first.load()
    first.recordContentPolicyConstraint('glm', glm, 'sensitive sk-this-must-not-be-saved')
    await first.flush()

    const reloaded = new HealthStore(dir)
    await reloaded.load()
    assert.deepEqual(reloaded.policyConstraints, {})
    const constraint = first.policyConstraints.glm
    assert.equal(constraint?.observations, 1)
    assert.equal(constraint?.lastModel, 'zhipu/glm-4.5')
    assert.ok((constraint?.avoidUntil ?? 0) > Date.now())
    assert.doesNotMatch(constraint?.lastError ?? '', /sk-this-must-not-be-saved/)

    first.reset('all')
    assert.deepEqual(first.policyConstraints, {})
    reloaded.reset('all')
    await reloaded.flush()
    const reset = new HealthStore(dir)
    await reset.load()
    assert.equal(reset.snapshot.contentPolicyFamilies, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearContentPolicyConstraints removes learned families while keeping other health records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-clear-policy-'))
  const glm: ModelRef = { provider: 'zhipu', id: 'glm-4.5' }
  try {
    // 上一个 session：约束和普通故障都先落盘
    const previous = new HealthStore(dir)
    await previous.load()
    previous.recordContentPolicyConstraint('glm', glm, 'sensitive')
    previous.recordFailure('model', 'zhipu/glm-4.5', 'endpoint', 'connection reset')
    await previous.flush()

    // 新 session：load 到旧约束 → clear → flush（真实 session 边界场景）
    const store = new HealthStore(dir)
    await store.load()
    assert.deepEqual(store.policyConstraints, {})
    store.clearContentPolicyConstraints()
    await store.flush()

    // 再次从磁盘读，确认约束确实被清掉，而不是被 merge 逻辑重新带回来
    const reloaded = new HealthStore(dir)
    await reloaded.load()
    assert.equal(reloaded.snapshot.contentPolicyFamilies, undefined)
    assert.ok(previous.policyConstraints.glm, 'another instance must not clear the owning session')
    previous.recordFailure('provider', glm.provider, 'quota')
    await previous.flush()
    store.recordSwitch('a', 'b')
    await store.flush()
    assert.deepEqual(store.policyConstraints, {}, 'merging shared health must never import another session policy')
    assert.ok(reloaded.snapshot.models['zhipu/glm-4.5']?.totalFailures >= 1, 'non-policy failure records should be preserved')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const scope of ['model', 'provider', 'endpoint'] as const) {
  for (const blocker of ['cooldown', 'disabled', 'lease', 'expired'] as const) {
    test(`atomic claim checks fresh ${scope} ${blocker}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccswitch-claim-'))
      try {
        const first = new HealthStore(dir), second = new HealthStore(dir)
        await first.load(); await second.load()
        const key = scope === 'model' ? modelKey(model) : scope === 'provider' ? model.provider : endpointKey(model)
        const state = first.snapshot
        const record = { consecutiveFailures: 1, totalFailures: 1,
          cooldownUntil: blocker === 'expired' ? Date.now() - 1000 : blocker === 'cooldown' ? Date.now() + 60000 : undefined,
          disabled: blocker === 'disabled', leaseUntil: blocker === 'lease' ? Date.now() + 60000 : undefined }
        state[scope === 'model' ? 'models' : scope === 'provider' ? 'providers' : 'endpoints'][key] = record
        await writeFile(first.file, JSON.stringify(state))
        const results = await Promise.all([first.claimCandidate(model), second.claimCandidate(model)])
        assert.equal(results.filter(Boolean).length, blocker === 'expired' ? 1 : 0)
      } finally { await rm(dir, { recursive: true, force: true }) }
    })
  }
}

test('healthy candidates do not acquire a half-open lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-healthy-'))
  try {
    const first = new HealthStore(dir), second = new HealthStore(dir)
    await first.load(); await second.load()
    assert.deepEqual(await Promise.all([first.claimCandidate(model), second.claimCandidate(model)]), [true, true])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const reverse of [false, true]) {
  test(`independent increments survive repeated merges (reverse=${reverse})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccswitch-counts-'))
    try {
      const seed = new HealthStore(dir)
      await seed.load()
      seed.recordFailure('provider', model.provider, 'quota')
      seed.recordSwitch('a', 'b'); await seed.flush()
      const a = new HealthStore(dir), b = new HealthStore(dir)
      await a.load(); await b.load()
      for (const store of [a, b]) {
        store.recordFailure('provider', model.provider, 'quota')
        store.recordSwitch('b', 'c')
      }
      const order = reverse ? [b, a] : [a, b]
      for (const store of order) await store.flush()
      // Force another dirty merge without new counter increments.
      for (const store of order) { store.disable('other/model', true); await store.flush() }
      const final = JSON.parse(await readFile(seed.file, 'utf8'))
      assert.equal(final.providers[model.provider].totalFailures, 3)
      assert.equal(final.switches, 3)
      assert.equal(final.providers[model.provider].consecutiveFailures, 2)
      assert.ok(final.providers[model.provider].cooldownUntil - final.providers[model.provider].lastFailureAt <= 60 * 60000)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test('schema 2 migration preserves all health buckets and independent increments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-schema-'))
  try {
    const a = new HealthStore(dir), b = new HealthStore(dir)
    const record = { totalFailures: 7, consecutiveFailures: 1, cooldownUntil: Date.now() + 60000 }
    await writeFile(a.file, JSON.stringify({ schemaVersion: 2, updatedAt: 0,
      models: { [modelKey(model)]: { ...record, disabled: true } },
      providers: { [model.provider]: record }, endpoints: { [endpointKey(model)]: record },
      switches: 4, contentPolicyFamilies: { glm: { observations: 1, avoidUntil: Date.now() + 60000 } } }))
    await a.load(); await b.load()
    assert.deepEqual(a.policyConstraints, {})
    for (const store of [a, b]) {
      store.recordFailure('provider', model.provider, 'quota')
      store.recordSwitch('a', 'b')
      await store.flush()
    }
    const final = new HealthStore(dir); await final.load()
    assert.equal(final.snapshot.schemaVersion, 3)
    assert.equal(final.snapshot.providers[model.provider].totalFailures, 9)
    assert.equal(final.snapshot.switches, 6)
    assert.equal(final.snapshot.models[modelKey(model)].disabled, true)
    assert.equal(final.snapshot.endpoints[endpointKey(model)].totalFailures, 7)
    assert.equal(JSON.parse(await readFile(a.file, 'utf8')).contentPolicyFamilies, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const action of ['disable', 'reactivate', 'reactivateAll', 'reset-model', 'reset-all'] as const) {
  test(`latest manual ${action} survives unrelated stale flush`, async t => {
    let now = Date.now()
    t.mock.method(Date, 'now', () => now)
    const dir = await mkdtemp(join(tmpdir(), 'ccswitch-manual-'))
    try {
      const a = new HealthStore(dir), b = new HealthStore(dir)
      await a.load()
      a.disable(modelKey(model), action !== 'disable'); await a.flush()
      await b.load()
      now += 10
      if (action === 'disable') a.disable(modelKey(model), true)
      if (action === 'reactivate') await a.reactivate(model)
      if (action === 'reactivateAll') await a.reactivateAll()
      if (action === 'reset-model') a.reset(modelKey(model))
      if (action === 'reset-all') a.reset('all')
      await a.flush()
      b.recordSwitch('unrelated', 'other'); await b.flush()
      const check = new HealthStore(dir); await check.load()
      assert.equal(Boolean(check.snapshot.models[modelKey(model)]?.disabled), action === 'disable')
      if (action.startsWith('reset')) assert.equal(check.snapshot.models[modelKey(model)], undefined, 'reset history cannot reappear from a stale snapshot')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

for (const phase of ['load', 'flush', 'reset', 'claim'] as const) {
  test(`unsupported schema is preserved on ${phase}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccswitch-future-schema-'))
    try {
      const store = new HealthStore(dir)
      if (phase !== 'load') await store.load()
      const original = JSON.stringify({ schemaVersion: 99, models: {}, providers: {}, endpoints: {}, futureData: 'preserve me' })
      await writeFile(store.file, original)
      if (phase === 'load') await store.load()
      if (phase === 'reset') store.reset('all')
      else store.recordFailure('provider', model.provider, 'quota')
      if (phase === 'claim') assert.equal(await store.claimCandidate(model), false)
      await store.flush()
      assert.equal(await readFile(store.file, 'utf8'), original)
      assert.match(await readFile(join(dir, 'ccswitch-auto-switch.log'), 'utf8'), /unsupported.*schema/i)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test('schema downgrade after observing schema 3 blocks stale writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-downgrade-'))
  try {
    const store = new HealthStore(dir)
    await store.load(); store.recordSwitch('a', 'b'); await store.flush()
    const old = JSON.stringify({ schemaVersion: 2, updatedAt: 0, models: {}, providers: {}, endpoints: {}, switches: 0 })
    await writeFile(store.file, old)
    store.recordSwitch('b', 'c'); await store.flush()
    assert.equal(await store.claimCandidate(model), false)
    assert.equal(await readFile(store.file, 'utf8'), old)
    assert.match(await readFile(join(dir, 'ccswitch-auto-switch.log'), 'utf8'), /schema downgrade/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('new manual enable supersedes a legacy disabled value on stale merge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccswitch-legacy-manual-'))
  try {
    const a = new HealthStore(dir), b = new HealthStore(dir)
    await writeFile(a.file, JSON.stringify({ schemaVersion: 2, models: { [modelKey(model)]: { consecutiveFailures: 0, totalFailures: 0, disabled: true } }, providers: {}, endpoints: {}, updatedAt: 0 }))
    await a.load(); await b.load()
    await a.reactivate(model); await a.flush()
    b.recordSwitch('x', 'y'); await b.flush()
    const check = new HealthStore(dir); await check.load()
    assert.equal(check.snapshot.models[modelKey(model)].disabled, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const all of [false, true]) {
  test(`reactivate all=${all} clears breakers added after load`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccswitch-atomic-recovery-'))
    try {
      const a = new HealthStore(dir), b = new HealthStore(dir)
      await a.load(); await b.load()
      const other = { provider: 'other', id: 'other', baseUrl: 'https://other.test' }
      const targets = all ? [model, other] : [model]
      for (const target of targets) {
        b.recordFailure('model', modelKey(target), 'unknown')
        b.recordFailure('provider', target.provider, 'quota')
        b.recordFailure('endpoint', endpointKey(target), 'endpoint')
        b.disable(modelKey(target), true)
      }
      await b.flush()
      const disk = JSON.parse(await readFile(b.file, 'utf8'))
      for (const bucket of [disk.models, disk.providers, disk.endpoints]) {
        for (const record of Object.values(bucket) as any[]) record.leaseUntil = Date.now() + 60000
      }
      await writeFile(b.file, JSON.stringify(disk))
      const result = await (all ? a.reactivateAll() : a.reactivate(model))
      // Verify persistence without an extra caller-side flush.
      const check = new HealthStore(dir); await check.load()
      for (const target of targets) assert.equal(check.isBlocked(target), false)
      assert.equal(result, true)
      for (const bucket of [check.snapshot.models, check.snapshot.providers, check.snapshot.endpoints]) {
        for (const record of Object.values(bucket)) {
          assert.equal(record.consecutiveFailures, 0)
          assert.equal(record.totalFailures, 1, 'recovery preserves failure counters')
          assert.equal(record.cooldownUntil, undefined)
          assert.equal(record.leaseUntil, undefined)
          assert.equal(record.disabled, false)
          assert.ok(record.disabledUpdatedAt)
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  for (const version of [99, 2]) {
    test(`reactivate all=${all} refuses schema ${version}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ccswitch-recovery-schema-'))
      try {
        const a = new HealthStore(dir); await a.load()
        a.recordSwitch('a', 'b'); await a.flush()
        const original = JSON.stringify({ schemaVersion: version, models: {}, providers: {}, endpoints: {}, updatedAt: 0 })
        await writeFile(a.file, original)
        assert.equal(await (all ? a.reactivateAll() : a.reactivate(model)), false)
        assert.equal(await readFile(a.file, 'utf8'), original)
        assert.match(await readFile(join(dir, 'ccswitch-auto-switch.log'), 'utf8'), /reactivat.*refused/i)
      } finally { await rm(dir, { recursive: true, force: true }) }
    })
  }
}
