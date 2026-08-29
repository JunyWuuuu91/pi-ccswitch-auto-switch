import type { FailureClass, FailureObservation, HealthScope } from './types.ts'

export interface Classification {
  kind: FailureClass
  scope?: HealthScope
  roundOnly: boolean
  retryAfterMs?: number
}

const content = /content[ _-]?filter|sensitive|guardrail|policy[_ ]?violation|content[_ ]?blocked/i
const quota = /quota|billing|insufficient.?balance|out of budget|usage.?limit|credit.?balance|monthly.?limit/i
const context = /context.?window|context.?length|too many tokens|prompt is too long|input is too long|token limit/i
const transport = /dns|enotfound|eai_again|socket|connection|network|fetch failed|timed? ?out|timeout|stream ended|terminated|websocket/i

export function classifyFailure(observation: FailureObservation): Classification {
  const text = `${observation.rawStopReason ?? ''} ${observation.message ?? ''}`
  const status = observation.status
  if (observation.aborted && !observation.watchdog) return { kind: 'unknown', roundOnly: true }
  if (observation.watchdog) return { kind: 'timeout', scope: 'endpoint', roundOnly: false }
  if (content.test(text)) return { kind: 'content_policy', roundOnly: true }
  if (context.test(text)) return { kind: 'context_overflow', roundOnly: true }
  if (status === 429) return { kind: 'rate_limit', scope: 'provider', roundOnly: false, retryAfterMs: observation.retryAfterMs }
  if (status === 401 || status === 403) return { kind: 'auth', scope: 'provider', roundOnly: false }
  if (quota.test(text)) return { kind: 'quota', scope: 'provider', roundOnly: false }
  if (status !== undefined && status >= 500) return { kind: 'endpoint', scope: 'endpoint', roundOnly: false }
  if (status === 400 || status === 404 || status === 422) return { kind: 'model_config', scope: 'model', roundOnly: false }
  if (transport.test(text)) return { kind: 'endpoint', scope: 'endpoint', roundOnly: false }
  return { kind: 'unknown', scope: 'model', roundOnly: false }
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}
