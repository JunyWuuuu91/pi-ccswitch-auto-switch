# CCSwitch 第二轮 Review 执行报告

- 状态：READY_FOR_REVIEW
- 更新时间：2026-09-13T23:33:07+08:00
- 计划：CCSwitch 第二轮 Review 返工
- task_id / plan_revision：计划未声明；本轮以计划标题和 SHA-256 区分首轮。
- Plan SHA-256：`ac5b7f781629f1bbab7ef3ae6e11c2b9f008a730a045af428906a6b2d9b5132a`（开始与报告前一致）
- execution_root：`/Users/wujunyin/Project/Github/pi-ccswitch-auto-switch`
- Git 基线：`main @ 7dc99771e470d2525f1bccef650a3779fd1f5d1d`
- 继续执行基线：第一轮 11 个未提交文件修改全部保留；第一轮报告另存为 `agent-status-round1.md`，仅为历史快照，不是验收归档。

## 本轮完成项

1. **人工状态合并**：`disabledUpdatedAt` 对人工启用/禁用排序，`disable`、`reactivate`、`reactivateAll` 使用本地单调时间戳；不再采用 b 参数优先。未带时间戳的 schema 2/3 值默认版本 0，冲突同版本时保守禁用，已有单一 disabled 值保留。model/global reset 使用持久化 reset 标记，阻止旧快照把已经清除的记录及人工状态带回。
2. **模态切换生命周期**：移除 `before_provider_request` 中的主动切换，仅保留状态清理和看门狗。input 预检与 awaited tool_execution_end 内完成切换；shared Promise 仅供并发工具回调等待。测试先等待工具回调结束、确认 vision、再准备/进入 before-provider；另测候选在 input 后才出现时，before-provider 不会晚切换。needsImage、verifying 和后续多模态 failover 均保留。
3. **状态版本保护**：读取不支持 schema 或无效状态时保留原文件，停止写入/claim，写诊断日志。flush、claim、reset-all 均经过锁内磁盘读取校验；reset 不再绕过校验。已观察 schema 3 的实例若再读到 schema 2，拒绝降级写入并记录原因。不新建状态文件名，不把未来格式改名为 corrupt 后当空白继续写。
4. **文档**：双语 README 明确禁止旧新版本混跑同一目录，并给出退出所有旧 Pi/定时 runner → 备份 → 升级所有安装 → 仅重启新版的强制顺序。

## 本轮修改文件

`health.ts`、`index.ts`、`test/health.test.ts`、`test/integration.test.ts`、`README.md`、`README.zh-CN.md`，以及本目录报告/日志/patch。第一轮其他代码、计数组件设计、分类、工具链和公开命令均保留；RPC protocolVersion 仍为 1，runner.mjs 无修改。

## 验证

下列命令均在 execution_root 执行；本轮结果没有复用首轮测试结论。

| 命令 / 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| 修复前 `node --experimental-strip-types --test --test-reporter=tap test/health.test.ts test/integration.test.ts` | EXPECTED_FAIL，exit 1；49 项中 10 失败，覆盖人工状态/reset、未知 schema、过晚切换 | round2-before.log |
| `npm run typecheck` | PASS，exit 0 | round2-typecheck.log |
| `npm test`，Node v24.13.1 | PASS，exit 0；75/75，0 skipped | round2-node24.log |
| `npm exec --yes --package=node@22.19.0 -- sh -c 'node --version && npm run typecheck && npm test'` | PASS，exit 0；实际 v22.19.0，类型检查通过；75/75，0 skipped | round2-node22.log |
| `node --test test/runner.test.mjs` | PASS，exit 0；5/5 | round2-runner.log |
| `git diff --check` | PASS，exit 0 | 最终差异检查 |

health / integration / logic / runner 四组均执行。新增 12 项，另修订工具图片生命周期测试；覆盖旧人工状态不会覆盖新版 enable/disable、reactivateAll、两种 reset、旧记录迁移、未知 schema 的 load/flush/reset/claim 四条路径、已观察版本降级和禁止 before-provider 晚切换。

## Mixed-version 策略及残余风险

- 当前代码可保护其自身不覆盖未知/未来版本，也会拒绝已观察到的 3 → 2 降级；**不能制止已运行的旧二进制自己重命名/覆盖 schema 3**。因此不支持混跑，必须按 README 停止所有共享目录的旧进程后统一升级。此次未执行用户环境升级或修改真实 Pi 状态文件。
- 人工操作时间戳跨实例相同时保守保留禁用；系统时钟偏移可能影响跨进程先后顺序，不能声称实现了跨主机全局时钟。
- reset 是清除旧状态代次的屏障：旧实例尚未合并的历史/计数可被丢弃。跨实例 reset 后应重新加载状态；更新的人工操作时间戳可保留，但不会带回旧健康计数。
- 沿用首轮 schema 3 每实例计数组件，元数据仍随写入实例数增长。
- 实际 Pi/TUI/provider 生命周期未做实机验收；本轮以 awaited 事件模拟测试核验切换时机，不把 mock 的 ctx.model 改写等同于实际 provider 请求切换。

## 交付

`implementation-diff.patch` 是相对 Git 基线的完整最终 review diff，包含首轮与本轮代码、测试和文档修改。原计划未改写；未提交、推送、部署或设置 CLOSED。按当前计划等待 ChatGPT 再次 review。
