# Statement Import Schema v1.1

版本：v1.1（吸收云端 08 评审意见，2026-06-29）

范围：Phase 1A 最小对账闭环。

数据库：现有项目使用 SQLite 语法，以下 DDL 为设计稿，落地时按 `DatabaseManager.ts` 的 `CREATE TABLE IF NOT EXISTS` + `ensureColumn` 风格实现。

## 1. statement_import_batches

用途：一份上传文件或网格的批次骨干。原始 batch 不因跨月而拆分。

```sql
CREATE TABLE IF NOT EXISTS statement_import_batches (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  partner_name TEXT,
  source_file TEXT,
  source_hash TEXT,
  template_family TEXT,
  parser_version TEXT,
  config_version INTEGER,
  declared_period_start TEXT,
  declared_period_end TEXT,
  settlement_month TEXT NOT NULL,
  period_source TEXT NOT NULL DEFAULT 'user_selected',
  period_conflict_flag INTEGER NOT NULL DEFAULT 0,
  period_conflict_note TEXT,
  multi_month_batch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded',
  uploaded_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_statement_batches_partner_month
  ON statement_import_batches(partner_id, settlement_month);

CREATE UNIQUE INDEX IF NOT EXISTS idx_statement_batches_hash
  ON statement_import_batches(source_hash)
  WHERE source_hash IS NOT NULL;
```

## 2. statement_raw_rows

用途：保存解析前的原始网格行，供审计和重算。

```sql
CREATE TABLE IF NOT EXISTS statement_raw_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_sheet TEXT,
  source_row INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  row_kind_hint TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(batch_id) REFERENCES statement_import_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_statement_raw_rows_batch
  ON statement_raw_rows(batch_id, source_row);
```

## 3. statement_normalized_lines

用途：系统理解后的对账单金额行。它是中间事实，不等于最终 P&L。

```sql
CREATE TABLE IF NOT EXISTS statement_normalized_lines (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  settlement_month TEXT NOT NULL,
  row_settlement_month TEXT,
  row_settlement_date TEXT,
  settlement_month_basis TEXT,

  case_no TEXT,
  external_subject_key TEXT,
  patient_ref TEXT,
  department TEXT,
  item_name TEXT,
  service_code TEXT,

  source_sheet TEXT,
  source_row INTEGER,
  source_column TEXT,
  source_label TEXT,
  section_label TEXT,
  template_family TEXT,

  row_kind TEXT NOT NULL DEFAULT 'detail',
  line_grain TEXT NOT NULL DEFAULT 'case',
  business_line TEXT NOT NULL DEFAULT 'UNKNOWN',
  entity_scope TEXT NOT NULL DEFAULT 'case',
  financial_metric TEXT NOT NULL DEFAULT 'revenue',
  amount_role TEXT NOT NULL DEFAULT 'settlement',
  declared_total_scope TEXT,
  amount DECIMAL(18, 4) NOT NULL DEFAULT 0,

  quantity DECIMAL(18, 4),
  unit_price DECIMAL(18, 4),
  rate DECIMAL(10, 6),
  rate_type TEXT,
  formula_basis TEXT,

  service_date TEXT,
  send_date TEXT,
  receive_date TEXT,
  report_date TEXT,

  classification_status TEXT NOT NULL DEFAULT 'pending',
  rule_id TEXT,
  rule_version INTEGER,
  parser_confidence DECIMAL(10, 6),
  classifier_confidence DECIMAL(10, 6),
  numeric_parse_status TEXT NOT NULL DEFAULT 'ok',
  quality_state TEXT NOT NULL DEFAULT 'ok',
  raw_payload TEXT,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(batch_id) REFERENCES statement_import_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_statement_lines_batch
  ON statement_normalized_lines(batch_id, source_row);

CREATE INDEX IF NOT EXISTS idx_statement_lines_partner_month
  ON statement_normalized_lines(partner_id, settlement_month);

CREATE INDEX IF NOT EXISTS idx_statement_lines_case
  ON statement_normalized_lines(partner_id, case_no, row_settlement_month);

CREATE INDEX IF NOT EXISTS idx_statement_lines_business
  ON statement_normalized_lines(business_line, row_kind, line_grain);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_lines_identity
  ON statement_normalized_lines(batch_id, source_row, source_column);
```

说明：`source_column` 需要由 builder 提供稳定身份；没有物理列的行式模板可使用 parser 生成的占位列身份，避免重解析产生重复规范行。

## 4. quality_flags

用途：质量标记和处理闭环。Phase 1A 最小实现可先只写，不做完整处理 UI。

```sql
CREATE TABLE IF NOT EXISTS quality_flags (
  id TEXT PRIMARY KEY,
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  resolution_action TEXT NOT NULL,
  blocks_posting INTEGER NOT NULL DEFAULT 0,
  blocks_closing INTEGER NOT NULL DEFAULT 0,
  partner_id TEXT,
  settlement_month TEXT,
  related_batch_id TEXT,
  related_line_id TEXT,
  message TEXT,
  resolved_by TEXT,
  resolved_at DATETIME,
  resolution_note TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(related_batch_id) REFERENCES statement_import_batches(id),
  FOREIGN KEY(related_line_id) REFERENCES statement_normalized_lines(id)
);

CREATE INDEX IF NOT EXISTS idx_quality_flags_batch
  ON quality_flags(related_batch_id, blocks_posting, blocks_closing);

CREATE INDEX IF NOT EXISTS idx_quality_flags_line
  ON quality_flags(related_line_id);

CREATE INDEX IF NOT EXISTS idx_quality_flags_partner_month
  ON quality_flags(partner_id, settlement_month, blocks_closing);
```

## 5. partner_month_revenue_ledger

用途：非逐病例聚合收入账本。Phase 1A 用于东安。

```sql
CREATE TABLE IF NOT EXISTS partner_month_revenue_ledger (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  settlement_month TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  category_label TEXT,
  business_line TEXT NOT NULL,
  gross_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
  settlement_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
  adjustment_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
  rule_id TEXT,
  rule_version INTEGER,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(batch_id) REFERENCES statement_import_batches(id),
  FOREIGN KEY(source_line_id) REFERENCES statement_normalized_lines(id)
);

CREATE INDEX IF NOT EXISTS idx_partner_month_ledger
  ON partner_month_revenue_ledger(partner_id, settlement_month, business_line);

CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_month_ledger_source_line
  ON partner_month_revenue_ledger(source_line_id);
```

## 6. out_settlement_ledger

用途：OUT 台账。Phase 1A 用于赣州纯外送和平泉远程会诊。

```sql
CREATE TABLE IF NOT EXISTS out_settlement_ledger (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  settlement_month TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  out_type TEXT NOT NULL,
  item_name TEXT,
  case_no TEXT,
  external_subject_key TEXT,
  gross_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
  settlement_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
  lab_revenue_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
  handoff_status TEXT NOT NULL DEFAULT 'internal_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(batch_id) REFERENCES statement_import_batches(id),
  FOREIGN KEY(source_line_id) REFERENCES statement_normalized_lines(id)
);

CREATE INDEX IF NOT EXISTS idx_out_settlement_partner_month
  ON out_settlement_ledger(partner_id, settlement_month, out_type);

CREATE UNIQUE INDEX IF NOT EXISTS uq_out_settlement_source_line
  ON out_settlement_ledger(source_line_id);
```

## 7. Enumerations

### row_kind

- `detail`
- `subtotal`
- `declared_total`
- `header`
- `note`

### line_grain

- `case`
- `aggregate`
- `out`
- `joint`
- `adjustment`
- `retainer`

### business_line

- `IN`
- `OUT`
- `UNKNOWN`
- `NEUTRAL`
- `EXCLUDED`

### amount_role

- `gross`
- `settlement`
- `discount`
- `cost`
- `adjustment`
- `surcharge`
- `declared_total`
- `subtotal`

### status

See `docs/dev/month-close-state-machine.md`.

### settlement_month_basis

- `user_selected`
- `header`
- `file_name`
- `sheet`
- `report_date`
- `send_date`
- `receive_date`
- `service_date`
- `manual_override`

### declared_total_scope

- `batch`
- `section`
- `business_line`

## 8. Phase 1A 派生规则

- `row_kind IN ('subtotal', 'declared_total', 'header', 'note')` 不派生收入账本。
- `business_line='IN' AND line_grain='aggregate'` 派生到 `partner_month_revenue_ledger`。
- `business_line='OUT'` 派生到 `out_settlement_ledger`，`lab_revenue_amount=0`。
- `business_line='UNKNOWN'` 不派生正常账本，生成 `missing_rule` 或 `ambiguous_rule`。
- 存在 `period_conflict`、`numeric_format_anomaly`、`declared_total_mismatch` 时，批次状态不得进入 `ready_to_close`。
- `row_settlement_month` 的来源优先级为用户选择 > header > 文件名 > sheet > 行日期；需要使用行日期时，默认取 `report_date`，并记录 `settlement_month_basis='report_date'`。
- 赣州纯 OUT 样本必须按 `report_date` 拆分 `row_settlement_month`；若 `report_date` 缺失，不得静默改用送检/接收日期入账。
- 同一 batch 重派生账本必须先按 `batch_id` 删除旧派生行，再从当前 normalized lines 重建，避免金额翻倍。
- `source_hash` 命中唯一索引时，应用层必须捕获冲突并返回 `duplicate_file` 质量标记和“忽略/替换”选择，不得返回 500。
