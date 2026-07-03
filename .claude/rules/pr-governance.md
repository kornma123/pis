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
| — | [#27](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/27) | `feat/reconcile-phase1` → `master` | ✅ **MERGED**(2026-07-02, merge commit `5343b572`) | **独立**（非栈式，off 已合 #24 的 master；已 merge origin/master 消 doc 冲突）。账实复核+逐抗体成本 **Phase 1 核对引擎**：差异=账单片数vsLIS物理片数+匹配率门+6认定原因+补收gate+关账状态机+`account_reconcile` 权限模块（3 表，只读收入侧）。独立对抗复核修 3 项（HIGH 账单片数 floor / MED 孤儿补收单 / LOW 幂等）。tsc 绿 + vitest 76 files/557 tests 绿；golden ¥13,152+¥27,870 零回归。 | merge-order/1 |

> ✅ **#24 → #27 均已合并（2026-07-02）**：Phase 0 成本地基 + Phase 1 核对引擎落 master。#27 遗留的前端 `PERMISSION_MODULES`(30) vs 后端 `MODULES`(31) 漂移 → **由 #30 修**（补 `account_reconcile` 到 31）。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#30](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/30) | `feat/reconcile-phase2` → `master` | ✅ **MERGED**(2026-07-02, merge commit `393979a3`) | **独立**（非栈式，off 已合 #27 的 master；merge origin/master 消 #28/#29 带来的前端+doc 冲突：AppSidebar/permissions 保留双方 nav 项[账实核对+LIS 病例]、看板保留双方条目）。账实核对 **Phase 2 三页前端**（复核总览/工作台/补收追踪 + 关账状态机 UI）。走 **mockup 先行红线**：mockup 经真人拍板后落 React。含 `PERMISSION_MODULES` 30→**31** 补 `account_reconcile`（消 #27 遗留漂移，前后端 MODULES 31=31 对齐）；后端零改动。vitest required 绿(59s)；tsc+vite build 绿；真跑端到端过。golden 零回归。 | merge-order/1 |

> ✅ **#30 已合并（2026-07-02, merge commit `393979a3`）**：**账实复核+逐抗体成本三阶段全落 master**（#24 成本地基 → #27 核对引擎 → #30 三页前端）。前后端 `MODULES` 均 31、`PERMISSION_MODULES` 漂移清零。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#33](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/33) | `feat/reconcile-supplement-revenue` → `master` | ✅ **MERGED**(2026-07-02, merge commit `6e03daa6`) | **独立**（非栈式，off #30 收官后的 master `0b662efe`）。补齐 Phase 2 已披露边界：**补收→计入本月实收**（已补收按实验室工序行扣率折实收、计入 collected_month；反向/放弃清零）。只读收入侧算扣率·**不写 case_revenue**（保护 golden）。独立对抗复核修 3 项（HIGH 扣率改工序行·纠误诊 / HIGH 无双计不变量文档化 / LOW 放弃清折实收）。vitest required 绿(1m0s)·77 files/580 tests；golden 零回归；真跑端到端过。 | merge-order/1 |

> ✅ **#33 已合并（2026-07-02, merge commit `6e03daa6`）**：补收实收闭环落地——账实核对补收侧「已补收→计入本月实收（实验室工序行扣率）」贯通。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#35](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/35) | `feat/reconcile-reason-modal` → `master` | ✅ **MERGED**(2026-07-02, merge commit `07543ca7`) | **独立**（非栈式，off master `858f16fa`）。账实核对边界②：4 处反向操作（重新打开/反关账/放弃/恢复待补收）理由收集从浏览器 `prompt` → 系统内正式弹窗 `ReasonModal`。**纯前端 UX**·后端 API 零改动·留痕口径不变。vitest required 绿(1m1s)·tsc+vite build 绿；真跑端到端过。 | merge-order/1 |

> ✅ **#35 已合并（2026-07-02, merge commit `07543ca7`）**：反向操作正式弹窗落地（边界②完）。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#40](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/40) | `feat/reconcile-antibody-hints` → `master` | ✅ **MERGED**(2026-07-02, merge commit `47b11756`) | **独立**（非栈式，off master `2bdbbee7`）。账实核对边界③：**逐抗体细粒度初判**（同蜡块同抗体重复=返工·跨蜡块=多病灶）。**关键**：逐抗体明细表 `lis_case_markers` 早已随 LIS 导入落库，此前只详情页展示；本 PR 补对账消费端。只读 marker·**只写 reconcile_case_hints**·正交不改差异/认定/golden。独立对抗复核修 5 项（HIGH 线索独立区显 delta=0 也可见 / MED 白名单对齐+事务原子 / LOW distinct切片+蜡块号）。vitest required 绿(1m2s)·78 files/590 tests；golden 零回归；真跑端到端过。 | merge-order/1 |

> ✅ **#40 已合并（2026-07-02, merge commit `47b11756`）**：逐抗体初判落地——账实核对三条边界（①补收实收 #33 · ②反向弹窗 #35 · ③逐抗体初判 #40）落 master。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#45](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/45) | `feat/reconcile-overdue-free` → `master` | ✅ **MERGED**(2026-07-02, merge commit `c0c91f54`) | **独立**（非栈式，off 已合 #43 的 master）。账实核对**边界④「超期免费」**——**用户拍板口径：超期免费=财务判断，非系统硬规则**（不按跨月/N天/关账自动判）；「免费」暂态，医院日后同意补→改认定「漏收，需补收」即生成补收单。做法=**前端差异卡支持「改认定」翻转**（后端 verdict 端点本就支持重认定，此前仅前端锁死）；**未建完成时间管道**（财务已有信息，不越权硬判）。后端逻辑零改动·TDD 4 用例锁翻转不变量·真跑端到端(改认定→补收单¥300)。vitest required 绿(1m4s)；golden 零回归。 | merge-order/1 |

> ✅ **#45 已合并（2026-07-02, merge commit `c0c91f54`）**：账实核对边界④超期免费收官——**四条边界全部落地**（①补收实收 #33 · ②反向弹窗 #35 · ③逐抗体初判 #40 · ④超期免费翻转 #45）。**账实复核+逐抗体成本主线全部完成。**

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#50](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/50) | `feat/import-ux` → `master` | ✅ **MERGED**(2026-07-03, merge commit `a82e5203`) | **独立**（非栈式，off master `3a662d46`）。对账单导入前端优化（用户拍板 4 方向全做·mockup 先行）：**接缝打通**（向导内当场归类·带改基线提示）+**拖拽上传**+**行级预览**+**批量队列**（拖多家→自动认院[客户头模糊匹配·仅唯一命中]+自动认账期→逐家核对入库）+测试台简化=去重。**纯前端·后端零改动**。codex 读码修 2 HIGH 异步竞态 + 多 agent 对抗自审修 10 项（needConfirm 串项·LIS 预检回归·并发预览·ref 同步 等）。真跑：真温州对账单 42%→100%·批量 2 家自动认院·零报错。vitest required 绿(1m4s)·golden 不受影响。 | merge-order/1 |

> ✅ **#50 已合并（2026-07-03, merge commit `a82e5203`）**：对账单导入前端优化落 master（用户拍板并确认合并）。
> ⚠️ **其它 open PR（并行会话·非本线）**：`gh pr list` 现见 #37（LIS抗体名→台账映射）/ #39（D2 检测项目目录）/ #41（逐抗体成本弱锚校准线 F）——合并各自前按 `gh pr list` 核对，勿误合。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#25](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/25) | `claude/practical-mclaren-1a4747` → `master` | ✅ **MERGED**(2026-07-02, merge commit `46e2027d`) | **独立**（非栈式，无上下游）。修 #24 合入后遗留的前端漂移：角色权限编辑器 `PERMISSION_MODULES` 27→30，补 `antibody_cost`/`partners`/`partner_pricing`（此前 UI 无法按角色授予/撤销这 3 个模块）。scope 仅一处前端 UI 常量，后端零改动。逐 key 比对后端 `MODULES` 30=30、顺序一致；前端 tsc 绿；vitest required check 绿(1m3s)。 | merge-order/1 |

> ✅ **#25 已合并（2026-07-02，merge commit `46e2027d`）**：独立 PR，vitest required check 绿(1m3s)后落 master（e2e 非 required，pending 不阻断）。至此前端 `PERMISSION_MODULES` 与后端 `MODULES` 均 30，漂移清零。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#26](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/26) | `chore/gitignore-skills-runtime` → `master` | ✅ **MERGED**(2026-07-02, merge commit `aeee4cb5`) | **独立**（非栈式，无上下游）。`.gitignore` 补 `.claude/skills-runtime/`（技能运行时 venv，非仓库产物；#24/#25 两会话均遇 `git add -A` 误纳）。零代码影响，仅忽略规则。e2e+vitest 均绿。 | merge-order/1 |

> ✅ **#26 已合并（2026-07-02, merge commit `aeee4cb5`）**：独立 PR，纯 `.gitignore` 忽略规则，零代码影响。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#28](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/28) | `feat/lis-import-to-master` → `master` | ✅ **MERGED**(2026-07-02, merge commit `4f7177a7`) | **独立**（非栈式，无上下游）。LIS 病例导入功能（列表/详情/整屏导入，`lis-cases/` 页 + `lis-cases-v1.1` 路由 + `lis-import` util）+ 迁移 phase2 显示层·配置口径到 master（含 split/diagnosis 四态建线、admin 写入门禁 `caliberSignature`、批一口径/告警疲劳/LIS预检）。**取代 #21**（见下）。 | merge-order/1 |
| — | [#21](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/21) | `feat/phase2-config-split` → `master` | 🔴 **CLOSED-superseded**(2026-07-02) | **已被 #28 + #27 完全取代，零内容丢失**（逐提交 patch/内容核验：LIS页/配置四态随 #28、split/diagnosis 建线与 admin 门禁 master 逐字一致、import-score+三导入页完全一致、TS 债 patch-id 同 #23）。分支建于今晨早于 #24/#25/#27/#28，严重落后 master，**只能关不能合**（原样合并会删 #27/#24/#19/#25 的活）。 | — |

> ✅ **#28 已合并（2026-07-02, merge commit `4f7177a7`）**：LIS 病例导入权威实现 + phase2 配置口径迁移。
> 🔴 **#21 CLOSED（2026-07-02, 14:43）**：被 #28+#27 取代，关闭时附逐提交核验说明（见 PR 评论），无内容丢失。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#32](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/32) | `claude/eloquent-lichterman-af4db5` → `master` | ✅ **MERGED**(2026-07-02, merge commit `6a8e69bd`) | **独立**（非栈式，无上下游）。纯文档：新增 `docs/COREONE-基础模块-实现任务拆分-2026-07-02.md`——把账实复核+逐抗体成本未决清单里的**基础模块（成本侧）**项拆成三条互不碰文件的独立线（A 抗体名称映射 / D 统一检测项目目录 / F G2 弱锚校准+承重墙口径），供多会话并行；明确排除对账引擎/前端三页/收入侧/独立复核。零代码·golden 零回归。 | merge-order/1 |

> ✅ **#32 已合并（2026-07-02, merge commit `6a8e69bd`）**：成本侧基础模块拆分边界表落 master。三线 chip：A 运行中·ultracode；D `task_a65bcaab`；F `task_b514b2ae`。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#38](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/38) | `claude/eloquent-lichterman-af4db5` → `master` | 🟢 **OPEN**(2026-07-02) | **独立**（非栈式，无上下游）。纯文档：新增 `docs/COREONE-进销存修流程-实现任务拆分-2026-07-02.md`——进销存基础流程 backlog **核实先行**（ultracode Workflow `w1yoz1dxl` 逐模块核当前 master 真实状态：入库/退货供应商/采购三模块已做→丢弃），真剩 **wave-1 四线**（C 调拨退库报废[唯一动 schema]/E 预警/A 库存盘点/B 出库排序）互不碰文件、已分派 ultracode chip；wave-2（D 主数据/F BOM）等 PM 口径。**单独可合**·零代码·golden 零回归。 | merge-order/1 |

> 🟢 **#38 OPEN（2026-07-02）**：进销存修流程 wave-1 拆分边界表。四线 chip：C `task_9b1bf9c5`·E `task_f68fd867`·A `task_9b77fcb3`·B `task_0d75ee19`（均 ultracode）。核实丢弃：入库 IN-03/05/06 已修、退货供应商已完整、采购菜单/路由/页面都在。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#48](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/48) | `claude/brave-bassi-4bdd83` → `master` | 🟢 **OPEN**(2026-07-02) | **独立**（非栈式，无上下游）。Lane E「预警做真」评审衍生：`alerts-v1.1.ts` 两写端点(handle/generate)权限口径复核。**评估=有意口径非缺口→维持 R**（全部非 admin 角色仅 alerts:R 无 W，裸加 W 会令除 admin 外全部 403；敏感阈值配置 PUT /rules/:id 已 W+admin 锁；全站 auditWrite 已留痕）。仅加口径注释 + 回归门禁 `bv-alerts-write-rbac.test.ts`（**变异测试证有效**：临时加 W→3 个 R 级用例翻 403）。scope 仅 alerts+测试。**单独可合**·无功能变更·vitest 79/594 绿·golden ¥13,152+¥27,870 零回归。 | merge-order/1 |

> 🟢 **#48 OPEN（2026-07-02）**：预警写操作 RBAC 口径固化（维持 R）。源于 #38 的 wave-1 线 E「预警做真」评审。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#49](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/49) | `claude/goofy-wescoff-33d1e9` → `master` | 🟢 **OPEN**(2026-07-02) | **独立**（非栈式，无上下游）。Lane A 修流程·库存/盘点做真：**盘点单条改真两阶段**（create 只登记不入账→新增 `POST /:id/adjust` 才入账·受控原因白名单+幂等+防过期409+operator取token→DELETE 仅对已入账回滚）+ `DepletionTab`/`DepletedTab` 空态。batch 故意保持一阶段（受控落地）。仅动 stocktaking 域 9 文件·**不碰对账/LIS/成本/收入侧**。新增 TDD `stocktaking-two-phase.test.ts` 11 用例；后端 vitest **591 全绿**（golden ¥13,152+¥27,870 零回归、batch p1-04 零改动仍绿）；tsc+vite build 绿。独立复核：Workflow 五镜头修 2 项 + codex 异构确认无双计/漏账。**单独可合**。 | merge-order/1 |

> 🟢 **#49 OPEN（2026-07-02）**：Lane A 盘点两阶段+空态。等 vitest required check。**已披露边界**：批量盘点仍一阶段；无 inventory 行物料 adjust=UPDATE no-op（master 既有行为，未新增风险）。

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#52](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/52) | `claude/eloquent-fermat-da583d` → `master` | ✅ **MERGED**(2026-07-03, merge commit `78d7296d`) | **独立**（非栈式·Lane C 修流程）。退库/报废/调拨三页补全（筛选/统计卡/快速筛选/排序白名单/详情弹窗/批量/导出/URL 同步）+ **改正两处既有库存语义**（退库→加库存·调拨→总量不变移库·报废不变）。前后端独占文件；共享 `api/inventory.ts` 仅 3 块、`DatabaseManager.ts` 仅追加 Lane C 段；**未碰 Lane A/对账/成本**。vitest **78 files/597 tests 绿**·golden ¥13,152+¥27,870 零回归·真跑端到端过·codex 异构复核①②③⑤clean+④两处已处置。⚠️副作用：Lane A 入库页「调拨入库」同路由随之变移库(文案待 Lane A 改)。**单独可合**。 | merge-order/1 |

> ✅ **#52 MERGED（2026-07-03, merge commit `78d7296d`）**：Lane C「修流程」三页补全 + 库存语义改正落 master。合并前 `git merge origin/master` 消冲突（session-log append 两段都留；`api/inventory.ts`/`DatabaseManager.ts` 自动合双方改动都在），合后重跑 **vitest 88 files/744 tests 全绿**（我的 + 收官批其他线一起，golden 零回归）；PR vitest required check 绿(1m10s)后 merge commit 落 master。

**已合/关闭**：#30(2026-07-02 独立·merge commit `393979a3`)；#28(2026-07-02 独立·merge commit `4f7177a7`·取代#21)；#27(2026-07-02 独立·merge commit `5343b572`)；#26(2026-07-02 独立·merge commit `aeee4cb5`)；#25(2026-07-02 独立·merge commit `46e2027d`)；#24(2026-07-02 独立·merge commit `36b8dda4`)；#19(2026-07-02 独立·merge commit `cd83153e`)；#17→#18(2026-07-02 栈·均 merge commit)；#8→#10→#11(2026-06-30 merge commit 落 master)；#9 引擎(MERGED→#8 线)、#7/#6/#4/#3/#2 已并 master；#21(2026-07-02 CLOSED·被#28+#27取代)、#5/#1 CLOSED。

> ✅ **合并完成（2026-06-30，账单已修，"按序合栈+拆 e2e 债"）**：#8→#10→#11 依次 merge commit 落 master。**每步 e2e 复校**=三次跑均 **6 failed/251 passed、失败集完全一致**（supplier-returns 5 + auth-logout 1），全栈**零新增 e2e 失败**。这 6 个=master 既有 supplier-returns/auth bug（与本栈无关，已拆 task `c93e8188` 单独修；非 RBAC 403，权限本就授予）。黄金 ¥13,152 守住、后端联合 482 绿。
>
> **经验沉淀**：①栈式 PR 用 **merge commit**（保留共享历史→下游重定向 base 后免 rebase、diff 干净）。②base 改 master 后 e2e（`pull_request: branches:[master]`）不会自动触发→**推空提交**（`git commit-tree`/`--allow-empty`）触发。③e2e 非 required check，合并门禁靠人/看板，不靠 GitHub 阻断。

### 活跃 PR 看板 · D2 统一检测项目目录（地基线 D）

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#39](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/39) | `feat/project-catalog-d2` → `master` | 🟢 **OPEN**(2026-07-02) | **独立**（非栈式，无上下游；从 `origin/master` tip `0b662efe` 出发）。D2 只读对照层：`project_catalog`(26 标准项)+`code_mappings` 两新表 + 幂等种子（国标/LIS/对账单/项目码四套叫法→标准项 `PC-*`）+ 查询 util `project-catalog.ts` + **全只读**路由 `/api/v1/project-catalog`（复用 `projects` 权限，**不新增权限模块=零 MODULES 漂移**）。**不改任何现有分类**（classifier/case-charge-mapping/statement-revenue/收入侧/reconcile 均未碰，git diff 仅 6 文件）。tsc 绿 + vitest **78 files/620 tests 全绿**；黄金 ¥13,152+¥27,870 零回归；分类器真跑 514 真对账单名（未覆盖仅 22=临床非病理项）；异构 codex+3-lens workflow 双轨复核修 4 真 bug（见 session-log）。 | merge-order/1 |

> 🟢 **D2 PR #39 OPEN（2026-07-02）**：独立·非栈·单独可合，等 vitest required check。合并后系统首次有「四套叫法↔同一项目」的对照地基（只读并存，供后续对账会话决定是否消费）。

### 收官批：进销存修流程 wave-1 + 逐抗体成本基础模块 —— 7 线全落 master（2026-07-03）

> ⚠️ **本节为权威收官记录**：上方 #38/#39/#48/#49 的 🟢OPEN 行已随本批合并**作废，以本节为准**（那些行是各线会话开 PR 时写的，未回填 MERGED）。

| PR | 线 | 状态 | merge commit | 备注 |
|---|---|---|---|---|
| [#37](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/37) | A·抗体名映射(A1+A3) | ✅ MERGED | `96a55b5d` | 成本侧。**手工消解** `antibody-cost-v1.1.ts`（与 #41 同文件）：保留双方 import + 响应对象 `resolution`+`meta` 双键。 |
| [#39](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/39) | D·统一检测项目目录 | ✅ MERGED | `3be2f840` | 只读对照层，零 MODULES 漂移。 |
| [#41](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/41) | F·G2校准+承重墙(B3+B4) | ✅ MERGED | `285db11f` | 成本侧。诚实透出「G2估·待校准」。 |
| [#44](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/44) | E·预警做真 | ✅ MERGED | `eb5f484a` | **手工消解** `alerts-v1.1.ts`（与 #48 同文件）：保留口径注释 + `HANDLE_ACTIONS` 常量。 |
| [#47](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/47) | B·出库真排序 | ✅ MERGED | `2c1e9026` | 后端白名单排序+表头点击。 |
| [#48](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/48) | E衍生·预警RBAC口径 | ✅ MERGED | `2350d4eb` | 固化「写操作仅 alerts:R」+回归门禁。 |
| [#49](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/49) | A·库存/盘点做真 | ✅ MERGED | `e7f89f3f` | 盘点两阶段+Tab 空态。 |
| [#52](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/52) | **C·退库/报废/调拨三页**(第8条) | ✅ **MERGED** | `78d7296d` | 最大·mockup 先行·**改正库存语义**（退库→加库存·调拨→总量不变移库）。PM 授权 vitest 绿后合。合并前 merge master 消冲突、合后 vitest 88 files/744 全绿。见记忆 [[coreone-transfers-returns-stock-semantics]]。 |

> ✅ **7 线收官（2026-07-03）**：全部 vitest required 绿后 merge commit 落 master（tip `96a55b5d`）。合并纪律：**2 处代码冲突**（`antibody-cost-v1.1.ts` #37↔#41、`alerts-v1.1.ts` #44↔#48）**手工消解=保留双方意图**、vitest 复核；**治理文档冲突（session-log/本看板）统一取 master 版**避免 append 级联，各线 PR body/分支历史仍留详细记录，本节为 consolidated 账。golden ¥13,152+¥27,870 零回归。**第 8 条 Lane C #52 已合（2026-07-03, merge commit `78d7296d`）→ 8 线全落 master、当前无 open PR**。
>
> ✅ **#55 已合（2026-07-03, merge commit `43644011`）**：#52 文案尾巴——入库页 `type='transfer'` 标签「调拨入库」→「库位调拨」（对齐 #52 调拨=总量不变移库）。纯 UI 文案 5 处、零逻辑；frontend tsc+build 绿、vitest required 绿(1m13s)。**当前无 open PR。**

### 活跃 PR 看板 · 对账逐抗体初判 DRY 收敛（复用线 A resolver）

| 合并序 | PR | 分支 → base | 状态 | 关系 / 风险 | 标签 |
|---|---|---|---|---|---|
| — | [#57](https://github.com/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/pull/57) | `feat/reconcile-antibody-resolver-dry` → `master` | ✅ **MERGED**(2026-07-03, merge commit `e873e09b`) | **独立**（非栈式，off master `8a0afa8f`）。**低优先 DRY/健壮性**，非修 bug。对账「逐抗体初判」(#40) 两段自写抗体名逻辑改**委托线 A** `antibody-name-map.ts`(#37)：①`isRealAntibodyMarker` 名字兜底委托 `classifyMarker`（advice_type 白名单仍为主信号不变；无码时 免组HE/分子/特染也剔）②`classifyCaseHints` 分组键改 `normalizeAntibodyName`（Ki67/Ki-67 归一判返工）③**复用 `ambiguousNorm` 碰撞防护**（独立复核逮到 TCR(a/b)/TCR(G/D) 去克隆号撞键=seed 唯一歧义键→回退原始名不误并，防伪造双计费指控）。只改 reconcile 域 1 源文件+1 测试·**零改动** delta/认定/补收/golden。新增 13 TDD；vitest **88 files/740 tests 绿**·tsc 绿·golden ¥13,152+¥27,870 零回归（合后 detached 复跑 golden+hints 42 绿复核）。独立复核=codex 异构(inline)+Workflow 3-lens 对抗面板。 | merge-order/1 |

> ✅ **#57 已合并（2026-07-03, merge commit `e873e09b`）**：vitest required check 绿(SUCCESS)后 `--merge --admin`（e2e 非 required·pending 不阻断）落 master；合后 detached 复跑 golden+statement+hints+DRY 42 用例全绿复核、merge commit 双亲干净无并发漂移。源于本 task「对账逐抗体初判复用线 A 抗体名 resolver」。**已披露边界**：碰撞防护覆盖 seed 台账已识别歧义键（当前唯一=TCR），未进 seed 的新撞键抗体对不在防护内（属**漏判**保守 miss 非**伪造**，对已知数据零风险）；歧义抗体同例不同 raw 拼写不合并（benign miss）。合并后**当前无 open PR**。

## 5. 会话启动检查清单（30 秒）

1. `gh pr list --state open` 对一遍本看板，差异即更新看板。
2. 看有没有 `do-not-merge-alone` 的 PR 处在「即将被单独合」的风险位。
3. 要合并？→ 确认是当前最上游可合项 → 合 → 更新看板 + 重定向下游 base。

---

*与 `CLAUDE.md`、`coreone-guardrails.md`、`session-log.md` 配套。看板是唯一事实源，PR body/标签是其在 GitHub 的镜像。*
