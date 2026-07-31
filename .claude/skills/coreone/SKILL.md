---
name: coreone-conventions
description: COREONE 仓库的本地工作路由。处理任何 PRD、功能、Bug、GitHub Issue/PR、代码修改、测试、复核或交接时使用；尤其在用户给出 PRD、要求“按 PRD 开发”、继续另一设备/会话的工作、创建或更新 PR 时自动触发。把仓库权威链、实时 GitHub 状态、ownership、preflight、质量 Loop、验收映射和 PR handoff 串成一条执行链。
---

# COREONE 本地工作路由

把本 Skill 当作 Claude Code 在本仓库的启动控制器，不把它当业务规格。技术选型、业务口径和实时状态仍从权威文件、活代码、Git/GitHub 现场读取。

采用**顺序主链 + 闸点评估**：上游产物未满足退出条件时，停在当前阶段；不得用下游实现替上游补决定。

## 1. 每次任务先路由

1. 完整读取 `CLAUDE.md` 和 `docs/agent-operating-contract.md`；若由 Codex 或 PM 启动、续接或监督本地 CLI，同时完整读取 `docs/claude-code-cli-supervision.md`，再按权威链读取相关工作模型、guardrails、golden、ADR/spec。
2. 现场读取 `git status`、当前分支、`origin/master`、相关 Issue/PR/checks；不使用聊天记忆或仓库快照冒充实时状态。
3. 判定入口：

| 输入 / 目标 | 入口 |
|---|---|
| 想法、痛点、未定需求 | `/coreone-prd` + PRD 质量 Loop |
| 已定稿并合并的 PRD，要拆单或实现 | 本 Skill 的“PRD 到交付”主链；可显式运行 `/coreone-deliver-prd` |
| 改页面结构或关键交互 | 先过 Mockup 质量 Loop，再进入写码 |
| Bug | 工程 Issue + 可复现路径，进入写码 Loop；不伪造 PRD |
| 独立复核 | review preflight + fixed-SHA 线下复核文档；默认不代写、不发布 GitHub review/comment/status |
| DB / E2E 专项 | 先完成本 Skill 的任务认领，再调用专项命令 |

`/feature-development` 只是兼容入口，不能绕过本 Skill 直接写码。

实现 / 复核按 `docs/agent-operating-contract.md` §4 分域：前端（`前端代码/**` 及 UI/交互制品）由 Claude Code CLI/K3 实现、Codex fixed-SHA 复核；后端（`后端代码/**` 及 API/数据库/认证/服务端）由 Codex 实现、Claude Code CLI/K3 fixed-SHA 复核。混合任务优先按可独立验收边界拆票；不能拆时，须由 PM 在实时 handoff 明确单一实现 owner 与异构 reviewer。规则生效前的在途例外只保存在对应 handoff，不进入本稳定 Skill。

## 2. 受治理交付任务第一次修改前交付本地任务合同

PRD、功能、Bug、Issue/PR、测试、复核、验收和跨设备交付先在会话中给出以下短块；有 GitHub 写权限时，把动态字段同步到主 Issue / PR。R0 错字、小样式等琐碎可逆修改不为此硬建 Issue，但第一次写入前运行 `node scripts/claude-task.cjs start-r0 --reason=<为何是R0> --owned=<path>`；目标检查后运行 `finish-r0 --evidence=<实际检查>`。只读解释不需要 state。

```text
LOCAL TASK CONTRACT
source: <PRD 路径@merged SHA / bug 复现 / 其他权威入口>
stage: <PRD / mockup / implementation / review / acceptance>
primary Issue / PR: <#N / 无，并说明原因>
current owner: <Issue body coreone-owner 块>
goal / non-goal / unacceptable: <大白话>
PRD requirements / AC in scope: <RQ/AC IDs；不适用则写 N/A>
risk: <R0/R1/R2/R3 + 升档原因>
base / owned / excluded: <现场值>
verification: <会失败的证据 + 最终证据>
next gate: <谁在什么证据出现后允许进入下一阶段>
```

下列任一条件不满足时不得开始 PRD 驱动的功能实现：

- PRD 不是 `origin/master` first-parent 上的已合并版本，或 PM 普通评论没有精确标记 `[PM-APPROVAL] decision=approved artifact=<PRD path@approved-head>`；
- 涉及界面/主流程却没有定稿 mockup；纯后端任务只能在说明 `mockup=NOT_APPLICABLE` 及理由后继续；
- 没有经 PM 确认的工程 Issue，或 Issue 没有独立可验收范围；
- Issue body 的 `coreone-owner` 受控块未认领当前 owner；评论不能替代当前 owner 主源；
- 未从最新 `origin/master` 建独立 worktree，或 develop preflight 未通过；
- 方向级开放问题、口径冲突、敏感数据授权或 ownership 冲突仍未解决。

PM “定稿”只结束 PRD 内容闸，不自动满足以上实现条件。

## 3. PRD 到交付主链

### A. 固定需求基线

1. 读取合并后的 PRD，记录固定 commit 链接或 `path@SHA`；不要只引用会移动的 `master`。
2. 提取目标、范围、非范围、不可接受结果、依赖、风险、每个 Requirement / AC 和 PM 决策证据。
3. 若 PRD 缺少可追踪 ID，先提出 PRD 修订；临时 ID 只用于草稿，不得借机新增需求。
4. 对 UI、金额/口径、权限、数据和 golden 逐项路由到对应权威入口与升档规则。

### B. 把 PRD 拆成工程 Issue 候选

按**用户可验证的纵向切片**拆，不默认按“前端 / 后端 / 测试”横切。只有 owner、风险、依赖或交付物确实不同才拆票。

每个候选 Issue 必须包含：

- `PRD path@merged SHA` 与 PM 定稿证据；
- 本切片覆盖的 Requirement / AC IDs；
- 业务结果、范围、非范围、不可接受结果；
- 依赖、风险档位、建议 owner、触发条件；
- BDD / 失败路径 / 真跑验收证据；
- 与已有 Issue/PR 的去重结论。

按 `docs/github-issue-pr-management-loop.md` 直接用只读 `gh` 现场核对开放/关闭 Issues、开放 PR 和近期合并 PR，再把 1–5 个去重候选写入当前 Claude project 的 `memory/` JSON manifest（`version=1`，每项只含 `title/body`）。把原始文件 SHA-256 和数量交 PM；只有仓库 owner 的新普通评论精确包含 `[PM-ISSUE-CREATION] decision=approved manifest-sha256=<64hex> count=<1..5>` 后，才运行 `node scripts/claude-task.cjs create-issues --manifest=<绝对路径> --approval=<评论 URL>`。该事务逐项执行 offline governance、串行写入、至少间隔一秒、逐项回读并防重放；结束即停止写入，交 Codex 重新去重、复核事实/范围/AC、正式评级与标签回读。不得直接运行 `gh issue create` 绕开事务。Codex 评级前 Issue 不得进入实现。已有 Issue 已完整覆盖时只链接，不重开。`.claude/workflows/surface-to-issues.js` 只供支持该 DSL 的 workflow harness 使用，不是 Claude Code 本地可自动调用入口。

### C. 认领一个工程 Issue

1. 先确认 Codex 已完成正式评级，再按共用契约 §4 分域。Claude Code 一次只认领一个可独立验收的**前端**工程 Issue；后端 Issue 交 Codex 实现，Claude Code 保持 reviewer，不创建实现分支、不代写后端文件。
2. 新建 Issue 保持 owner=`unassigned`；用 `claude-task.cjs start --claim=true ...` 在 preflight 通过后原子更新 `coreone-owner` 块并发认领评论。若已有其他 owner 或无 body 写权限，保持未认领。
3. fetch、建立独立 worktree/branch，声明 owned/excluded files；运行同一 `start` 建立 worktree 私有任务状态。
4. 重新核对 PRD 固定版本、依赖 PR、活代码与现状；功能已经存在或前提已变化时停下并报告证据。

本节命令形态只适用于 Claude Code 确实是实现 owner 的任务。`claude-task start` 会拒绝后端、全仓、混合或无法判定为前端的 implementation scope。混合任务确实无法拆票时，PM 普通评论必须精确包含 `[PM-OWNERSHIP-EXCEPTION] decision=approved owner=Claude-Code issue=<N> scope-sha256=<排序去重 owned scope 的 SHA-256> reason=<不能拆分与 reviewer 安排>`，并用 `--ownership-exception=<评论 URL>` 绑定；稳定后端主链不得用例外常态化改派。

实现阶段使用以下形态；PRD / Mockup 阶段省略不适用的 `--prd/--approval/--mockup/--mockup-approval`：

```text
node scripts/claude-task.cjs start \
  --issue=N --stage=implementation --owner="<与 Issue body current owner 精确一致>" --claim=true --risk=R1 \
  --prd=docs/prd/PRD-N-name.md@<merged-SHA> \
  --approval=https://github.com/.../issues/N#issuecomment-... \
  --mockup=path/to/mockup.md@<merged-SHA> \
  --mockup-approval=https://github.com/.../issues/N#issuecomment-... \
  --owned='path/**' --excluded='other-owner/**'
```

非 PRD 的 Bug、治理或测试工作项必须在 Issue body 中把 `PRD 固定基线` 与 `RQ → AC 映射` **同时精确填为 `N/A`**；一边为 `N/A`、另一边仍有映射时 fail-closed。此类任务不伪造 PRD 或 PRD 批准证据，启动时用 `--prd=N/A` 并省略 `--approval`；Mockup 闸点仍按工作项表单执行：

```text
node scripts/claude-task.cjs start \
  --issue=N --stage=implementation --owner="<与 Issue body current owner 精确一致>" --claim=true --risk=R1 \
  --prd=N/A \
  --mockup='NOT_APPLICABLE:不改变界面或主流程' \
  --mockup-approval=https://github.com/.../issues/N#issuecomment-... \
  --owned='path/**' --excluded='other-owner/**'
```

纯后端任务用 `--mockup='NOT_APPLICABLE:具体理由'`，不能只写 `N/A`；仍须用 `--mockup-approval=<PM普通评论URL>` 证明 PM 同意“不适用”，且评论精确包含 `[PM-APPROVAL] decision=approved artifact=MOCKUP_NOT_APPLICABLE`。批准评论必须由仓库 owner 发布，不能用“未通过/不批准”等自然语言子串冒充。

### D. 建立验收追踪矩阵

在主 Issue 评论或 PR body 中维护当前任务矩阵，不另建第二份实时状态文档：

```text
PRD AC | 本 Issue 切片 | 实现位置 | 先失败的证据 | 最终自动证据 | 真跑证据 | 状态
AC-01  | ...          | ...      | ...          | ...          | ...      | pending
```

每个范围内 AC 必须有实现位置与证据；范围外 AC 明确指向其他 Issue。不能映射的 AC 是上游缺口，不得静默跳过。

### E. 小步实现与偏离控制

1. 按写码质量 Loop 先写会失败的 BDD/TDD 证据，再做最小实现，再重构。
2. 一轮只完成矩阵中的一个可运行目标；测试、构建或 golden 红时如实停在红态。
3. 只从活代码与 `.claude/rules/coreone-guardrails.md` 选择技术模式；不得套用旧命令中的固定库或过时范式。
4. 新事实与 PRD 冲突时写入偏离清单并回上游拍板；不得在代码里悄悄重写需求。
5. 涉及共享事实链、钱、权限、PII、DB 或生产时执行对应 R2/R3 加固与独立复核。

### F. 验证、PR 与复核

1. 逐行更新验收追踪矩阵；保留失败证据、最终测试、构建、golden、真数据/手核和未覆盖边界。
2. 运行任务相关检查、`node scripts/build-discipline/run-all.cjs`、preflight/drift check 和 `git diff --check`；复原被跑脏的 tracked dev DB。
3. 使用仓库 PR 模板；主关系用 `Closes #N` 或 `Refs #N`，并运行 `scripts/issue-handoff/check-pr-body.cjs` 校验实际 PR body。
4. PR body 记录实时 handoff；Issue body 记录整项工作剩余项；GitHub 只保留经授权的低频正式状态、决定与阻塞事件。
5. 独立 reviewer 在隔离 checkout / bundle 上核对 fixed SHA、tree、parent、base、full range 与 predecessor delta，输出线下完整复核文档，写 Verdict、findings、证据、未覆盖边界和下一动作。默认不向 GitHub 发布 review/comment/status，也不 APPROVE、REQUEST CHANGES 或 MERGE。前端实现由 Codex 复核；后端实现由 Claude Code CLI/K3 复核。

### G. 合并后真跑验收

1. PR 合并不等于功能完成。以同一 PRD 固定版本和验收追踪矩阵进入真跑验收 Loop。
2. 真起系统，逐条执行范围内 AC，覆盖相关角色、错误态、边界和代表性数据；每条留下可判断证据。
3. 将发现分为实现 Bug、PRD/设计问题、新想法，分别回对应 Loop；本次不夹带扩范围。
4. PM 明确“验收通过”后才能把消费者被服务标为完成；发布/上线继续单独取证。

## 4. GitHub 同步检查点

在以下时点重新读 GitHub/Git，而不是沿用会话开头快照：

1. 开工和认领前；
2. 范围、owner、依赖或 PRD 基线变化后；
3. 提交 / push / 开 PR 前；
4. reviewer 评论或 head SHA 变化后；
5. 请求 PM 合并、验收或跨设备接手前。

跨设备接手只依赖 GitHub Issue、PR body/checks、合并 PRD 和固定 commit；不得依赖另一台设备的聊天历史、个人 memory、未推送分支或本地 session-log。停止前由当前 GitHub 操作者在活动 Issue 留本轮新普通评论，使用以下非占位字段，再运行 `node scripts/claude-task.cjs handoff --status=<同一状态> --evidence=<本轮新评论URL>`。共享 Stop hook 首次提醒未交接，task state 在证据校验成功前不会清除。

活动任务只发生正式双轴评级变化或需要迁移旧版 state 时，由 Codex 在同一 Issue 留一条
`[ISSUE-RATING] owner=Codex previous=<P?/上线影响|UNRECORDED/UNRECORDED> current=<P?/上线影响> reason=<具体依据>`
普通评论；实现 owner 核对后运行 `node scripts/claude-task.cjs rebaseline-rating --evidence=<comment URL>`。命令只重定评级字段，不接受 Issue body、owner、branch 或 base 漂移；这些变化仍须正式 handoff / 重新认领。

```text
[HANDOFF] status=<in-progress|blocked|ready-for-review|waiting-pm|waiting-acceptance|accepted>
result: <本轮业务/交付结果>
evidence: <commit / PR / checks / 真跑证据>
risk: <残余风险，确无也要说明原因>
next-owner: <下一角色或具名负责人>
trigger: <下一步启动条件>
least-confidence: risk-v1; anchor=name:支付回调; uncertainty=unverified:目标环境重试行为
biggest-missing: no-finding-v1; checked=path:scripts/example.cjs; unchecked=ref:Issue#81
```

`least-confidence` 与 `biggest-missing` 只接受共用契约 §6.1 的 `risk-v1` / `no-finding-v1` strict typed wire grammar，不接受旧 free-form，也不要加入 Markdown/HTML 包装。ASCII mode/key/id 是 entity decode + NFKC 后的 canonical 形态；raw/canonical contract 均 `<=4096` UTF-8 bytes，ref 编号保持 digit string。raw U+0009 只可作 mode/segment 边界、key/`=` 周围或 value 外层 padding；value 内 Tab 和 entity 解码生成的 Tab 必须 fail-closed。canonical mode 后首个 `;` 固定分段；其余 `;` 仅在后继 optional space/tab + ASCII field-key + optional space/tab + `=` 时才是字段分隔，再逐 token 重检 entity，不能按 value 大小写猜测；NFKC 后新出现的 unresolved entity 也 fail-closed。`scope&amp;bogus; uncertainty=...` 表示裸 `scope&bogus` 后接 grammar delimiter；`scope&amp;bogus;; uncertainty=...` 才保留未知完整 entity 并须拒绝。placeholder 比较忽略连续句末标点及 `/ _ + - &` 终止填充，并拒绝 canonical `n(?:[./_+-])?a` 等价族；内部的 `C++`、`snake_case`、`R&D+`、`A&B`、`rock&roll` 与路径保持不变。完整支持的 entity 可解码，裸 `&` 可作可见文本。entity 名边界按 ASCII 名 token 推导，无分号的受支持 entity 名/前缀 fail-closed。checker 只证明 wire shape 与 lexical anchor 可审计；不能证明 anchor 真实、detail 真未知、checked / unchecked 真执行或回答诚实，这些仍由 reviewer / PM 人审。最终直接面向用户的产品化结尾继续用产品大白话。

## 5. 回复主体输出（非最终收口）

以下内容作为回复主体按 PM 语言交付：业务结果、PRD/AC 覆盖、已验证、未验证、风险、需要 PM 决定、下一 owner / 触发条件。严格区分已实现、已验证、已评审、PM 验收、已合并和已发布。直接向最终用户交付结果的交互式根任务会话，最后一个用户可读收口区块仍按 `docs/agent-operating-contract.md` §6.1；本 Skill 不复制该合同字段。
