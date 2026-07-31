# COREONE Claude Code CLI 监督协议

<!-- protocol-id: coreone-claude-code-cli-supervision/v1 -->
<!-- supervisor-defaults: effort=ultracode poll-seconds=300 visible-pty=true background=false stable-eof-reads=2 question-interrupt=immediate session-reuse=true -->
<!-- stable-rules-only -->

本协议用于 Codex 或 PM 在本机启动、续接、监督 Claude Code CLI/K3 并与其双向协作。它解决的是会话可见、问题及时回答、输出不遗漏和派单前复核，不新增命令白名单，也不替代 `docs/agent-operating-contract.md` 的权限、ownership、GitHub 写入或效率规则。

本地终端输出轮询不是 GitHub 轮询。GitHub 仍只按共用契约 §9 的低频、串行、经授权路径读写。

## 1. 单一控制面

- 当前用户可见的 Codex 根任务或 PM 是唯一控制者；一个 owned task 同时只保留一个受监督 Claude CLI 会话。
- 控制者保存任务名、仓库绝对路径、Claude session id、PTY handle 和最后已消费输出位置。不得把 token、环境变量值、凭据或私密数据写进会话名、命令、评论或日志。
- Claude 负责在同一会话中明确报告 `ACTIVE`、`WAITING_CONTROLLER`、`VERIFYING`、`COMPLETE` 或 `BLOCKED`；控制者负责读取、判断和回写，不把无人应答造成的停顿算作 Claude 的阻塞。

## 2. 启动和续接

启动前在目标 worktree 做只读探针：

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
- 必须在当前用户可见的 Codex 任务终端以交互式前台 PTY 启动。不得使用 `--bg`、`nohup`、shell 后台符号、输出重定向或隐藏的子任务代替这个会话；`--tmux` 仅在用户明确要求且当前任务同时给出可见 attach 入口时使用。
- 启动成功后，控制者立即在当前任务回报任务名、cwd、session id、Claude 版本、实际 effort 和“终端可见”状态。若其中任何一项未核实，不得声称会话已接通。

## 3. 输出消费与五分钟节奏

- 始终复用同一个 PTY handle 增量读取，不用重复启动 Claude，也不从旧日志推断当前状态。
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

- 终端暂时断开但 session 仍存在时，先用原 session id 恢复；不得因“看不到输出”就新开重复会话。恢复后先消费断开期间全部新增输出，再处理问题。
- Claude 进程异常退出时，保存退出状态和最后输出；确认没有另一个同任务进程后，才用原 session id 续接。
- 只有 Claude 已给出终态、输出经过两次稳定读取、控制者完成事实闸、没有未答问题，并且当前目标确实无安全的范围内下一步时，才停止监督并向用户交付。
- `COMPLETE` 只表示本会话目标完成，不自动授权提交、push、开 PR、标记 Ready、合并、部署、发布或关闭 Issue；这些动作继续按共用契约分别取证和授权。

## 7. 状态机

| 当前状态 | 控制者动作 | 下一状态 |
|---|---|---|
| `STARTING` | 探针、显式 `ultracode`、可见 PTY、记录 session id | `ACTIVE` |
| `ACTIVE` | 输出唤醒优先，最长五分钟消费增量 | `ACTIVE` / `WAITING_CONTROLLER` / `VERIFYING` |
| `WAITING_CONTROLLER` | 立即回答原 CLI；需新增权限时才问用户 | `ACTIVE` / `BLOCKED` |
| `VERIFYING` | 两次稳定读取 + 独立事实闸 | `ACTIVE` / `COMPLETE` / `BLOCKED` |
| `BLOCKED` | 保留现场，说明缺失权限或外部条件 | 条件满足后回 `ACTIVE` |
| `COMPLETE` | 交付实际证据和仍受限动作 | 停止 |
