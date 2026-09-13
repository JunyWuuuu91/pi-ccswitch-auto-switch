import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FailureClass, HealthScope, ModelRef } from './types.ts'

const STATE_FILE = 'ccswitch-auto-switch-state.json'
const LEGACY_FILE = 'ccswitch-cooldown.json'
const LOCK_DIR = '.ccswitch-auto-switch.lock'
const LOG_FILE = 'ccswitch-auto-switch.log'
const REPORT_FILE = 'ccswitch-failure-report.md'
const MAX_LOG_BYTES = 512 * 1024

export interface HealthRecord {
  consecutiveFailures: number
  totalFailures: number
  /** Per-writer grow-only counters; legacy totals form one shared baseline. */
  failureCounts?: Record<string, number>
  lastFailureAt?: number
  lastSuccessAt?: number
  cooldownUntil?: number
  lastClass?: FailureClass
  lastError?: string
  disabled?: boolean
  disabledUpdatedAt?: number
  leaseUntil?: number
}

export interface ContentPolicyConstraint {
  observations: number
  lastObservedAt: number
  avoidUntil: number
  lastModel: string
  lastError?: string
}

export interface HealthState {
  schemaVersion: 2 | 3
  updatedAt: number
  /** Reset barriers prevent older snapshots from resurrecting cleared history. */
  resetAt?: number
  modelResetAt?: Record<string, number>
  models: Record<string, HealthRecord>
  providers: Record<string, HealthRecord>
  endpoints: Record<string, HealthRecord>
  /**
   * Legacy schema-2 field: ignored on load and removed on the next write.
   * Active policy constraints live only in the owning HealthStore instance.
   */
  contentPolicyFamilies?: Record<string, ContentPolicyConstraint>
  /** 累计成功切换次数（跨 session 持久化，用于衡量扩展有效程度） */
  switches?: number
  switchCounts?: Record<string, number>
  /** 最近成功切换日志（有限条，环形保留） */
  switchLog?: Array<{
    at: number
    from: string
    to: string
    reason?: string
  }>
}

export function agentDir(env = process.env, home = homedir()): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(home, '.pi', 'agent')
}

export function modelKey(model: Pick<ModelRef, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

export function endpointKey(model: ModelRef): string {
  const source = model.baseUrl ? safeEndpoint(model.baseUrl) : `provider:${model.provider}`
  return createHash('sha256').update(`${model.provider}\0${source}`).digest('hex').slice(0, 20)
}

/**
 * 同平台标识：仅按 BaseURL 归组（不含 provider 名）。b-ai / b-ai-copy / b-ai-copy-copy 这类
 * 同一上游平台的多个 provider 副本会得到相同 key，用于本轮内同平台隔离。
 * 注意：与 endpointKey（含 provider，用于跨轮健康台账）刻意不同——不同的 API key
 * 有独立的配额/限流，跨轮冷却不应互相波及。
 */
export function platformKey(model: ModelRef): string {
  return model.baseUrl ? safeEndpoint(model.baseUrl) : `provider:${model.provider}`
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return value.slice(0, 256)
  }
}

function blank(): HealthState {
  return { schemaVersion: 3, updatedAt: Date.now(), models: {}, providers: {}, endpoints: {}, switches: 0, switchLog: [] }
}

function redact(text: string | undefined): string | undefined {
  if (!text) return undefined
  return text
    .replace(/(authorization\s*[:=]\s*)(\S+)/gi, '$1[redacted]')
    .replace(/(bearer\s+)(\S+)/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|api[_-]?key|signature)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 240)
}

function cooldownMs(kind: FailureClass, failures: number, retryAfterMs?: number): number {
  const factor = 2 ** Math.max(0, failures - 1)
  if (kind === 'rate_limit') return Math.min(24 * 60 * 60_000, Math.max(retryAfterMs ?? 0, 5 * 60_000 * factor))
  if (kind === 'auth' || kind === 'quota') return Math.min(6 * 60 * 60_000, 30 * 60_000 * factor)
  if (kind === 'model_config') return Math.min(2 * 60 * 60_000, 15 * 60_000 * factor)
  return Math.min(30 * 60_000, 2 * 60_000 * factor)
}

export class HealthStore {
  readonly dir: string
  private state: HealthState = blank()
  private dirty = false
  private readonly writer = randomUUID()
  private manualClock = 0
  private writeBlocked = false
  private observedSchema3 = false
  private constraints: Record<string, ContentPolicyConstraint> = {}

  constructor(dir = agentDir()) { this.dir = dir }
  get file(): string { return join(this.dir, STATE_FILE) }
  get snapshot(): HealthState { return structuredClone(this.state) }
  get policyConstraints(): Record<string, ContentPolicyConstraint> { return structuredClone(this.constraints) }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      this.state = await this.readDisk()
      this.writeBlocked = false
      delete this.state.contentPolicyFamilies
      if (!existsSync(this.file)) await this.migrateLegacy()
    } catch (error) {
      // Unknown/newer formats are not corruption. Keep the original in place
      // and fail closed until an explicit successful reload repairs the state.
      this.writeBlocked = true
      await this.log(`health state load refused: ${String(error)}`)
    }
  }

  private async migrateLegacy(): Promise<void> {
    const legacy = join(this.dir, LEGACY_FILE)
    if (!existsSync(legacy)) return
    try {
      const entries = JSON.parse(await readFile(legacy, 'utf8')) as Record<string, { failedAt?: number, reason?: string, errorMessage?: string }>
      for (const [key, entry] of Object.entries(entries)) {
        this.state.models[key] = {
          consecutiveFailures: 1, totalFailures: 1, lastFailureAt: entry.failedAt,
          cooldownUntil: (entry.failedAt ?? Date.now()) + 60 * 60_000,
          lastClass: entry.reason === 'sensitive' ? 'content_policy' : 'unknown', lastError: redact(entry.errorMessage),
        }
      }
      this.dirty = true
      await this.flush()
    } catch { /* legacy data is optional */ }
  }

  recordFailure(scope: HealthScope, key: string, kind: FailureClass, message?: string, retryAfterMs?: number): void {
    const bucket = this.bucket(scope)
    const previous = bucket[key] ?? { consecutiveFailures: 0, totalFailures: 0 }
    const failures = previous.consecutiveFailures + 1
    bucket[key] = {
      ...previous, consecutiveFailures: failures, totalFailures: previous.totalFailures + 1,
      failureCounts: incrementCounts(previous.failureCounts, previous.totalFailures, this.writer),
      lastFailureAt: Date.now(), cooldownUntil: Date.now() + cooldownMs(kind, failures, retryAfterMs),
      lastClass: kind, lastError: redact(message), leaseUntil: undefined,
    }
    this.touch()
  }

  /**
   * 内容审查约束是当前 session 的观测，按 session 隔离：新 session 可能处理
   * 不涉及审查内容的任务，因此约束在 session_start 时清除，不跨 session 继承；
   * 本 session 内再次观察到同系列审查会增加证据计数并刷新时间戳。
   */
  recordContentPolicyConstraint(family: string, model: ModelRef, message?: string): void {
    const constraints = this.constraints
    const previous = constraints[family]
    const now = Date.now()
    constraints[family] = {
      observations: (previous?.observations ?? 0) + 1,
      lastObservedAt: now,
      avoidUntil: now + 30 * 24 * 60 * 60_000,
      lastModel: modelKey(model),
      lastError: redact(message),
    }
  }

  recordSuccess(model: ModelRef): void {
    this.close('model', modelKey(model))
    this.close('provider', model.provider)
    this.close('endpoint', endpointKey(model))
    this.touch()
  }

  /**
   * 记录一次成功的模型切换：累计计数 + 环形保留最近 20 条切换日志。
   * 用于衡量扩展有效程度，并在 /ccswitch status 面板展示。
   */
  recordSwitch(from: string, to: string, reason?: string): void {
    this.state.switchCounts = incrementCounts(this.state.switchCounts, this.state.switches ?? 0, this.writer)
    this.state.switches = (this.state.switches ?? 0) + 1
    const log = this.state.switchLog ?? []
    log.push({ at: Date.now(), from, to, reason })
    this.state.switchLog = log.slice(-20)
    this.touch()
  }

  private close(scope: HealthScope, key: string): void {
    const current = this.bucket(scope)[key]
    if (!current) return
    this.bucket(scope)[key] = { ...current, consecutiveFailures: 0, cooldownUntil: undefined, leaseUntil: undefined, lastSuccessAt: Date.now() }
  }

  disable(key: string, disabled: boolean): void {
    const old = this.state.models[key] ?? { consecutiveFailures: 0, totalFailures: 0 }
    this.state.models[key] = { ...old, disabled, disabledUpdatedAt: this.manualVersion() }
    this.touch()
  }

  async reactivate(model: ModelRef): Promise<boolean> {
    return this.reactivateAtomically(model)
  }

  async reactivateAll(): Promise<boolean> {
    return this.reactivateAtomically()
  }

  private async reactivateAtomically(model?: ModelRef): Promise<boolean> {
    try {
      if (this.writeBlocked) throw new Error('health state writes are blocked; reload a supported state first')
      return await this.withLock(async () => {
        this.state = mergeState(await this.readDisk(), this.state)
        const disabledUpdatedAt = this.manualVersion()
        const targets: Array<[HealthScope, string]> = model
          ? [['model', modelKey(model)], ['provider', model.provider], ['endpoint', endpointKey(model)]]
          : (['model', 'provider', 'endpoint'] as const).flatMap(scope => Object.keys(this.bucket(scope)).map(key => [scope, key] as [HealthScope, string]))
        for (const [scope, key] of targets) {
          const old = this.bucket(scope)[key]
          if (!old) continue
          this.bucket(scope)[key] = { ...old, disabled: false, disabledUpdatedAt,
            cooldownUntil: undefined, leaseUntil: undefined, consecutiveFailures: 0,
            lastSuccessAt: Math.max(Date.now(), (old.lastFailureAt ?? 0) + 1) }
        }
        this.touch()
        await this.commit()
        return true
      })
    } catch (error) {
      await this.log(`reactivation refused: ${String(error)}`)
      return false
    }
  }

  reset(target: string | 'all'): void {
    const resetAt = this.manualVersion()
    if (target === 'all') {
      this.clearContentPolicyConstraints()
      this.state = { ...blank(), resetAt }
    } else {
      delete this.state.models[target]
      const resets = this.state.modelResetAt ??= {}
      resets[target] = resetAt
    }
    this.touch()
  }

  /**
   * 清除已学习的模型系列内容审查约束。新 session 可能处理不同任务，不假设
   * 对审查内容敏感，因此不在 session 间继承审查约束。
   */
  clearContentPolicyConstraints(): void {
    this.constraints = {}
  }

  isBlocked(model: ModelRef, now = Date.now()): boolean {
    if (this.writeBlocked) return true
    return [this.state.models[modelKey(model)], this.state.providers[model.provider], this.state.endpoints[endpointKey(model)]]
      .some(record => Boolean(record?.disabled || (record?.cooldownUntil && record.cooldownUntil > now) || (record?.leaseUntil && record.leaseUntil > now)))
  }

  async claimCandidate(model: ModelRef): Promise<boolean> {
    if (this.writeBlocked) return false
    let claimed = false
    await this.withLock(async () => {
      const disk = await this.readDisk()
      this.state = mergeState(disk, this.state)
      const records = (state: HealthState) => [state.models[modelKey(model)], state.providers[model.provider], state.endpoints[endpointKey(model)]]
      const now = Date.now()
      // Check disk as well: a stale local disabled flag must never override a
      // disable written by another process before this atomic claim.
      if ([...records(disk), ...records(this.state)].some(record => record?.disabled || (record?.cooldownUntil ?? 0) > now || (record?.leaseUntil ?? 0) > now)) return
      const expired = records(this.state).filter(record => record?.cooldownUntil !== undefined && record.cooldownUntil <= now)
      if (expired.length) {
        for (const record of expired) record!.leaseUntil = now + 2 * 60_000
        this.touch()
        await this.commit()
      }
      claimed = true
    }).catch(async error => { claimed = false; await this.log(`candidate claim refused: ${String(error)}`) })
    return claimed
  }

  async flush(): Promise<void> {
    if (!this.dirty || this.writeBlocked) return
    await this.withLock(async () => {
      // Even reset-all must validate the on-disk schema before writing.
      this.state = mergeState(await this.readDisk(), this.state)
      await this.commit()
    }).catch(async error => { await this.log(`health state flush refused: ${String(error)}`) })
  }

  async log(line: string): Promise<void> {
    const path = join(this.dir, LOG_FILE)
    try {
      if (existsSync(path) && (await stat(path)).size > MAX_LOG_BYTES) {
        await rm(`${path}.3`, { force: true })
        await rename(`${path}.2`, `${path}.3`).catch(() => {})
        await rename(`${path}.1`, `${path}.2`).catch(() => {})
        await rename(path, `${path}.1`)
      }
      await appendFile(path, `[${new Date().toISOString()}] ${redact(line) ?? ''}\n`, 'utf8')
    } catch { /* logging must never affect Pi */ }
  }

  async report(markdown: string): Promise<void> {
    const safe = markdown.split('\n').map(line => redact(line) ?? '').join('\n')
    await writeFile(join(this.dir, REPORT_FILE), safe, 'utf8').catch(() => {})
  }

  private touch(): void { this.dirty = true }
  private async readDisk(): Promise<HealthState> {
    try {
      let raw: string
      try { raw = await readFile(this.file, 'utf8') }
      catch (error: any) { if (error?.code === 'ENOENT') return blank(); throw error }
      const parsed = JSON.parse(raw) as HealthState
      if (!parsed || (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3)) throw new Error(`unsupported state schema: ${parsed?.schemaVersion}`)
      if (this.observedSchema3 && parsed.schemaVersion === 2) throw new Error('unsupported state schema downgrade: 3 -> 2; stop all old Pi processes')
      if (!parsed.models || !parsed.providers || !parsed.endpoints) throw new Error('invalid health state buckets')
      this.observedSchema3 ||= parsed.schemaVersion === 3
      return parsed
    } catch (error) {
      this.writeBlocked = true
      throw error
    }
  }

  private manualVersion(): number {
    const records = [...Object.values(this.state.models), ...Object.values(this.state.providers), ...Object.values(this.state.endpoints)]
    this.manualClock = Math.max(Date.now(), this.manualClock + 1, (this.state.resetAt ?? 0) + 1,
      ...Object.values(this.state.modelResetAt ?? {}).map(at => at + 1),
      ...records.map(record => (record.disabledUpdatedAt ?? 0) + 1))
    return this.manualClock
  }

  private async commit(): Promise<void> {
    if (this.writeBlocked) throw new Error("health state writes are blocked; reload a supported state first")
    this.state.schemaVersion = 3
    delete this.state.contentPolicyFamilies
    this.state.updatedAt = Date.now()
    const temp = `${this.file}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8')
    await rename(temp, this.file)
    this.observedSchema3 = true
    this.dirty = false
  }
  private bucket(scope: HealthScope): Record<string, HealthRecord> {
    return scope === 'model' ? this.state.models : scope === 'provider' ? this.state.providers : this.state.endpoints
  }
  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const lock = join(this.dir, LOCK_DIR)
    const deadline = Date.now() + 750
    while (true) {
      try {
        await mkdir(lock)
        try { return await work() } finally { await rm(lock, { recursive: true, force: true }) }
      } catch (error: any) {
        if (error?.code !== 'EEXIST' || Date.now() >= deadline) throw error
        try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true }) } catch { /* another process won */ }
        await new Promise(resolve => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)))
      }
    }
  }
}

function mergeRecord(a: HealthRecord | undefined, b: HealthRecord | undefined): HealthRecord | undefined {
  if (!a) return b
  if (!b) return a
  const newest = (b.lastFailureAt ?? 0) >= (a.lastFailureAt ?? 0) ? b : a
  const lastFailureAt = Math.max(a.lastFailureAt ?? 0, b.lastFailureAt ?? 0)
  const lastSuccessAt = Math.max(a.lastSuccessAt ?? 0, b.lastSuccessAt ?? 0)
  const successWins = lastSuccessAt > lastFailureAt
  const failureCounts = mergeCounts(a.failureCounts, a.totalFailures, b.failureCounts, b.totalFailures)
  return {
    ...newest,
    totalFailures: sumCounts(failureCounts),
    failureCounts,
    disabled: (a.disabledUpdatedAt ?? 0) === (b.disabledUpdatedAt ?? 0)
      ? (a.disabled === true || b.disabled === true ? true : b.disabled ?? a.disabled)
      : (a.disabledUpdatedAt ?? 0) > (b.disabledUpdatedAt ?? 0) ? a.disabled : b.disabled,
    disabledUpdatedAt: Math.max(a.disabledUpdatedAt ?? 0, b.disabledUpdatedAt ?? 0) || undefined,
    lastFailureAt: lastFailureAt || undefined,
    lastSuccessAt: lastSuccessAt || undefined,
    consecutiveFailures: successWins ? 0 : Math.max(a.consecutiveFailures, b.consecutiveFailures),
    cooldownUntil: successWins ? undefined : Math.max(a.cooldownUntil ?? 0, b.cooldownUntil ?? 0) || undefined,
    leaseUntil: successWins ? undefined : Math.max(a.leaseUntil ?? 0, b.leaseUntil ?? 0) || undefined,
  }
}

function mergeBucket(a: Record<string, HealthRecord>, b: Record<string, HealthRecord>): Record<string, HealthRecord> {
  const output: Record<string, HealthRecord> = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const record = mergeRecord(a[key], b[key])
    if (record) output[key] = record
  }
  return output
}

function mergeState(a: HealthState, b: HealthState): HealthState {
  const resetAt = Math.max(a.resetAt ?? 0, b.resetAt ?? 0)
  a = afterGlobalReset(a, resetAt)
  b = afterGlobalReset(b, resetAt)
  const modelResetAt = { ...a.modelResetAt }
  for (const [key, at] of Object.entries(b.modelResetAt ?? {})) modelResetAt[key] = Math.max(modelResetAt[key] ?? 0, at)
  const models = mergeBucket(a.models, b.models)
  for (const [key, at] of Object.entries(modelResetAt)) {
    const record = mergeRecord(afterReset(a.models[key], a.modelResetAt?.[key] ?? 0, at), afterReset(b.models[key], b.modelResetAt?.[key] ?? 0, at))
    if (record) models[key] = record
    else delete models[key]
  }
  const switchCounts = mergeCounts(a.switchCounts, a.switches ?? 0, b.switchCounts, b.switches ?? 0)
  const switches = sumCounts(switchCounts)
  // 取最近更新的 switchLog（按 at 去倒序合并，保留最新 20 条）
  const log = [...(a.switchLog ?? []), ...(b.switchLog ?? [])]
    .sort((x, y) => y.at - x.at)
    .filter((entry, index, all) => index === 0 || all[index - 1].at !== entry.at || all[index - 1].from !== entry.from || all[index - 1].to !== entry.to)
    .slice(0, 20)
  return { schemaVersion: 3, resetAt: resetAt || undefined, modelResetAt, updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0), models, providers: mergeBucket(a.providers ?? {}, b.providers ?? {}), endpoints: mergeBucket(a.endpoints ?? {}, b.endpoints ?? {}), switchCounts, switches, switchLog: log }
}

// Each store increments only its own component. Merging the same state twice is
// idempotent; independent increments add without inflating the backoff streak.
function mergeCounts(a: Record<string, number> | undefined, aTotal: number, b: Record<string, number> | undefined, bTotal: number): Record<string, number> {
  const left = a ?? { legacy: aTotal }, right = b ?? { legacy: bTotal }
  const result = { ...left }
  for (const [writer, count] of Object.entries(right)) result[writer] = Math.max(result[writer] ?? 0, count)
  return result
}
function incrementCounts(counts: Record<string, number> | undefined, total: number, writer: string): Record<string, number> {
  const next = { ...(counts ?? { legacy: total }) }
  next[writer] = (next[writer] ?? 0) + 1
  return next
}
function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

function afterReset(record: HealthRecord | undefined, sourceResetAt: number, resetAt: number): HealthRecord | undefined {
  if (sourceResetAt >= resetAt || !record) return record
  // A manual operation newer than the reset survives, but old health history
  // does not. Legacy records have timestamp zero and cannot beat a reset.
  if ((record.disabledUpdatedAt ?? 0) > resetAt) return { consecutiveFailures: 0, totalFailures: 0, disabled: record.disabled, disabledUpdatedAt: record.disabledUpdatedAt }
  return undefined
}
function afterGlobalReset(state: HealthState, resetAt: number): HealthState {
  if ((state.resetAt ?? 0) >= resetAt) return state
  const clean = { ...blank(), resetAt }
  for (const scope of ['models', 'providers', 'endpoints'] as const) {
    for (const [key, record] of Object.entries(state[scope])) {
      const kept = afterReset(record, state.resetAt ?? 0, resetAt)
      if (kept) clean[scope][key] = kept
    }
  }
  return clean
}
