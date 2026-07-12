# COREONE GitHub Issue / PR 项目管理闭环

> 目标：让产品经理、Codex、Claude Code 和其他模型看到同一条实时工作链；不再依靠散落在 PR body、评论或旧文档中的待办猜状态。

## 1. 哪个地方是主源

| 信息 | 唯一主源 | 其他地方怎么处理 |
|---|---|---|
| 当前 backlog、已接受的工作 owner、截止日、剩余 checklist | GitHub Issues | 文档和 PR 只放链接，不复制工作级实时状态 |
| 当前 PR、checks、是否合并 | GitHub Pull Requests / Actions | 必须现场读取，不写入长期规则文档 |
| PM 已拍板的稳定结论、重新拍板触发条件 | `docs/PM待拍板.md` 或其最新合并替代文件 | 不把它当第二份实时 backlog；变更由该文件 owner 的独立 PR 维护 |
| 每个实现任务的实时交接 | PR body | 独立 handoff 文件只保存稳定验收、边界和证据 |
| Git 分支、SHA、dirty 文件、worktree | Git 现场 | 不复制到全仓共享状态文档 |

Issue 记录“整项工作还剩什么”；PR body 记录“这一次交付由谁做到哪、下一会话何时接手”。PR 的 follow-up 字段只能放 Issue 链接，合并前必须回填到主 Issue 或新 Issue，不能在两处各养一份 checklist。

旧文档中的待办不能原样搬进 GitHub。创建 Issue 前必须实时核对开放 / 关闭 Issues、开放 PR、近期合并 PR、labels 和 milestones，并判断旧材料是否已经失效。

## 2. 单一分类与去重

每个 Issue 只选一个决定 owner 和关闭方式的主分类：

1. 事故 / 安全硬化；
2. 明确可实施的工程任务；
3. 需要 PM 决策的问题；
4. 有截止日期的治理债；
5. 外部运维依赖；
6. 已由现有 PR / 任务覆盖或已完成的事项。

第 6 类通常不再创建实现 Issue；确需跨任务看总状态时，只建一个父级 tracking，并链接真正的实施源。相关小项优先用一个 umbrella + checklist；风险、owner 或交付物不同才拆分。

Issue 必须包含：业务影响、来源链接、现状证据、范围、非范围、验收标准、依赖、优先级、建议 owner、截止时间或触发条件、与现有 PR / Issue 的关系。

## 3. PM 决策怎么走

需要 PM 拍板时使用“PM 决策”表单：

1. 先用非技术语言说明业务影响和推荐项；
2. 只给互斥的 A / B，或 A / B / C，并写清收益、代价和风险；
3. PM 在 Issue 评论中回复选项和条件；
4. 决策 owner 记录稳定结论与重新触发条件，并链接一个权威实施入口；确因不同 owner / 风险 / 交付物需要拆分时，由一个 umbrella 关联不重叠子 Issue；无需实施则不建；
5. 决策已记录、实施入口已建立后，关闭决策 Issue。工程完成由工程 Issue 自己判断。

推荐不等于决定。任何模型不得把技术偏好写成“PM 已同意”。

## 4. PR 与多会话交接合同

每个 PR 只能有一个主 Issue。除现有 PR 模板字段外，在 PR body 加上：

```md
## Issue / 会话交接
- **Issue**: Closes #<主 Issue 编号>
- **当前 owner / 模型**: <负责人 / 使用模型>
- **交接状态**: <实现中 / 待复核 / 待 PM / 待验收 / 阻塞 / 可合并>
- **下一 owner / 触发条件**: <谁在什么条件下接手>
- **未完成 follow-up**: 无
```

完整满足主 Issue 验收时使用 `Closes #N`；合入默认分支后由 GitHub 自动关闭。只完成一部分、只提供证据或只建立关联时使用 `Refs #N`，主 Issue 保持开放并更新 checklist。

未完成工作必须在 PR 合并前创建或关联 GitHub Issue：

```md
- **未完成 follow-up**: #<Issue 编号> — <一句话说明>
```

不能只写“以后处理”“后续优化”或把 TODO 留在评论 / 文档里。相关但不是主源的 PR / Issue 写到现有模板的“依赖与关系”，不要在主 Issue 字段堆多个编号。

跨会话或跨模型交接时，下一位执行者先读取主 Issue、PR body、最新 checks 和当前 Git 状态，再开始工作；不继承上一会话口头声称的“已完成”。同一文件同一时间只有一个实现 owner，复核模型不在被审文件上代写。

## 5. 自动检查做什么

`Issue / Handoff Contract` 在 PR 打开、正文编辑、代码更新、重新打开或转为 ready 时运行：

- 从默认分支读取可信 workflow 与 checker；
- 只 checkout PR 的 base SHA，不 checkout、安装或执行候选 PR 代码；
- 检查主 Issue、owner / 模型、交接状态、下一触发条件和 follow-up；
- 检查现有 PR 模板中的 task、文件所有权、验收、证据、迁移、回滚和边界字段不是空值或占位符；
- 实时确认引用编号属于本仓库、是开放 Issue 而不是 PR；
- 把唯一状态 `issue-handoff-contract` 发布到 PR head；用并发取消和发布前二次所有权检查降低旧 run 覆盖新结果的风险。Commit Status API 没有原子 compare-and-swap，因此不得把这一红绿灯夸大成单独的合并授权。
- checker / workflow 自身的候选改动由无 secrets、无写权限的 `Issue Handoff Integrity` 运行语法检查和确定性自测；可信 target workflow 仍只执行默认分支代码。

该 workflow 只有读取仓库 / Issue 和写 commit status 的最小权限，不读取业务 secrets、不评论、不合并、不改 Issue。除非 PM 另行批准修改分支保护并把该状态设为 required，否则它是可信、可见的红绿信号，但不能单独阻止合并。

红绿灯是最近一次 PR 事件的快照：Issue 之后被关闭不会自动触发重验；同一 SHA / context 的 GitHub Commit Status 也有平台配额。合并前仍要现场核对 Issue，并在正文编辑或代码更新后取得新结果。若未来要把它升级为 required，必须另行评估可更新的 Check Run、expected source 和 Issue 状态变化触发，不直接沿用当前轻量实现。

## 6. 合并与关闭规则

- 完整交付：PR body 使用 `Closes #N`；checks、异构复核和 PM 合并批准齐全后人工合并；GitHub 关闭主 Issue。
- 部分交付：使用 `Refs #N`；合并前更新主 Issue checklist、证据和下一触发条件，Issue 保持开放。
- 新 follow-up：合并前先搜索去重，再追加到现有 Issue 或创建一个克制的新 Issue；PR body 只保留链接。
- PM 决策：选项、条件和工程入口齐全后关闭决策 Issue，不等待工程 Issue 一起关闭。
- 父级 tracking：只有所有权威子项由各来源 owner 确认完成 / 不做后才关闭。
- 外部运维：生产规划、密钥轮换或外部系统接入被真实触发时，再创建具名 owner 的外部运维 Issue；仓库中不保存密钥。

## 7. 轻量维护节奏

- 每次 PR 合并前：执行一次 follow-up sweep，确认没有未入 Issue 的后续工作。
- 每周或每个交付窗口：先找没有任何 `kind/*` label 的 Issue，再结合 label 与 Issue 内“单一分类”字段，检查无 owner、无触发条件和长期无更新项；治理债提交后由 triage owner 人工挂到对应 milestone。
- 有截止日期的治理债：到期前两周检查 milestone，逐项确认 owner、交付 PR 或有限期续批。
- 文档与 GitHub 不一致：实时工作状态以 GitHub 为准；稳定决定由文档 owner 用独立小 PR 校准，不在并行任务中抢改。
- Project 仅在 Issue 数量或跨 milestone 视图确有需要时启用；小 backlog 使用 labels + milestone 即可。

## PM 大白话

以后每项工作都有一个“总单号”（Issue），每次交付都有一张“交接单”（PR body），没做完的部分必须先拿到新的单号。模型换了、会话断了，也能从同一个 Issue、PR 和检查结果接着做；文档负责记稳定决定，不再和 GitHub 各养一套会漂移的队列。

## 参考

- [GitHub：Issue forms 语法](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
- [GitHub：pull_request_target 事件语义](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)
- [GitHub：安全使用 pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
