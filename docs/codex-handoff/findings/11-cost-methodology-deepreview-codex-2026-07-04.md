# Codex 深审 11：成本口径方法论 / 贡献毛利 / 标准成本落地风险

> 日期：2026-07-04
> 分支：`claude/cost-methodology-deepreview`
> 复核对象 HEAD：`85114a3`
> 复核入口：`docs/analysis/README-codex-xhigh-复核指引.md` 指定的 3 份文档 + 1 个模拟脚本，并核了相关代码锚点与聚焦测试。

## 总结结论

我没有发现能推翻“标准成本（该花多少）+ 贡献毛利判去留 + 固定成本不下沉”这个大方向的致命逻辑错误。它比“实际库存消耗摊单片”和“院级全成本分摊砍院”更稳，尤其适合 COREONE 当前“库存从未认真统计、单片实际耗用不可追”的业务现实。

但当前结论不能直接进入产品实现。必须先修三类硬问题：

1. **指标语义要拆开**：贡献毛利只能扣“停做即可避免”的变动/增量成本；当前 P&L 代码和 B4 “算全”成本会把 ABC/工时/设备/间接混进毛利，容易把“贡献毛利”误用成“全成本利润”。
2. **合作形态/工序集还没有真正参与成本计算**：`service_step_scope` 只是预埋字段，成本路径没有读取它；代送/只加做染色病例仍有被套全流程成本的风险。
3. **换价源路径被文档说得过于顺滑**：`calculateMaterialCost()` 确实能按 BOM/materials 算，但多个生产调用显式传入 `materialCost`，ABC preview 甚至传 `0`，出库/重算用的是出库单总成本；因此“回填 MAT-IHC-* 的 materials/batches 价”不会自动移动所有 P&L 报表。

一句话：**方法论可定，落地前要先做“成本指标契约”和“数据源契约”，否则会把一套用来防假精确的方法论，又实现成新的假精确。**

## Findings

### HIGH 1 / 指标混用：贡献毛利与当前 P&L/算全成本边界不一致

方法论定义的贡献毛利是：

```text
已确认实收 - 可避免变动成本
```

这条适合判“多做这一单是否值得”，但当前实现里院级 P&L 的成本来自 `outbound_abc_details`，并命名为 `grossMargin = labRevenue - costTotal`；逐抗体 “算全” 又包含工时和设备：

- `后端代码/server/src/utils/partner-pnl-service.ts:4-6` 写明成本侧来自 `outbound_abc_details` 既有 ABC 成本。
- `后端代码/server/src/utils/partner-pnl-service.ts:100-108` case 级毛利直接用 `labRevenue - costTotal`。
- `后端代码/server/src/utils/partner-pnl-service.ts:177-190` 院级 `grossMargin` 也是 `labRevenueTotal - costTotal`。
- `后端代码/server/src/utils/antibody-cost.ts:126-140` “算全”每片成本 = 一抗 + 二抗/显色 + 工时 + 设备。
- B4 校准文档允许把月技师人力、设备折旧、房租/水电按月产片量摊到每片。

风险：

- 固定在编人力、折旧、房租如果被摊到 case，再拿去做“去留”，就回到了文档反对的全成本分摊。
- `grossMargin`、`毛利`、`贡献毛利`、`算全` 现在容易被 PM/UI/实现者当成同一个数。

建议：

- 明确三条成本 lane，并在字段/接口/UI 上分名：
  - `contributionMargin`：只扣可避免变动/增量成本，用于去留/谈价下限。
  - `standardFullCostMargin` 或 `abcMargin`：含标准工时/设备/间接，用于经营看板/效率监控，不直接砍院。
  - `actualFinancialCost`：财务实付/台账层，只做总账或周期核验。
- 每个成本参数都加 `costBehavior`：`avoidable_variable` / `capacity_step` / `fixed_allocated` / `unknown`。贡献毛利只允许取前两类中经业务确认可避免的部分。

### HIGH 2 / 合作形态和工序集只有字段，没有接进成本路径

固化文档把“配方按合作形态裁工序集”列为 PM 拍板项，这是对的。代码里也能看到预埋：

- `后端代码/server/src/database/DatabaseManager.ts:1462-1469` 给 `lis_cases` 增加 `business_line`、`service_step_scope`、`service_step_scope_source`。

但我搜索后只看到字段定义/ensureColumn，没有看到成本计算读取 `service_step_scope`。现有可执行路径更多是：

- 收入侧 `partner service_scope` 决定技术/诊断收入比例。
- 成本侧 `partner-pnl-service` 按 `outbound_abc_details` 上卷。
- ABC/BOM 路径按 BOM、出库、作业中心算，不知道“本 case 只做染色还是全流程”。

风险：

- 代送加做染色病例可能被加上组织处理耗材/工时/设备，贡献毛利被系统性压低。
- `service_scope = technical_only / with_diagnosis` 是收入归属概念，不等于工序集合；不能拿它替代 `service_step_scope`。

建议：

- 先实现一个独立的 `resolveCaseStepScope(case)`，输出例如：

```json
{
  "grossing": false,
  "processing": false,
  "embedding": false,
  "sectioning": true,
  "he": false,
  "ihc": true,
  "specialStain": false,
  "source": "contract|bill|lis|manual",
  "confidence": "high|medium|low"
}
```

- 组织处理耗材、HE、切片动作、染色试剂分别挂到步骤，不要再用一个默认全流程 BOM。
- 未能判定工序集的 case 不应产出“精确贡献毛利”，只能产出 `needs_step_scope_review`。

### HIGH 3 / “换价源路径 a”不会自动影响所有报表，文档需要收窄

文档说抗体已进材料成本引擎、缺口是把 `antibodies.per_test_price` 换成 `MAT-IHC-*` 的材料价源。事实的一半成立：旧 BOM 里确实有 `MAT-IHC-*` 一抗行，且 seed 价是瓶价/演示价：

- `后端代码/server/scripts/seed-pathology-data.ts:1112-1130` IHC BOM 含特定一抗，`usage_per_sample=0.05`。
- `后端代码/server/scripts/seed-pathology-data.ts:642-658` Ki-67/HER2/PD-L1/ALK 等材料价格是 `1100/1500/2800/2200` 这类瓶价。
- `后端代码/server/src/database/DatabaseManager.ts:1171-1183` `antibodies.per_test_price` 是另一套每人份价。

但 active code path 比文档复杂：

- `后端代码/server/src/utils/cost-calculator.ts:509` 只有 `input.materialCost == null` 时才调用 `calculateMaterialCost()`。
- `后端代码/server/src/routes/abc-v1.1.ts:1865-1870` ABC preview 显式传 `materialCost: Number(req.body?.materialCost) || 0`，缺省就是 0，绕开 BOM/materials 自动计算。
- `后端代码/server/src/routes/outbound-v1.1.ts:352-357` 出库写 ABC 明细时传的是出库单 `totalCost`。
- `后端代码/server/src/utils/cost-runs.ts:43-57` 重算也用 `outbound.total_cost`。

所以“回填/覆盖 `MAT-IHC-*` 的 materials/batches 价”只会影响后续具体路径：

- 如果出库单行单价来自新价源，后续出库成本会变。
- 如果某调用不传 `materialCost`，`calculateMaterialCost()` 会读 BOM/materials/batches。
- 但已写入的 `outbound_abc_details`、旧出库单 `total_cost`、ABC preview 默认缺省不会自动变。

建议：

- 把路径 a 拆成可测试的三步：`台账抗体 -> material 映射 -> 批次/物料价回填 -> 新出库/重算读入`。
- 加一个 golden 测试：同一 IHC BOM，在旧 seed 价和台账价下，哪些 API 数字必须变、哪些历史快照不变。
- 明确历史报表是否重算；若重算，必须有版本号和审计，避免关账后数字漂移。

### MEDIUM / 业务和模拟脚本层面的补充裁决

- ①②③ 框架成立，不需要新增第四档；但 `①*` 必须结构化，否则会被当 ① 精确数误用。
- B4 校准机制可用，但它得到的是标准全成本参数，不应默认进入贡献毛利。只有经业务标记为可避免的成本，才进贡献毛利。
- `cm_sim.py` 适合演示结构，不适合作为量级证据。我在 Windows 默认 GBK 下直接运行会因 Unicode 减号报错；用 UTF-8 后输出“模型一抗成本 ¥176,402 vs 真实采购现金 ¥343,047，差额 +94%”，与文档中的 “30-40%” 不一致，应把百分比表述降级为探索性模拟。
- 缺价政策需要分桶：文档说缺价置 0 并单列缺口，实现里缺价 fallback 到全院均价。两者都可以存在，但汇总必须分 `preciseVariableCost`、`estimatedVariableCost`、`missingCostExposure`。
- “分子线未建模”要收窄：院内 FISH/NGS 标准成本未建模；NGS 外购转销若有已核外包成本，可以独立算 `sell_price - outsource_cost`，未核单单列。

## 建议落地顺序

1. **先写成本指标 ADR**：定义贡献毛利、标准全成本、ABC 毛利、财务实际成本的字段、用途、禁止用途。
2. **实现 case 工序集 resolver**：先做到人工/协议默认 + 账单/LIS 线索，低置信阻断精确毛利。
3. **做价源契约测试**：证明 `antibodies.per_test_price -> MAT-IHC/material/batch/outbound/ABC/P&L` 哪些路径会变，哪些历史快照不变。
4. **缺价三桶展示**：精算成本、含估值成本、缺口暴露分开。
5. **B4 只进标准全成本**：除非标记为可避免变量，否则不要进贡献毛利。
6. **把模拟脚本改成可复现证据**：UTF-8 可跑、多 scenario、断言关键结构而不是引用单次百分比。

## 复核命令与结果

```powershell
$env:PYTHONIOENCODING='utf-8'; python "docs\analysis\cm_sim-贡献毛利端到端模拟-2026-07-03.py"
npm ci
npm test -- tests/antibody-cost.test.ts tests/antibody-cost-calibration.test.ts tests/antibody-name-map.test.ts tests/statement-split-route.test.ts tests/golden/hemujia-purelab-golden.test.ts tests/partner-pnl.test.ts tests/partner-pnl-statement.test.ts tests/ngs-pnl.test.ts tests/ngs-partner-pnl.test.ts
```

测试结果：

```text
Test Files 9 passed (9)
Tests 101 passed (101)
```

执行说明：

- `npm ci` 仅生成被忽略的 `node_modules`；未改 lockfile。
- `npm ci` 报告 18 个依赖漏洞（2 low / 8 moderate / 7 high / 1 critical），本轮未处理依赖升级。
- 未跑全量前端/E2E；本轮聚焦成本口径、收入 golden、P&L、NGS、逐抗体成本和校准。
