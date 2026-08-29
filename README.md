# Pi CCSwitch Auto Switch

> 中文说明：[README.zh-CN.md](README.zh-CN.md)

Resilient model failover for [Pi](https://github.com/badlogic/pi-mono) when its providers are managed by [CC Switch](https://ccswitch.io/).

The extension observes real Pi requests, records sanitized health signals, and—only in interactive TUI/RPC sessions—moves a failed request to a healthy model. It treats provider failures as provider failures: an exhausted balance, invalid credentials, or rate limit will not cause a rapid series of retries against sibling models from the same provider.

## Features

- Uses Pi's effective model registry; never reads CC Switch databases, Pi auth files, or API keys.
- Provider-first circuit breakers for authentication, quota, billing, and rate-limit failures.
- Endpoint circuit breakers for DNS, connection, server, and streaming failures.
- Model-only isolation for missing models and incompatible parameters.
- Prefers a healthy model from another provider before considering a sibling model.
- 90-second first-response and 120-second streaming-idle watchdogs.
- Exponential cooldowns, `Retry-After` support, and one persisted half-open probe lease per provider.
- Persistent, atomic, cross-process health state with error redaction and bounded logs.
- Compact Pi status bar and interactive health panel.
- Non-interactive `--print` / JSON runs monitor and record failures but do not inject a competing retry.

## Requirements

- Pi `0.84.4` or newer.
- CC Switch `3.20+` is recommended for its native Pi model configuration support.
- Node.js `22.19+` only for local development and tests. Pi supplies the runtime for the extension itself.

## Installation

### Pi package install (recommended)

```bash
pi install git:github.com/JunyWuuuu91/pi-ccswitch-auto-switch
```

This works on macOS, Linux, and Windows when Git is available. After the npm release, this will also work:

```bash
pi install npm:pi-ccswitch-auto-switch
```

Restart Pi or run `/reload` after installing or updating. To update the Git installation later, run `pi update --extensions`.

CC Switch should be configured normally. This extension deliberately does not write Pi model settings or CC Switch data.

## Commands

| Command | What it does |
| --- | --- |
| `/ccswitch` or `/ccswitch status` | Open the health panel. |
| `/ccswitch help` | Show the command reference in Pi. |
| `/ccswitch refresh` | Refresh Pi's model registry and the status display. |
| `/ccswitch reactivate <provider/model\|all>` | Clear a breaker and let the next real request verify recovery, while preserving history. |
| `/ccswitch disable <provider/model>` | Manually exclude a model from failover. |
| `/ccswitch reset <provider/model\|all>` | Delete selected health history after confirmation. |
| `/ccswitch-test` | Inspect candidate discovery without changing models. |

Examples:

```text
/ccswitch reactivate all
/ccswitch disable openai/gpt-4.1
/ccswitch reset anthropic/claude-sonnet-4
```

## Status bar

```text
CCS ✓70/131 · ⏳61 · ⛔0
```

- `✓70/131`: 70 healthy models out of 131 unique `provider/model` combinations in Pi's effective scope. Duplicate scoped entries are counted once.
- `⏳61`: 61 models are currently affected by automatic model, provider, or endpoint cooldowns. One provider breaker can account for many affected models.
- `⛔0`: no manually disabled models.
- During a switch, `CCS ↻2/5 provider/model` means the second of at most five attempts is being made.

When all unique models are healthy, the compact form is `CCS ✓131`. Use `/ccswitch` or `/ccswitch-test` to see Pi's raw scope entry count, the deduplicated model count, affected model counts, and the underlying breaker-record count.

## Failover behavior

The state machine waits for Pi's native retry cycle to settle before switching. A user message invalidates any pending switch from an older round, avoiding duplicate dispatches.

| Failure | Scope | Initial cooldown |
| --- | --- | --- |
| `401`, `403`, quota, billing | Provider | 30 minutes |
| `429` | Provider | `Retry-After` when present; otherwise 5 minutes |
| DNS, network, `5xx`, interrupted stream | Endpoint | 2 minutes |
| `404`, invalid model, incompatible parameters | Model | 15 minutes |
| Content filtering or context overflow | Current round only | None |

Cooldowns grow exponentially within bounded limits. Context-overflow retries only consider models with a larger context window. User cancellations are not recorded as failures; watchdog cancellations are recorded as timeouts.

## Data and privacy

Health state is stored in Pi's agent directory as `ccswitch-auto-switch-state.json`. The extension stores counters, timestamps, cooldowns, and redacted/truncated error summaries. It does not access credentials, authorization headers, CC Switch's database, or Pi's `auth.json`.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests use Node's built-in test runner and cover failure classification, provider-first selection, cooldowns, state persistence, and Windows-compatible paths.

## License

[MIT](LICENSE)
