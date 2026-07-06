# Claude 复核 codex 深审 11/12 的结论（2026-07-04）

> 复核者：Claude（本地，掌握完整讨论上下文）。任务：**独立核实 codex 深审 11/12 的每条断言，判断哪些采纳、哪些收窄、哪些 codex 视角不全**。
> 复核对象：`findings/11-...`、`findings/12-...`。已对每条代码断言回后端只读核实（file:line）。

## 一句话

**codex 的 3 个 HIGH 全部经我独立核实为真，采纳；我的固化 doc 有两处说过头（§6"抗体已进引擎"、§8"path a 换价源自动生效"），已按 codex 订正。** 但 codex 在两处不如本地上下文全：① 它把现有 ABC 全成本管道当成"有意义的生产数据"去分 lane，未连回"出库从没被记录→整条成本管道跑在 seed 上"这个根；② 它的"工序集应先于换价源"重开了 PM 已拍的 path a——那是可再权衡的排序建议，不是"path a 错了"。

## 逐条核实

### HIGH 1（指标混用：现有 grossMargin=全成本≠贡献毛利）—— ✅ 属实，采纳
- 核实：`partner-pnl-service.ts` 成本侧取 `outbound_abc_details`（含 ABC 作业成本=工时/设备/间接）按 partner 上卷；case 级 `grossMargin=c.labRevenue-costTotal`、院级 `grossMargin=rev.labRevenueTotal-costTotal`（`:100-108`/`:177-190`）。确为**全成本毛利**，不是"实收−可避免变动成本"。
- 采纳：固化 doc §6 已加"现有 grossMargin=全成本、实现必须分 lane"。

### HIGH 2（service_step_scope 只有字段没接进成本）—— ✅ 属实，采纳
- 核实：`grep -rn service_step_scope src/` 只命中 `DatabaseManager.ts:1464/1468/1469`（列定义+注释），**任何成本/计算路径零命中**。且 `partner-pnl-service.ts:4` 明确 `partner service_scope` 在**收入侧**——codex"service_scope 是收入概念≠工序集"成立。
- 采纳：固化 doc §6 收入侧锚点已注明"service_step_scope 预埋未读"，§8#4/§9 本就是"把它接进计算"。

### HIGH 3（换价源 path a 不自动生效所有报表）—— ✅ 属实，且我再深一层
- 核实（逐条命中）：`cost-calculator.ts:509` = `input.materialCost ?? calculateMaterialCost(...)`（只有没传才算）；`abc-v1.1.ts:1865` 传 `Number(req.body.materialCost)||0`（缺省 0，绕过）；`outbound-v1.1.ts:352` 传 `outbound.total_cost`；`cost-runs.ts:43` 用 `outbound.total_cost`。全部属实。
- **我的深化（codex 未展开）**：新出库 `total_cost = Σ(batch.inbound_price × 数量)`（`outbound-v1.1.ts:164`，FIFO 批次入库价，**非 materials.price**）。所以：① 真要动的是 `batches.inbound_price`；② 且**抗体要真被逐 case 出库**才流得进——而**库存/消耗从没认真统计**（本方法论前提），抗体多半没有逐 case 出库 → 整条 `出库→outbound_abc_details→P&L` 成本管道现多跑在 **seed/演示出库**上、非真实消耗。**这是比 codex 的"不自动生效"更根的一层**：不只是"改价路径复杂"，是"这些 lane 现在压根没有真实数据源"。
- 采纳：固化 doc §6/§8#2 已订正 path a"轻"的说法 + 加"价源契约测试 + batch 价 + 历史快照冻结/重算版本化"；§6 加"数据真空是绑定约束"。

### MEDIUM（cm_sim 百分比 / 缺价分桶 / 分子转销）—— 采纳
- cm_sim.py 的 +94% ≠ doc 的 30-40%：固化 doc §4 已声明"非实测量级"，实录 §6 表述已注明"其中一半是囤货/时间错配"；接受 codex"降级为探索性、别引单次百分比"，实录相应句可再弱化（低优先）。
- 缺价分三桶（精算/含估值/暴露）：采纳，已入 §8#6。
- 分子外购转销可算 `sell_price−outsource_cost`（未核成本单列）：采纳，比"一律未建模"更准，功能梳理时纳入。

### 业务侧（分 lane / 6 业务动作 / 看板 5 层 / 工序集 first）—— 采纳为功能梳理输入，一处替 PM 顶
- "分 lane""6 业务动作各用不同成本口径""看板输出动作+置信度"——**方向正确、是本方法论原则（贡献毛利≠利润、①②③）的产品化落地**，采纳为**功能梳理输入**（不改本口径 doc 的判据，只影响看板设计）。
- **"第一落地点是工序集而非抗体换价源"**——这**重开了 PM 已拍的 path a**。我的判断：codex 的 HIGH 3 **不否掉 path a**（它仍是让最贵成本块用真价的必要一步），只是给它加了前置（价源契约测试）。工序集 vs 换价源谁先 = **PM 可再权衡的排序**，已作为待拍列进 §8 codex 补正 callout，不擅自改 PM 拍板。

## codex 哪里"没本地全"
1. **未连回数据真空根**：它审的是代码路径的"哪条会变"，没连回"出库从没被认真记录→所有成本 lane 现在都没真实数据源"（本讨论的原点）。分 lane / 契约测试都对，但都建在没数据源的地基上——真正的绑定约束是收得率管道 + 真实采购流水（§8#3）。
2. **重开 PM 拍板**：把排序建议写成了"第一落地点不是换价源"，语气上像否掉 path a；实际 HIGH 3 只是给 path a 加前置。已在 doc 里按"不否掉、加前置、排序待 PM"处理。

## 净结论
codex 这轮**质量高、代码断言全对、真逮到我 doc 两处过头**——异构第二引擎价值坐实。采纳其全部 HIGH + MEDIUM 到固化 doc；业务侧作功能梳理输入；唯一给 PM 留的再权衡点=「工序集/分 lane 先，还是抗体换价源先」。**本方法论主线（①②③ / 贡献毛利判去留 / 固定成本不下沉）codex 明确未推翻，仍成立。**
