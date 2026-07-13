# COREONE PR 治理规范

> 本文件只保存稳定的 PR 不变量。实时 open/merged、checks、review、base/head SHA 和 mergeability 一律以 GitHub 为准；历史台账入口见 `docs/archive/pr-governance-ledger-through-2026-07-06.md`。

## 1. 实时事实源

开始、交接和合并前都现场查询：

```bash
gh pr list --state open
gh pr view '<PR>' --json state,isDraft,mergeStateStatus,baseRefName,headRefName,headRefOid,url
gh pr checks '<PR>'
```

仓库文档不得维护“当前 open PR 看板”。PR body 可以记录该任务的关系、边界和验证，但状态字段只是当时证据，不替代 GitHub。

## 2. 分支、base 与依赖

1. 新开发先 fetch，再从现场 `origin/master` 创建独立 worktree 和命名分支；开工运行 `scripts/agent-preflight.cjs` 的 develop 模式。
2. PR base 必须表达真实依赖：无依赖时 base 为 master；有上游依赖时 base 为上游 head，形成 GitHub 可见的物理栈。
3. 栈式 PR 的 body 要写明上游、下游和合并顺序；上游合并后，立即现场核对并把下游 base 重定向到仍然真实的上游。
4. 半成品或不能单独落地的 PR 必须在 body 顶部标明原因，并使用仓库现有的阻止单独合并标签。
5. 新 PR 取代旧 PR 时，双方 body 或评论互相链接并说明保留/舍弃范围；不得用旧分支的“完成”文档冒充 master 现状。

## 3. 文件所有权与并发

- 一个文件同时只有一个实现 owner；另一模型只复核，不在同一文件上代写。
- 每个代理同一时间最多维护一个实现 PR。实现完成或明确交接后才能接下一条实现线。
- PR body 或任务 handoff 必须列 owned files、excluded files、依赖和 ABC/共享事实链影响。
- 不切换、清理、覆盖或提交其他 worktree；只显式暂存本任务拥有的路径。

## 4. PR body 最小合同

使用 `docs/agent-handoffs/TEMPLATE.md` 的字段，并至少写清：

- task id、owner/author、reviewer、base SHA、worktree；
- 当前状态到目标状态、owned/excluded files；
- 依赖关系与合并顺序；
- BDD/验收、真数据或 golden 影响；
- 验证证据、未覆盖边界；
- 迁移、回滚、PR URL、merge authority。

动态状态留在 PR body/GitHub；需要入仓交接时建立每任务独立 handoff 文件，不共同追加一份大状态文件。

## 5. Checks 与合并权限

1. required checks 的名称和结论从 GitHub 分支保护与 PR checks 现场读取，长期文档不硬编码。
2. 文档 PR 也必须收到 required context；因此 required job 的 pull-request 触发不得被文档路径过滤掉。
3. 合并前重新 fetch，比较届时的 `origin/master`；依赖已合入时吸收最新 master 并重跑受影响验证。
4. 实现代理可以提交、推送和开 PR，但不得自动合并。required checks 满足、异构复核完成且 PM 明确批准后，才有合并授权。
5. 不以管理员越过失败或尚未完成的 required checks；若平台故障需要例外，必须先取得 PM 明确授权并留下替代验证证据。

## 6. 状态文档与 session-log

- `.claude/session-log.md` 仅保留历史稀疏索引，不是每个 PR 的必改文件，也不承载实时状态。
- Backlog、Release、Decision 文档只保存稳定决策、验收定义或 GitHub 查询入口，不复制 PR 状态、SHA、测试数量或 worktree 数量。
- 纯状态回填不单独开 PR。确有稳定决策变化时，在对应正文/ADR 中更新，而不是给旧快照“刷状态”。
- 历史台账和旧指南保留取证价值，但必须带醒目的 SUPERSEDED 头，且不能重新进入权威链。

## 7. 启动与交接清单

1. fetch origin，记录 `origin/master`。
2. 运行 preflight，确认 develop/review 模式、目标 ref、所有权和 excluded files。
3. 用 `gh pr list` / `gh pr view` 读取当前依赖与在途 PR；不要从仓库快照推断。
4. 提交前运行相关自测、构建纪律闸与 `git diff --check`，复核无 DB、env、token、临时日志或越界文件。
5. 开 PR 后只交接 PR URL 与查询入口；等待独立复核和 PM 合并批准。

> 需求→mockup→写码→真跑验收各阶段的质量循环见 `docs/COREONE-质量Loop总览-2026-07-12.md`（方法论细化；合并门、所有权与依赖仍以本文与 GitHub 现场为准，质量循环不构成 required 门）。

## PM 大白话

PR 的实时进度以后只看 GitHub，不再维护一张很快过期的大看板。仓库里只留下不会频繁变化的规则：谁拥有哪些文件、依赖谁、怎么验收、谁有权合并。
