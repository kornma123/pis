# COREONE BOM 版本化 + 对账核准链 — 实施计划（2026-06-26）

> 目标线：`coreone-audit-p0`（master 线，分支 `frontend/ui-redesign`）
> 蓝本线（只读参考）：`进销存`（孤儿线，已有成熟 BOM 版本化子系统）
> 核心目标：消除"静默 + 无授权 + 追溯性"BOM 覆写。让每一次标准用量变更做到：(a) 版本化（快照+diff+变更日志），(b) 范围可控（future_only vs retroactive + 影响摘要），(c) 走核准（propose→approve，提交人≠审核人 = SoD），(d) RBAC 正确（pathologist 不可写；approve 限成本负责人/admin）。
> 来源：调研 [选题二 gap 分析](COREONE-非ABC调研-选题二-消耗对账核准链-gap分析-2026-06-26.md)（H1/H2 核准链+回写治理）；规划经 Plan agent 逐条读码核实（master 线 + 孤儿线蓝本）。

---

## 0. 现状核实结论（已逐条读码确认）

| 事实 | 证据（TARGET 文件:行） | 结论 |
|---|---|---|
| TARGET 无 `bom_versions` 表 | `database/DatabaseManager.ts` 全表无该 CREATE | 需新建 |
| `outbound_abc_details.bom_version_id` 列已存在但永不写 | `DatabaseManager.ts:710`（列在）；`cost-runs.ts:77-112` 与 `outbound-v1.1.ts:310-337` 两处 INSERT 均不含该列 | 列在、写路径缺失 |
| BOM 写守卫为 admin | `bom-v1.1.ts:8` `requireBomWrite = requireRole('admin')` | POST/PUT 仅 admin 能过 |
| 成本引擎实时直读 `bom_items.usage_per_sample` | `cost-calculator.ts:583-588`（`calculateMaterialCost`）；`outbound-v1.1.ts:227/254`；`cost-runs.ts` 经 `calculateMaterialCost` | BOM 改动会追溯改变已核算出库的重算结果 |
| `source_snapshot` 写但从不回读 | 写：`cost-runs.ts:111`、`outbound-v1.1.ts:330`；读：无 | 仅留痕，不参与计算 |
| 对账 POST `/logs` 静默覆写 `bom_items.usage_per_sample` | `reconciliation-v1.1.ts:429-434` | 无核准、无快照 |
| 对账可达角色 | `app.ts:92` `admin,pathologist,finance,technician` | pathologist 可写，违反 SoD |
| `reconciliation_logs` 无 status 列 | `DatabaseManager.ts:279-290`（仅事后审计字段） | 需补 status 工作流列 |
| 前端 handleFixBom 直连 POST /logs | `前端代码/src/pages/reconciliation/hooks/useReconciliationPage.ts:246-277` | 提示"BOM用量已修正" |
| 黄金护栏存在且**未 skip** | `tests/integration/abc-golden-accuracy.test.ts`（describe 在 116/241/370/442/507/560 行均为活动态）| 钉死 materialCost=100 / costPerSlide=120 / 完全吸收 |
| 其他护栏 | `tests/integration/abc-cost.test.ts`、`utils/abc-calculator.test.ts`、`tests/integration/outbound-abc-hook.test.ts`、`tests/p0-06-reconciliation.test.ts`、`tests/p1-01-bom-auxiliary-skip.test.ts` | 全部存在 |

**关键结构性差异（决定"移植"还是"改写"）**：
- 蓝本 `bom-v1.1.ts` ≈1479 行，BOM 是富模型（`bom_items` + `bom_general_reagents` + `bom_general_consumables` + `bom_quality_controls` + `bom_equipment_templates`）。蓝本 `buildBomVersionSnapshot` 快照全部 5 张子表。
- TARGET `bom-v1.1.ts` ≈143 行，BOM 是极简模型（仅 `boms` + `bom_items`）。
- **因此 `buildBomVersionSnapshot` 必须按 TARGET 结构改写（只快照 `boms` 字段 + `bom_items`），不可逐行照搬蓝本。** 其余版本化纯函数（diff/summarize/normalizeEffectiveScope/versionNumber/buildBomChangeImpact/runRetroactiveBomRecalculation）可近乎照搬（只依赖 snapshot 形状 + `runCostRecalculation`，TARGET 已有 `cost-runs.ts:122`）。

**黄金测试为何不被前 4 个 Phase 触发**：黄金测试**直接 INSERT `bom_items` 并直接调用 `calculateSlideCostWithFee`/`calculateMaterialCost`**，不经 BOM HTTP 路由、不经对账 /logs。只要不改 `calculateMaterialCost`/`calculateSlideCostWithFee` 口径，Phase 1–4 不动黄金断言。**本计划刻意不改引擎口径**，只在外围加版本化/核准编排。

**已有可复用范式（TARGET 自带，无需从蓝本搬）**：
- propose→approve + SoD：`abc-v1.1.ts:2479-2599`（`/adjustments` create pending → approve|reject），SoD 助手 `ensureAdjustmentReviewerDifferent`（`abc-v1.1.ts:328-332`）。对账核准链**镜像此范式**。
- 成本写权限守卫：`requireCostWorkbenchAccess`（`middleware/auth.ts:140-160`，admin/finance）= approve 安全默认。
- 幂等建表/补列：`ensureColumn`（`DatabaseManager.ts:353-358`）。

---

## 1. 阶段总览

| Phase | 名称 | 触碰文件数 | 风险 | 黄金风险 |
|---|---|---|---|---|
| P1 | Schema：bom_versions + reconciliation_logs 工作流列 | 1 | 低 | 无（纯 ADD） |
| P2 | 版本快照写入（BOM POST/PUT 落版本） | 1（+1新util） | 低 | 无（不改引擎） |
| P3 | 对账 propose→approve（核心） | 3 | **高** | 间接 |
| P4 | 追溯重算编排（approve→retroactive recalc） | 2 | **高** | **直接相邻** |
| P5 | bom_version_id 回填 | 2 | 中 | 间接 |
| P6 | RBAC 收口（移除 pathologist 写/审，approve 限 finance/admin） | 2 | 中 | 无 |
| P7 | 前端（已提交待审核 + 审批视图 + 隐藏自审） | 3 | 低 | 无 |

**TDD 总原则**：每 Phase 先写红测试 → 实现转绿 → 跑全量 `npm test`（`vitest run`）确认黄金+既有护栏全绿，再进入下一 Phase。

---

## 2. Phase 1 — Schema

**文件**：`database/DatabaseManager.ts`
1. 新建 `bom_versions`（移植蓝本 `DatabaseManager.ts:208-222`，CREATE IF NOT EXISTS；列：id, bom_id, version, snapshot, diff_summary, change_log, effective_scope DEFAULT 'future_only', impact_summary, changed_by, created_at, UNIQUE(bom_id,version)）。位置紧跟 `bom_items` CREATE。
2. `reconciliation_logs` 补工作流列（用 `ensureColumn` 幂等）：`status TEXT NOT NULL DEFAULT 'pending'`（pending|approved|rejected|applied）、`reviewed_by`、`reviewed_at`、`applied_bom_id`、`proposed_usage DECIMAL(18,4)`、`material_id`、`project_id`。
   > 提案信息只在请求体里，落库后无法重放 → 必须持久化 material_id/project_id/proposed_usage。

**先写测试**：`tests/p2-01-schema-bom-versions.test.ts`（表存在+列齐+二次 init 幂等不抛）。护栏：`outbound-abc-hook` + 黄金。
**风险**：低，纯 ADD。隐患：旧审计行 status 默认 pending 被审批视图误列 → 用新提案专用 `type='bom_fix_proposal'` + status 过滤隔离。

---

## 3. Phase 2 — 版本快照写入

**文件**：新增 `utils/bom-version.ts`；改 `routes/bom-v1.1.ts`（POST/PUT 末尾各落一次快照）。
**从蓝本移植**（改写为 TARGET 结构）：`buildBomVersionSnapshot`（**改写**：只 SELECT TARGET `boms` 实有字段 + `bom_items`）、`buildBomVersionDiff`/`summarizeBomVersionDiff`/`normalizeEffectiveScope`/`versionNumber`/`getLatestBomVersionSnapshot`/`getBomVersionHistory`/`writeBomVersionSnapshot`/`buildBomChangeImpact`/`runRetroactiveBomRecalculation`（后者 P2 仅定义，不触发）。
**接线**：POST `/` 落初始版本（change_log='初始版本'）；PUT `/:id` 取 previousSnapshot → 改 bom_items → `writeBomVersionSnapshot(...,{effectiveScope:'future_only'})`；用事务包裹（BEGIN IMMEDIATE/COMMIT/ROLLBACK）。
**先写测试**：`tests/p2-02-bom-version-snapshot.test.ts`（POST 落 1 版本、PUT 升 v1.1+diff）。护栏：黄金+p1-01+outbound-abc-hook。
**风险**：低，不改成本函数。

---

## 4. Phase 3 — 对账 propose→approve（核心）

**文件**：`routes/reconciliation-v1.1.ts`（改 POST /logs 语义 + 新增 approve/reject + 列表过滤）。
1. **POST `/logs` 改为只写 pending 提案，删除 `reconciliation-v1.1.ts:429-434` 的 UPDATE bom_items**：校验必填+newUsage≥0+reason 非空；记录 old_value（当前 usage）；INSERT `type='bom_fix_proposal'`/`status='pending'`/material_id/project_id/applied_bom_id/proposed_usage/old_value/reason/operator。返回 message"已提交待审核"。
2. **POST `/logs/:id/approve`**（镜像 `abc-v1.1.ts:2531-2564`）：非 pending→422；**SoD**：`row.operator===req.user.username → 403 SELF_REVIEW_FORBIDDEN`；事务内：乐观锁校验现值==old_value（否则 409）→ 取 previousSnapshot → UPDATE bom_items → `writeBomVersionSnapshot(effectiveScope, impactSummary)` → log status='applied'+reviewed_by/at。
3. **POST `/logs/:id/reject`**：status='rejected'，不动 BOM。
4. **GET `/logs` 增 status 过滤**，审批视图默认 `status='pending' AND type='bom_fix_proposal'`。

**先写测试**：`tests/p3-01-reconciliation-propose-approve.test.ts`（pending 不动 bom_items / 他人 approve 生效+落版本 / 自审 403 / reject 不变 / 乐观锁 409）。护栏：`p0-06-reconciliation`（GET /materials 不受影响）+ 黄金。
**风险**：**高（语义反转）**。POST /logs 从"立即生效"变"待审" → 破坏依赖即时生效的调用方。已确认后端 tests 无依赖旧覆写；前端唯一调用点 `useReconciliationPage.ts:253`（P7 改）。**不碰成本引擎 → 黄金不受影响。**

---

## 5. Phase 4 — 追溯重算编排（黄金相邻，最危险）

**文件**：`routes/reconciliation-v1.1.ts`（approve 接通追溯）；`utils/bom-version.ts`（runRetroactiveBomRecalculation）。
**改动**：approve 落版本后若 `effectiveScope==='retroactive'`：`buildBomChangeImpact` 得每月 recalculable（period_status!=='closed'）→ `runRetroactiveBomRecalculation` 对未关账月触发 `runCostRecalculation(db, ym, reviewer, 'bom_retroactive_recalculate')`（`cost-runs.ts:122`）；已关账月不重算→提示走调整单（`abc-v1.1.ts:2479` 既有通道）。`future_only`→完全不动历史。返回 retroactiveRuns + impactSummary。
**先写测试**：`tests/p4-01-retroactive-recalc.test.ts`（future_only→历史不变 / retroactive 未关账→重算反映新用量 / retroactive 已关账→不重算+requiresRecalculation）。**护栏（最关键）**：黄金全 6 describe + abc-cost + abc-calculator 必须全绿（`runCostRecalculation`→`writeOutboundAbcSnapshot`→`calculateSlideCostWithFee` 是黄金钉死同链，本 Phase 只编排不改口径）。
**风险**：**最高**。直接调 `runCostRecalculation`（黄金第 560 行回归覆盖同链）。缓解：future_only 默认；按既有事务/期间状态机不旁路；关账月一律拒绝。

---

## 6. Phase 5 — bom_version_id 回填

**文件**：`utils/cost-runs.ts`（writeOutboundAbcSnapshot INSERT）；`routes/outbound-v1.1.ts`（内联 INSERT）。**无蓝本可抄（净新增设计）**。
**改动**：新增 `getActiveBomVersionId(db, bomId)`（取最新 version 行 id，无则 null）；两处 INSERT outbound_abc_details 各加列 `bom_version_id = getActiveBomVersionId(...)`。语义：出库/核算时钉到当时活跃版本；future_only 变更后旧行仍指旧版本 id（历史可复现）；retroactive 重算刷新。
**先写测试**：`tests/p5-01-bom-version-id.test.ts`（出库后=当前活跃版本 / 无版本→null 不报错）。护栏：outbound-abc-hook 原断言绿。
**风险**：中。两处 INSERT 必须同步改（漏一处 column count mismatch）。可空→历史 BOM 安全降级。黄金 seed 不落 bom_versions → bom_version_id=null 仍绿。

---

## 7. Phase 6 — RBAC 收口

**文件**：`app.ts`（对账挂载角色）；`routes/reconciliation-v1.1.ts`（approve 端点守卫）。
**改动**：对账写类（POST /logs, approve, reject）propose 可达=`admin,finance,technician`（移除 pathologist 写），GET 视图保持宽角色；approve/reject 端点守卫 `requireRole('admin','finance')`（与 `requireCostWorkbenchAccess` 一致的安全默认）。BOM 写本就仅 admin（`bom-v1.1.ts:8`），无需额外改。
**先写测试**：`tests/p6-01-reconciliation-rbac.test.ts`（pathologist POST /logs→403 / technician propose 可但 approve→403 / finance approve→200 / admin approve→200）。护栏：`p0-06-reconciliation`（GET /materials）。
**风险**：中。改角色破 E2E 权限矩阵。缓解：与 RBAC pass 协同，先取安全默认。

---

## 8. Phase 7 — 前端

**文件**：`useReconciliationPage.ts`（handleFixBom 文案+不再即生效刷新）；`FixBomModal.tsx`（提交文案/effectiveScope 选择）；`LogListTab.tsx`（审批列 approve/reject 按状态展示，自提案隐藏 approve）。
**风险**：低（隔离对账页）。

---

## 9. MVP vs 后续 切割线

**MVP（最小可信核准链）**：P1 Schema、P2 版本快照、P3 propose→approve+SoD、P6 RBAC、P7 前端。→ 消除"静默+无授权"覆写，达成 (a)(c)(d)，且 **approve 固定 future_only、完全不碰黄金钉死的重算链**。
**后续（高风险，单独 PR + 单跑全黄金）**：P4 追溯重算（黄金相邻）、P5 bom_version_id 回填（净新增）。MVP 阶段 retroactive 选项灰置。
> 切割理由：(a)(c)(d) 用 future_only 即达成（低黄金风险高业务价值）；(b) 的 retroactive 是唯一重跑黄金链的部分，隔离到后续让 MVP 快速落地。

---

## 10. 风险登记（汇总）

| 风险 | Phase | 等级 | 缓解 |
|---|---|---|---|
| 追溯重算改动黄金钉死的 `runCostRecalculation` 链 | P4 | 高 | 不改引擎口径；future_only 默认；每次实跑全黄金 |
| POST /logs 语义反转破坏现有"即生效"假设 | P3 | 高 | 后端无依赖测试；前端单点 P7 同步 |
| 两处 outbound_abc_details INSERT 漏改一处 | P5 | 中 | 测试覆盖两条路径 |
| RBAC 改角色破坏 E2E 权限矩阵 | P6 | 中 | 与 RBAC pass 协同；安全默认 |
| 历史无版本 BOM 的 bom_version_id 空值 | P5 | 低 | 列可空、helper 返回 null 降级 |
| reconciliation_logs 历史行被审批视图误列 | P1/P3 | 低 | 新提案专用 type + status 过滤 |

---

## 11. 需用户拍板的决策点

1. **effectiveScope 默认值** → 建议 `future_only`（保守，历史不变）。retroactive 设显式高门槛。
2. **who-approves 角色** → 建议安全默认 `admin,finance`；是否引入专门 `cost_owner` 角色待 RBAC pass。
3. **关账月追溯策略** → 建议拒绝重算 + 提示走调整单（不在 MVP）。
4. **propose 可达角色** → 建议 `admin,finance,technician`（移除 pathologist 写）；technician 能否 propose 待确认。
5. **MVP 一次到位 vs 全 P1–P7 一气呵成** → MVP（P1-3,6,7）低黄金风险；P4/P5 是用户"建 versions 基础设施"诉求的核心（历史可复现），建议紧随 MVP 但单独 PR/单跑黄金。

---

## 12. 实施关键文件清单（TARGET 绝对路径）

- `后端代码/server/src/routes/reconciliation-v1.1.ts`（P3/P4/P6 核心）
- `后端代码/server/src/database/DatabaseManager.ts`（P1 schema）
- `后端代码/server/src/utils/cost-runs.ts`（P4/P5，黄金链相邻）
- `后端代码/server/src/routes/bom-v1.1.ts`（P2 版本快照接线）
- `后端代码/server/src/utils/bom-version.ts`（**新增**，版本化纯函数集中地）
- `前端代码/src/pages/reconciliation/{hooks/useReconciliationPage.ts, components/FixBomModal.tsx, components/LogListTab.tsx}`（P7）

---

*本计划经逐条读码核实；触碰成本引擎相邻链（P4/P5）须黄金用例全绿护栏。实施按 Phase 顺序 TDD。*
