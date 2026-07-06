# Claude 复核 codex 深审 14（P0 内圈复核）的结论（2026-07-04）

> 复核者：Claude（本地，掌握完整讨论 + PM 拍板上下文）。任务：独立核实 codex 深审 14 的每条断言，判采纳/收窄/顶回。

## 一句话

**codex 的 4 HIGH + MEDIUM(1/2/4) 全部经本地核实为真，采纳，已锁进 P0 v3 §10 工程契约。** 这轮 codex 在**数据契约层比本地三视角红队更全**——逮到 4 处红队漏项（收入 `lab_revenue` vs `net_amount`、`collected_month` 不存在、组织处理料价无源、撞号唯一键无接收号维度）。主线（内圈=实收 lab − 可避免材料）codex 未推翻。唯一我做的**refine**：组织处理不"降级到 P1"，而是"gate 在料价源+工序集上"（honoring PM 合作形态拍板）。

## 逐条核实（file:line 已命中）

| codex | 判定 | 本地核实证据 |
|---|---|---|
| HIGH1 收入用 `lab_revenue` 非 `net_amount`；`collected_month` 不存在 | ✅ 真 | `DatabaseManager.ts:1394` lab_revenue ensureColumn；`:1397` 注释 net=lab+diagnosis+out+unallocated；case_revenue 唯一键 `(partner_id,case_no,service_month)` `:441`、**无 collected_month**（collected_month 在 `:1327` 另一张补收表） |
| HIGH2 组织处理耗材无单价源 | ✅ 真 | `ihc_cost_params` seed 只有 secondary_per_slide/labor_per_slide/equipment_per_slide（`:1667-1670`），无 tissue processing；special_stain_kits 是特染盒非组织处理 |
| HIGH3 工序集无 schema/resolver/写入 | ✅ 真 | service_step_scope 仅 `DatabaseManager.ts:1468` 预埋列；`rg service_step_scope src/` 零命中读取（与固化 doc codex HIGH2 一致） |
| HIGH4 撞号 vs 唯一键矛盾 | ✅ 真 | `lis_cases` uq=(partner_id,case_no) `:1498`；case_revenue=(…,service_month) `:441`；无接收号维度→联合键做不到 |
| MED1 Y000003 双口径 | ✅ 真 | reconcile-account.ts:239 + lis-cases-v1.1.ts:274 = {Y000001,Y000003} 均真抗体；project-catalog.ts:231-233 Y000001=medium、Y000003=low 未确认 |
| MED2 特染含 labor | ✅ 真 | `antibody-cost.ts:167-168` specialStainPerTestCost = kit_price/denom + laborPerTest |
| MED4 作废无可靠状态字段 | ✅ 真 | case_revenue 建表(`:427-441`)**无 status 列**；net/lab=0 可能免费/移出非作废 |
| MED5 签入 DB 快照证明不了"今天能 join" | ✅ 真（与本地 producible 一致） | 本地 producible lens 已同结论；codex 实测 case_revenue/lis_case_markers/antibodies MISSING |

## 我做的一处 refine（对 codex HIGH2 的两个选项）
codex HIGH2 给"删组织处理到 P1" 或 "加封闭参数源" 二选一。鉴于 **PM 已拍板"合作形态现在纳入"**，我选**不删**：把组织处理 gate 在 (a)封闭参数 `P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK` 已定 且 (b)工序集 tissue_processing=true 上——缺任一则该 case 走"染色贡献毛利(不含前处理)"。即**合作形态不变量仍在，组织处理只是"参数源+工序集就绪后才算"**。P0 今天可产的核心 = 染色贡献毛利；组织处理是紧邻的第一扩展。

## codex 哪里"没本地全"（这轮很少，反而更全）
这轮 codex 在数据契约层更全，本地红队反而漏了 4 处（见上）。codex 唯一略"欠"的是没连回 PM 的合作形态拍板去判"组织处理该删还是该 gate"——它给了中性二选一，由本地上下文补上决策（选 gate）。

## 净结论
codex P0 复核质量高、断言全对、把 P0 从"业务逻辑框死"推进到"字段级契约框死"。采纳全部到 v3 §10。**P0 至此可判定：业务逻辑 + 数据契约均框死，可交实现**（实现前只剩 PM 拍 5 个常量值 + 决定组织处理料价源/撞号唯一性两个前置）。
