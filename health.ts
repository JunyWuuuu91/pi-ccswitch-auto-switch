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
  lastFailureAt?: number
  lastSuccessAt?: number
  cooldownUntil?: number
  lastClass?: FailureClass
  lastError?: string
  disabled?: boolean
  leaseUntil?: number
}

export interface HealthState {
  schemaVersion: 2
  updatedAt: number
  models: Record<string, HealthRecord>
  providers: Record<string, HealthRecord>
  endpoints: Record<string, HealthRecord>
  /** 累计成功切换次数（跨 session 持久化，用于衡量扩展有效程度） */
  switches?: number
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

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return value.slice(0, 256)
  }
}

function blank(): HealthState {
  return { schemaVersion: 2, updatedAt: Date.now(), models: {}, providers: {}, endpoints: {}, switches: 0, switchLog: [] }
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
  private replaceOnFlush = false

  constructor(dir = agentDir()) { this.dir = dir }
  get file(): string { return join(this.dir, STATE_FILE) }
  get snapshot(): HealthState { return structuredClone(this.state) }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(await readFile(this.file, 'utf8')) as HealthState
        if (parsed.schemaVersion !== 2 || !parsed.models || !parsed.providers || !parsed.endpoints) throw new Error('unsupported state schema')
        this.state = parsed
      } else {
        await this.migrateLegacy()
      }
    } catch {
      if (existsSync(this.file)) await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      this.state = blank()
      this.dirty = true
      await this.flush()
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
      lastFailureAt: Date.now(), cooldownUntil: Date.now() + cooldownMs(kind, failures, retryAfterMs),
      lastClass: kind, lastError: redact(message), leaseUntil: undefined,
    }
    this.touch()
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
    this.state.models[key] = { ...old, disabled }
    this.touch()
  }

  reactivate(model: ModelRef): void {
    const key = modelKey(model)
    for (const [scope, id] of [['model', key], ['provider', model.provider], ['endpoint', endpointKey(model)]] as const) {
      const old = this.bucket(scope)[id]
      if (old) this.bucket(scope)[id] = { ...old, disabled: false, cooldownUntil: undefined, leaseUntil: undefined, lastSuccessAt: Date.now(), consecutiveFailures: 0 }
    }
    this.touch()
  }

  reactivateAll(): void {
    const now = Date.now()
    for (const bucket of [this.state.models, this.state.providers, this.state.endpoints]) {
      for (const [key, old] of Object.entries(bucket)) bucket[key] = { ...old, disabled: false, cooldownUntil: undefined, leaseUntil: undefined, lastSuccessAt: now, consecutiveFailures: 0 }
    }
    this.touch()
  }

  reset(target: string | 'all'): void {
    if (target === 'all') this.state = blank()
    else delete this.state.models[target]
    this.replaceOnFlush = true
    this.touch()
  }

  isBlocked(model: ModelRef, now = Date.now()): boolean {
    return [this.state.models[modelKey(model)], this.state.providers[model.provider], this.state.endpoints[endpointKey(model)]]
      .some(record => Boolean(record?.disabled || (record?.cooldownUntil && record.cooldownUntil > now) || (record?.leaseUntil && record.leaseUntil > now)))
  }

  async claimProvider(model: ModelRef): Promise<boolean> {
    const key = model.provider
    let claimed = true
    await this.withLock(async () => {
      if (!this.replaceOnFlush) this.state = mergeState(await this.readDisk(), this.state)
      const record = this.state.providers[key]
      if (!record || !(record.cooldownUntil && record.cooldownUntil <= Date.now())) return
      if (record.leaseUntil && record.leaseUntil > Date.now()) { claimed = false; return }
      record.leaseUntil = Date.now() + 2 * 60_000
      this.touch()
      await this.commit()
    }).catch(() => { claimed = false })
    return claimed
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    await this.withLock(async () => {
      this.state = mergeState(await this.readDisk(), this.state)
      await this.commit()
    }).catch(() => {})
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
      if (!existsSync(this.file)) return blank()
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as HealthState
      return parsed.schemaVersion === 2 ? parsed : blank()
    } catch { return blank() }
  }
  private async commit(): Promise<void> {
    this.state.updatedAt = Date.now()
    const temp = `${this.file}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8')
    await rename(temp, this.file)
    this.dirty = false
    this.replaceOnFlush = false
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
  return {
    ...newest,
    totalFailures: Math.max(a.totalFailures, b.totalFailures),
    disabled: b.disabled ?? a.disabled,
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
  const switches = Math.max(a.switches ?? 0, b.switches ?? 0)
  // 取最近更新的 switchLog（按 at 去倒序合并，保留最新 20 条）
  const log = [...(a.switchLog ?? []), ...(b.switchLog ?? [])]
    .sort((x, y) => y.at - x.at)
    .filter((entry, index, all) => index === 0 || all[index - 1].at !== entry.at || all[index - 1].from !== entry.from || all[index - 1].to !== entry.to)
    .slice(0, 20)
  return { schemaVersion: 2, updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0), models: mergeBucket(a.models ?? {}, b.models ?? {}), providers: mergeBucket(a.providers ?? {}, b.providers ?? {}), endpoints: mergeBucket(a.endpoints ?? {}, b.endpoints ?? {}), switches, switchLog: log }
}
