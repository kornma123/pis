# COREONE 跨代理工作机制治理 — 审计与交接

> 本文件是本任务的独立 handoff，不是全仓实时状态源。PR/checks 以 GitHub 为准，分支/SHA/worktree 以 Git 为准。

## 身份与基线

- **task id**: `cross-agent-governance-2026-07-09`
- **owner / author**: Codex（分支 `codex/agent-operating-contract`）
- **reviewer**: 待 Claude Code / Codex 异构复核
- **首次 fetch 后 base SHA**: `87923aba78a69a240bf82bab637c06febf29e366`
- **worktree**: `/Users/maxiaoyuan/.codex/worktrees/agent-operating-contract/进销存`
- **PR URL**: 创建后以 GitHub / 最终回报为准
- **merge authority**: required checks + 异构复核 + PM 明确批准；本任务不自动合并

## 文件所有权

- **owned files**: 根入口/README、三份历史 Git/E2E 指南头、共用契约、handoff 模板与本文件、两份工作模型的交接段、guardrails 口径、PR 治理、session-log 头部、PR 模板、agent preflight/自测、build-discipline workflow/README。
- **excluded files**: auth、`middleware/auth`、DatabaseManager、docker-compose、环境/密钥/debug、backend/e2e/secret-scan workflows、入库/物料路由及测试、产品业务功能、成本算法、权限矩阵、tracked DB。
- **owner 规则**: 一项文件一个实现 owner；另一模型只复核不代写。本 owner 当前只维护这一条实现 PR。

## 现场审计：当前状态 → 目标状态

| 现场事实 | 风险 | 本任务目标 |
|---|---|---|
| Codex 读 AGENTS，Claude Code 读 CLAUDE；旧权威链还让一个入口依赖另一个入口 | 两份镜像会各自修补、再次冲突 | 两个 14 行薄入口都只指向 `docs/agent-operating-contract.md` |
| 开工新鲜度只有文字要求 | 旧 worktree/孤儿线能继续实现 | preflight 的 develop 模式对 behind、orphan、detached 和越界 dirty 判红 |
| review 与 develop 未区分 | 旧树审查被误当成可开工 base | review 模式允许旧 ref，但明确警告并从目标 ref 读权威 |
| guardrails 写“生产权限用 requireRole、所有路由用 express-validator” | 纸面强制项与活代码相反 | 对齐到生产 `requirePermission` + 具名授权组合子；输入验证服从活路由显式契约与测试 |
| 根 README 仍把旧 Git/E2E 指南当入口 | 直接推主线、批量暂存或本地重装浏览器等历史做法会复活 | README 移除入口；三份历史文件保留但加 SUPERSEDED 阻断头 |
| PR 治理文件混放稳定规则和逐 PR 历史看板 | 旧状态冒充实时 GitHub | 活文件只留稳定规则；旧台账通过归档和固定提交取证 |
| session-log 接近两千行且曾要求每任务追加 | 并行 PR 高频冲突、交接被历史噪声吞没 | 头部重定义为历史稀疏索引；PR body / 每任务 handoff 取代强制追加 |
| 无结构化跨模型 handoff | owner、边界、证据和 merge authority 容易丢 | 新模板覆盖 task/owner/reviewer/base/worktree/owned/excluded/依赖/BDD/证据/边界/PR/合并权 |

## 活代码取证

- 生产 `src/app.ts` 和路由挂载使用 `requirePermission(module, level)`；`requireRole()` 的生产侧只剩兼容函数定义，调用集中在旧测试脚手架。
- `后端代码/server/src` 内没有 `express-validator` import 或 `validationResult/body/query/param` 路由链；当前验证形态是各活路由的显式类型、范围、枚举/白名单与错误码契约。
- master 分支保护现场返回两个 required contexts；本任务只给既有 `gate` job 增加步骤，job id 不改。
- Build Discipline workflow 的 pull-request 触发没有文档路径过滤，因此纯文档 PR 仍会上报 required context，不会停在 Expected/Waiting。

## 设计

```text
AGENTS.md ─┐
           ├─> agent-operating-contract.md ─> 工作模型 / golden / guardrails / PR 规则
CLAUDE.md ─┘                 │
                             ├─> agent-preflight.cjs（开工/审查）
                             └─> 每任务 handoff + PR body（交接）

Build Discipline gate ─> preflight selftest ─> rule drift check ─> 原 C1-C5 自测与 gate
```

preflight 自身不联网也不改 Git；fetch 是操作者在 develop 前的显式动作。可回收 worktree 复用现有 GC 的 dry-run 判定，只输出候选。

## 场景验收矩阵

| 场景 | 模式 | 预期 verdict | 机器断言 |
|---|---|---:|---|
| fresh worktree | develop | PASS | branch 含最新本地 `origin/master`，权威和边界干净 |
| behind master | develop | FAIL | `HEAD..origin/master` 非空即阻断 |
| orphan branch | develop | FAIL | 与 base 无 merge-base 即阻断 |
| dirty-owned | develop | WARN | 允许继续核对，但逐项列出已改 owned files |
| foreign dirty files | develop | FAIL | 任务所有权之外的 dirty 路径阻断 |
| review old ref | review | WARN | 旧 ref 可审，但 authority source 必须等于目标 ref |
| Codex / Claude 两入口 | develop | PASS | 同一输入得到相同 contract path、rules digest 和 verdict |
| dynamic status in stable contract | rules | FAIL | 实际 SHA、PR URL、测试数量或 live PR ledger 不能进入稳定权威 |
| 旧 Git/E2E 指南无阻断头 | rules | FAIL | 缺 SUPERSEDED 或共用契约链接即阻断 |

## 验证证据

- `node scripts/agent-preflight.selftest.cjs`: fresh/behind/orphan/dirty-owned/dirty-foreign/review-old-ref/双入口/动态状态/旧规则/历史指南等场景全部通过。
- `node scripts/build-discipline/selftest.cjs`: 原 C1–C5 与 fail-closed 变异自测全部通过。
- `node scripts/build-discipline/run-all.cjs --block=C1,C2`: C1/C2 无新增违规，C4/C5 结构门通过；C3 保持既有 warn 口径。
- `node scripts/agent-preflight.cjs --mode=develop ...`: 当前只有 owned-dirty WARN，无 foreign/excluded dirty；全部权威与漂移检查通过。
- 默认 worktree 报告现场列出 14 个“可回收候选”，仅输出未删除；是否清理由各 owner 另行确认。
- `git diff --check`: 提交前执行并记录在 PR body。

## 迁移、回滚与未覆盖边界

- **迁移**: 合并后所有工具从根入口进入同一契约；旧指南留在原路径但被阻断；session-log 历史正文不搬迁。
- **回滚**: 以本 PR 的 merge/revert 为单位回滚；历史台账、旧指南和 session-log 证据不删除。
- **未覆盖边界**: preflight 不证明远端引用一定最新，develop 前仍需显式 fetch；静态漂移规则只守已知高风险模式，不替代人工领域审查；worktree 只报告候选不清理。

## PM 大白话

这轮不是改产品功能，而是把“AI 怎么开工、谁能改哪些文件、实时进度去哪看”做成同一套规则和一把会报红的开工检查。以后旧分支、孤儿线、越界文件和两套入口分叉，会在开始干活前就被点出来；任何合并和清理仍要人批准。
