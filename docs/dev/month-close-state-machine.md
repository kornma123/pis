# 月结状态机

范围：Phase 1A 最小对账闭环。

## 1. 批次状态

| 状态 | 含义 | 可进入来源 | 可流向 |
| --- | --- | --- | --- |
| `uploaded` | 文件/网格已上传，尚未解析 | 创建批次 | `parsed`, `template_unrecognized`, `parse_failed`, `voided` |
| `template_unrecognized` | 模板无法识别 | `uploaded` | `uploaded`, `voided` |
| `parse_failed` | 解析失败 | `uploaded` | `uploaded`, `voided` |
| `parsed` | 已生成 raw rows 和 normalized lines | `uploaded` | `classification_required`, `review_required`, `posted`, `posted_with_flags` |
| `classification_required` | 存在待归类或歧义规则 | `parsed` | `review_required`, `voided` |
| `review_required` | 可派生账本但需要财务复核 | `parsed`, `classification_required` | `posted`, `posted_with_flags`, `voided` |
| `posted` | 已派生账本且无阻断质量标记 | `review_required`, `parsed` | `ready_to_close`, `recompute_pending`, `voided` |
| `posted_with_flags` | 已派生账本但有质量标记 | `review_required`, `parsed` | `cost_pending`, `ready_to_close`, `recompute_pending`, `voided` |
| `cost_pending` | 成本待补或成本质量标记未解决 | `posted_with_flags` | `posted`, `ready_to_close`, `recompute_pending` |
| `recompute_pending` | 等待重算 | `posted`, `posted_with_flags`, `cost_pending` | `recomputing` |
| `recomputing` | 重算中 | `recompute_pending` | `posted`, `posted_with_flags`, `recompute_failed` |
| `recompute_failed` | 重算失败 | `recomputing` | `recompute_pending`, `voided` |
| `ready_to_close` | 不存在阻断关账项 | `posted`, `posted_with_flags`, `cost_pending` | `closed` |
| `closed` | 已关账 | `ready_to_close` | `adjusted` |
| `adjusted` | 已生成调整单 | `closed` | `closed` |
| `voided` | 批次作废 | 任意未关账状态 | 终态 |
| `superseded` | 被新批次替代 | 任意未关账状态 | 终态 |

## 2. 医院月份状态

| 状态 | 含义 |
| --- | --- |
| `not_started` | 该医院该月未开始 |
| `collecting` | 正在收集文件 |
| `in_progress` | 有批次正在解析/归类/复核 |
| `blocked` | 存在阻断入账或阻断关账质量标记 |
| `posted_with_flags` | 已入账但有待补项 |
| `ready_to_close` | 所有关账阻断项已解决 |
| `closed` | 已关账 |
| `needs_adjustment` | 关账后补单或规则影响需要调整 |

## 3. 状态推导

医院月份状态按批次和质量标记汇总：

- 无批次：`not_started`。
- 存在 `template_unrecognized` / `parse_failed` / `classification_required`：`blocked`。
- 存在 `blocks_closing=1` 且未解决：`blocked`。
- 所有批次已 `posted`，但存在 warning/info：`posted_with_flags`。
- 所有批次已 `posted` 或 `posted_with_flags`，且无未解决 `blocks_closing=1`：`ready_to_close`。
- 已执行关账动作：`closed`。
- `closed` 后有新批次或规则影响：`needs_adjustment`。

## 4. 不变量

- `closed` 批次不得被重写；只能生成 `adjusted`。
- `row_kind=subtotal/declared_total` 不得触发收入派生。
- `business_line=OUT` 不得进入实验室工序毛利。
- `period_conflict` 未解决时，批次不得进入 `posted`。
- `numeric_format_anomaly` 未解决时，批次不得进入 `posted`。
- `missing_cost` 可允许收入入账，但不得进入正常毛利关账。

## 5. Phase 1A 最小 API 建议

Phase 1A 可以先只实现后端服务，不做完整 UI。

```text
POST /api/v1/statement-batches/preview-normalized
POST /api/v1/statement-batches/:id/post
GET  /api/v1/statement-batches/:id/quality-flags
GET  /api/v1/month-close/:settlementMonth/partners/:partnerId/summary
```

响应必须包含：

- `batchStatus`
- `partnerMonthStatus`
- `blockingFlags`
- `warningFlags`
- `amountSummary`
