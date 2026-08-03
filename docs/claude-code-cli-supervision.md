# COREONE Claude Code CLI 监督协议

<!-- protocol-id: coreone-claude-code-cli-supervision/v3 -->
<!-- supervisor-defaults: effort=ultracode poll-seconds=300 desktop-terminal=attached-readwrite backend-tool-pty=not-visible background=false stable-eof-reads=2 question-interrupt=immediate session-reuse=true -->
<!-- terminal-proof: canary-write-and-app-readback=required same-handle=true missing-capability=fail-closed -->
<!-- supervisor-runtime: script=scripts/claude-cli-supervisor.cjs selftest=scripts/claude-cli-supervisor.selftest.cjs test-harness=scripts/claude-cli-supervisor.test-harness.cjs production-test-exports=forbidden review-target-execution=materialized adapter-api=2 capability=host-native-unforgeable file-adapter=test-only terminal-generation=required lease=task-exclusive state-cas=true structured-exit=required canary=out-of-band-marker probe=structured state=git-external visibility-failure=TERMINAL_VISIBILITY_UNPROVEN -->
<!-- external-visible-runtime: mode=external-visible-readonly action=fixed-sha-readonly-review surface=macos-terminal-dedicated-window-or-existing startup-claim=required-for-automatic-launch codex-task-binding=false permission-mode=plan evidence-layers=STATIC_INSTALL,SKILL_DISCOVERY,VISIBLE_SESSION_CANARY,REVIEW_BEHAVIOR_ACCEPTANCE hidden-pty=forbidden print-mode=forbidden github-write=forbidden candidate-drift=fail-closed visibility-failure=VISIBLE_CLI_CONTROL_UNAVAILABLE -->
<!-- stable-rules-only -->

本协议用于 Codex 或 PM 在本机启动、续接、监督 Claude Code CLI/K3 并与其双向协作。它解决的是会话可见、问题及时回答、输出不遗漏和派单前复核，不新增命令白名单，也不替代 `docs/agent-operating-contract.md` 的权限、ownership、GitHub 写入或效率规则。

本地终端输出轮询不是 GitHub 轮询。GitHub 仍只按共用契约 §9 的低频、串行、经授权路径读写。

## 0. 两种保证模式与唯一可执行入口

本协议区分两个不能互相冒充的保证等级：

| 模式 | 保证边界 | 当前用途 |
|---|---|---|
| `native-task-bound` | Codex 宿主原生、调用方不可伪造的 `threadId + terminalHandle + terminalGeneration` capability | 最高保证等级；当前 Codex Desktop 尚未接入 native bridge，缺能力时继续 `TERMINAL_VISIBILITY_UNPROVEN` |
| `external-visible-readonly` | 精确 macOS Terminal window id、当时窗口标题、TTY、Claude PID/session、同可见会话 challenge-response 与 transcript 回读 | 只允许固定 SHA、只读异构复核；自动启动只进入新建专用窗口，也可附着用户已准备好的可见 Claude 会话，都不要求绑定当前 Codex task |

“没有 Codex 内置终端句柄”不等于“无法控制用户现有可见终端”。外部模式承认后一种能力，但不会把它标成 host-native 或不可伪造；收据必须明确 `codexTaskBindingRequired=false`。

仓库内唯一生产监督入口是 `scripts/claude-cli-supervisor.cjs`，回归入口是 `scripts/claude-cli-supervisor.selftest.cjs`，测试专用装载器是 `scripts/claude-cli-supervisor.test-harness.cjs`。默认回归只运行可在 review preflight 物化目标中独立执行的核心 suite；依赖完整仓库协议文档与 Git 现场的外部可见终端扩展必须显式运行 `node scripts/claude-cli-supervisor.selftest.cjs --external-summary`，两者都通过才可进入真实桌面验收。监督器拥有状态机、同句柄校验、Claude 探针、session/prompt 绑定、增量读取、问题中断、双读 EOF、独立 Git/scope/R0 事实闸和 Git 外恢复状态；它不拥有 Codex Desktop 前端终端。

两种模式都以 adapter API v2 接入。**生产 CLI 不加载 `--adapter=<文件>`，生产模块也不导出任何 fake-adapter 测试入口**：任意仓库外/仓库内 JavaScript 文件都能伪报 `attached/visible`。回归测试只能由测试进程显式加载专用 harness；生产 runtime 不得 import、命名或重新导出该 harness，不能用 `NODE_ENV`、环境变量或布尔值伪造信任边界。

`native-task-bound` 只接受 Codex Desktop 原生 bridge 在同一进程给出的 capability；当前宿主缺该 bridge，所以该模式的生产 `run/answer/ack-stop` 仍非零退出。`external-visible-readonly` 只接受生产模块内建的 macOS Terminal 原生 adapter：自动启动先用 Terminal 自身 `do script` 新建一个前台专用窗口并回读 claim；`attach-existing` 则只附着已由用户准备好的精确可见 Claude 会话。它不会把自动启动命令投入不透明的已有 tab；每次操作前重新核对 Terminal、window id、selected tab 与 TTY，不加载调用方代码，也不使用 System Events/Accessibility 键盘注入。

自动启动前先单独领取专用窗口；该命令只返回动态回执，不启动 Claude：

```bash
node scripts/claude-cli-supervisor.cjs claim \
  --cwd='<经校验的绝对 worktree 根目录>'
```

只有在新窗口执行的随机 challenge 变换结果被同一 Terminal window/TTY 回读后，`claim` 才输出 JSON。回执有效期五分钟，必须原样放入 request；过期、重绑窗口/TTY、回读 proof 消失或窗口已有 Claude 都返回 `VISIBLE_CLI_CONTROL_UNAVAILABLE`。然后才可运行：

```bash
node scripts/claude-cli-supervisor.cjs run \
  --request='<任务 request JSON>'
```

request JSON 只保存调度合同，不内嵌 prompt 正文：

```json
{
  "taskId": "stable-task-id",
  "taskName": "可识别且唯一的任务名",
  "threadId": "native 模式为当前 Codex task id；外部模式仅为审计关联 id",
  "cwd": "/absolute/verified/worktree",
  "promptFile": "/absolute/private/prompt.txt",
  "minimumClaudeVersion": "2.0.0",
  "owned": ["scripts/example.cjs"],
  "excluded": ["前端代码/**", "后端代码/**"],
  "risk": "R1",
  "questionTimeoutMs": 300000
}
```

外部可见模式还必须携带动态、完整的只读复核合同；下列值只是字段形状，不是稳定默认值：

```json
{
  "supervisionMode": "external-visible-readonly",
  "externalVisibleTerminal": {
    "action": "fixed-sha-readonly-review",
    "terminalApp": "Terminal",
    "windowId": 12345,
    "windowTitle": "启动时现场读取的窗口标题",
    "tty": "/dev/ttysNNN",
    "startup": "launch-in-dedicated-window",
    "claudeSessionId": "预生成 UUID",
    "expectedClaudeVersion": "现场批准的精确版本",
    "expectedEffort": "现场批准且 transcript 可证明的 effort",
    "expectedPermissionMode": "plan",
    "repositoryFullName": "owner/repo",
    "reviewTargetSha": "完整 40 位 candidate SHA",
    "skillName": "coreone",
    "skillPath": "目标 worktree 内 Skill 的绝对路径",
    "skillSha256": "完整 64 位 SHA-256",
    "claim": {
      "schemaVersion": 1,
      "claimId": "claim 命令返回的 UUID",
      "claimedAt": "claim 命令返回的 ISO-8601 时间",
      "expiresAt": "claim 命令返回的 ISO-8601 时间",
      "cwd": "/absolute/verified/worktree",
      "terminalApp": "Terminal",
      "windowId": 12345,
      "windowTitle": "claim 完成时回读的窗口标题",
      "tty": "/dev/ttysNNN",
      "challenge": "COREONE_CLAIM_<random>",
      "response": "claim 命令返回的变换结果",
      "proofMarker": "claim 命令返回的 marker",
      "proofPayloadBase64": "claim 命令返回的 payload",
      "proofSha256": "claim 命令返回的完整 SHA-256"
    }
  }
}
```

`attach-existing` 必须提供现场 Claude PID 与同 session transcript 路径，且不接受 launch claim；`launch-in-dedicated-window` 禁止预填 PID/transcript，必须提供上述完整 claim，由监督器在该专用窗口启动后发现并回读 Claude 身份。历史值 `launch-in-idle-tab` 不再合法：已有 tab 的 shell 输入缓冲、前台 TUI 与提交时序无法在自动启动前可靠证明为空。任何路径都不得自动退出、杀死或接管用户已有的 Claude。**进程存活且只是思考慢、转录暂时无新输出、单次等待超时或超过观测节奏，都不构成终止授权**；不得因此发送信号、退出、替换会话或降低 effort。

`minimumClaudeVersion` 是任务启动时由操作者/宿主按已批准版本策略注入的动态下限，不写死在稳定协议。prompt 文件必须是普通非 symlink 文件；监督状态只保存 prompt SHA-256，不保存正文。

原生 adapter 元数据必须声明 `apiVersion=2`、`surface=codex-desktop-terminal`、`sameHandleReadWrite=true`、`canaryDelivery=out-of-band-marker` 与 `structuredProbe=true`。外部 adapter 必须声明 `surface=external-visible-terminal`、`readOnly=true` 与 `canaryDelivery=same-visible-session-challenge-response`。每个调用/返回值都必须绑定并回传同一 handle/generation；handle、generation、window id、TTY、Claude PID/session 或 fixed SHA 任一漂移立即失败关闭。

| 方法 | 必须证明 |
|---|---|
| `createTerminal` | native 模式在当前 `threadId` 中按 `taskId+sessionId+generation` 幂等键同步创建并打开前端终端；外部自动启动模式只附着已由 `claim` 新建并现场回读的专用窗口。两者都返回 `status=attached`、`visible=true`、稳定 handle、同一 generation 与原样幂等键；`queued` 不合格 |
| `attachTerminal` | native 模式在 Codex app/task 重启后按同一幂等键重新附着；外部模式重新核对同一 Terminal window id/TTY/session/transcript。前台 PID 仍在时核对其命令；PID 已证实不存在时保留原 window/TTY/session，交给 `resumeClaude`，不能改用另一个终端 |
| `writeTerminal` | 向同一 handle 写 canary、控制者回答和前台 CLI 输入；每次写入前都重新聚焦并现场复核同一 app/window id/selected TTY，不能把前一阶段的前台状态跨等待复用。macOS `activate()` 与 frontmost 回读可异步生效；只可对 `frontmost/frontWindow` 做有界等待，window/TTY/title/selected tab 任一不同仍立即失败关闭；visibility canary 必须走不会注入 Claude 前台输入的宿主 marker 通道；返回 `accepted=true` |
| `readTerminal` | 应用侧按 cursor 增量回读同一 handle；外部模式必须长轮询 transcript 变化或结构化问题/终态，无新记录时不得空转忙循环。返回绑定后的 `threadId/handle/generation`、`attached/visible`、真实输出、EOF、运行工具、结构化 question/stop，以及同 `sessionId` 的结构化进程终态 |
| `probeTerminal` | 新启动前在同一终端运行 `pwd`、worktree root、Claude 路径/版本探针；Claude 路径必须从当前可见 shell 继承的 `PATH` 解析，不得另起 login shell 导致另一套 PATH。恢复时用进程与 transcript 元数据复核实际 executable、version、effort、permission mode、cwd/session。`claude --effort <值> --version` 只证明版本命令接受参数，**不能**证明实际会话采用该 effort |
| `launchClaude` | 在该 handle 的前台使用唯一 name/session id 启动；native 使用其固定默认，外部使用 request 的精确 effort 与 `permission-mode=plan`。外部模式先发送不调用 Skill、不展开复核的轻量 digest/challenge 握手；收到同 session ACK 后再显式 `/<skill>` 投递带唯一 marker 的复核消息，并以 transcript 中的 user message 证明已注入。Skill/权威链的长读取属于后续复核，不得与启动握手合并后再用一分钟误杀 |
| `resumeClaude` | 复用原 window/TTY/session id、同一幂等键、原 `--effort` 与 `permission-mode=plan`；进程仍在时回报 `alreadyRunning`，否则在原可见窗口用原 id `--resume`，不得新建、fork 或重复投递会话 |

同一 task 的 `run/answer/ack-stop` 受 Git 外独占 lease 保护，状态文件每次写入做 revision CAS；并发控制者只能得到 `SUPERVISOR_LEASE_HELD`，不得第二次 create/launch。应用或任务异常退出后，仅在 owner PID 已确定不存在（`ESRCH`）时自动回收旧 lease；owner 仍存活或证据不可解析时继续失败关闭。

外部自动启动是有副作用的三阶段操作：先出现精确 Claude 进程，再用轻量独立回合取得 Skill digest 与 prompt ACK，最后才显式调用 Skill 投递复核。阶段间等待可能使 Terminal 失去前台，因此启动命令、握手和正式复核三次写入都必须在写入前重新聚焦并现场复核同一 app/window id/selected TTY；仅凭先前 canary 或前一阶段的窗口状态不得继续。若控制器在任一阶段之间退出，重试必须在已持久的同一 terminal handle 上核对精确 launch command、session id、runtime metadata 与 transcript；全部匹配时从最后一个已证明阶段续接，不得再启动进程、重复握手或重复投递复核。Claude 原生后台 agent 可以是同一可见会话的内部实现，但后台 fork 的输出单独不能充当第四层行为验收；结果必须回传原前台 session，并从该可见会话的当前 transcript 或终端回读确认。无已持久 handle、任一身份不匹配或 transcript 中出现无关后续回合时仍 fail-closed。

调度者收到 `WAITING_CONTROLLER` 后，在权限与 scope 不扩大的问题上可通过库 API 的 `onQuestion` 立即回答，或调用：

```bash
node scripts/claude-cli-supervisor.cjs answer \
  --request='<同一 request JSON>' \
  --answer-file='<控制者答案文本>'
```

answer 路径会重新做同句柄 canary，再把答案写回原终端；不得要求 PM 点击、切换、粘贴或输入。外部协议只接受封闭 question kind：`clarification/evidence` 默认不扩权；`permission/ownership/product-direction/github-write/write/merge/publish/deploy/release/external-send` 必须 `requiresAuthority=true`；未知 kind、引用/前后缀/重复/冲突的 terminal record，或同一回合同时出现 QUESTION 与 COMPLETE，均 fail-closed。一个 QUESTION 只能在 transcript 中出现后续、非 canary/handshake/review-prompt 的 `user` 回答后，才可被下一条 QUESTION 或 COMPLETE 取代；无回答的跨 assistant `QUESTION → COMPLETE` 不得压掉待处理问题。需要新增权限、ownership、产品方向或 GitHub 写入的问题会持久锁存，禁止 `onQuestion` 自动回答；只有附带 `--authorization-receipt=<JSON>` 的显式回答才可解除。回执必须精确绑定 `threadId + sessionId + terminalHandle + terminalGeneration + questionId + questionTextSha256`，另含 decision id、授权人、授权时间和范围；过期、过早、未来时间或任一上下文不一致均稳定拒绝。结构化 stop 同样跨重启锁存，只能由 `ack-stop --ack-file=<JSON>` 显式确认，确认后会话进入 `STOPPED`，不得自动 resume。

恢复状态保存在 `git rev-parse --git-path coreone/claude-cli-supervisor/<task-hash>.json`，位于 Git 外且按 worktree 隔离。Codex app/task 重启后用同一 request 重跑 `run`：监督器校验 thread/task/prompt/scope、初始 branch 与 per-worktree gitdir 绑定，重新证明原 terminal handle/generation，再以原 Claude session id 续接；raw prompt、问题正文、token、终端原文和凭据都不落状态文件。线程迁移没有隐式 fallback；当前 runtime 未实现授权 handoff，所以 thread 变化一律 `STATE_BINDING_MISMATCH`。

以下已知失败形态全部属于回归负例：打开动作只返回 `queued`；应用回读显示未附着；回读的是主 checkout 的人工终端而非目标 handle；工具 PTY 能完成但前端不可见。它们只能报告 `TERMINAL_VISIBILITY_UNPROVEN` 或 `TERMINAL_HANDLE_MISMATCH`，不得声称 Claude 已启动，更不得把点击/输入步骤转交 PM。

**前端集成 owner / trigger**：Codex Desktop terminal bridge 的宿主维护者仍拥有 native 模式；出现原生 capability 后再接线，不由外部模式冒充。仓库治理 owner 维护外部只读模式、状态机、测试和协议；每次真实使用仍须先做无秘密 challenge-response，不能把一次历史 smoke 当永久通行证。

## 0.1 四层证据不得折叠

外部模式的 typed receipt 必须分别列出：

1. `STATIC_INSTALL`：Claude 可执行对象与目标 worktree 内 Skill 普通文件、精确 digest；
2. `SKILL_DISCOVERY`：同一 Claude session 实际读取 Skill，并回报它独立计算的相同 digest；
3. `VISIBLE_SESSION_CANARY`：同一 window/TTY 的随机 challenge-response；预期响应不得原样写在提示中；
4. `REVIEW_BEHAVIOR_ACCEPTANCE`：同一 transcript 对精确 candidate SHA 给出结构化终态，transcript SHA-256 已回读。

四层任一为 `UNVERIFIED/FAIL` 时，整体不得称 runtime/review PASS。static install PASS 不代表 Skill 已发现；canary PASS 不代表行为验收完成；行为 PASS 也不构成代码结论 PASS，更不构成修复、合并、发布或部署授权。

## 1. 单一控制面

- 当前用户可见的 Codex 根任务或 PM 是唯一控制者；一个 owned task 同时只保留一个受监督 Claude CLI 会话。外部模式的 `threadId` 只是审计关联，不是原生绑定证明。
- “用户可见终端”必须同时满足：它是前台 Terminal 的精确 window/selected tab/TTY，控制者能向同一 tab 写入，并能从该窗口或同 session transcript 回读。`exec_command(..., tty:true)`、shell TTY、工具返回的 PTY/session id 或进程存活都不能单独证明这一点。
- 只有应用侧只读回读、没有同一终端的写入能力，也不构成可监督会话：控制者无法及时回答 Claude 的提问。宿主不提供“同一终端可写 + 应用侧可回读”能力时，必须 fail-closed，不得用隐藏工具 PTY 代替。
- 控制者保存任务名、仓库绝对路径、Claude session id、桌面终端执行句柄、最后已消费输出位置和启动 canary 证明。不得把 token、环境变量值、凭据或私密数据写进会话名、命令、评论或日志。
- Claude 负责在同一会话中明确报告 `ACTIVE`、`WAITING_CONTROLLER`、`VERIFYING`、`COMPLETE` 或 `BLOCKED`；控制者负责读取、判断和回写，不把无人应答造成的停顿算作 Claude 的阻塞。

## 2. 启动和续接

执行任何 Claude 命令前，先完成所选模式对应的终端证明：

1. native 模式确认当前 task 已附着原生终端；外部自动启动先执行 `claim`，确认它新建了 exact Terminal app/window id、claim 完成时标题、前台 selected tab 与 TTY；`attach-existing` 则核对用户已准备好的同等身份与 Claude PID/session/transcript。已有会话不得被自动启动路径接管。
2. 通过准备承载 Claude 的**同一个句柄、专用窗口或已附着会话**写入不含秘密的随机 challenge。native 用 out-of-band marker；外部要求返回提示中没有原样给出的变换结果，并从同一窗口或同 session transcript 回读。
3. 写入、回读、身份或 challenge 任一不存在、失败或来自不同对象时停止：native 报 `TERMINAL_VISIBILITY_UNPROVEN`，外部报 `VISIBLE_CLI_CONTROL_UNAVAILABLE`。不得转用工具 PTY、后台进程、日志文件或另一个终端继续。

证明通过后，才在该同一桌面终端执行目标 worktree 的只读探针。native 模式仍按其固定默认；外部模式的 effort 必须来自 request，并由实际 transcript 再确认：

```bash
command -v claude
claude --version
claude --help
```

新会话使用预先生成并保存的 UUID；续接必须复用原 session id：

```bash
claude --effort '<该模式批准的精确 effort>' --name '<可识别任务名>' --session-id '<uuid>'
claude --effort '<该模式批准的精确 effort>' --name '<可识别任务名>' --resume '<原 session id>'
```

- `native-task-bound` 的既有默认仍是 `ultracode`，在 native bridge 接线前不得伪称可运行。`external-visible-readonly` 不继承这个未经实际 session 证明的默认：启动参数必须等于 request 的 `expectedEffort`，并从 transcript 元数据读回相同值。当前 COREONE 固定 SHA 异构复核的已批准值为 `max`；除非 PM 后续对精确任务显式改变，不得降低。任何任务现场批准的 effort 都只是动态证据，不是跨设备常量。
- Claude 版本按严格 SemVer 比较；prerelease 低于相同 core 的稳定版（例如 `2.0.0-beta.1 < 2.0.0`），不得只比较前三段数字后放行。
- SemVer 的数字标识符按十进制数字串长度和字典序比较，不转为 JavaScript `Number`；超出安全整数范围的版本也必须保持双向对称顺序。
- effort 不在本机 `claude --help` 声明集合、启动后实际值不同或 transcript 无法确认时停止派单；不得因 `claude --effort <值> --version` 返回 0 就认定支持，也不得静默降级。
- 外部模式必须使用 `permission-mode=plan`；已有 session 为 `bypassPermissions`、`acceptEdits` 或其他可写模式时拒绝复用。它只允许只读固定 SHA 复核；GitHub 写入/评论、Issue/PR 修改、权限/身份变化、合并、发布、部署和对外发送均保留人工关卡。
- 必须在已经通过 canary 的同一可见终端以前台交互方式启动或复用。不得使用工具 PTY、`--print`、`--bg`、`nohup`、shell 后台符号、输出重定向、另开隐藏 Claude 或隐藏子任务代替。不得因 System Events 键盘注入缺 Accessibility 权限就要求用户改权限；使用 Terminal 自身的窗口/tab `do script` 接口，具体提交行为由 challenge 回读验收。
- 启动成功后，控制者立即在当前任务回报任务名、cwd、session id、Claude 版本、实际 effort，以及 canary 写入与应用回读均成功的“桌面终端已附着”状态。若其中任何一项未核实，不得声称会话已接通或终端可见。

## 3. 输出消费与五分钟节奏

- 始终复用已通过 canary 证明的同一桌面终端执行句柄和应用回读入口增量读取，不用重复启动 Claude，也不从工具 PTY、旧日志或另一终端推断当前状态。
- Claude 正在执行且没有新输出时，控制者至少每 `300` 秒消费一次新增输出。优先使用“有输出立即唤醒、无输出最多等待五分钟”的宿主等待原语；不得用 `sleep 300` 阻塞控制面。宿主单次等待上限更短时，可以内部短轮询，但对外仍按五分钟无输出节奏管理。
- 上述五分钟是回读/进度观测节奏，不是任务死线、失败判定或进程终止计时器。即使一次 canary 因 `max` effort 超过旧的 30 秒窗口，也只能按任务 wait budget 继续回读或保留可恢复状态，不得杀进程或降 effort。
- 一旦出现新输出立即消费，不等五分钟整点。只处理上次 cursor 之后的增量，并持续读到当前提示符或稳定尾部，防止问题被截在半段。
- 无变化的轮询不向用户刷屏；有新事实、问题、风险、验证结果或状态变化时才给简短进度。

## 4. 提问和等待是最高优先级中断

出现下列任一信号时，控制者立即独立判断并回写原 CLI：提问、方案选择、权限请求、owned/excluded scope 请求、方向确认、冲突、明确的 `WAITING_CONTROLLER`，或可判断为正在等控制者输入的提示符。

- 回答当前问题不受“连续两次稳定 EOF”或完整 diff 复核闸限制；先解除等待，再继续监督。这条优先级高于常规派单前硬闸。
- 在既有任务范围、可逆且不新增外部权限时，控制者直接给出明确答案，不把可自行核实的问题转问用户。
- question/stop 一旦出现即写入 Git 外状态并跨重启锁存；后续 read 没再重复该信号不得清除。普通 question 只由显式 answer 清除，stop 只由显式 ack-stop 清除。
- 同一次 read 同时出现 question 与 stop 时必须先原子锁存两者，并以 stop 为最高优先级：不得调用 `onQuestion`、answer 或 resume，只有 `ack-stop` 能解除 stop；确认 stop 后仍不得把遗留 question 当作恢复许可。
- 只有答案会扩大授权、执行破坏性动作、改变 ownership、进行未授权 GitHub 写入或改变产品方向时，才把最小必要决策交给用户；同时保持原 Claude 会话可见并说明正在等待什么。这类 `requiresAuthority` 问题禁止自动回答，显式 answer 还必须携带绑定该 question 的可审计用户授权回执。
- Claude 提出多个 Issue、方案或后续候选时，控制者必须逐项消费并核对，不能只读取最后一段后直接派下一任务。

## 5. 常规下一派单的双闸

回答中断问题之外，在发送任何新的任务、纠偏、扩大检查或“继续下一项”之前，依次满足：

1. **输出闸**：完整消费当前新增输出；只有宿主给出绑定同 `sessionId` 的结构化终态 `status=exited + exitCode=0 + signal=null + pendingQuestion=false + runningTool=false` 后，才对同一终端真实读回 tail 做连续两次相同 hash。监督器自己计算 hash，忽略 adapter 自报 `tailSha256`；从增量真实读回中发现的 `FATAL:` 或结构化协议失败会持久锁存，后续空 tail 或 clean exit 不能洗掉；缺终态、非零退出、signal、待答问题或运行工具也一律 `CLAUDE_EXIT_ABNORMAL`。
2. **事实闸**：控制者绑定启动时 branch 与 per-worktree gitdir，独立检查 `git status`、HEAD/tree、working tree/index/untracked 内容指纹、测试结果、commit 和 GitHub 写入。外部固定 SHA 模式在**第一次终端写入前**和**行为验收时**都要求 index、tracked worktree 与 untracked set 全空；即使脏文件属于 owned scope，也不得把未提交字节冒充为 candidate SHA。scope 检查枚举 `initialHead..HEAD` 每个 commit 的所有 parent delta，再与 working tree 路径取并集；中途 add/remove、merge 历史里的越界路径也不得被最终树掩盖。R0 状态按 claude-task v2 schema、分支、时效、祖先关系和文件身份严格分类为 `missing/valid/malformed/unsafe`；启动时只能接受 `valid` 并保存 evidence hash，完成时只有先前有效 evidence 与当前确认 `missing` 才能证明 `finish-r0`，malformed、symlink、目录或其他非普通文件全部 `R0_CONTRACT_UNPROVEN`。

任一闸未满足时不得派常规下一任务。发现声明与现场不一致时，在原会话给出具体证据和最小纠偏，不启动第二个重复会话。

## 6. 恢复、完成与停止

- 桌面终端附着或同句柄写入能力丢失时，立即暂停派单并回到 canary 证明；不得因“看不到输出”就改用隐藏工具 PTY 或新开重复会话。证明恢复后才用原 session id 续接，并先消费断开期间全部新增输出。
- 只有进程查询证明原前台 Claude 已不存在，才能记录“进程退出”；慢、暂无 transcript 或存在 Claude 原生后台 agent 都不等于退出。保存最后输出并确认没有另一个同任务前台进程后，在原 window/TTY 用原 session id、`max` effort 与 `permission-mode=plan` 续接，不投递重复 prompt。
- 只有 Claude 已给出终态、输出经过两次稳定读取、控制者完成事实闸、没有未答问题，并且当前目标确实无安全的范围内下一步时，才停止监督并向用户交付。
- 持久化 `COMPLETE` 不是永久通行证：每次 `run` 都要重新核对 threadId、终端绑定、branch/gitdir、HEAD/tree、working status 与新鲜事实闸；任一变化转 `STALE_COMPLETION`/`BLOCKED`，不得直接早退。只读 `status` 不得复用旧成功，必须降级为等待新一次 `run` 复核的 `BLOCKED`。thread 变化只允许未来具备显式授权 handoff 的宿主路径；当前实现无该路径，故一律拒绝。
- `COMPLETE` 只表示本会话目标完成，不自动授权提交、push、开 PR、标记 Ready、合并、部署、发布或关闭 Issue；这些动作继续按共用契约分别取证和授权。
- `review` preflight 必须从目标 ref 物化 supervisor runtime、专用 harness、依赖与 selftest，并在该物化目标中真实执行 import、负例和确定场景 suite；目标资产缺失、语法损坏或 suite 失败必须显式 `FAIL`，不得因工作树版本可运行而把目标 ref 报成 PASS。

## 7. 状态机

| 当前状态 | 控制者动作 | 下一状态 |
|---|---|---|
| `STARTING` | 模式绑定 + 同 tab challenge-response、探针、实际 effort/permission/transcript 回读、记录 session id | `ACTIVE` / `BLOCKED` |
| `ACTIVE` | 输出唤醒优先，最长五分钟消费增量 | `ACTIVE` / `WAITING_CONTROLLER` / `VERIFYING` |
| `WAITING_CONTROLLER` | 立即回答原 CLI；需新增权限时才问用户 | `ACTIVE` / `BLOCKED` |
| `VERIFYING` | 两次稳定读取 + 独立事实闸 | `ACTIVE` / `COMPLETE` / `BLOCKED` |
| `BLOCKED` | 保留现场，说明缺失权限或外部条件 | 条件满足后回 `ACTIVE` |
| `COMPLETE` | 交付实际证据和仍受限动作 | 停止 |
