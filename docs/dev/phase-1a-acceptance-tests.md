# Phase 1A 验收测试

版本：v1.1（吸收云端 08 评审意见，2026-06-29）

范围：东安、赣州、平泉三样本 + 和睦家黄金锚点。

建议测试文件：

- `后端代码/server/tests/statement-normalized-lines.test.ts`
- `后端代码/server/tests/statement-ledger-phase1a.test.ts`
- `后端代码/server/tests/month-close-quality-flags.test.ts`

## 1. Fixture

| 样本 | 文件 | 目标 |
| --- | --- | --- |
| 东安 | `out_category_summary__dongan_2601.json` | 科目汇总 -> 聚合收入账本 |
| 赣州 | `out_outsourced_detail__ganzhou.json` | 跨月纯 OUT -> OUT 台账 |
| 平泉 | `out_consult_remote__pingquan_2603.json` | 宽表来源列 -> OUT 规则 + 期间冲突 |
| 和睦家 | `out_line_item__hemujia_2602.json` / 现有黄金测试 | 病例级收入黄金 `13152` 不回退 |

## 2. 东安科目汇总

### TC-DA-01 normalized lines

Given 东安科目汇总 fixture。

When 构建 `statement_normalized_lines`。

Then 应生成类别 detail 行和声明合计行。

Expected：

- `template_family='category_summary'`
- `declared_total=121016.9`
- `row_kind=declared_total` 的合计行存在。
- 常规病理诊断、免疫组化、EBER、特殊染色、冰冻、P16 至少映射为 `business_line=IN`。
- 病理诊断HPV、基因检测、FISH 至少映射为 `business_line=OUT`。
- 上述映射来自 Phase 1A 固定 seed 规则，即使默认产品目录未包含 HPV-E6E7，也不得把 HPV 行落为 UNKNOWN。
- EBER、特殊染色本版默认归 IN；开发前业务确认若否定该口径，应同步更新 seed 规则和本测试的金额锚点。
- FISH amount=0 行必须保留为规范行，`line_grain=out`，但本版不派生 `out_settlement_ledger` 零金额行；不得因为无病例号生成阻断项。

### TC-DA-02 ledger split

When 派生聚合收入账本。

Then：

- IN settlement amount = `93264.9`
- OUT settlement amount = `27752.0`
- total = `121016.9`
- detail 行 IN+OUT 合计等于 `declared_total=121016.9`，允许误差 `<=0.01`。
- 不生成 `declared_total_mismatch`。
- 小计/合计不重复入账。

## 3. 赣州纯外送

### TC-GZ-01 pure OUT normalized lines

Given 赣州纯外送 fixture。

When 构建规范行。

Then：

- 每个明细行 `case_no=''` 或 `NULL`，但有 `external_subject_key`。
- 每个明细行 `business_line=OUT`。
- 每个明细行 `line_grain=out`。
- 批次 `multi_month_batch=1`。
- 声明合计 `40219.2` 保留为 `declared_total`。

### TC-GZ-02 month split

When 按 `report_date` 派生 OUT 台账。

Then：

- 2026-01 OUT settlement = `2570.4`
- 2026-02 OUT settlement = `7534.8`
- 2026-03 OUT settlement = `30114.0`
- total = `40219.2`
- 每个明细行记录 `settlement_month_basis='report_date'`。
- `lab_revenue_amount=0`。
- 不生成缺病例号阻断项，只生成 `pure_out_without_case` info。

## 4. 平泉宽表远程会诊

### TC-PQ-01 source column preserved

Given 平泉宽表 fixture。

When 构建规范行。

Then 每条远程会诊金额行保留：

- `source_column` 对应远程会诊结算列。
- `source_label` 包含远程会诊结算语义。
- `business_line=OUT` 或 `classification_status=pending` 且带候选 OUT。
- 明细金额两行各 `308.7`。
- 声明合计 `617.4`。

### TC-PQ-02 period conflict

Given 文件标题/文件名指向 2026-03，但 sheet 名指向 202510。

When 创建批次。

Then：

- `period_conflict_flag=1`。
- 生成 `period_conflict` quality flag。
- 默认 `blocks_posting=1`，`blocks_closing=1`。
- `settlement_month` 在确认前不得静默按 sheet 或文件名覆盖。
- 未确认结算月前不得进入 `posted`。

## 5. 和睦家黄金锚

### TC-HMJ-01 golden regression

Given 现有和睦家黄金测试数据。

When 执行 statement commit 或现有黄金回归。

Then：

- labRevenueTotal = `13152`
- sourceCounts.statement = `25`
- 新增 normalized line 逻辑不得改变现有病例级收入计算。

## 6. 最小差异包

### TC-PACK-01 export summary

Given 东安、赣州、平泉三批次已生成规范行。

When 生成最小差异包 JSON。

Then 每个批次至少包含：

- `settlement_month`
- `partner_name`
- `batch_id`
- `source_file`
- `template_family`
- `declared_total`
- `parsed_total`
- `in_amount`
- `out_amount`
- `adjustment_amount`
- `unknown_amount`
- `cost_pending_amount`
- `lis_pending_count`
- `quality_flags`
- `rule_version`
- `ledger_scope`，Phase 1A 期望为 `statement_internal`
- `pnl_bridge_status`，Phase 1A 期望为 `not_integrated`
- `confirmed_by`
- `confirmed_at`
- `confirmation_note`

### TC-PACK-02 no silent P&L merge

Given 东安聚合收入账本、赣州 OUT 台账、平泉 OUT 台账已生成。

When 生成最小差异包或院月摘要。

Then：

- 新账本金额必须单独展示为 statement/internal ledger。
- 不得把 `partner_month_revenue_ledger` / `out_settlement_ledger` 静默并入现有 `case_revenue` / `partner-pnl` 口径。
- 摘要必须暴露 `pnl_bridge_status='not_integrated'` 或等价状态，作为 Phase 1A 后续并表任务的入口。

## 7. 幂等和去重

### TC-DUP-01 duplicate file

Given 任一 Phase 1A 样本文件已上传并写入 `statement_import_batches.source_hash`。

When 使用同一 `source_hash` 再次上传。

Then：

- 返回或写入 `duplicate_file` quality flag。
- 不产生第二个有效 batch。
- 不重复生成 `statement_normalized_lines`。
- 不返回 500。

### TC-RE-01 repost idempotency

Given 同一 batch 已生成 normalized lines 并完成一次 post。

When 对同一 batch 连续执行两次 post 或重算派生。

Then：

- `partner_month_revenue_ledger` 行数不翻倍。
- `out_settlement_ledger` 行数不翻倍。
- 同一 `source_line_id` 在对应派生账本中最多一行。

## 8. 删除修复应变红的断言

- 如果 parser 不保留 `source_column/source_label`，TC-PQ-01 应失败。
- 如果小计/合计被当明细派生，TC-DA-02 或 TC-GZ-02 应失败。
- 如果无病例号 OUT 被阻断，TC-GZ-01 应失败。
- 如果期间冲突未标记，TC-PQ-02 应失败。
- 如果新增逻辑污染病例级链路，TC-HMJ-01 应失败。
