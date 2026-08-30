import type { FailureClass, ModelRef, ScopedModel } from './types.ts'
import { endpointKey, modelKey, type HealthState } from './health.ts'

export interface CandidateOptions {
  current?: ModelRef
  tried: Set<string>
  failureKind?: FailureClass
  health: HealthState
  avoidEndpoints?: Set<string>
  /** 模型系列已被证实存在内容审查约束时，本轮不再选择该系列。 */
  avoidFamilies?: ReadonlySet<string>
  /** 本轮输入真正需要的模态；显式声明不支持的候选会被排除。 */
  requiredInputs?: readonly string[]
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
    if (options.avoidEndpoints?.has(endpointKey(model))) return false
    if (options.avoidFamilies?.has(modelFamily(model))) return false
    if (!supportsRequiredInputs(model, options.requiredInputs)) return false
    if (options.failureKind === 'context_overflow' && current && (model.contextWindow ?? 0) <= (current.contextWindow ?? 0)) return false
    return true
  })
  return candidates.sort((a, b) => score(a, current, options.health) - score(b, current, options.health))[0]
}

/**
 * 返回跨 Provider 稳定的模型系列标识。内容审查通常是模型系列的能力约束，而不是某个 API Key
 * 或单一部署的瞬时故障，因此已知系列使用显式规则；未知模型则保守地按版本号前的 id 归组。
 */
export function modelFamily(model: Pick<ModelRef, 'id' | 'name'>): string {
  const identity = `${model.id} ${model.name ?? ''}`.toLowerCase()
  const knownFamilies: Array<[string, RegExp]> = [
    ['glm', /(?:^|[^a-z0-9])(?:chat)?glm(?:$|[^a-z])/],
    ['qwen', /(?:^|[^a-z0-9])qwen(?:$|[^a-z])/],
    ['deepseek', /(?:^|[^a-z0-9])deepseek(?:$|[^a-z])/],
    ['kimi', /(?:^|[^a-z0-9])(?:kimi|moonshot)(?:$|[^a-z])/],
    ['gpt', /(?:^|[^a-z0-9])gpt(?:$|[^a-z])/],
    ['claude', /(?:^|[^a-z0-9])claude(?:$|[^a-z])/],
    ['gemini', /(?:^|[^a-z0-9])gemini(?:$|[^a-z])/],
    ['llama', /(?:^|[^a-z0-9])llama(?:$|[^a-z])/],
    ['mistral', /(?:^|[^a-z0-9])mistral(?:$|[^a-z])/],
    ['minimax', /(?:^|[^a-z0-9])minimax(?:$|[^a-z])/],
    ['ernie', /(?:^|[^a-z0-9])ernie(?:$|[^a-z])/],
    ['doubao', /(?:^|[^a-z0-9])doubao(?:$|[^a-z])/],
    ['hunyuan', /(?:^|[^a-z0-9])hunyuan(?:$|[^a-z])/],
  ]
  for (const [family, pattern] of knownFamilies) if (pattern.test(identity)) return family

  const leaf = model.id.toLowerCase().split('/').pop() ?? model.id.toLowerCase()
  return leaf
    .replace(/(?:[-_.]v)?\d+(?:[.-]\d+)*(?:[-_.].*)?$/, '')
    .replace(/[-_.:]+$/, '') || leaf
}

function supportsRequiredInputs(candidate: ModelRef, required: readonly string[] | undefined): boolean {
  if (!required?.length || !candidate.input?.length) return true
  return required.every(input => candidate.input!.includes(input))
}

function score(candidate: ModelRef, current: ModelRef | undefined, health: HealthState): number {
  if (!current) return 0
  // 排序优先级：故障域多样性 > 原模型等价性 > 输入/推理/上下文兼容性 > 历史稳定性。
  // 硬约束（冷却、审查系列、输入模态、上下文溢出）已在上方 filter 中处理。
  const sameProvider = candidate.provider === current.provider ? 1000 : 0
  const differentId = candidate.id === current.id ? 0 : 100
  const inputMismatch = sameInputs(candidate, current) ? 0 : 20
  const reasoningMismatch = candidate.reasoning === current.reasoning ? 0 : 10
  const contextPenalty = (candidate.contextWindow ?? 0) < (current.contextWindow ?? 0) ? 5 : 0
  const records = [health.models[modelKey(candidate)], health.providers[candidate.provider], health.endpoints[endpointKey(candidate)]]
  const historicalPenalty = Math.min(80, records.reduce((sum, record) => sum + Math.log2((record?.totalFailures ?? 0) + 1) * 4, 0))
  return sameProvider + differentId + inputMismatch + reasoningMismatch + contextPenalty + historicalPenalty
}

function sameInputs(a: ModelRef, b: ModelRef): boolean {
  const left = a.input ?? []
  const right = b.input ?? []
  return left.length === right.length && left.every(input => right.includes(input))
}
