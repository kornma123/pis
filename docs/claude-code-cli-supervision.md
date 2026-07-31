# COREONE Claude Code CLI 监督协议

<!-- protocol-id: coreone-claude-code-cli-supervision/v2 -->
<!-- supervisor-defaults: effort=ultracode poll-seconds=300 desktop-terminal=attached-readwrite backend-tool-pty=not-visible background=false stable-eof-reads=2 question-interrupt=immediate session-reuse=true -->
<!-- terminal-proof: canary-write-and-app-readback=required same-handle=true missing-capability=fail-closed -->
<!-- supervisor-runtime: script=scripts/claude-cli-supervisor.cjs selftest=scripts/claude-cli-supervisor.selftest.cjs adapter-api=1 canary=out-of-band-marker probe=structured state=git-external visibility-failure=TERMINAL_VISIBILITY_UNPROVEN -->
<!-- stable-rules-only -->

本协议用于 Codex 或 PM 在本机启动、续接、监督 Claude Code CLI/K3 并与其双向协作。它解决的是会话可见、问题及时回答、输出不遗漏和派单前复核，不新增命令白名单，也不替代 `docs/agent-operating-contract.md` 的权限、ownership、GitHub 写入或效率规则。

本地终端输出轮询不是 GitHub 轮询。GitHub 仍只按共用契约 §9 的低频、串行、经授权路径读写。

## 0. 可执行入口与宿主 adapter

仓库内唯一可执行监督入口是 `scripts/claude-cli-supervisor.cjs`，回归入口是 `scripts/claude-cli-supervisor.selftest.cjs`。监督器拥有状态机、同句柄校验、Claude 探针、session/prompt 绑定、增量读取、问题中断、双读 EOF、独立 Git/scope/R0 事实闸和 Git 外恢复状态；它不拥有 Codex Desktop 前端终端。

宿主以 adapter API v1 接入。缺 adapter 时没有任何 PTY fallback，`run` 必须非零退出并报告 `TERMINAL_VISIBILITY_UNPROVEN`：

```bash
node scripts/claude-cli-supervisor.cjs run \
  --request='<任务 request JSON>' \
  --adapter='<Codex Desktop terminal adapter 模块>'
```

request JSON 只保存调度合同，不内嵌 prompt 正文：

```json
{
  "taskId": "stable-task-id",
  "taskName": "可识别且唯一的任务名",
  "threadId": "当前 Codex task id",
  "cwd": "/absolute/verified/worktree",
  "promptFile": "/absolute/private/prompt.txt",
  "minimumClaudeVersion": "2.0.0",
  "owned": ["scripts/example.cjs"],
  "excluded": ["前端代码/**", "后端代码/**"],
  "risk": "R1",
  "questionTimeoutMs": 300000
}
```

`minimumClaudeVersion` 是任务启动时由操作者/宿主按已批准版本策略注入的动态下限，不写死在稳定协议。prompt 文件必须是普通非 symlink 文件；监督状态只保存 prompt SHA-256，不保存正文。

adapter 元数据必须声明 `apiVersion=1`、`surface=codex-desktop-terminal`、`sameHandleReadWrite=true`、`canaryDelivery=out-of-band-marker` 与 `structuredProbe=true`，并实现以下同一 `terminalHandle` 合同；每个返回值都必须回传该 handle，任何 handle 漂移立即失败关闭：

| 方法 | 必须证明 |
|---|---|
| `createTerminal` | 在当前 `threadId` 中同步创建并打开前端终端；返回 `status=attached`、`visible=true` 与稳定 handle；`queued` 不合格 |
| `attachTerminal` | Codex app/task 重启后，把已保存的同一 handle 重新附着到当前任务；不能改用另一个终端 |
| `writeTerminal` | 向同一 handle 写 canary、控制者回答和前台 CLI 输入；visibility canary 必须走不会注入 Claude 前台输入的宿主 marker 通道；返回 `accepted=true` |
| `readTerminal` | 应用侧按 cursor 增量回读同一 handle，返回 `attached`、`visible`、输出、尾部/EOF、运行工具和结构化 question/stop 信号 |
| `probeTerminal` | 新启动前在同一终端运行 `pwd`、worktree root、Claude 路径/版本和 `--effort ultracode` 支持探针；恢复时必须用宿主进程/会话查询等不向仍活着的 Claude 注入命令的方式复核，返回结构化结果 |
| `launchClaude` | 在该 handle 的前台使用唯一 name/session id 和精确 `--effort ultracode` 启动，并以 prompt hash 回执证明已注入 |
| `resumeClaude` | 复用原 session id；进程仍在时回报 `alreadyRunning`，否则用原 id `--resume`，不得新建重复会话 |

调度者收到 `WAITING_CONTROLLER` 后，在权限与 scope 不扩大的问题上可通过库 API 的 `onQuestion` 立即回答，或调用：

```bash
node scripts/claude-cli-supervisor.cjs answer \
  --request='<同一 request JSON>' \
  --adapter='<同一宿主 adapter>' \
  --answer-file='<控制者答案文本>'
```

answer 路径会重新做同句柄 canary，再把答案写回原终端；不得要求 PM 点击、切换、粘贴或输入。需要新增权限、ownership、产品方向或 GitHub 写入时保持 `WAITING_CONTROLLER`，由调度者把最小决策交给用户。

恢复状态保存在 `git rev-parse --git-path coreone/claude-cli-supervisor/<task-hash>.json`，位于 Git 外且按 worktree 隔离。Codex app/task 重启后用同一 request 重跑 `run`：监督器校验 task/prompt/scope 绑定，重新证明原 terminal handle，再以原 Claude session id 续接；raw prompt、token、终端原文和凭据都不落状态文件。

以下已知失败形态全部属于回归负例：打开动作只返回 `queued`；应用回读显示未附着；回读的是主 checkout 的人工终端而非目标 handle；工具 PTY 能完成但前端不可见。它们只能报告 `TERMINAL_VISIBILITY_UNPROVEN` 或 `TERMINAL_HANDLE_MISMATCH`，不得声称 Claude 已启动，更不得把点击/输入步骤转交 PM。

**前端集成 owner / trigger**：owner 是 Codex Desktop terminal bridge 的宿主集成维护者；当宿主同时提供“当前 task 同步创建/附着前端终端、稳定 handle、同 handle 写入、应用侧带 handle 回读”四项 API 时触发接线。接线验收必须先让 `node scripts/claude-cli-supervisor.selftest.cjs` 全绿，再用无秘密 canary 做真实同 handle smoke；只有该 smoke 通过才允许受控 Claude 启动。仓库治理 owner 维护本脚本、状态机、测试和协议，不得用仓库代码伪造宿主可见性。

## 1. 单一控制面

- 当前用户可见的 Codex 根任务或 PM 是唯一控制者；一个 owned task 同时只保留一个受监督 Claude CLI 会话。
- “用户可见终端”必须同时满足：它出现在当前 Codex Desktop 任务的终端界面中；应用侧能回读其输出；控制者能通过同一个执行句柄向它写入。`exec_command(..., tty:true)`、shell 的 TTY、工具调用返回的 PTY/session id 或进程仍存活，都只证明后端有伪终端，**不能**证明用户在桌面端看得到。
- 只有应用侧只读回读、没有同一终端的写入能力，也不构成可监督会话：控制者无法及时回答 Claude 的提问。宿主不提供“同一终端可写 + 应用侧可回读”能力时，必须 fail-closed，不得用隐藏工具 PTY 代替。
- 控制者保存任务名、仓库绝对路径、Claude session id、桌面终端执行句柄、最后已消费输出位置和启动 canary 证明。不得把 token、环境变量值、凭据或私密数据写进会话名、命令、评论或日志。
- Claude 负责在同一会话中明确报告 `ACTIVE`、`WAITING_CONTROLLER`、`VERIFYING`、`COMPLETE` 或 `BLOCKED`；控制者负责读取、判断和回写，不把无人应答造成的停顿算作 Claude 的阻塞。

## 2. 启动和续接

执行任何 Claude 命令前，先完成桌面终端证明：

1. 用宿主应用的终端回读能力确认当前任务已附着终端；明确返回“未附着”时，记录 `BLOCKED: DESKTOP_TERMINAL_NOT_ATTACHED` 并停止。
2. 通过准备承载 Claude 的**同一个执行句柄**写入一次不含秘密的随机 canary（例如 `COREONE_TERMINAL_PROBE_<uuid>`），再由宿主应用回读当前任务终端；只有读回完全相同的 canary 才算证明通过。
3. canary 写入与应用回读任一能力不存在、失败或来自不同句柄时，记录 `BLOCKED: DESKTOP_TERMINAL_CONTROL_UNAVAILABLE` 并停止。不得转用工具侧 PTY、后台进程、日志文件或另一个终端继续。

证明通过后，才在该同一桌面终端执行目标 worktree 的只读探针：

```bash
command -v claude
claude --version
claude --effort ultracode --version
```

新会话使用预先生成并保存的 UUID；续接必须复用原 session id：

```bash
claude --effort ultracode --name '<可识别任务名>' --session-id '<uuid>'
claude --effort ultracode --name '<可识别任务名>' --resume '<原 session id>'
```

- `--effort ultracode` 是默认且必须显式传入的启动参数。模型沿用当时有效配置；只有用户或固定 handoff 明确指定模型时才传 `--model`，不得把会过期的模型名写成长期默认。
- 只有用户明确指定其他 effort 时才可覆盖默认值。CLI 不支持 `ultracode`、启动后显示降级或实际 effort 无法确认时，停止派单并如实报告；不得静默退回 `xhigh`、`high` 或其他级别。
- 必须在已经通过 canary 证明的同一 Codex Desktop 任务终端以前台交互方式启动。不得使用工具调用分配的 PTY、`--bg`、`nohup`、shell 后台符号、输出重定向或隐藏子任务代替；`--tmux` 仅在用户明确要求、桌面端可见 attach 入口已验证且控制者仍能同句柄读写时使用。
- 启动成功后，控制者立即在当前任务回报任务名、cwd、session id、Claude 版本、实际 effort，以及 canary 写入与应用回读均成功的“桌面终端已附着”状态。若其中任何一项未核实，不得声称会话已接通或终端可见。

## 3. 输出消费与五分钟节奏

- 始终复用已通过 canary 证明的同一桌面终端执行句柄和应用回读入口增量读取，不用重复启动 Claude，也不从工具 PTY、旧日志或另一终端推断当前状态。
- Claude 正在执行且没有新输出时，控制者至少每 `300` 秒消费一次新增输出。优先使用“有输出立即唤醒、无输出最多等待五分钟”的宿主等待原语；不得用 `sleep 300` 阻塞控制面。宿主单次等待上限更短时，可以内部短轮询，但对外仍按五分钟无输出节奏管理。
- 一旦出现新输出立即消费，不等五分钟整点。只处理上次 cursor 之后的增量，并持续读到当前提示符或稳定尾部，防止问题被截在半段。
- 无变化的轮询不向用户刷屏；有新事实、问题、风险、验证结果或状态变化时才给简短进度。

## 4. 提问和等待是最高优先级中断

出现下列任一信号时，控制者立即独立判断并回写原 CLI：提问、方案选择、权限请求、owned/excluded scope 请求、方向确认、冲突、明确的 `WAITING_CONTROLLER`，或可判断为正在等控制者输入的提示符。

- 回答当前问题不受“连续两次稳定 EOF”或完整 diff 复核闸限制；先解除等待，再继续监督。这条优先级高于常规派单前硬闸。
- 在既有任务范围、可逆且不新增外部权限时，控制者直接给出明确答案，不把可自行核实的问题转问用户。
- 只有答案会扩大授权、执行破坏性动作、改变 ownership、进行未授权 GitHub 写入或改变产品方向时，才把最小必要决策交给用户；同时保持原 Claude 会话可见并说明正在等待什么。
- Claude 提出多个 Issue、方案或后续候选时，控制者必须逐项消费并核对，不能只读取最后一段后直接派下一任务。

## 5. 常规下一派单的双闸

回答中断问题之外，在发送任何新的任务、纠偏、扩大检查或“继续下一项”之前，依次满足：

1. **输出闸**：完整消费当前新增输出；看到输入提示符或任务结束状态后，对同一 PTY 尾部做连续两次相同的稳定读取，期间没有新增输出、运行中工具或待答问题。
2. **事实闸**：控制者独立检查与 Claude 声明相关的实际 `git status`、diff、测试结果、commit 和 GitHub 写入；只核对本轮实际声称发生的对象，不机械重跑无关全量检查。

任一闸未满足时不得派常规下一任务。发现声明与现场不一致时，在原会话给出具体证据和最小纠偏，不启动第二个重复会话。

## 6. 恢复、完成与停止

- 桌面终端附着或同句柄写入能力丢失时，立即暂停派单并回到 canary 证明；不得因“看不到输出”就改用隐藏工具 PTY 或新开重复会话。证明恢复后才用原 session id 续接，并先消费断开期间全部新增输出。
- Claude 进程异常退出时，保存退出状态和最后输出；确认没有另一个同任务进程后，才用原 session id 续接。
- 只有 Claude 已给出终态、输出经过两次稳定读取、控制者完成事实闸、没有未答问题，并且当前目标确实无安全的范围内下一步时，才停止监督并向用户交付。
- `COMPLETE` 只表示本会话目标完成，不自动授权提交、push、开 PR、标记 Ready、合并、部署、发布或关闭 Issue；这些动作继续按共用契约分别取证和授权。

## 7. 状态机

| 当前状态 | 控制者动作 | 下一状态 |
|---|---|---|
| `STARTING` | 同句柄 canary 写入 + 应用回读、探针、显式 `ultracode`、记录 session id | `ACTIVE` / `BLOCKED` |
| `ACTIVE` | 输出唤醒优先，最长五分钟消费增量 | `ACTIVE` / `WAITING_CONTROLLER` / `VERIFYING` |
| `WAITING_CONTROLLER` | 立即回答原 CLI；需新增权限时才问用户 | `ACTIVE` / `BLOCKED` |
| `VERIFYING` | 两次稳定读取 + 独立事实闸 | `ACTIVE` / `COMPLETE` / `BLOCKED` |
| `BLOCKED` | 保留现场，说明缺失权限或外部条件 | 条件满足后回 `ACTIVE` |
| `COMPLETE` | 交付实际证据和仍受限动作 | 停止 |
