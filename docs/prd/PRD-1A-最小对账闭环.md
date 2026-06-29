# PRD-1A：最小对账闭环

> 对应最终路线图 §12。目标不是完整院级盈亏关账，而是用东安、赣州、平泉三个真实样本跑通“上传 -> 规范行 -> 分类/质量标记 -> 派生账本 -> 最小差异包”的最小对账闭环，并用和睦家黄金值守住病例级收入链路。

## 1. Executive Summary

**Problem Statement**：当前系统已能处理规整逐病例明细，但科目汇总、纯外送和宽表远程会诊仍难以进入可追溯的月结事实层，财务无法把真实月结作为系统主流程。

**Proposed Solution**：建立对账单导入的第一层事实模型：`statement_import_batches`、`statement_raw_rows`、`statement_normalized_lines`，并基于东安、赣州、平泉三个样本派生聚合收入账本、OUT 台账和质量标记，输出最小差异包。

**Success Criteria**：

- 东安、赣州、平泉均能生成可追溯的 `statement_normalized_lines`。
- 东安声明合计 `121016.9` 与解析合计闭合，IN/OUT 金额可解释。
- 赣州声明结算 `40219.2` 全额进入 OUT 台账，按行级月份汇总。
- 平泉远程会诊结算保留来源列，并生成期间冲突质量标记。
- 和睦家黄金 `13152` 不回退。

## 2. User Experience & Functionality

### User Personas

- 财务月结负责人：需要知道某院某月文件是否可入账、差异在哪里、谁确认。
- 运营/实施人员：需要把真实样本映射成规则、识别列语义、处理异常。
- 成本/经营分析人员：需要确保 OUT、成本待补、LIS 待补不会混入正常毛利。

### User Stories

1. 作为财务，我希望东安科目汇总能进入聚合收入账本，这样该院不会因为没有病例号从月结里消失。
2. 作为财务，我希望赣州纯外送能进入 OUT 台账，这样我能确认外送结算金额完整但不混入实验室收入。
3. 作为实施人员，我希望平泉宽表的金额保留来源列，这样我能把“远程会诊结算”按列归为 OUT。
4. 作为财务主管，我希望最小差异包能展示声明合计、解析合计、IN、OUT、未知和质量标记，这样我能判断是否可继续推进月结。

### Acceptance Criteria

- 所有导入批次都有 `batch_id`、文件哈希、模板、医院、结算月、解析器版本和配置版本。
- 所有规范行都能追溯到 source sheet、row、column。
- 小计和声明合计以 `row_kind=subtotal/declared_total` 保留，但不重复入账。
- OUT 行不进入实验室工序收入，但进入 `out_settlement_ledger`。
- 期间冲突、缺规则、数字异常、对账不平必须生成质量标记。
- 最小差异包字段符合 `docs/dev/phase-1a-acceptance-tests.md`。

### Non-Goals

- 不做 7 模板全覆盖。
- 不做完整月结工作台 UI。
- 不做 maker-checker。
- 不对接公司级 OUT 外部系统。
- 不实现完整 P&L 快照和调整单。

## 3. Technical Specifications

### Architecture Overview

```text
uploaded file/grid
  -> statement_import_batches
  -> statement_raw_rows
  -> statement_normalized_lines
  -> quality_flags
  -> partner_month_revenue_ledger / out_settlement_ledger
  -> minimum reconciliation export
```

### Integration Points

- Parser：复用现有 `statement-parser`，新增 normalized line builder。
- Config：读取逐院配置和规则版本；Phase 1A 可先用固定规则 seed 支持三样本。
- Ledger：新增聚合收入账本和 OUT 台账；不改写现有 `case_revenue` 作为 Phase 1A 主目标。
- Tests：基于 `后端代码/server/tests/fixtures/statements/*.json`。

### Security & Privacy

- 患者姓名等敏感信息只允许进入脱敏引用字段 `patient_ref` 或 raw payload；开发测试继续使用已脱敏 fixture。
- 成本/售价异常只显示给财务、管理员、成本角色；Phase 1A 可先在后端数据层定义，不做完整权限 UI。

## 4. Phase 1A Scope

### In Scope

- `statement_import_batches` schema。
- `statement_raw_rows` schema。
- `statement_normalized_lines` schema。
- `quality_flags` schema 和默认阻断矩阵。
- 批次状态机基础版。
- 东安、赣州、平泉规范化与派生。
- 和睦家黄金回归锚点。
- 最小差异包导出数据结构。

### Out of Scope

- 温州、宁波、石门完整派生账本。
- 完整前端月结工作台。
- 历史规则影响预估。
- 已关账调整单。

## 5. Risks & Roadmap

### Technical Risks

- 规范行字段过多导致首版实现过慢：先实现必需字段，长尾进入 `raw_payload`。
- 期间归属冲突导致错月入账：`period_conflict` 默认阻断。
- 小计重复入账：`row_kind` 必须参与派生过滤。
- OUT 混入实验室毛利：派生规则必须按 `business_line=OUT` 单列。

### Rollout

- MVP：三样本 + 和睦家锚点后端通过。
- v1.1：加入最小 API 和导出数据结构。
- v1.2：接入基础前端月结视图。

## 6. Open Decisions

- Phase 1A 是否需要实际落 SQLite 表，还是先以内部 normalized DTO + 测试固定输出验证字段。建议直接落表，避免后续返工。
- 最小差异包是后端 JSON 还是 Excel。建议先 JSON，Excel 放 Phase 1B。
- 平泉期间冲突是否允许用户手工选择 2026-03 放行。建议 Phase 1A 先生成阻断标记，不做放行 UI。
