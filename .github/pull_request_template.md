<!--
跨工具契约见 docs/agent-operating-contract.md，PR 稳定规则见 .claude/rules/pr-governance.md。
实时 open/merged/checks 真相以 GitHub / `gh` 为准；下列字段是本任务 handoff，不是全仓实时看板。
-->

## Issue / 会话交接
<!--
完整交付：Issue 填 Closes #N；部分交付/仅关联：填 Refs #N。
未完成 follow-up 只能填“无”或“#N — 一句话说明”，不能只写“以后处理”；请直接替换下划线。
规则与示例：docs/github-issue-pr-management-loop.md#4-pr-与多会话交接合同
-->
- **Issue**: `Closes #N` / `Refs #N`
- **当前 owner / 模型**: _
- **交接状态**: _（实现中 / 待复核 / 待 PM / 待验收 / 阻塞 / 可合并）
- **下一 owner / 触发条件**: _
- **未完成 follow-up**: _

## 任务身份
- **task id**:
- **owner / author**:
- **reviewer**:
- **base SHA**:
- **worktree**:

## 变更摘要
<!-- 一句话说清做了什么、为什么 -->
- **当前状态 → 目标状态**:

## 文件所有权
- **owned files**:
- **excluded files**:
- **ABC / 共享事实链影响**:

## Base / 栈位置
- **base**: `<branch>`（= 真实依赖的上游分支，非图省事 base 到 master）
- **栈位置**: 第 _ 层；上游=`#_` 下游=`#_`

## 依赖与关系
- **Depends on（必须先合）**: `#_`
- **Supersedes / 完成**: 完成 `#_` 的 …部分 / 取代 `#_`（无则填「无」）
- **合并前提**: [ ] 单独可合　[ ] ⚠️ 不可单独合并（说明：必须在 `#_` 之后/一起）

## 合并顺序
- merge-order: `_`（合并前从 GitHub 现场核对是否为当前最上游可合项）

## 消费者与入口（构建纪律闸 · P0 设计选择 #7「完成=消费者被服务」，见 scripts/build-discipline/README.md）
<!-- 本 PR 若新增/改动 前端 API 调用、后端路由、或持久化配置字段，逐项答；否则填「不涉及」。 -->
- **新增后端路由的消费者是谁 / 入口在哪**：`<前端调用/定时任务/内部引用>`（若「暂无」→ 必须登进 `scripts/build-discipline/consumer-whitelist.json` 带 owner+孵化死线）
- **新增前端调用命中的后端路由**：`routes/<file>.ts:<line>`（避免幽灵 404）
- **新增配置字段的读取点**：`<引擎/工具文件>`（UI 让人设的口径参数须真有计算读它，别做 allocation_base 型空转旋钮）
- **若暂无消费者 → 孵化死线**：`YYYY-MM-DD`（到期仍无消费者，默认删）

## 验证
- BDD / 验收：_
- 测试与真数据 / golden 证据：_
- tsc / lint：_
- 构建纪律闸：`node scripts/build-discipline/run-all.cjs` 无**新增**违规（C1 幽灵404 / C2 无消费者 / C3 空转参数）
- agent preflight / drift check：_
- `git diff --check`：_

## 迁移、回滚与边界
- **迁移方式**:
- **回滚方式**:
- **未覆盖边界**:
- **merge authority**: required checks + 异构复核 + PM 明确批准；实现代理不得自动合并。

## 合并后动作（如适用）
- [ ] 重定向下游 PR 的 base（若本 PR 是其上游）
- [ ] 若需仓库内长期承接，更新本任务独立 handoff；不追加共享大状态文件。
