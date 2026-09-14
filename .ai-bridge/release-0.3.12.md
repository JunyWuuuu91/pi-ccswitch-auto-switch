Fixes failover image requirements across retries, atomic model/provider/endpoint claims and recovery, concurrent health counters, session-local policy constraints, and 403 quota classification. Includes native TypeScript test support and 87 passing tests.

State schema 3 loads schema 2 but old releases cannot safely share the state directory with this release. Before upgrading, stop every old Pi process and scheduled runner using the same PI_CODING_AGENT_DIR, back up ccswitch-auto-switch-state.json, upgrade all installations, then restart only upgraded processes. Unsupported schemas are preserved and writes are refused.

Validation: typecheck and all 87 tests pass; runner 5/5. Real provider/TUI acceptance was not performed.
