import type { FailureClass, FailureObservation, HealthScope } from './types.ts'

export interface Classification {
  kind: FailureClass
  scope?: HealthScope
  roundOnly: boolean
  retryAfterMs?: number
}

const content = /content[ _-]?(?:filter|policy|blocked|moderation)|sensitive|guardrail|policy[_ -]?violation|responsibleai|safety[_ -]?(?:policy|filter|violation)|security[_ -]?policy|moderation[_ -]?(?:blocked|failed)|blocked by.{0,20}(?:policy|safety|moderation)|data[_ -]?inspection[_ -]?failed|内容(?:审查|审核|安全|违规|被拦截)|安全审核|安全(?:策略|风控).{0,12}(?:阻断|拦截|拒绝)|审核(?:未通过|不通过|失败)|敏感(?:内容|词|信息)?|政治敏感|涉政|不合规|违反.{0,12}(?:安全|政策|规定)/i
const quota = /quota|billing|insufficient.?balance|out of budget|usage.?limit|credit.?balance|monthly.?limit/i
const context = /context.?window|context.?length|too many tokens|prompt is too long|input is too long|token limit/i
const transport = /dns|enotfound|eai_again|econn(?:reset|refused|aborted)|epipe|socket|connection|network|fetch failed|tls|certificate|timed? ?out|timeout|stream ended|terminated|websocket|und_err/i
const overloaded = /overload|server busy|service unavailable|temporarily unavailable|capacity|upstream|bad gateway/i

export function classifyFailure(observation: FailureObservation): Classification {
  const text = `${observation.rawStopReason ?? ''} ${observation.message ?? ''}`
  const status = observation.status
  if (observation.aborted && !observation.watchdog) return { kind: 'unknown', roundOnly: true }
  if (observation.watchdog) return { kind: 'timeout', scope: 'endpoint', roundOnly: false }
  // 内容审查/敏感拦截属于该模型的失败：按 model 级记录并与冷却（2min×2ⁿ 上限 30min），
  // chooseCandidate 会排除后自动切换到其他模型，而不是同一内容原样重试到本轮上限。
  if (content.test(text)) return { kind: 'content_policy', scope: 'model', roundOnly: false }
  if (context.test(text)) return { kind: 'context_overflow', roundOnly: true }
  if (status === 413) return { kind: 'context_overflow', roundOnly: true }
  if (status === 429) return { kind: 'rate_limit', scope: 'provider', roundOnly: false, retryAfterMs: observation.retryAfterMs }
  if (status === 402) return { kind: 'quota', scope: 'provider', roundOnly: false }
  if (status === 401 || status === 403) return { kind: 'auth', scope: 'provider', roundOnly: false }
  if (quota.test(text)) return { kind: 'quota', scope: 'provider', roundOnly: false }
  if (status === 408) return { kind: 'timeout', scope: 'endpoint', roundOnly: false }
  if (status !== undefined && status >= 500) return { kind: 'endpoint', scope: 'endpoint', roundOnly: false }
  if (transport.test(text) || overloaded.test(text)) return { kind: 'endpoint', scope: 'endpoint', roundOnly: false }
  if (status === 400 || status === 404 || status === 422) return { kind: 'model_config', scope: 'model', roundOnly: false }
  return { kind: 'unknown', scope: 'model', roundOnly: false }
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}
