# Codex 深审 14：P0 内圈院级贡献毛利业务逻辑复核

> 日期：2026-07-04
> 分支：`claude/cost-methodology-deepreview`
> 复核对象：`docs/COREONE-成本口径-P0内圈-院级贡献毛利-绝对最小业务逻辑-2026-07-04.md`
> 复核范围：P0 spec 全文；只读核了 `case_revenue`、`lis_cases`、`lis_case_markers`、`antibodies`、`ihc_cost_params`、`special_stain_kits` 的建表、写入、读取和现有 helper。

## 一句话结论

这版 P0 的方向是对的，也已经把“全成本/库存/工时设备/假精确”大坑基本挡住了。但我不能判定它已经“彻底框死”。当前还剩 4 个会让实现者回头问 PM 或实现成两套口径的阻断点：

1. **收入字段和月轴没锁死**：公式写“实收”和 `collected_month`，但生产表是 `case_revenue.service_month`，且同一行有 `net_amount`、`lab_revenue`、`diagnosis_revenue`、`out_revenue`、`unallocated_amount`。P0 该减实验室材料成本，收入分子必须锁成 `lab_revenue`，否则会把诊断桶/外送/未分配收入混进贡献毛利。
2. **组织处理耗材进了公式，但 P0 白名单数据源没有其单价源**：`block_count` 有，`每蜡块约定料价` 没有表/字段/常量。按“只用这些表”无法生产。
3. **工序集是硬不变量，但 `service_step_scope` 没有 schema、resolver、写入路径**：字段只在 `lis_cases` 预埋，导入不写，成本路径也不读。没有它，完整贡献毛利不能安全输出。
4. **同院同 `case_no` 撞号的处理与现有唯一键矛盾**：spec 要按 `(院, case_no, 接收号/蜡块)` 区分，但当前 `lis_cases` 唯一键是 `(partner_id, case_no)`，`case_revenue` 是 `(partner_id, case_no, service_month)`，没有接收号维度。

净判断：**P0 框架可继续，不能直接交实现。先补 4 条契约，再开工。**

## Findings

### HIGH 1 / 收入分子和月轴有歧义，会直接算出两种贡献毛利

P0 多处写“实收”与 `collected_month`：

- §1 数据源：`case_revenue` 逐 case 已确认实收，自带 `service_month`。
- §2 公式：`贡献毛利 = 实收 - case 可避免材料成本`。
- §4 不变量⑥：月轴 = `collected_month`。

代码现状：

- `case_revenue` 建表只有 `service_month`，没有 `collected_month`（`DatabaseManager.ts:427-441`）。
- `lab_revenue`、`diagnosis_revenue`、`out_revenue`、`unallocated_amount` 是后续增列（`DatabaseManager.ts:1393-1402`）。
- statement 落库明确写 `lab_revenue=Σ(IN结算)`，并保持 `net_amount = lab + diagnosis + out + unallocated`（`statement-import-v1.1.ts:166-194`）。
- 现有 P&L 读侧已经把 `lab_revenue != null` 当作“对账单权威实验室收入”，否则才走估算（`partner-pnl-service.ts:63-72`）。

风险：

- 工程师 A 可能用 `net_amount`：把诊断桶、外送转销、未分配金额都当成实验室贡献收入，毛利虚高。
- 工程师 B 可能用 `lab_revenue`：只算实验室收入，结果更低。
- 工程师 C 可能按 `lis_cases.operate_time` 过滤 marker 月份：补收/迟到账单的 case 会在收入月丢成本，毛利虚高。
- 工程师 D 可能按 `case_revenue.service_month` 过滤收入、按 `operate_time` 过滤成本：收入和成本不同轴。

改法：

```text
P0 revenue_amount =
  if case_revenue.lab_revenue IS NOT NULL and revenue_source in ('statement','corrected'):
    lab_revenue
  else:
    不输出贡献毛利，状态 = 需补数据 / 需收入拆分

P0 month =
  case_revenue.service_month

P0 case set =
  case_revenue rows where partner_id = ? and service_month = ?

P0 cost facts =
  join lis_cases / lis_case_markers by (partner_id, case_no) for that revenue case set.
  lis_cases.operate_time 只做异常提示，不做主过滤条件。
```

如果 PM 真要 `collected_month`，必须先在 `case_revenue` 或一张收款事实表上建字段；不能借 `supplement_orders.collected_month` 这个补收专用字段冒充全量收入月轴。

### HIGH 2 / 组织处理耗材无单价源，P0 “只用这些表”生产不出来

P0 公式写：

```text
组织处理耗材(每蜡块约定料价 × 蜡块数)
```

数据源表里只有：

- `lis_cases.block_count`：蜡块数有。
- 但没有 `每蜡块约定料价` 的来源。

`ihc_cost_params` 当前 seed 只有：

- `secondary_per_slide`
- `labor_per_slide`
- `equipment_per_slide`

`special_stain_kits` 是特染盒，不是组织处理耗材。现有 `computeFullSlideCost` 也没有组织处理耗材项。

风险：

- 工程师会临时硬编码一个数，破坏“只用这些表”。
- 或偷用 ABC/工时设备/旧 charge mapping 的比例，P0 又会混入中圈或收入侧估算。
- 或直接漏算组织处理耗材，但文档说完整口径应扣，导致“完整贡献毛利”名不副实。

改法二选一：

1. P0 先删掉组织处理耗材，只输出 `染色贡献毛利(不含前处理)`，把组织处理放 P1。
2. P0 增加一个封闭参数源，例如 `p0_cost_params.tissue_processing_material_per_block`，并把它标成 `①*`，同时加测试断言只有 `service_step_scope.tissue_processing=true` 时才扣。

在补源之前，不应输出名为“完整贡献毛利”的字段。

### HIGH 3 / 工序集不够可实现：核心字段没有 schema、resolver 和写入路径

P0 把“成本步骤集 = 实收覆盖步骤集”列为硬不变量，这是正确的。但当前 spec 没有把工程契约写死：

- `service_step_scope` 在 `lis_cases` 只是预埋字段（`DatabaseManager.ts:1461-1469`）。
- `lis-cases-v1.1.ts` 导入只写数量、样本类型，不写 `service_step_scope`。
- 当前 `rg service_step_scope src/` 仍只命中建表/注释，没有 resolver 或计算读取。

实现者会卡住的问题：

- JSON 结构是什么？数组还是对象？
- `staining`、`tissue_processing`、`diagnosis`、`outsourced` 分别叫什么？
- 默认值是什么？未知时是全流程、仅染色，还是不输出？
- 账单行 `scope=in/split/diagnosis/out` 与工序步骤如何映射？
- partner 协议默认和 case 人工覆盖谁优先？

改法：

```json
{
  "staining": true,
  "tissue_processing": false,
  "diagnosis": false,
  "source": "manual|bill|contract|unknown"
}
```

并写死 resolver 优先级：

```text
manual case override > bill/statement inference > partner contract default > unknown
```

P0 输出规则也要锁死：

- `staining !== true`：不输出贡献毛利，只上卷实收，标 `needs_step_scope`。
- `staining === true && tissue_processing !== true`：只输出 `染色贡献毛利(不含前处理)`。
- `staining === true && tissue_processing === true`：才允许输出 `完整贡献毛利`。

否则“优雅降级”会被各实现按不同默认解释。

### HIGH 4 / 同院同 case_no 撞号的硬不变量与现有唯一键不兼容

P0 §4 不变量⑥写：

```text
同院同 case_no 撞号 → 按 (院, case_no, 接收号/蜡块) 联合键区分，不静默合并成本。
```

代码现状：

- `lis_cases` 的唯一索引是 `(partner_id, case_no)`（`DatabaseManager.ts:1498`）。
- `case_revenue` 的唯一键是 `(partner_id, case_no, service_month)`（`DatabaseManager.ts:441`）。
- `lis_case_markers` 有 `wax_no`/`section_no`，但它们只是 marker 明细属性，不是 case 实例主键。
- `case_revenue` 没有接收号/蜡块号，无法把同院同号的两例收入拆给不同 marker 集。

风险：

- 如果同院同月同号两例存在，当前 schema 无法表示。
- 如果同院跨月同号，收入表可以存两条，但 `lis_cases` 只能存一条；P0 用 case_no join 会把同一套 LIS 数量/marker 套到两个收入月。

改法：

- 如果业务确认同院 `case_no` 永不复用：把 P0 这条改成“同院同 case_no 复用 = 数据异常，禁止输出贡献毛利”，不要承诺联合键。
- 如果业务不能保证：先加 `case_instance_key`/`accession_id`，让 `lis_cases`、`lis_case_markers`、`case_revenue` 三表同键后再做 P0。

### MEDIUM 1 / “真抗体码白名单”没有在正文常量化，且现有代码有两套置信口径

P0 §1/§2 写 `advice_type ∈ {真抗体码白名单}`，但正文没有直接定义集合。变更记录提到 `Y000001/Y000003`，代码也有两种口径：

- `reconcile-account.ts:237-253` 和 `lis-cases-v1.1.ts:273-275` 把 `Y000001/Y000003` 当真抗体。
- `project-catalog.ts:229-235` 只把 `Y000001` 映射到 IHC，`Y000003` 标为低置信未确认。

这不是说 `Y000003` 一定不能算，而是 P0 必须把决策写成不可误解的常量：

```text
P0_ANTIBODY_ADVICE_TYPES = {'Y000001','Y000003'}
```

同时写清：

- 有 `advice_type` 时只认白名单。
- 无 `advice_type` 时是禁止计入、还是允许 `classifyMarker(name)==抗体` 兜底。

我建议 P0 为防假精确：**有码只认白名单；无码不进合计，计入 marker 口径缺失暴露**。不要在 P0 主算里用名字兜底，名字兜底可放审计提示。

### MEDIUM 2 / 特染成本最可能被误复用成“盒价/次数 + 工时”

P0 明确特染只进材料：

```text
special_stain_count × 特染每片约定价(kit_price/nominal_tests)
```

但现有 helper / route 是：

- `specialStainPerTestCost()` = `kit_price / denom + laborPerTest`（`antibody-cost.ts:166-169`）。
- `/special-stains` 返回的 `perTestCost` 也把 `labor_per_test` 传进去（`antibody-cost-v1.1.ts:420-428`）。

风险：实现者很自然会复用现有 `perTestCost`，把工时带进 P0，违反“只减可避免材料 / 工时永不进 P0”。

改法：

```text
P0 特染材料单价 = kit_price / denom
denom = nominal_tests
```

若要允许 `actual_yield` 优先，也必须在 P0 写死：

```text
denom = COALESCE(NULLIF(actual_yield, 0), nominal_tests)
```

并明确 **禁止读取 `labor_per_test`，禁止复用 `specialStainPerTestCost()` 的 total**。

### MEDIUM 3 / coverage、有效 case 数、缺价暴露率的分母还不够死

P0 要输出：

- 覆盖率
- 有效 case 数
- 缺价暴露率
- `needs_step_scope` 占比

但分母没有完全定义。至少会出现这些实现分叉：

- 覆盖率 = 有 LIS 的收入 case / 收入 case？
- 覆盖率 = 有 marker 的 IHC case / `ihc_count > 0` case？
- 有效 case 数是否剔除分子线、作废、无染色归属、缺价 gate case？
- 缺价暴露率分母是全部 marker 行、真抗体 marker 行，还是 `ihc_count`？

建议写死：

```text
revenue_case_count = P0 case set 中 lab_revenue 非空的 case 数
ihc_expected_case_count = revenue case set 中 lis_cases.ihc_count > 0 的 case 数
marker_ready_case_count = ihc_expected_case_count 中存在真抗体 marker 或 ihc_count = 0 的 case 数
coverage = marker_ready_case_count / revenue_case_count
missing_price_rate = missing_price_true_antibody_marker_rows / true_antibody_marker_rows
valid_case_count_for_per_case_cm = 通过数据 gate 且未双剔的 case 数
```

如果 PM 选择别的分母也可以，但必须先写死，否则状态 gate 不可回归。

### MEDIUM 4 / 作废/退单双剔没有可靠状态字段

P0 写“退单/作废 case（实收冲红/置 0）→ 分子分母双剔”。现有表：

- `lis_cases.status` 是病例状态，但不等于收入作废状态。
- `case_revenue` 没有 `status`。
- `net_amount=0` 或 `lab_revenue=0` 可能是作废，也可能是免费/全额移出/诊断桶/未分配。

风险：把 0 收入 case 一律剔除，会把真实低价/免费/移出样本从分母拿掉，抬高每例贡献毛利。

改法：

```text
只有 case_revenue.status in ('voided','refunded') 或明确冲红原单引用，才双剔。
lab_revenue = 0 但无 void 状态：保留在分母，贡献毛利按 0 收入计算或进入需补数据，不能自动剔除。
```

### MEDIUM 5 / 当前签入 DB 快照不能证明“今天能 join 出数”

我只读打开了 `后端代码/server/data/coreone.db`，结果：

```text
case_revenue: MISSING
lis_cases: 6
lis_case_markers: MISSING
antibodies: MISSING
ihc_cost_params: MISSING
special_stain_kits: MISSING
```

这说明当前签入 DB 快照不是 P0 可跑样本库。代码初始化后会建表和 seed，但“今天能出真数”的诚实措辞只能是：

```text
schema initializer 具备这些表；真实对账单 + LIS 工作量 + 抗体清单导入后，才可对指定医院月份生产 P0 结果。
当前仓库签入 DB 快照不能直接 join 出 P0 真数。
```

这不否定 P0，只要求把“已建表”改成“初始化后有 schema”，把“今天能出”改成“导入三件套后能出”。

## 工程实现者最可能卡住的问题

1. `实收` 到底用 `net_amount` 还是 `lab_revenue`？
2. `collected_month` 在哪里？为什么 `case_revenue` 只有 `service_month`？
3. `service_step_scope` 的 JSON 长什么样？未知时默认什么？
4. 组织处理“每蜡块约定料价”从哪张表读？
5. 特染能不能直接用 `/special-stains` 返回的 `perTestCost`？
6. 同院同 `case_no` 复用时，三张表怎么 join 到同一个 case 实例？

## 最可能被实现错的 3 个点

1. **用 `net_amount` 当 P0 收入**，把诊断/外送/未分配收入放进实验室贡献毛利。
2. **复用 `specialStainPerTestCost()`**，把 `labor_per_test` 带进 P0。
3. **按 `lis_cases.operate_time` 独立过滤 marker 月份**，让补收/迟到账单在收入月丢成本。

## 最小修正文案建议

在 P0 spec 里补一段“P0 SQL 契约”：

```text
输入 case 集：
  from case_revenue cr
  where cr.partner_id = :partnerId
    and cr.service_month = :month
    and cr.lab_revenue is not null
    and cr.revenue_source in ('statement','corrected')

收入：
  p0_revenue = cr.lab_revenue

成本 join：
  left join lis_cases lc on lc.partner_id = cr.partner_id and lc.case_no = cr.case_no
  left join lis_case_markers m on m.partner_id = cr.partner_id and m.case_no = cr.case_no

禁止：
  不用 cr.net_amount 做 P0 收入
  不用 outbound_abc_details
  不用 computeFullSlideCost
  不用 specialStainPerTestCost 的含 labor total
  不用 lis_cases.operate_time 作为主月轴过滤成本
```

然后补 4 个具名常量/参数：

```text
P0_ANTIBODY_ADVICE_TYPES = {'Y000001','Y000003'}
P0_STAIN_MATERIAL_DENOM = nominal_tests 或 actual_yield 优先（二选一）
P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK = 暂无则 P0 不输出完整口径
P0_SERVICE_STEP_SCOPE_SCHEMA = { staining, tissue_processing, diagnosis, source }
```

## 最终裁决

**不算彻底框死。** 这版 P0 已经把大方向框在“实收 + LIS 片数 + 约定材料价 + 贡献毛利”内，且明确排除了库存、ABC、工时设备和假精确；这是正确主线。

但落地前必须先修：收入字段/月轴、组织处理参数源、工序集 schema/resolver、同院同号表示能力。修完后，我会倾向判定 P0 可实现、可回归、不会冒充真实成本。

## 本轮只读核验命令

```powershell
rg -n "lis_case_markers|lis_cases|case_revenue|ihc_cost_params|special_stain_kits|antibodies" "后端代码/server/src" "后端代码/server/scripts"
rg -n "service_step_scope|business_line|collected_month|lab_revenue|net_amount" "docs/COREONE-成本口径-P0内圈-院级贡献毛利-绝对最小业务逻辑-2026-07-04.md" "后端代码/server/src"
rg -n "Y000001|Y000003|Y000006|Y000007|advice_type" "docs" "后端代码/server/src" "后端代码/server/tests"
rg -n "specialStainPerTestCost|labor_per_test|special_stain_kits|nominal_tests" "后端代码/server/src" "后端代码/server/tests"
```

签入 DB 快照只读计数：

```text
case_revenue: MISSING
lis_cases: 6
lis_case_markers: MISSING
antibodies: MISSING
ihc_cost_params: MISSING
special_stain_kits: MISSING
```
