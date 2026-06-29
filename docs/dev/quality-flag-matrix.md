# 质量标记矩阵

范围：Phase 1A 最小对账闭环。

## 1. quality_flags 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | 是 | 主键 |
| `flag_type` | TEXT | 是 | 标记类型 |
| `severity` | TEXT | 是 | `blocking` / `warning` / `info` |
| `owner_role` | TEXT | 是 | `finance` / `implementation` / `cost` / `admin` |
| `resolution_action` | TEXT | 是 | 建议处理动作 |
| `blocks_posting` | INTEGER | 是 | 是否阻断派生账本 |
| `blocks_closing` | INTEGER | 是 | 是否阻断关账 |
| `related_batch_id` | TEXT | 否 | 关联批次 |
| `related_line_id` | TEXT | 否 | 关联规范行 |
| `message` | TEXT | 否 | 人类可读说明 |
| `resolved_by` | TEXT | 否 | 处理人 |
| `resolved_at` | DATETIME | 否 | 处理时间 |
| `resolution_note` | TEXT | 否 | 处理说明 |

## 2. 默认阻断矩阵

| flag_type | severity | owner_role | resolution_action | blocks_posting | blocks_closing | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `template_unrecognized` | blocking | implementation | select_template | 1 | 1 | 模板无法识别 |
| `parse_failed` | blocking | implementation | fix_parser_or_file | 1 | 1 | 文件无法解析 |
| `period_conflict` | blocking | finance | confirm_settlement_month | 1 | 1 | 文件名/sheet/header/行日期冲突 |
| `missing_rule` | blocking | implementation | create_rule | 1 | 1 | 未归类 |
| `ambiguous_rule` | blocking | finance | choose_rule | 1 | 1 | 多规则命中 |
| `missing_price` | blocking | finance | fill_price | 1 | 1 | 缺售价 |
| `missing_cost` | warning | cost | fill_cost | 0 | 1 | 可入收入，但阻断正常毛利关账 |
| `missing_lis` | warning | finance | import_or_bind_lis | 0 | 1 | 可暂入收入，最终关账需处理或带原因放行 |
| `numeric_format_anomaly` | blocking | implementation | fix_numeric_parse | 1 | 1 | 石门等 Excel 数字被日期格式污染 |
| `declared_total_mismatch` | blocking | finance | reconcile_or_confirm | 0 | 1 | 对账不平，可复核后放行 |
| `pure_out_without_case` | info | finance | post_to_out_ledger | 0 | 0 | 纯 OUT 无病例号，不阻断 |
| `manual_override` | warning | admin | review_override | 0 | 1 | 人工覆盖需复核 |
| `closed_month_change` | blocking | finance | create_adjustment | 1 | 1 | 已关账月份不得覆盖 |
| `duplicate_file` | warning | finance | ignore_or_replace | 1 | 1 | 同 hash 重复上传 |
| `section_total_mismatch` | warning | finance | reconcile_section | 0 | 1 | 小计段不平 |

## 3. 放行规则

Phase 1A 默认不做完整 UI，但后端数据结构要支持放行：

- `declared_total_mismatch` 可由财务带原因放行，但必须保留 `resolution_note`。
- `missing_lis` 可暂入收入，但最终关账前必须补 LIS 或带原因放行。
- `missing_cost` 不阻断收入派生，但阻断正常毛利关账；P&L 必须单列。
- `pure_out_without_case` 不阻断，必须进入 OUT 台账。

## 4. 自动生成规则

- 模板识别失败：批次级 `template_unrecognized`。
- 解析异常：批次级 `parse_failed`。
- 期间冲突：批次级和必要的行级 `period_conflict`。
- `business_line=UNKNOWN` 且 `row_kind=detail`：行级 `missing_rule`。
- `numeric_parse_status != 'ok'`：行级 `numeric_format_anomaly`。
- `declared_total` 与明细合计差异大于 0.01：批次级 `declared_total_mismatch`。
- `case_no IS NULL` 且 `business_line=OUT`：行级或批次级 `pure_out_without_case`。
