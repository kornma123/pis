---
name: coreone-conventions
description: COREONE 仓库的本地工作路由。处理任何 PRD、功能、Bug、GitHub Issue/PR、代码修改、测试、复核或交接时使用；尤其在用户给出 PRD、要求“按 PRD 开发”、继续另一设备/会话的工作、创建或更新 PR 时自动触发。把仓库权威链、实时 GitHub 状态、ownership、preflight、质量 Loop、验收映射和 PR handoff 串成一条执行链。
---

# COREONE 本地工作路由

把本 Skill 当作 Claude Code 在本仓库的启动控制器，不把它当业务规格。技术选型、业务口径和实时状态仍从权威文件、活代码、Git/GitHub 现场读取。

采用**顺序主链 + 闸点评估**：上游产物未满足退出条件时，停在当前阶段；不得用下游实现替上游补决定。

## 1. 每次任务先路由

1. 完整读取 `CLAUDE.md` 和 `docs/agent-operating-contract.md`，再按权威链读取相关工作模型、guardrails、golden、ADR/spec。
2. 现场读取 `git status`、当前分支、`origin/master`、相关 Issue/PR/checks；不使用聊天记忆或仓库快照冒充实时状态。
3. 判定入口：

| 输入 / 目标 | 入口 |
|---|---|
| 想法、痛点、未定需求 | `/coreone-prd` + PRD 质量 Loop |
| 已定稿并合并的 PRD，要拆单或实现 | 本 Skill 的“PRD 到交付”主链；可显式运行 `/coreone-deliver-prd` |
| 改页面结构或关键交互 | 先过 Mockup 质量 Loop，再进入写码 |
| Bug | 工程 Issue + 可复现路径，进入写码 Loop；不伪造 PRD |
| 独立复核 | review preflight + GitHub 复核评论合同；默认不代写 |
| DB / E2E 专项 | 先完成本 Skill 的任务认领，再调用专项命令 |

`/feature-development` 只是兼容入口，不能绕过本 Skill 直接写码。

## 2. 受治理交付任务第一次修改前交付本地任务合同

PRD、功能、Bug、Issue/PR、测试、复核、验收和跨设备交付先在会话中给出以下短块；有 GitHub 写权限时，把动态字段同步到主 Issue / PR。R0 错字、小样式等琐碎可逆修改按权威工作模型直接做、目标检查和简短收尾，不为此硬建 Issue。若相关 prompt 最终只需解释/只读检查或用户取消、且尚未建立 task state，运行 `node scripts/claude-task.cjs disarm --reason=<具体原因>` 解除本会话的交付写入门。

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

- PRD 不是已合并版本，或没有可链接的 PM 定稿证据；
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

按 `docs/github-issue-pr-management-loop.md` 直接用 `gh` 现场核对开放/关闭 Issues、开放 PR 和近期合并 PR，再起草候选；PM 确认后才创建新 Issues。已有 Issue 已完整覆盖时只链接，不重开。`.claude/workflows/surface-to-issues.js` 只供支持该 DSL 的 workflow harness 使用，不是 Claude Code 本地可自动调用入口。

### C. 认领一个工程 Issue

1. 一次只认领一个可独立验收的工程 Issue。
2. 先更新 Issue body 的 `coreone-owner` 块，再发认领事件评论；无 body 写权限时保持未认领。
3. fetch、建立独立 worktree/branch，声明 owned/excluded files；运行 `node scripts/claude-task.cjs start ...` 建立 worktree 私有任务状态并通过 develop preflight。
4. 重新核对 PRD 固定版本、依赖 PR、活代码与现状；功能已经存在或前提已变化时停下并报告证据。

实现阶段使用以下形态；PRD / Mockup 阶段省略不适用的 `--prd/--approval/--mockup/--mockup-approval`：

```text
node scripts/claude-task.cjs start \
  --issue=N --stage=implementation --owner="Claude Code (Fable 5)" --risk=R1 \
  --prd=docs/prd/PRD-N-name.md@<merged-SHA> \
  --approval=https://github.com/.../issues/N#issuecomment-... \
  --mockup=path/to/mockup.md@<merged-SHA> \
  --mockup-approval=https://github.com/.../issues/N#issuecomment-... \
  --owned='path/**' --excluded='other-owner/**'
```

纯后端任务用 `--mockup='NOT_APPLICABLE:具体理由'`，不能只写 `N/A`；仍须用 `--mockup-approval=<PM普通评论URL>` 证明 PM 同意“不适用”。

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
4. PR body 记录实时 handoff；Issue body 记录整项工作剩余项；评论只记录状态变化、决定、阻塞与复核事件。
5. 独立 reviewer 在目标 PR 留普通评论，锚定 head SHA，写 Verdict、findings、证据、未覆盖边界和下一动作。默认不 APPROVE、REQUEST CHANGES 或 MERGE。

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

跨设备接手只依赖 GitHub Issue、PR body/checks、合并 PRD 和固定 commit；不得依赖另一台设备的聊天历史、个人 memory、未推送分支或本地 session-log。停止前先在活动 Issue 留普通评论，正文包含 `[HANDOFF] status=<状态>`、结果、证据、风险和下一 owner，再运行 `node scripts/claude-task.cjs handoff --status=<同一状态> --evidence=<本轮新评论URL>`。共享 Stop hook 首次提醒未交接，task state 在证据校验成功前不会清除。

## 5. 收尾输出

按 PM 语言交付：业务结果、PRD/AC 覆盖、已验证、未验证、风险、需要 PM 决定、下一 owner / 触发条件。严格区分已实现、已验证、已评审、PM 验收、已合并和已发布。
