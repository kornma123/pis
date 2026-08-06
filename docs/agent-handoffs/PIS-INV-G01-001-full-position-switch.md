# PIS-INV-G01-001 库存位置唯一真值全量切换 Handoff

> Graph ID: `PIS-INV-G01-001-FULL-SWITCH`
>
> 需求版本: `REQ-v1`
>
> 决策澄清: `skipped / pass`。PM 已在当前任务冻结关键产品决定；实现细节采用下文 fail-closed 默认。
>
> 风险: `R2 / schema + synthetic migration + inventory truth`

## 身份与基线

- **task id**: `PIS-INV-G01-001-FULL-SWITCH`
- **owner / author**: Codex root task `PIS-INV-G01-001`
- **reviewer**: 未参与实现的只读 reviewer；首轮对 `afff326e...` 返回 4 P1 + 1 P2，R2 对 `5b298630...` 确认原 finding 闭环并新命中 1 P2；新候选 `cf15d478...` 的 PM 限定定向收口复核已 PASS
- **delivery status**: `READY_FOR_PM_GATE`（不等于 GitHub、merge、真实迁移或 deploy 授权）
- **base SHA**: `e0cb8083d113ab5c9fc901fc16fb9265cf01243e`
- **fixed implementation candidate SHA**: `cf15d4789aa1e25d84c1d3f9e6581df917e3610f`
- **fixed implementation tree hash**: `96b99d96adc6e5cd7fbe0bc52b525158a42ca2d2`
- **worktree**: `/Users/maxiaoyuan/.codex/worktrees/a34c/进销存`
- **branch**: `codex/pis-inventory-position-full-switch-20260805`

## 固定权威与需求版本

- 产品权威: `pm编排@8c234173d6a2a4c6361389cadd29364933d1dbd2`
- 需求 handoff: `sha256:b1c066b7eb637362471fc9cf33ad6bb0637a09bdc1288436f66f32ffa338a8ac`
- 差距审计: `pm编排@0d9e32198ba1fe34fcd590a868ea659386c0d9b9`
- 旧审计与当前启动 base: `PIS@e0cb8083d113ab5c9fc901fc16fb9265cf01243e`
- 当前任务新增且优先的 PM 决定:
  1. `inventory_positions(material_id, optional batch_id, location_id)` 是唯一数量真值；`inventory.stock` 与 `batches.remaining` 只能在同一事务内由 position 汇总派生。
  2. 不允许先形成第三套会漂移的真值；现存所有实际会改变数量或位置的后端入口必须在同一切片接入统一计划器，或在补偿合同缺失时明确 fail closed。
  3. 出库、库存内报废、供应商退货等减少动作由系统按 `expiry_date → batch.created_at → batch identity → location identity` 自动 FEFO；请求不得钉住批次或库位；实际 allocation 必须持久化。
  4. 实验室退库优先回原出库 allocation 的原库位；没有可验证来源时请求必须提供显式目标库位。
  5. 容量以标准格位计算：每个 material 配 `units_per_package` 与 `slots_per_package`；每个库位/批次 position 独立向上取整。目标库位换算齐全且增加后超限则拒绝；目标库位任一在库物料或本次物料换算缺失则允许，但写入 capacity warning 事实。
  6. 调拨按指定数量在来源/目标位置间守恒；非批次物料保持 `batch_id IS NULL`；旧数据不能证明物料、批次、库位和总数一致时，合成迁移整体零写失败。
  7. 现有删除、取消或更新若需要精确逆转已生效事实，属于 G2 补偿链。本切片不得以软删除或原地覆盖冒充补偿；在完整补偿事件合同未纳入当前范围前，这些数量反转入口稳定返回 `COMPENSATION_CHAIN_REQUIRED` 且零业务写。
  8. PM 补充裁决：已完成出库单的 material/quantity 禁止直接修改，PUT 保持 `409 COMPENSATION_CHAIN_REQUIRED` 且不得改写库存、position 或原单；未来只通过独立更正/追加式补偿流程处理。因此 Issue #112 原 update 活跃路径已被 G2 边界移除。

## 目标、范围与不做

- **目标用户结果**: 仓库每一次增加、减少和移库只改变可定位的 position；总库存、批次余量和库位容量显示均从 position 同事务派生，不再出现“调拨 30 却整物料搬走”或扣减位置不可追溯。
- **范围内**:
  - position/schema、材料包装换算字段、位置 allocation/capacity warning 事实表；
  - 只对合成 SQLite fixture 运行的 legacy backfill；
  - 统一位置计划器与 cache 守恒校验；
  - 入库、出库、实验室退库、供应商退货、库存内报废、调拨；
  - 库存/库位读模型与继续保持 fail-closed 的盘点入口；
  - focused/full relevant、故障注入、mutation、build/gate、diff/scope 证据。
- **范围外**:
  - 前端实现或 mockup；
  - PM Harness 修改；
  - 真实数据库读取、backfill、迁移或部署；
  - G2 通用追加式事件/撤销/反补偿链；
  - Issue #60 的位置级盘点调整；
  - GitHub 写、push、PR、merge、Issue 关闭、发布。
- **不可接受**: 负 position；position/cache 漂移后继续写；部分调拨丢量；非批次制造假批次；FEFO 被请求覆盖；容量已知超限仍写；容量未知无留痕；迁移失败留下 partial；用软删除/覆盖宣称补偿完成。

## 文件所有权

- **owned files**:
  - `docs/agent-handoffs/PIS-INV-G01-001-full-position-switch.md`
  - `docs/agent-handoffs/PIS-INV-G01-001-effect-evidence.json`（仅记录 PIS 实效事实；不评价或修改 Harness）
  - `后端代码/server/src/database/DatabaseManager.ts`
  - `后端代码/server/src/services/inventory-transactions.ts`
  - `后端代码/server/src/routes/{inbound-v1.1,outbound-v1.1,returns-v1.1,supplier-returns-v1.1,transfers-v1.1,scraps-v1.1,stocktaking-v1.1,inventory-v1.1,locations-v1.1,materials}.ts`
  - `后端代码/server/src/utils/inventory-consistency.ts`
  - `后端代码/server/src/utils/material-delete-reference-guards.ts`（仅增加 position 非零删除保护）
  - `后端代码/server/tests/inventory-position-*.test.ts`
  - 现有受影响库存回归：`data-1-numeric-guards.test.ts`、`data-2-transaction-numeric-guards.test.ts`、`inventory-batch-schema-contract.test.ts`、`inventory-dev-seed-contract.test.ts`、`inventory-transaction-conservation.test.ts`、`lane-c-transfers-returns-scraps.test.ts`、`ledger-drift-guard.test.ts`、`p1-04-stocktaking-batch.test.ts`、`p1-12-06-locations.test.ts`、`p1-13-supplier-refund-bound.test.ts`、`p1-14-supplier-refund-closure.test.ts`、`stocktaking-two-phase.test.ts`（只迁移 position/cache/G2 直接冲突的 fixture 与断言）
  - **fixture-only exception + explicit G2 assertion authorization**: `后端代码/server/tests/issue-112-business-month.test.ts`，允许补齐测试播种所需的 location/position 事实；经 `issue112_update_conflict` 人工检查点明确授权，仅把已退役的完成态 outbound PUT 用例改为 `409 COMPENSATION_CHAIN_REQUIRED` 与零写断言。单位层和创建路径的业务月、财务金额、漂移告警断言不得修改，也不得扩到其他 Issue #112 文件。
- **excluded files**: `前端代码/**`、`/Users/maxiaoyuan/Documents/pm编排/**`、`.github/**`、`scripts/**`、真实 `*.db*`、非库存业务域。
- **owner 规则确认**: 一项文件一个实现 owner；探索/复核节点只读，不代写。
- **实现并发确认**: live open PR 为空；Issue #57 owner 块指向本任务；已存在的同名干净 worktree不切换、不清理、不复用。

## API / 前端合同阻断

- `materials` 写接口需接受 `batchManaged`、`unitsPerPackage`、`slotsPerPackage`；旧调用缺省保持批次管理，换算缺失按 warning 允许。
- `inbound` 的 `batchNo` 只对批次物料必填；非批次物料传 batch 必须拒绝，仍要求显式 `locationId`。
- `outbound`、`scraps`、`supplier-returns` 中客户端传入的 `batchId` 不再是选择权；后端自动 FEFO 并返回/保存实际 allocations。
- `returns` 有来源 allocation 时回原 location；无来源时必须提供 `locationId`。
- 已生效记录的 update/delete/cancel 暂时返回 `409 COMPENSATION_CHAIN_REQUIRED`。前端本轮不改，必须把这些 API 变化作为下游阻断，不能宣称端到端 UI 已完成。

## BDD / 验收

- **给定 / 当 / 那么**:
  - 给定同批次 A 库位 100；调拨 30 到 B；那么 A=70、B=30、batch cache=100、material cache=100。
  - 给定目标已有同一 material/batch position；调入后合并同一 position，不重复建行。
  - 给定非批次 material；入库、调拨、出库后所有 positions 与 allocations 的 `batch_id` 仍为 NULL。
  - 给定多批多库位；扣减按日期、批次创建时间、批次 identity、location identity 自动排序，跨 position 分配并保存明细；任一位置/缓存损坏或总量不足则整单零写。
  - 给定原出库 allocation；退库回原 location 且累计不超来源；无来源且无显式 location 时拒绝。
  - 给定换算齐全且目标增加会超 capacity；拒绝且零写。给定任一换算缺失；允许并写 capacity warning。
  - 给定可证明 legacy 单库位账；backfill 守恒。给定缺库位、非法数量、batch/material/cache 不一致或非批次身份不明；整个 backfill 回滚。
- **PM 可判断结果**: 数量在哪里、为何被扣、扣了哪些批次/库位、容量为何被挡或为何放行，都能从持久化事实复核。
- **golden / 真数据 / 守恒**: 不修改收入/成本 golden；库存守恒为本切片 Locked Candidate，必须有运行断言与 mutation，不使用真实 DB。

## 最小任务图

| ID | 状态 | 依赖 | Owner | 输出 / 完成条件 | 允许写入 | 证据 / 重试 |
|---|---|---|---|---|---|---|
| G0 | verified | — | 主 Agent | 固定 REQ-v1、live ownership、develop preflight PASS | 本 handoff | Git/GitHub/preflight；0 次重试 |
| G1 | verified | G0 | 主 Agent | schema/backfill/FEFO/capacity/守恒 RED | tests + handoff | RED 覆盖 schema、planner、全路由、删除保护；0 次超限重试 |
| G2 | verified | G1 | 主 Agent | schema、合成迁移器、统一计划器 GREEN | DB/service | position schema/planner focused GREEN |
| G3 | verified | G2 | 主 Agent | 所有实际数量/位置入口接入；补偿外入口 fail closed | listed routes/tests | 两轮 reviewer 返工已关闭：reserved inbound、零容量、status filters 500/混合效期互斥、conversion precision、outbound G2 precedence |
| G4 | verified | G3 | 主 Agent | combined machine gates 与 mutation | owned files only | mixed-expiry 修复后 focused/full/build/lint/diff + 5 mutants killed；full=2014 |
| G5 | verified | G4 | 独立 reviewer | fixed local candidate 定向收口复核 | 只读 | `cf15d478...` PASS；P0/P1=0，mixed-expiry P2 已修，原 4 P1 未复活，未开放式找新问题 |

## 验证证据

- **自动测试**:
  - 精确 Issue #112：`tests/issue-112-business-month.test.ts` => 1 file / 9 tests PASS；保留单位层和创建路径的上海业务月断言，唯一旧完成态 PUT 用例现在验证 `409 COMPENSATION_CHAIN_REQUIRED`、原单/position/cache 零写、零新增 `ledger_drift` 记录与调用。
  - 最终库存/G2/幂等聚焦：9 files / 67 tests PASS；含 pending 入库完成的批次与非批次路径、已完成入库取消/删除 G2 零写、FEFO、70/30、退回原 allocation 库位和材料删除保护。
  - `pending inbound complete`、`completed inbound cancel/delete`、首轮 4 P1 + 1 P2 及 R2 mixed-expiry P2 全部修复后，重新运行最终完整后端（CI 等价临时进程密钥，`TZ=UTC npm run test:node -- --maxWorkers=1 --minWorkers=1`）：**exit 0，156 files / 2014 tests PASS，duration 220.85s**。密钥未打印、未写文件；此前的 2007/2007、2010/2010 和 mixed-expiry 修复前的 2014/2014 均不作为最终候选证据。此前一次未注入测试密钥的运行在模块加载阶段 fail closed，也不计 GREEN。
  - 首轮 reviewer 返工 focused：8 files / 77 tests PASS；route 合同 1 file / 13 tests PASS。R2 mixed-expiry RED 稳定复现 `expected false / received true`，修复后单用例 GREEN，再跑 route + BOM retirement 为 2 files / 19 tests PASS。双批证据覆盖 pending transfer/retag 零写、capacity=0、status filter 可查且 expired/expiring-soon 互斥、转换精度 API/DDL、畸形完成态 outbound PUT 409，并保留 BOM retirement 与 Issue #112。
- **人工或真人验证**: 本轮无前端写入，UI 真跑不在授权范围。
- **preflight / drift check**: `2026-08-05` 启动 develop preflight PASS；base/head 均为 `e0cb8083...`。实施中 scope 纠偏选择 A：精确追加 `material-delete-reference-guards.ts` 和 `inventory-position-delete-guards.test.ts`，撤回未授权的 `scripts/**` 改动。重跑 develop preflight：HEAD/origin/master 均为 `e0cb8083...`，ahead/behind=0，`excludedDirty=[]`、`foreignDirty=[]`，精确跨 worktree overlap 仅当前 worktree；总 verdict 为 WARN 而非 PASS，唯一 WARN 是实施中 17 个已声明 owned paths 正在 dirty，无 scope/authority/freshness 失败。待候选固定后再跑干净候选 gate。
- **最终提交前 scope checkpoint**: 刷新 `origin/master` 后仍为 `e0cb8083...`，live open PR=`[]`；以 33 条精确 owned patterns（含 effect evidence 新文件、material delete guard 和 Issue #112 例外）重跑 develop preflight。总 verdict=`WARN`，唯一 WARN 是当前实现中的 32 个 owned paths 正在 dirty；branch/freshness/authority 全部 PASS，`excludedDirty=[]`、`foreignDirty=[]`，未扩大到其他主数据保护、Issue #112 或 seed script 文件。该 WARN 是候选提交前的预期状态，不冒充干净候选 PASS。
- **固定候选干净 preflight**: 提交 `afff326e84aba5b2af1cbe14aabd2bb638f136f0` 后再次刷新 `origin/master` 并以同一精确 scope 运行 develop preflight：verdict=`PASS`，ahead=1、behind=0、worktree clean，`ownedDirty=[]`、`excludedDirty=[]`、`foreignDirty=[]`，authority/freshness/drift checks 全部 PASS。
- **reviewer 返工 scope / 新候选 preflight**: 首轮 finding 只修改 7 个既有 owned paths；提交前 preflight=`WARN`，唯一 WARN 为这 7 个 owned dirty，`excludedDirty=[]`、`foreignDirty=[]`。固定新实现候选 `5b2986304f3d22ca96cadc0d54dfbb21ea43aa5b` 后重跑为 `PASS`，ahead=3、behind=0、worktree clean，无 WARN/FAIL。
- **R2 P2 scope checkpoint**: 刷新 `origin/master` 后仍为 `e0cb8083...`；以 33 条精确 owned paths 运行 develop preflight，verdict=`WARN`，唯一 WARN 是候选提交前 4 个 owned dirty（两个证据文件 + `inventory-v1.1.ts` + `inventory-position-routes.test.ts`）；`excludedDirty=[]`、`foreignDirty=[]`，ahead=3、behind=0，authority/freshness/drift 全 PASS。仅两个产品路径固定为新实现候选 `cf15d4789aa1e25d84c1d3f9e6581df917e3610f`（tree `96b99d96adc6e5cd7fbe0bc52b525158a42ca2d2`）；证据文件待定向 reviewer 结论后单独固定。
- **证据提交前 scope checkpoint**: 定向 reviewer PASS 写入后以同一 33 条 owned paths 重跑 develop preflight：HEAD=`cf15d478...`，ahead=4、behind=0，verdict=`WARN`；唯一 WARN 为本 handoff 与 effect-evidence 两个 owned docs 正在 dirty，`excludedDirty=[]`、`foreignDirty=[]`，产品代码与测试已干净。
- **Issue #112 fixture-only scope checkpoint**: 首轮完整后端测试为 155 files / 2004 tests PASS，唯一失败是 `issue-112-business-month.test.ts` 的 3 个出库请求因旧 fixture 缺 position 而 fail closed 409；在修改该文件前已将精确路径加入上述 fixture-only exception。刷新 `origin` 后 exact overlap 扫描未发现任何现存 worktree 在该精确路径有 dirty 写入（3 个已登记但路径不存在的 prunable worktree 不视为活写者）；HEAD/origin/master 均为 `e0cb8083...`。develop preflight 总 verdict=`WARN`，唯一 WARN 是 30 个已声明 owned paths 正在 dirty；branch/freshness/authority 均 PASS，`excludedDirty=[]`、`foreignDirty=[]`。该结果不表述为整体 PASS。
- **Issue #112 conflict resolution**: fixture-only 补齐后 exact 为 8/9，完整后端为 155 files / 2006 tests PASS；唯一红灯是既有完成态 outbound PUT 期望 200，而当前 G2 合同要求 409。PM 裁决明确完成态 material/quantity 禁止直接修改，原 update 活跃路径已被 G2 边界移除；授权范围仅该一个用例验证 409、零库存/position/原单改写及零新增 ledger_drift 记录/调用。未授权实现更新补偿链或修改其他 Issue #112 断言/文件。
- **入口与写者静态复核**: `src` 内数量表写入只剩统一 `inventory-transactions.ts`、显式 synthetic migration 和材料创建的零缓存行；`inbound-v1.1.ts` 的两处 `UPDATE inventory` 只维护 `last_inbound_*` 元数据。未发现 `inventory_locations` 第二真值；`is_reversed` 仅出现在旧 allocation schema 检测，当前事实表无可变 reverse 标志。
- **机器门**: R2 mixed-expiry P2 修复后，`npm run build` exit 0；`npm run lint` exit 0（0 errors / 1427 inherited warnings）；`git diff --check` exit 0。
- **独立 reviewer 实效**: `afff326e...` 首轮 verdict=`REQUEST_CHANGES`，无 P0，命中 4 P1 + 1 P2（`PIS-EFF-013..017`）。R2 对 `5b298630...` 定向确认这五项关闭，P0/P1=0，并新命中 1 P2：混合“已过期 + 30 天内到期”批次被 `expiring-soon` 查询命中，但返回行自身标记 `expired`。该 P2 的 RED/修法/GREEN 见 `PIS-EFF-018`。对新固定 `cf15d478...` 的最终定向复核为 **PASS**：SHA/tree/base 精确匹配，独立 fixed-archive 内存探针确认 mixed-expiry P2 关闭且原 4 P1 未复活，2 files / 19 tests PASS（duration 3.06s），`git diff --check e0cb808...cf15d478...` exit 0；结论 P0/P1=0、P2 已修。
- **PM 冻结停止规则**: 固定 SHA 上 P0/P1=0、P2 已修或明确接受、完整门禁与定向复核通过即停止开放式审查。本轮定向复核仅确认 mixed-expiry P2 与前 4 P1 未复活，已 PASS 且未启动第三轮开放式找新问题；当前状态为 `READY_FOR_PM_GATE`，不等于 GitHub、merge、真实迁移或 deploy 授权。实效记录见 `PIS-EFF-019`。
- **变异证有牙**: 5 个临时 mutant 均被 focused test 杀死并已恢复：FEFO expiry 逆序（planner 1 fail）、容量 `ceil→floor`（planner 1 fail）、调拨目标少入 0.0001（planner 2 fail）、请求批次锁定绕过（planner 1 fail）、legacy cache/batch 不一致校验关闭（schema 1 fail）。恢复后 focused/full 均 GREEN。
- **偏离清单**: 当前无未拍方向偏离；Issue #57 GitHub 正文仍是旧窄 G1，本 handoff 记录当前 PM 指令的扩大范围，但不回写 GitHub。

## 边界与交付

- **未覆盖边界**: 前端消费者；真实旧库形状；通用补偿链；位置级盘点调整；生产并发/部署环境。
- **迁移方式**: 只实现并运行合成 fixture backfill；真实数据库迁移必须另获针对固定 DB/备份/回滚的 R3 人工授权。
- **回滚方式**: 当前仅本地分支；按本任务提交整体回滚。不得用数据库反迁移脚本处理真实数据。
- **PR URL**: 未创建且当前禁止创建。
- **merge authority**: required checks + 固定 SHA 异构复核 + PM 明确批准；本任务不得 push/开 PR/合并。

## 反盲区自检

- **我现在最没把握的是什么？ / Least confidence**: risk-v1; anchor=name:legacy inventory position backfill; uncertainty=unverified:real database shape is intentionally unread and synthetic fixtures may not cover every historical corruption pattern
- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: no-finding-v1; checked=ref:Issue#57; unchecked=path:前端代码

## PM 大白话

- **做了什么**: 本地候选已把 position 设为数量唯一真值，统一接入收货、pending 入库完成、出库、退库、报废、供应商退货和调拨；完成态修改/取消/删除统一停在 G2 边界。
- **结果是什么**: 合成迁移 fail closed，扣减自动 FEFO 并保存实际库位，调拨真实守恒，容量已知超限会拦截、换算缺失会放行留痕；完整后端与变异门均通过。
- **对业务或用户意味着什么**: 本地代码现在能回答每一份库存“什么物料、哪个批次（如适用）、在哪个库位、由哪次动作增减”；它仍不是已上线功能，前端适配、真实库迁移和 G2 补偿事件链需要独立授权与交付。
