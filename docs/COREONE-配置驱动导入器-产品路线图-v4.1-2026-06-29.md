# COREONE 配置驱动导入器产品路线图 v4.1

日期：2026-06-29

## 0. 本版定位

v4.1 是进入开发前的产品基线版。它基于 v3/v3.1 继续收敛，不再扩展大方向，而是补齐会导致“关不了账、入错月、算错账、丢上下文”的关键细节。

本版结论：

- 可以进入开发，但只进入 Phase 0 和 Phase 1A 的受控开发。
- 不建议继续多轮纯文档互评。
- 后续审查应从“路线图互评”切换为“PRD / schema / 任务拆分 / 测试用例”审查。

v4.1 继承的核心判断：

- 产品本质不是 Excel 导入器，而是病理实验室月结 sub-ledger。
- 对账单是收入主源；LIS 只做病例匹配、完整度校验和成本归属。
- 原始不可变，规范行可重算，派生账本可重建，已关账月份只能调整。
- OUT 不进实验室工序毛利，但必须进入月结事实闭环。

## 1. 已锁定决策

1. 病例身份采用全链路复合键 `(partner_id, case_no)`。
2. Phase 0 先修正确性子集：跨院串账、配置读/回滚归一、NGS 缺成本/售价质量标记。
3. 联合运营/共建按逐院 `special.joint` 配置决定是否进院级 P&L 主表；默认 OUT 单列。
4. 已关账月份只出调整单，未关账月份可一键重算。
5. 对账单为收入主源；LIS 不作为收入生产主脊。
6. Phase 1A 的目标调整为“最小对账闭环”，不是完整院级盈亏关账。

## 2. v4.1 相比 v3/v3.1 的关键变化

| 模块 | v3/v3.1 | v4.1 |
| --- | --- | --- |
| Phase 1A 定义 | 最小可关账月 | 改为最小对账闭环；如要证明院级盈亏关账，必须加入和睦家病例级锚 |
| 期间归属 | 提到跨月 case | 增加文件名、sheet、标题、行日期冲突处理和字段 |
| 规范行 | 基础字段 | 增加行类型、声明合计、小计、数量、单价、扣率、分配率、公式来源、实体视角 |
| 石门共建 | `line_grain=joint` | 增加 `entity_scope`、`financial_metric`、数字格式异常 |
| 状态机 | 主成功路径 | 增加失败态、中间态、重算态、废弃态 |
| 质量标记 | 字段定义 | 增加默认阻断矩阵 |
| 月结差异包 | 原则性描述 | 明确最小字段清单 |

## 3. 开发闸门

### 3.1 可以立即进入开发的范围

Phase 0 可以立即开发：

- 全链路 `(partner_id, case_no)`。
- 配置读/回滚归一。
- NGS 缺成本/售价质量标记。
- 黄金值 `13,152` 回归保护。

Phase 1A 可以进入设计和开发：

- `statement_import_batches`。
- `statement_raw_rows`。
- `statement_normalized_lines` 最小字段集。
- 质量标记最小模型。
- 月结状态机基础版。
- 东安、赣州、平泉 3 样本的最小对账闭环。
- 最小月结差异包。

### 3.2 不应立即开发的范围

以下内容不应挤进 Phase 1A：

- 7 模板全量覆盖。
- 完整 maker-checker。
- 公司级 OUT 外部系统接口。
- 完整 P&L 快照和调整单体系。
- NGS 前端完整导入。
- 批量识别和任务分派。

### 3.3 开发前必须补成任务说明的内容

进入开发前，不需要再做路线图互评，但必须把以下内容拆成 PRD 或工程任务：

- Phase 0 schema migration 和回归测试。
- `statement_normalized_lines` 最小字段和枚举。
- 期间归属优先级。
- 质量标记默认阻断矩阵。
- Phase 1A 三样本验收用例。
- 月结差异包字段。

## 4. 北极星和成功标准

北极星：财务能在一个月结周期内完成所有医院结算单导入、分类确认、异常处理、院级盈亏生成与审计留痕，不再依赖线下 Excel 当主账。

v4.1 将成功标准拆成两层。

### 4.1 Phase 1A 成功标准

Phase 1A 的成功标准是最小对账闭环：

- 东安科目汇总能入聚合收入账本。
- 赣州纯外送能入 OUT 台账，`labRevenue = 0`，`outSettle = 全额`。
- 平泉宽表能保留来源列，并按列确认远程 OUT 规则。
- 三个样本都能追溯原始文件、sheet、行、列、规则版本。
- 质量标记能说明是否阻断入账、是否阻断关账、由谁处理。
- 能导出最小月结差异包。

### 4.2 完整月结成功标准

完整月结成功标准留到 Phase 1B/2：

- 7 类模板均有明确处理路径。
- 病例级收入、聚合收入、OUT、共建和调整能统一进入月结视图。
- 未关账可重算，已关账只出调整单。
- P&L 快照可审计。
- 所有金额可解释为 IN、OUT、调整、未匹配、成本待补或人工确认。

## 5. 期间归属规则

期间归属是 v4.1 的必须补项。真实样本存在明显冲突：

- 赣州文件覆盖 2026-01 至 2026-03。
- 平泉文件名和标题是 202603，但 sheet 写 202510。
- 宁波文件名是 202602，但 header 期间是 20240101-20240131。
- 和睦家文件中存在 2026-03 日期落在 2 月结算表内。

### 5.1 批次层字段

`statement_import_batches` 增加：

| 字段 | 说明 |
| --- | --- |
| `declared_period_start` | 文件标题或表头声明开始日期 |
| `declared_period_end` | 文件标题或表头声明结束日期 |
| `settlement_month` | 本批次最终归属月 |
| `period_source` | `filename` / `sheet` / `header` / `user_selected` / `row_dates` |
| `period_conflict_flag` | 是否存在期间冲突 |
| `period_conflict_note` | 冲突说明 |
| `multi_month_batch` | 是否跨多月 |

### 5.2 规范行字段

`statement_normalized_lines` 增加：

| 字段 | 说明 |
| --- | --- |
| `service_date` | 服务/登记日期 |
| `send_date` | 送检日期 |
| `receive_date` | 接收样本日期 |
| `report_date` | 报告日期 |
| `row_settlement_month` | 行级结算归属月 |
| `period_conflict_flag` | 行级期间冲突 |

### 5.3 默认优先级

默认归属优先级：

1. 用户在月结工作台选择的 `settlement_month`。
2. 文件标题或表头声明期间。
3. 文件名期间。
4. sheet 名期间。
5. 行级日期。

规则：

- 文件名、sheet、header 冲突时，不自动静默选择，生成 `period_conflict` 质量标记。
- 跨多月文件可拆为多个行级归属月，但原始 batch 不拆，派生账本按 `row_settlement_month` 汇总。
- 已关账月份补单只能生成调整单。

## 6. 数据模型

v4.1 继续采用两层模型：不可变导入与规范行，派生账本与快照。

### 6.1 不可变导入层

核心表：

- `statement_import_batches`
- `statement_raw_rows`
- `statement_normalized_lines`

### 6.2 `statement_normalized_lines` v4.1 最小字段

| 字段 | 说明 |
| --- | --- |
| `line_id` | 规范行 ID |
| `batch_id` | 批次 ID |
| `partner_id` | 医院/合作方 |
| `settlement_month` | 最终结算月 |
| `row_settlement_month` | 行级结算月 |
| `case_no` | 病例号，可为空 |
| `external_subject_key` | 无病例号时的稳定行身份 |
| `patient_ref` | 脱敏患者引用 |
| `department` | 科室 |
| `item_name` | 项目名称 |
| `service_code` | 服务项目代码 |
| `source_sheet` | 来源 sheet |
| `source_row` | 来源行 |
| `source_column` | 来源列 |
| `source_label` | 来源列业务标签 |
| `section_label` | 分段/小计段落标签 |
| `template_family` | 模板家族 |
| `row_kind` | `detail` / `subtotal` / `declared_total` / `header` / `note` |
| `line_grain` | `case` / `aggregate` / `out` / `joint` / `adjustment` / `retainer` |
| `business_line` | `IN` / `OUT` / `UNKNOWN` / `NEUTRAL` / `EXCLUDED` |
| `entity_scope` | `case` / `partner` / `department` / `project` / `hospital` |
| `financial_metric` | `revenue` / `cost` / `profit` / `profit_rate` / `share` |
| `amount_role` | `gross` / `settlement` / `discount` / `cost` / `adjustment` / `surcharge` / `declared_total` / `subtotal` |
| `amount` | 金额 |
| `quantity` | 数量 |
| `unit_price` | 单价 |
| `rate` | 扣率或分配率 |
| `rate_type` | `discount` / `allocation` / `tax` / `manual` |
| `formula_basis` | 结算金额来源：声明、行公式、配置、人工 |
| `service_date` | 服务/登记日期 |
| `send_date` | 送检日期 |
| `receive_date` | 接收样本日期 |
| `report_date` | 报告日期 |
| `classification_status` | 自动分类、待人工、已确认、已覆盖 |
| `rule_id` | 命中规则 |
| `rule_version` | 规则版本 |
| `parser_confidence` | 解析置信度 |
| `classifier_confidence` | 分类置信度 |
| `numeric_parse_status` | 正常、疑似日期格式污染、非数字 |
| `quality_state` | 正常、警告、阻断 |
| `raw_payload` | 原始上下文 |

### 6.3 枚举说明

`row_kind` 用于避免把小计、合计、签名、说明行当成明细。

`line_grain` 用于说明金额粒度：

- `case`：逐病例。
- `aggregate`：科目/partner-month 聚合。
- `out`：外送或远程等 OUT。
- `joint`：联合运营。
- `adjustment`：红冲、补单、调账。
- `retainer`：月度固定保底费。

`business_line` 用于财务分类：

- `IN`：实验室工序收入。
- `OUT`：外送、远程、共建等移出项。
- `UNKNOWN`：需要判断。
- `NEUTRAL`：说明、小计、非业务金额。
- `EXCLUDED`：明确排除。

### 6.4 石门共建表达

石门共建利润表必须使用 `entity_scope` 和 `financial_metric` 表达：

- 医院应分得收入：`entity_scope=hospital`，`financial_metric=revenue/share`。
- 医院承担成本：`entity_scope=hospital`，`financial_metric=cost`。
- 医院利润：`entity_scope=hospital`，`financial_metric=profit`。
- 科室收入/成本/利润：`entity_scope=department`。
- 项目收入/成本/利润：`entity_scope=project`。
- 成本利润率：`financial_metric=profit_rate`。

若数字被 Excel 日期格式污染，必须生成 `numeric_format_anomaly` 质量标记，不得直接入账。

### 6.5 声明合计和小计表达

所有独立声明合计行必须保留：

- `row_kind=declared_total`
- `amount_role=declared_total`
- `declared_total_scope=batch|section|business_line`

所有小计行必须保留：

- `row_kind=subtotal`
- `amount_role=subtotal`
- `section_label`

声明合计和小计不直接派生为收入明细，但用于对账闭合和差异解释。

## 7. 派生账本

从 `statement_normalized_lines` 派生：

- `case_revenue_ledger`
- `partner_month_revenue_ledger`
- `out_settlement_ledger`
- `joint_operation_ledger`
- `quality_flags`
- `pnl_snapshots`
- `adjustment_entries`

派生规则：

- 只从 `row_kind=detail` 或明确可入账的 `adjustment/retainer` 行派生账本。
- `subtotal` 和 `declared_total` 只用于对账校验。
- `UNKNOWN` 不进入正常收入，除非人工确认。
- `OUT` 进入 OUT 台账，默认不进入实验室工序毛利。
- 已关账月份不重写派生账本，只新增调整单。

## 8. 状态机

### 8.1 批次状态

| 状态 | 含义 |
| --- | --- |
| `uploaded` | 已上传 |
| `template_unrecognized` | 模板未识别 |
| `parse_failed` | 解析失败 |
| `parsed` | 已解析到 raw rows / normalized lines |
| `classification_required` | 存在待归类行 |
| `review_required` | 可入账但需复核 |
| `posted` | 已派生到账本 |
| `posted_with_flags` | 已派生但存在质量标记 |
| `cost_pending` | 成本待补 |
| `recompute_pending` | 等待重算 |
| `recomputing` | 重算中 |
| `recompute_failed` | 重算失败 |
| `ready_to_close` | 可关账 |
| `closed` | 已关账 |
| `adjusted` | 已生成调整 |
| `voided` | 批次作废 |
| `superseded` | 被新批次替代 |

### 8.2 医院月份状态

| 状态 | 含义 |
| --- | --- |
| `not_started` | 未开始 |
| `collecting` | 收集中 |
| `in_progress` | 处理中 |
| `blocked` | 存在阻断项 |
| `posted_with_flags` | 已入账但有待补事项 |
| `ready_to_close` | 可关账 |
| `closed` | 已关账 |
| `needs_adjustment` | 需要调整 |

### 8.3 状态机原则

- 工作台首页围绕“还差什么不能关账”组织。
- 每个 `blocked` 状态必须能下钻到质量标记、批次、规范行、责任人。
- 未关账月份允许从 `posted_with_flags` 回到 `recompute_pending`。
- 已关账月份只能进入 `needs_adjustment`，不能直接重算覆盖。

## 9. 质量标记

### 9.1 质量标记字段

| 字段 | 说明 |
| --- | --- |
| `flag_type` | 类型 |
| `severity` | `blocking` / `warning` / `info` |
| `owner_role` | 财务、实施、成本、管理员 |
| `resolution_action` | 处理动作 |
| `blocks_posting` | 是否阻断入账 |
| `blocks_closing` | 是否阻断关账 |
| `related_batch_id` | 关联批次 |
| `related_line_id` | 关联规范行 |
| `resolved_by` | 处理人 |
| `resolved_at` | 处理时间 |
| `resolution_note` | 处理说明 |

### 9.2 默认阻断矩阵

| 质量标记 | 默认入账 | 默认关账 | 责任人 |
| --- | --- | --- | --- |
| `template_unrecognized` | 阻断 | 阻断 | 实施 |
| `parse_failed` | 阻断 | 阻断 | 实施 |
| `period_conflict` | 阻断 | 阻断 | 财务 |
| `missing_rule` | 阻断 | 阻断 | 实施 |
| `ambiguous_rule` | 阻断 | 阻断 | 财务/实施 |
| `missing_price` | 阻断 | 阻断 | 财务 |
| `missing_cost` | 可入收入 | 阻断毛利关账 | 成本 |
| `missing_lis` | 可暂入收入 | 阻断最终关账，除非带原因放行 | 财务 |
| `numeric_format_anomaly` | 阻断 | 阻断 | 实施 |
| `declared_total_mismatch` | 需复核 | 阻断，除非带原因放行 | 财务 |
| `pure_out_without_case` | 不阻断，进 OUT 台账 | 不阻断实验室收入关账 | 财务 |
| `manual_override` | 需复核 | 视金额和规则决定 | 财务/管理员 |
| `closed_month_change` | 不允许覆盖 | 生成调整单 | 财务 |

## 10. 模板覆盖策略

| 模板 | 样本 | v4.1 处理路径 | 阶段 |
| --- | --- | --- | --- |
| 常规病例明细 | 和睦家 | 病例级账本，复合键，黄金回归 | Phase 0/1A 锚 |
| 科目汇总 | 东安 | 规范行 -> 聚合收入账本；保留声明合计 | Phase 1A |
| 纯外送明细 | 赣州 | 规范行 -> OUT 台账；支持跨月行归属 | Phase 1A |
| 宽表远程会诊 | 平泉 | 来源列展开；期间冲突标记；列级规则 | Phase 1A |
| 混合服务费 | 温州 | section 继承语义；分配率；IN/OUT 分类 | Phase 1B |
| 宽表诊断费 | 宁波 | 列级语义；培训/授课类服务分类 | Phase 1B |
| 联合运营 | 石门 | joint 账本；实体视角和财务指标；数字异常 | Phase 1B/2 |

## 11. Phase 0：可信度止血

周期建议：1-2 周。

目标：当前已有链路不再污染数据。

范围：

- `(partner_id, case_no)` 全链路。
- LIS 导入、人工覆盖、ABC 回填、P&L join、成本 rollup 均带 partner。
- 配置读/回滚归一。
- NGS 缺成本/售价质量标记。
- 黄金值 `13,152` 不回退。

验收：

- 跨院同号回归用例通过。
- 配置历史坏扣率读出后归一。
- 缺成本/缺价 NGS 不进入正常毛利。
- 和睦家黄金用例通过。

## 12. Phase 1A：最小对账闭环

周期建议：2-3 周。

目标：用东安、赣州、平泉跑通最小对账闭环，并用和睦家作为病例级黄金锚。

范围：

- 建立规范行最小表结构。
- 建立质量标记最小模型。
- 建立批次状态机基础版。
- 东安进入聚合收入账本。
- 赣州进入 OUT 台账，支持 2026-01 至 2026-03 行级归属。
- 平泉保留来源列，识别期间冲突，支持远程列归 OUT。
- 和睦家作为病例级回归锚，不要求重做全部导入体验。
- 输出最小月结差异包。

非目标：

- 不要求 7 模板全量可入账。
- 不要求完整 P&L 快照。
- 不要求公司级 OUT 系统接口。
- 不要求 maker-checker。

验收：

- 三个样本都能生成 `statement_normalized_lines`。
- 所有入账金额能追溯原始文件、sheet、行、列。
- 声明合计和解析合计可对比。
- 未归类、期间冲突、缺成本、缺 LIS 能形成质量标记。
- 可导出最小差异包。

## 13. 最小月结差异包

Phase 1A 的差异包至少包含：

| 字段 | 说明 |
| --- | --- |
| `settlement_month` | 结算月 |
| `partner_name` | 医院 |
| `batch_id` | 批次 |
| `source_file` | 文件名 |
| `template_family` | 模板 |
| `declared_total` | 声明合计 |
| `parsed_total` | 解析合计 |
| `in_amount` | IN 金额 |
| `out_amount` | OUT 金额 |
| `adjustment_amount` | 调整金额 |
| `unknown_amount` | 未归类金额 |
| `cost_pending_amount` | 成本待补金额 |
| `lis_pending_count` | LIS 待补数量 |
| `quality_flags` | 质量标记摘要 |
| `rule_version` | 规则版本 |
| `confirmed_by` | 确认人 |
| `confirmed_at` | 确认时间 |
| `confirmation_note` | 确认说明 |

## 14. Phase 1B：模板扩展和确认体验

周期建议：2-4 周。

范围：

- 温州混合服务费。
- 宁波宽表诊断费。
- 石门联合运营。
- 默认服务目录补齐 HPV-E6E7、FISH、NGS、远程、STR。
- 模板化预览。
- confirm 原因、影响摘要、审计。

新增分类：

- `training_service`：进修学习、专家授课等培训/教学服务。
- `retainer`：月度固定保底费。
- `section_inherited`：从小计段落继承的业务语义。

验收：

- 7 模板均有明确处理路径。
- 温州分配率和 section 小计可解释。
- 宁波培训/授课金额不会误入普通病理收入。
- 石门数字格式污染被质量标记捕获。

## 15. Phase 2：治理、重算与关账制度

周期建议：3-6 周。

范围：

- 规则影响预估。
- 未关账月份重算。
- 已关账月份调整单。
- P&L 快照。
- LIS 匹配恢复。
- 黄金值产品化。
- maker-checker。

验收：

- 修改 HPV-E6E7 OUT 规则前能看到影响范围。
- 已关账月份不被静默改写。
- 未关账重算保留前后快照。
- LIS 未匹配能导出、补录、手动绑定或带原因放行。

## 16. Phase 3：规模化运营

范围：

- 批量文件自动识别。
- 样本库。
- NGS 前端导入。
- 公司级 OUT 台账接口。
- 月结风险评分。
- 任务分派。

## 17. PRD 切片

### PRD-0：可信度止血

交付：

- 复合键迁移。
- 配置归一。
- NGS 质量标记。
- 回归测试。

### PRD-1A：最小对账闭环

交付：

- 规范行 schema。
- 期间归属规则。
- 质量标记矩阵。
- 批次状态机。
- 东安、赣州、平泉、和睦家锚点。
- 最小差异包。

### PRD-1B：模板扩展

交付：

- 温州、宁波、石门。
- 默认服务目录。
- 模板化预览。
- confirm 审计。

### PRD-2：关账制度

交付：

- 规则影响预估。
- 重算和调整单。
- P&L 快照。
- maker-checker。

## 18. 关键验收场景

### 场景 1：期间冲突

Given 文件名、sheet、header 或行日期存在冲突。

When 用户导入文件。

Then 系统生成 `period_conflict` 质量标记。

And 不得静默入账到错误月份。

### 场景 2：声明合计

Given 文件包含小计或合计行。

When 系统解析规范行。

Then 小计和合计以 `row_kind=subtotal/declared_total` 保留。

And 不作为明细收入重复入账。

### 场景 3：赣州跨月纯 OUT

Given 赣州文件覆盖 2026-01 至 2026-03。

When 系统解析行日期。

Then 原始 batch 保持一个，派生 OUT 台账按行级归属月汇总。

### 场景 4：平泉宽表

Given 平泉文件包含远程会诊结算列。

When 系统解析金额列。

Then 每个金额保留来源列和来源标签。

And 财务可按列确认 OUT 规则。

### 场景 5：石门数字异常

Given 石门共建表中金额列出现日期格式值。

When 系统解析数字。

Then 生成 `numeric_format_anomaly`。

And 阻断入账和关账。

### 场景 6：缺成本

Given NGS 或 OUT 缺成本。

When 生成 P&L。

Then 不按 0 成本计算正常毛利。

And 生成阻断毛利关账的质量标记。

## 19. 风险和控制

| 风险 | 控制 |
| --- | --- |
| Phase 1A 继续膨胀 | 明确只做最小对账闭环，不做完整月结 |
| 错误月份入账 | 期间冲突质量标记默认阻断 |
| 小计重复入账 | `row_kind` 区分 detail/subtotal/declared_total |
| 石门共建算错 | `entity_scope` + `financial_metric` + 数字异常标记 |
| 纯 OUT 丢失 | OUT 台账一等公民 |
| 缺成本当 0 | 质量标记矩阵阻断毛利关账 |
| 已关账被覆盖 | 只允许调整单 |

## 20. 立即下一步

1. 启动 PRD-0 和对应工程任务。
2. 同步写 PRD-1A，重点是 schema、期间归属、质量标记矩阵和三样本验收。
3. 工程先做迁移设计和红测试，不等全部 Phase 1B 文档完成。
4. 下一轮互评只评 PRD-0/PRD-1A 和测试用例，不再评大路线图。

## 21. 结论

v4.1 已达到开发启动条件。继续做路线图互评的边际收益已经低于把 Phase 0 和 Phase 1A 拆成 PRD、schema 和测试用例的收益。

推荐动作：现在进入开发，但用阶段闸门控制范围。Phase 0 完成后再合入 Phase 1A；Phase 1A 完成最小对账闭环后，再扩 Phase 1B。
