# CCSwitch 最后一轮并发恢复修复

Updated: 2026-09-13
Workspace: /Users/wujunyin/Project/Github/pi-ccswitch-auto-switch
Target agent: Codex

## Goal

基于第三轮 review，只修复最后确认的跨进程人工恢复缺口，不回退前两轮已通过的改动。

## Problem

`reactivate(model)` 与 `reactivateAll()` 当前只修改本进程内存已有记录。如果另一个进程在本实例 load 之后新写入了 model/provider/endpoint cooldown/lease/disabled，当前实例执行 reactivate 可能看似成功，但 flush 时会重新合并磁盘上的新 breaker，导致实际仍 blocked。

## Plan

1. 将 `reactivate(model)` 改为基于最新磁盘状态的原子操作：拿同一状态锁，读取并校验支持的 schema，merge 最新状态，然后同时清除目标 model/provider/endpoint 的 `disabled`、`cooldownUntil`、`leaseUntil`、`consecutiveFailures`，并写入新的 `disabledUpdatedAt`/人工操作版本，最后 commit。不要仅依赖旧内存 snapshot。
2. `reactivateAll()` 同理：必须在锁内读取最新磁盘状态后，对所有最新 model/provider/endpoint 记录执行恢复，再 commit。
3. 保持当前 schema 3 fail-closed 策略：遇到 unsupported/newer schema 或已观察 3→2 downgrade 时不得覆盖原文件；reactivate/reactivateAll 也必须遵守这一点并返回/记录失败，而不是伪成功。
4. 现有同步 API 如需改为 async，可以同步调整命令 handler 与面板调用点，确保 UI 只有在真正持久化成功后才提示“已重新激活”。不要让命令在失败时静默显示成功。
5. 补至少两个多实例回归：
   - A、B 同时 load；B 之后新写 provider/endpoint breaker 并 flush；A 再 `reactivate(model)`，最终新 HealthStore load 后 `isBlocked(model) === false`。
   - A、B 同时 load；B 之后新增多个 breaker 并 flush；A 再 `reactivateAll()`，最终所有相关模型均不再 blocked。
6. 再补一个 fail-closed focused test：磁盘在 A load 后被替换为 unsupported schema，A 的 reactivate/reactivateAll 不得覆盖该文件，也不得报告成功。
7. 不改变公开命令名称、RPC protocolVersion、候选排序、图片状态机、schema 3 counter 设计。

## Verification

- `npm run typecheck` PASS。
- Node >=22.19 下 `npm test` 全部 PASS。
- `node --test test/runner.test.mjs` PASS。
- `git diff --check` PASS。
- 更新 `.ai-bridge/agent-status.md` 为 `READY_FOR_REVIEW`，明确本轮修改文件、测试结果、reactivate 的原子化方式和任何残余风险。
- 更新 `.ai-bridge/implementation-diff.patch`。

## Constraints

- 不回退前两轮已通过修复。
- 不提交、不推送、不部署。
- 完成后等待 ChatGPT 再次 review。
