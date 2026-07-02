# PR 治理规范（防止 PR 被忽视 / 错误合并）

> **优先级**：P0 — 强制。每个会话启动读 `session-log.md` 时，连带核对本文件「活跃 PR 看板」。
> ✅ **已收口到 master（2026-07-02）**：本文件随工作模型收口提交落 master，所有 worktree 均可读到这份 P0 治理规则。⚠️ 若同时存在 codex/abc 线的旧副本，以 **master 版为权威**（旧副本待退役）。
> **问题背景**：本项目长期是「栈式 PR」（一个 PR base 在另一个 PR 的 head 上，最终汇入 master）。
> 栈一深 + master 在动，就容易：①某个开着的 PR 被忘了 ②合并顺序错（先合上游导致下游 base 失效/冲突）
> ③一个「半成品」PR 被单独合进 master（如只修了一半的跨院串账）。本规范把「栈关系 / 合并顺序 / 依赖 / supersedes」
> 显式记录在三处：**PR 描述体 + GitHub 标签 + 本看板**，任一处都能独立看懂，避免踩雷。

## 1. 铁律

1. **base 政策**：新 PR 的 base = 它真实依赖的那个分支（通常是栈里的上一个 PR 的 head），不要图省事 base 到 master 而把上游的改动混进自己的 diff。
2. **栈式 PR 必须físicamente依赖**：下游 PR 的 base 设成上游 PR 的 head → GitHub 天然不允许下游先于上游合并，合并顺序被物理约束。
3. **「不可单独合并」必须显式标注**：任何「半成品 / 必须和另一个 PR 一起落地」的 PR，body 顶部加 `> ⚠️ 不可单独合并：必须在 #X 之后/一起合并（原因…）`，并打 `do-not-merge-alone` 标签。
4. **supersedes 必须显式**：若新 PR 重做/取代旧 PR 的某部分，旧 PR body 注明 `被 #Y 完成/取代`，新 PR body 注明 `完成/取代 #X 的 …部分`。
5. **合并顺序写下来**：见下方看板「合并顺序」。合并任意 PR 前，先核对它是不是当前可合的最上游项；合完一个就立刻更新看板 + 处理下游 PR 的 base 重定向。
6. **base 重定向**：当上游 PR 合进 master 后，其下游 PR 的 base 会悬空 → 立即把下游 PR 的 base 改到 master（或新的上游）并 rebase，再继续。
7. **会话边界**：会话启动先读看板；开/合/改任何 PR 后立即更新看板 + 受影响 PR 的 body/标签；会话结束在 `session-log` 留指针。

## 2. 新 PR 必填字段（PR body 模板，见 `.github/pull_request_template.md`）

- **Base / 栈位置**：base=`<branch>`；本 PR 在栈中的位置（第几层、上下游是谁）。
- **依赖（Depends on）**：`#X`（必须先合）。
- **Supersedes / 完成**：`完成 #X 的 … / 取代 #Y`（如有）。
- **合并前提**：单独可合 ✅ / ⚠️ 不可单独合并（说明）。
- **验证**：测试数/回归/关键不变量（如黄金 ¥13,152）。

## 3. GitHub 标签（轻量护栏，已建）

- `stacked`：栈式 PR（base 非 master）。
- `do-not-merge-alone`：不可单独合并（半成品/需配对）。
- `merge-order/N`：合并序号（N 小者先合）。
- `ready-to-merge`：前置已满足、可合（合并前再核看板）。

## 4. 活跃 PR 看板（唯一事实源，随开/合/改实时更新）

> 状态以 `gh pr list` 为准（每会话启动交叉核对），本表是「关系 + 顺序 + 风险」的人读视图。行内已带各自状态日期 + git log 可查，**不再单独维护标头时间戳**（原标头"更新时间：2026-06-29"与表内 2026-07-01 行自相矛盾，已删——防漂移文件自己别漂）。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| 1 | [#8](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/8) | `feat/partner-cost-profit` → `master` | ✅ **MERGED**(2026-06-30) | 栈底（W1–W7+引擎#9）落 master，merge commit。 | merge-order/1 |
| 2 | [#10](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/10) | `fix/codex-p0-p6` → `master` | ✅ **MERGED**(2026-06-30) | codex 25 项修复；e2e=6 既有失败零新增。跨院串账半截，全链路在 #11。 | merge-order/2 |
| 3 | [#11](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/11) | `feat/phase0-correctness` → `master` | ✅ **MERGED**(2026-06-30) | **完成 #10 跨院串账全链路** + 配置归一 + NGS 缺值；e2e 零新增；黄金 ¥13,152、后端 482。 | merge-order/3 |

> ✅ 旧栈全部落 master（2026-06-30，tip 1d4e1a50）。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| 1 | [#17](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/17) | `feat/phase2-lab-revenue-split` → `master` | ✅ **MERGED**(2026-07-02, merge commit `24d6eee0`) | Phase 2 纯实验室收入拆分；**并带来后端 golden CI 门禁**（`backend-tests.yml`）+ master 分支保护 required=vitest。vitest 绿(59s)；e2e 非必需（仅 auth+supplier-returns 既知失败，正交）。golden ¥27,870 + ¥13,152 零回归。 | merge-order/1 |
| 2 | [#18](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/18) | `feat/phase2-pnl-diagnosis` → `master` | ✅ **MERGED**(2026-07-02, merge commit `769f3f6d`) | 原栈第2层，#17 合并后 base 已重定向 master；diff 干净（仅诊断桶 +20/-5）；vitest + e2e 均绿。 | merge-order/2 |

> ✅ **该栈全部落 master（2026-07-02）**：#17 → #18 依次合入（均 merge commit），**当前无 open PR、栈已清空**。#17 顺带立了后端 golden CI 门禁（`backend-tests.yml`）+ master 分支保护 `required=vitest`。e2e 非 required check。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#19](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/19) | `claude/nervous-kilby-6788c2` → `master` | ✅ **MERGED**(2026-07-02, merge commit `cd83153e`) | **独立**（非栈式，无上下游）。审计收口：核实 admin 审计缺口=误报 + 新增全站写操作统一审计中间件（`middleware/audit-log.ts`，双轨/只记成功/脱敏）。vitest 绿(1m0s)；e2e 非必需。golden ¥27,870 + ¥13,152 零回归。 | merge-order/1 |

> ✅ **#19 已合并（2026-07-02）**：独立 PR，vitest required check 绿后 merge commit 落 master。合并后**当前无 open PR**。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#24](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/24) | `feat/reconcile-cost` → `master` | ✅ **MERGED**(2026-07-02, merge commit `36b8dda4`) | **独立**（非栈式，无上下游）。账实复核+逐抗体成本 **Phase 0 成本地基**：抗体库主数据+每片成本派生+192 种真台账 seed+`antibody_cost` 权限模块；与收入侧物理隔离。vitest required 绿(58s)；golden ¥13,152+¥27,870 零回归。合入后后端 `MODULES`→30；前端 `PERMISSION_MODULES` 漂移由 #25 修。 | merge-order/1 |
| — | [#27](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/27) | `feat/reconcile-phase1` → `master` | ✅ **MERGED**(2026-07-02, merge commit `5343b572`) | **独立**（非栈式，off 已合 #24 的 master；merge origin/master 消 #25 带来的 doc 冲突）。账实复核+逐抗体成本 **Phase 1 核对引擎**：差异=账单片数vsLIS物理片数+匹配率门+6认定原因+补收gate+关账状态机+`account_reconcile` 权限模块（3 表，只读收入侧）。独立对抗复核修 3 项（HIGH 账单片数 floor / MED 孤儿补收单 / LOW 幂等）。vitest required 绿(1m0s)；golden ¥13,152+¥27,870 零回归。 | merge-order/1 |

> ✅ **#24 → #27 均已合并（2026-07-02）**：Phase 0 成本地基 + Phase 1 核对引擎落 master。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#30](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/30) | `feat/reconcile-phase2` → `master` | 🟡 **OPEN**(2026-07-02) | **独立**（非栈式，off 已合 #27 的 master）。账实核对 **Phase 2 三页前端**（复核总览/工作台/补收追踪 + 关账状态机 UI）。走 **mockup 先行红线**：mockup 经真人拍板后落 React。纯前端新增页 + 3 处小改（含 `PERMISSION_MODULES` 30→**31** 补 `account_reconcile`，消 Phase 1 遗留漂移）；后端零改动。tsc + vite build 绿；**真跑端到端**（seed 演示院·登录·认定→补收 gate 口径正确·零报错）。golden 不受影响。**单独可合**。 | merge-order/1 |

> 🟡 **#30 OPEN（2026-07-02）**：Phase 2 三页前端，off 已合 #27 的 master，等 vitest required check（本 PR 后端零改动，风险为零；vitest 仍会跑）。合并后账实复核+逐抗体成本三阶段（成本地基→核对引擎→三页前端）全落地。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#25](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/25) | `claude/practical-mclaren-1a4747` → `master` | ✅ **MERGED**(2026-07-02, merge commit `46e2027d`) | **独立**（非栈式，无上下游）。修 #24 合入后遗留的前端漂移：角色权限编辑器 `PERMISSION_MODULES` 27→30，补 `antibody_cost`/`partners`/`partner_pricing`（此前 UI 无法按角色授予/撤销这 3 个模块）。scope 仅一处前端 UI 常量，后端零改动。逐 key 比对后端 `MODULES` 30=30、顺序一致；前端 tsc 绿；vitest required check 绿(1m3s)。 | merge-order/1 |

> ✅ **#25 已合并（2026-07-02，merge commit `46e2027d`）**：独立 PR，vitest required check 绿(1m3s)后落 master（e2e 非 required，pending 不阻断）。至此前端 `PERMISSION_MODULES` 与后端 `MODULES` 均 30，漂移清零。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#26](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/26) | `chore/gitignore-skills-runtime` → `master` | 🟡 **OPEN**(2026-07-02) | **独立**（非栈式，无上下游）。`.gitignore` 补 `.claude/skills-runtime/`（技能运行时 venv，非仓库产物；#24/#25 两会话均遇 `git add -A` 误纳）。零代码影响，仅忽略规则。**单独可合**。 | merge-order/1 |

> 🟡 **#26 OPEN（2026-07-02）**：独立 PR，纯 `.gitignore` 忽略规则，零代码影响。

**已合/关闭**：#27(2026-07-02 独立·merge commit `5343b572`)；#25(2026-07-02 独立·merge commit `46e2027d`)；#24(2026-07-02 独立·merge commit `36b8dda4`)；#19(2026-07-02 独立·merge commit `cd83153e`)；#17→#18(2026-07-02 栈·均 merge commit)；#8→#10→#11(2026-06-30 merge commit 落 master)；#9 引擎(MERGED→#8 线)、#7/#6/#4/#3/#2 已并 master；#5/#1 CLOSED。

> ✅ **合并完成（2026-06-30，账单已修，"按序合栈+拆 e2e 债"）**：#8→#10→#11 依次 merge commit 落 master。**每步 e2e 复校**=三次跑均 **6 failed/251 passed、失败集完全一致**（supplier-returns 5 + auth-logout 1），全栈**零新增 e2e 失败**。这 6 个=master 既有 supplier-returns/auth bug（与本栈无关，已拆 task `c93e8188` 单独修；非 RBAC 403，权限本就授予）。黄金 ¥13,152 守住、后端联合 482 绿。
>
> **经验沉淀**：①栈式 PR 用 **merge commit**（保留共享历史→下游重定向 base 后免 rebase、diff 干净）。②base 改 master 后 e2e（`pull_request: branches:[master]`）不会自动触发→**推空提交**（`git commit-tree`/`--allow-empty`）触发。③e2e 非 required check，合并门禁靠人/看板，不靠 GitHub 阻断。

## 5. 会话启动检查清单（30 秒）

1. `gh pr list --state open` 对一遍本看板，差异即更新看板。
2. 看有没有 `do-not-merge-alone` 的 PR 处在「即将被单独合」的风险位。
3. 要合并？→ 确认是当前最上游可合项 → 合 → 更新看板 + 重定向下游 base。

---

*与 `CLAUDE.md`、`coreone-guardrails.md`、`session-log.md` 配套。看板是唯一事实源，PR body/标签是其在 GitHub 的镜像。*
