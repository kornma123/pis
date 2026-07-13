# COREONE Agent Operating Contract / 跨工具工作机制契约

<!-- contract-id: coreone-agent-operating-contract/v1 -->
<!-- stable-rules-only -->

> 本文件是 Codex、Claude Code 及其他自动化工具共同遵守的运行契约。这里只放长期稳定的不变量；分支、提交、PR、检查结果和 worktree 数量等实时事实必须现场查询。

## 1. 权威链

发生冲突时按以下顺序处理：

1. 本契约：跨工具工作方式、所有权和权限边界。
2. `docs/工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md` 与 `docs/工作模型-COREONE项目版-2026-06-30.md`：讨论、摊假设、真数据、BDD/TDD、真人验收与独立复核。其在「需求→mockup→写码→真跑验收」主链与「报告/结论」横切各阶段的执行循环细化，见质量 Loop 家族唯一入口 `docs/COREONE-质量Loop总览-2026-07-12.md`（从属本条工作模型与本契约，冲突一律以后二者为准；只指路、不复制其规则，故不构成独立权威档位）。
3. `docs/golden-registry.md`：已登记的业务黄金锚及其机器断言。
4. `.claude/rules/coreone-guardrails.md`：活代码对应的安全、编码、数据库和测试护栏。
5. `.claude/rules/pr-governance.md`：稳定的 PR、依赖和合并纪律。
6. `.claude/rules/codex-cli-usage.md`：Codex 的工具特定用法。
7. 成本域任务再读取 `docs/COREONE-成本域文档-权威索引-2026-07-06.md`。

`AGENTS.md` 与 `CLAUDE.md` 只是工具适配入口，不得各自复制或改写这套规则。领域规格、ADR 和测试是对应业务事实的补充权威；它们不能覆盖本契约的协作边界。

## 2. 稳定规则与动态事实

| 稳定规则，可写入仓库 | 动态事实，必须现场读取 |
|---|---|
| 权威链、工作模式、文件所有权、验收方法、提交和合并权限 | 当前分支、base SHA、origin/master SHA、dirty 文件、worktree 列表 |
| golden 的登记规则与撤回流程 | 当前 PR 状态、检查结论、mergeability、review 状态 |
| handoff 字段、失败与阻塞处理 | 测试数量、最近一次运行结果、当前 backlog 完成度 |
| 稳定决策与 ADR | 某个会话“正在做什么”或某个 PR“现在是 OPEN/MERGED” |

实时 Git 事实来自 `git status`、`git rev-parse`、`git merge-base`；实时 PR 事实来自 `gh pr list`、`gh pr view`、`gh pr checks` 或 GitHub 页面。Backlog、Release、Decision 类文档只能保存稳定决策、验收定义或实时入口链接，不复制会快速漂移的状态。

## 3. 两种开工模式

### 新开发模式

1. 先在现有仓库执行 `git fetch origin`，记录现场的 `origin/master`。
2. 从该 `origin/master` 创建命名分支和独立 worktree；一个 worktree 只属于一个实现任务。
3. 开工前运行：

   ```bash
   node scripts/agent-preflight.cjs --mode=develop \
     --owned='<本任务文件或目录>' \
     --excluded='<明确禁止触碰的文件或目录>'
   ```

4. 落后 base、无共同历史、detached HEAD、禁止域有改动或出现任务外 dirty 文件时，不得继续实现。先换到合格 worktree，或把边界问题交回 owner。

### 只读审查模式

审查可以针对旧提交或孤立历史，但必须明确目标 ref，并从目标 ref 读取权威文件：

```bash
node scripts/agent-preflight.cjs --mode=review --target-ref='<待审 ref>'
```

旧树在审查模式中只产生清晰警告，不得被误当成新开发 base。审查任务默认不修改、不提交、不推送。

preflight 默认只读：不会 fetch、merge、rebase、prune、删除 worktree、暂存或改文件。可回收 worktree 只报告；是否清理由对应 owner 另行确认。

## 4. 所有权、scope 与 ABC 影响

- 一项文件同时只能有一个实现 owner；handoff 中列出 `owned files` 与 `excluded files`。另一模型负责独立复核，不在同一文件上代写。
- 每个代理同一时间最多维护一个实现 PR。审查可以并行，但不得顺手接管被审文件。
- 不切换、清理、覆盖或提交其他 worktree 的内容。只暂存本任务明确拥有的路径。
- 动手前做 scope 判断：若改动会影响库存、出库、BOM、成本、收入、权限或审计等共享事实链，必须说明 ABC/上游影响并补相应回归；无影响也要在 PR 中明确写出理由。
- 发现必须跨越 excluded files 或另一个 owner 才能完成时，先停在可验证边界，记录依赖与影响，等待 owner 或 PM 授权。

## 5. 讨论、BDD/TDD、真数据与 golden

- 先把假设、猜测、可能误解和需要 PM 判断的结果摊开；关键逻辑不得用常识自信填空。
- 先写能失败的 BDD/验收场景或 TDD 断言，再实现，再重构。修机制脚本同样先写自测。
- 碰钱、口径、数据模型或关键业务链时，使用真实或可审计的脱敏数据产出手核答案，并用独立守恒或对照证明；已登记 golden 必须保持机器断言有效。
- 纯文档或机制改动不伪造业务测试价值，但必须运行对应自测、漂移检查和 `git diff --check`。

## 6. 独立复核与完成定义

- 实现者负责产出；另一模型或不共享同一假设的视角负责复核。复核给出证据和可复现触发条件，不以“另一个 AI 说了”为证据。
- 完成至少包含：需求对应的验收、相关自动测试、dirty/边界复核、diff 检查、PR 依赖说明与未覆盖边界。
- UI 变更还需真人可判断的页面或 mockup；动态系统状态仍从 GitHub/Git 读取，不写回长期规则。

## 7. 提交、PR 与合并权限

- 提交只包含本任务 owned files，使用 Conventional Commit；不把 DB、环境文件、token、临时日志、运行产物或其他 owner 的改动带入。
- 开 PR 前再次 fetch，记录届时的 `origin/master`，吸收已合并的依赖并重跑相关验证。
- PR body 是该任务的实时 handoff 主体，至少包含：当前状态到目标状态、文件所有权、依赖、验收与证据、迁移/回滚、已知边界、merge authority。
- 实现代理可以提交、推送和开 PR；不得自动合并。合并只在 required checks 满足、异构复核完成且 PM 明确批准后执行。

## 8. 交接与状态合同

- 模板：`docs/agent-handoffs/TEMPLATE.md`。需要仓库内交接时，每个任务建立独立文件，不让并行任务共同追加一个大文件。
- PR body 优先承载仍在变化的任务状态；任务独立 handoff 文件用于稳定的验收、边界和证据。GitHub URL 只在具体任务 handoff 或 PR body 中保存。
- `.claude/session-log.md` 是历史稀疏索引，不是实时事实源，也不是每个实现 PR 的必改文件。已有历史保留取证价值；新任务只有在确需给长期索引增加一个稳定入口时才追加一条短指针。

## 9. 失败、阻塞与恢复

- 命令失败先记录原始错误、已验证事实和未验证假设；不要把超时、断流或环境失败说成产品失败。
- 验证无法执行时，明确缺失证据、影响范围和可恢复步骤；不得用文档宣称替代运行结果。
- 同一阻塞反复出现或需要扩权时，停止扩大修改，更新 handoff 的依赖/未覆盖边界，并请求 owner 或 PM 决策。
- 回滚以 PR 或提交边界为单位；不删除历史证据，不自动清理他人 worktree，不恢复孤儿分支上的旧“完成状态”。

## PM 大白话

这份契约的作用是：不管用 Codex 还是 Claude Code，大家先看同一张“交通规则”；实时进度去 GitHub 和 Git 查，不再靠一份会越写越乱的共享日志猜。脚本会在开工前拦住旧分支、孤儿线和越界文件，但不会替人自动合并或清理任何东西。
