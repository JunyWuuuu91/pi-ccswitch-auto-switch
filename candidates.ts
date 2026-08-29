import type { ModelRef, ScopedModel } from './types.ts'
import { endpointKey, modelKey, type HealthState } from './health.ts'

export interface CandidateOptions {
  current?: ModelRef
  tried: Set<string>
  failureKind?: string
  health: HealthState
}

export interface CandidateSnapshot {
  models: ModelRef[]
  source: 'scoped' | 'available'
  sourceEntries: number
}

export interface CandidateHealthSummary {
  total: number
  healthy: number
  cooling: number
  disabled: number
  breakerRecords: number
}

function activeCooldown(record: HealthState['models'][string] | undefined, now: number): boolean {
  return Boolean((record?.cooldownUntil && record.cooldownUntil > now) || (record?.leaseUntil && record.leaseUntil > now))
}

function blocked(model: ModelRef, health: HealthState, now = Date.now()): boolean {
  const records = [health.models[modelKey(model)], health.providers[model.provider], health.endpoints[endpointKey(model)]]
  return records.some(record => Boolean(record?.disabled || (record?.cooldownUntil && record.cooldownUntil > now) || (record?.leaseUntil && record.leaseUntil > now)))
}

export function effectiveCandidates(scoped: readonly ScopedModel[], available: ModelRef[]): ModelRef[] {
  const source = scoped.length > 0 ? scoped.map(item => item.model) : available
  const seen = new Set<string>()
  return source.filter(model => {
    const key = modelKey(model)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function candidateSnapshot(scoped: readonly ScopedModel[], available: ModelRef[]): CandidateSnapshot {
  const source = scoped.length > 0 ? 'scoped' : 'available'
  return {
    models: effectiveCandidates(scoped, available),
    source,
    sourceEntries: source === 'scoped' ? scoped.length : available.length,
  }
}

export function summarizeCandidateHealth(models: ModelRef[], health: HealthState, now = Date.now()): CandidateHealthSummary {
  let healthy = 0
  let cooling = 0
  let disabled = 0
  for (const model of models) {
    const modelRecord = health.models[modelKey(model)]
    if (modelRecord?.disabled) {
      disabled += 1
      continue
    }
    const records = [modelRecord, health.providers[model.provider], health.endpoints[endpointKey(model)]]
    if (records.some(record => activeCooldown(record, now))) cooling += 1
    else healthy += 1
  }
  const breakerRecords = [...Object.values(health.models), ...Object.values(health.providers), ...Object.values(health.endpoints)]
    .filter(record => activeCooldown(record, now)).length
  return { total: models.length, healthy, cooling, disabled, breakerRecords }
}

export function chooseCandidate(models: ModelRef[], options: CandidateOptions): ModelRef | undefined {
  const current = options.current
  const candidates = models.filter(model => {
    if (options.tried.has(modelKey(model)) || blocked(model, options.health)) return false
    if (options.failureKind === 'context_overflow' && current && (model.contextWindow ?? 0) <= (current.contextWindow ?? 0)) return false
    return true
  })
  return candidates.sort((a, b) => score(a, current) - score(b, current))[0]
}

function score(candidate: ModelRef, current?: ModelRef): number {
  if (!current) return 0
  const sameProvider = candidate.provider === current.provider ? 1000 : 0
  const differentId = candidate.id === current.id ? 0 : 100
  const inputMismatch = sameInputs(candidate, current) ? 0 : 20
  const reasoningMismatch = candidate.reasoning === current.reasoning ? 0 : 10
  const contextPenalty = (candidate.contextWindow ?? 0) < (current.contextWindow ?? 0) ? 5 : 0
  return sameProvider + differentId + inputMismatch + reasoningMismatch + contextPenalty
}

function sameInputs(a: ModelRef, b: ModelRef): boolean {
  return (a.input ?? []).join(',') === (b.input ?? []).join(',')
}
