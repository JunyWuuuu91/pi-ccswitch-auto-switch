# Pi CCSwitch 自动故障转移

> English: [README.md](README.md)

当 [CC Switch](https://ccswitch.io/) 管理 [Pi](https://github.com/badlogic/pi-mono) 的 Provider 时，为 Pi 提供更稳健的模型自动故障转移。

它只观察 Pi 的真实请求，保存脱敏健康记录；仅在 TUI/RPC 交互会话中，才会把失败请求平滑切到健康模型。额度耗尽、凭据失效或限流等 Provider 级问题会直接熔断整个 Provider，不会连续尝试同一 Provider 下的多个兄弟模型。

## 功能

- 以 Pi 的有效模型注册表为准，不读取 CC Switch 数据库、Pi 认证文件或 API Key。
- 对认证、额度、账单和限流实施 Provider 优先熔断。
- 对 DNS、连接、服务端和流中断实施端点熔断。
- 模型不存在或参数不兼容时仅隔离该模型。
- 内容审查失败会学习模型系列约束（例如 `glm-4.5`、`GLM-4.6` 同属 `glm`），在本轮内容审查故障转移中避开整个受限系列。该约束按 session 隔离：`session_start` 时清除，因为新 session 处理的任务不一定涉及审查内容，模型系列恢复可用，直到本 session 再次观察到内容审查拒绝。
- 候选模型先经过健康、故障域、审查系列、输入模态和上下文窗口硬过滤，再按跨 Provider、模型等价性、能力兼容和历史稳定性排序。
- 首响应 90 秒、流式停滞 120 秒看门狗。
- 指数退避、`Retry-After` 支持和跨进程 half-open 单探针租约。
- 原子持久化状态、错误脱敏和有上限的日志。
- Pi 紧凑状态栏与健康管理面板。
- `--print` / JSON 非交互运行只监控和记录，不会注入可能与进程退出竞争的新请求。
- `pi-ccswitch-run` 使用单个 Pi RPC 会话完成无头自动故障转移，只输出最终成功模型的回答。

## 要求

- Pi `0.84.4` 或更高版本。
- 建议使用 CC Switch `3.20+`，其已支持原生维护 Pi 模型配置。
- 本地开发和测试需要 Node.js `22.19+`；Pi 运行插件本身不需要额外安装 Node。

## 安装

### 通过 Pi Package 安装（推荐）

```bash
pi install git:github.com/JunyWuuuu91/pi-ccswitch-auto-switch
```

该命令在 macOS、Linux 和安装了 Git 的 Windows 上均可使用。npm 版本发布后，也可以执行：

```bash
pi install npm:pi-ccswitch-auto-switch
```

安装或更新后重启 Pi，或执行 `/reload`。后续更新 Git 版本可执行 `pi update --extensions`。

### 无头自动化调用

`pi-ccswitch-run`（`runner.mjs`）是独立于 Pi 扩展的 headless 调用入口：它启动一个 `pi --mode rpc` 会话，把一次请求自动切换到健康模型后只返回最终成功结果。它**不在** `pi install` 的扩展加载路径里自动暴露给下游项目，需要单独安装。

#### 在消费方项目内安装（推荐，保证 `require.resolve` 可解析）

`pi install git:...` 只把扩展装进 Pi 全局目录（`~/.pi/agent/...`），**不会**把它放进下游项目的 `node_modules` 解析路径。因此消费方代码里 `require.resolve('pi-ccswitch-auto-switch/runner.mjs')` 需要把本包安装进**自己的项目依赖**：

```bash
# 在消费方项目目录内执行
npm i github:JunyWuuuu91/pi-ccswitch-auto-switch
# 或从 npm registry 安装最新版
npm i pi-ccswitch-auto-switch@latest
```

安装后 `require.resolve('pi-ccswitch-auto-switch/runner.mjs')` 会命中项目自身 `node_modules`，bin `pi-ccswitch-run` 也可直接调用。

#### 版本锁定警告（0.x caret 陷阱）

npm 对 `^0.1.6` 的 caret 语义**只匹配 `0.1.x`**，不会自动升到含 `runner.mjs` 的 `0.3.x`。如果机器上 `~/.pi/agent/npm/node_modules/pi-ccswitch-auto-switch` 仍停留在 `0.1.6`（该版本无 `runner.mjs`、无 `pi-ccswitch-run` bin），重复执行 `pi install` 也不会升级。请手动升级 npm 侧版本：

```bash
cd ~/.pi/agent/npm && npm install pi-ccswitch-auto-switch@latest
```

升级后确认 `~/.pi/agent/npm/node_modules/pi-ccswitch-auto-switch/runner.mjs` 存在。也可以在扩展内执行 `/ccswitch-doctor` 检查 `runner.mjs` 是否可解析。

#### 运行方式

```bash
pi-ccswitch-run --no-tools --no-context-files @prompt.md "请总结附件"
```

runner 内部只显式加载本扩展并启动一次 Pi RPC；`PI_BIN` 只能指定内部真实 `pi`，不能指向 runner。默认总超时为 10 分钟，可用 `--timeout-ms` 调整。退出码：成功 `0`、候选耗尽 `1`、参数/RPC 配置错误 `2`、超时 `124`、中断 `130/143`。首版只支持文本 `@文件`，不支持图片和 stdin。

正常使用 CC Switch 配置 Provider 即可；本插件不会修改 Pi 模型设置或 CC Switch 数据。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/ccswitch` 或 `/ccswitch status` | 打开健康面板。 |
| `/ccswitch help` | 在 Pi 内显示命令帮助。 |
| `/ccswitch refresh` | 刷新 Pi 模型注册表和状态栏。 |
| `/ccswitch reactivate <provider/model\|all>` | 解除熔断，下一次真实请求验证恢复情况；保留历史。 |
| `/ccswitch disable <provider/model>` | 手动排除模型。 |
| `/ccswitch reset <provider/model\|all>` | 确认后删除相应健康历史；`all` 同时清除已学习的审查约束。 |
| `/ccswitch-test` | 仅检查候选发现，不切换模型。 |
| `/ccswitch-doctor` | 诊断 `runner.mjs` 可解析性和安装情况。 |

## 状态栏

```text
CCS v0.3.1 ✓70/131 · ⏳61 · ⛔0 · 🔄3 · provider/model-id
```

- `v0.3.1`：当前安装的 CCSwitch 扩展版本。
- `✓70/131`：Pi 有效范围内共有 131 个去重后的 `provider/model` 组合，其中 70 个健康；重复的 scope 条目只计一次。
- `⏳61`：有 61 个模型正受模型、Provider 或端点自动冷却影响；一条 Provider 熔断记录可能同时影响许多模型。
- `⛔0`：没有被手动禁用的模型。
- `🔄3`：**本次 pi session 成功切换的模型次数**（衡量扩展有效程度，0 时也显示图标）。`/new`、`/fork`、`/resume` 等新 session 开始时归零；但**失败记录与冷却状态不重置**（它们是物理事实，跨 session 保留）。累计切换数（`state.switches`）与最近 20 条切换日志会持久化到状态文件，可在 `/ccswitch` 面板和 `/ccswitch-test` 中查看。
- `provider/model-id`：当前实际生效的模型（`provider/id`，切换后立即更新，长名自动截断）。
- 切换中出现 `CCS ↻2/5 provider/model`，表示正在进行最多 5 次尝试中的第 2 次。

四个状态（健康/冷却/禁用/切换）即使为 0 也始终显示，便于确认扩展处于监控中；全部健康时仍显示零计数，例如 `CCS ✓131/131 · ⏳0 · ⛔0 · 🔄0 · provider/model-id`。通过 `/ccswitch` 或 `/ccswitch-test` 可同时查看 Pi 原始 scope 条目数、去重模型数、受影响模型数、底层熔断记录数、本 session 切换数与累计切换数。

切换成功后扩展还会通过 `appendEntry` 向会话注入一条 `ccswitch-switch` custom entry（不参与 LLM 上下文），触发 TUI 底栏重绘——这样 Pi 右下角的模型名显示也会同步为切换后的模型。RPC 模式还会发出协议版本为 `1` 的 `ccswitch-complete` 或 `ccswitch-exhausted` 终态 entry，供 runner 判定最终结果。

## 故障转移逻辑

插件会先等待 Pi 内置重试结束和会话恢复 idle，再进行切换。新的用户输入会使旧轮次的待切换任务失效，从而避免重复发送。

| 失败类型 | 熔断范围 | 初始冷却 |
| --- | --- | --- |
| `401`、`403`、额度或账单问题 | Provider | 30 分钟 |
| `429` | Provider | 优先使用 `Retry-After`，否则 5 分钟 |
| DNS、网络、`408`、`5xx`、流中断 | 端点 | 2 分钟 |
| `404`、模型不存在、参数不兼容 | 模型 | 15 分钟 |
| 内容审查/敏感拦截 | 当前模型 + 模型系列约束 | 模型冷却 2 分钟；系列约束按 session 隔离（`session_start` 时清除） |
| 上下文溢出 | 仅本轮 | 无 |

冷却时间会指数增长但有上限。发生内容审查时，插件只在审查故障转移链中避开已标记系列，普通限流、网络或模型配置故障仍可选择这些模型。上下文溢出时只会选择上下文窗口更大的模型；带图片的请求不会切到明确仅支持文本的模型。无法归类的异常按单模型故障处理并正常切换。用户主动取消是唯一不会触发故障转移的异常终止；看门狗取消会记录为超时。

## 数据与隐私

健康状态保存在 Pi agent 目录的 `ccswitch-auto-switch-state.json`。其中只有计数、时间、冷却信息、模型系列审查约束和脱敏/截断的错误摘要；插件不会访问凭据、Authorization 请求头、CC Switch 数据库或 Pi 的 `auth.json`。

## 开发

```bash
npm install
npm run typecheck
npm test
```

测试使用 Node 内置测试运行器，覆盖失败分类矩阵、系列级审查避让、Provider 优先选择、输入兼容、冷却、状态持久化以及 Windows 路径。

## 许可证

[MIT](LICENSE)
