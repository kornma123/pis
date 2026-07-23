# PRD-1A：最小对账闭环

版本：v1.2（LOC-004A G0 PM 定稿，2026-07-23）

> **状态**：`PM_APPROVED`；仅结束 LOC-004A PRD 内容闸，不构成 LOC-004B 实现、合并、发布或生产授权。
>
> **主 Issue**：GitHub Issue #4（LOC-004A）
>
> **作者 / 模型 / 使用界面**：Codex 文档 owner / GPT-5 / Codex Desktop
>
> **基线**：`origin/master@13c340cbb47310c80040488c22d1ceebfd61aa65`（核对日期：2026-07-23）
>
> **数据边界**：PUBLIC 脱敏规格；只引用仓库内脱敏 fixture 与 golden 登记，不引入真实 DB 或原始 PII。
>
> **PM 定稿证据**：PM 已在委托主会话明确完成复核并授权合并；GitHub PR #58 的 AI-assisted 结构化评论绑定最终 PR head。

> 对应最终路线图 §12。目标不是完整院级盈亏关账，而是用东安、赣州、平泉三个真实样本跑通“上传 -> 规范行 -> 分类/质量标记 -> 派生账本 -> 最小差异包”的最小对账闭环，并用和睦家黄金值守住病例级收入链路。
>
> 本轮变化：把原 §7 三项未决选择改为直接、可测试的 Decided 合同，并冻结事实对象、世代键、source readiness、幂等、关账边界和三样本 expected。LOC-004A 只结束 PRD 内容闸，不实现 LOC-004B。

## 1. Executive Summary

**Problem Statement**：当前系统已能处理规整逐病例明细，但科目汇总、纯外送和宽表远程会诊仍难以进入可追溯的月结事实层，财务无法把真实月结作为系统主流程。

**Proposed Solution**：建立对账单导入的第一层事实模型：`statement_import_batches`、`statement_raw_rows`、`statement_normalized_lines`，并基于东安、赣州、平泉三个样本派生聚合收入账本、OUT 台账和质量标记，输出最小差异包。

**Success Criteria**：

- 东安、赣州、平泉均能生成可追溯的 `statement_normalized_lines`。
- 东安声明合计 `121016.9` 与解析合计闭合，IN/OUT 金额可解释。
- 赣州声明结算 `40219.2` 全额进入 OUT 台账，按 `report_date` 派生行级月份，并记录 `settlement_month_basis='report_date'`。
- 平泉远程会诊结算保留来源列，并生成期间冲突质量标记。
- 和睦家黄金 `13152` 不回退。
- Phase 1A 的权威事实必须持久化到 SQLite 表；DTO 和 JSON 都只是从表事实生成的投影。
- 最小差异包的 canonical machine artifact 是 JSON；Excel/CSV 不作为权威事实或复算输入。
- 每个 source 的读取结果显式区分 `complete`、`complete_empty`、`partial`、`stale`、`unavailable`、`error`，未知不得折算为 `0`、`[]` 或成功。

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
- 每个批次/重算世代都有稳定 `generation_id`，绑定 `partner_id + settlement_month + source_hash + parser_revision + config_revision`。
- 所有规范行都能追溯到 source sheet、row、column。
- 小计和声明合计以 `row_kind=subtotal/declared_total` 保留，但不重复入账。
- OUT 行不进入实验室工序收入，但进入 `out_settlement_ledger`。
- 期间冲突、缺规则、数字异常、对账不平必须生成质量标记。
- `compute`、`read`、`complete`、`close` 必须消费同一 `generation_id`；跨世代、旧世代或来源不完整时 fail-closed。
- 最小差异包字段符合 `docs/dev/phase-1a-acceptance-tests.md`。

### Non-Goals

- 不做 7 模板全覆盖。
- 不做完整月结工作台 UI。
- 不做 maker-checker。
- 不对接公司级 OUT 外部系统。
- 不实现完整 P&L 快照和调整单。
- 不提供普通手工放行 `period_conflict`、普通 reopen、覆盖原始导入事实或重写已关账世代的入口。

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

DTO、API response 和 canonical JSON artifact 都是上述 SQLite 事实的只读投影，不得反向成为权威存储。

### Phase 0 / Phase 1A 事实边界

| 层级 | canonical 表 / 事实对象 | 本阶段合同 |
| --- | --- | --- |
| Phase 0（继承，不复制） | `case_revenue`、`case_revenue_lines`、`lis_cases`、`partner_configs` / `partner_config_changes` | 继续承载病例级收入、LIS 工作量与配置版本谱系；Phase 1A 不以新表静默改写这些事实。和睦家 `G-REV-1` 只做回归守卫。 |
| Phase 1A 原始事实 | `statement_import_batches`、`statement_raw_rows` | SQLite 持久化；batch metadata 与 raw row 不可变。原始文件/网格的 hash 与来源定位必须可审计。 |
| Phase 1A 可重算事实 | `statement_normalized_lines`、`quality_flags` | 每行绑定 batch 和 `generation_id`；新 parser/config 只能产生新世代，不能覆盖旧世代。 |
| Phase 1A 派生账本 | `partner_month_revenue_ledger`、`out_settlement_ledger` | 只从同一世代的规范行重建；保持 `statement_internal`，不得静默并入 `case_revenue` / `partner-pnl`。 |
| Phase 1A 投影 | `SourceReadinessResult<T>`、最小差异包 JSON | 不是事实存储；必须可追溯到上述表、世代和 artifact hash。现有 `reconcile_hospital_months` 布尔 ready 字段不得作为 Phase 1A source readiness 权威。 |

LOC-004B 落地 schema 时，以本节为直接规格：当前蓝图中的 `source_hash` 单列唯一约束必须收敛为下节的世代/幂等合同，不能阻止同一原始来源在新 parser/config revision 下生成可审计的新世代。

### 世代、幂等与单一消费面

- `generation_id` 必须由 `partner_id`、规范化后的 `settlement_month`、`source_hash`、`parser_revision`、`config_revision` 确定；缺任一字段不得进入 `complete`、`posted` 或 `closed`。
- 同一完整世代键的上传、post 或重算重试必须返回同一有效 batch/结果，不新增第二份规范行或账本金额；对应账本仍以 `source_line_id` 唯一。
- 同一 `source_hash` 使用新 parser/config revision 重算时，必须创建新世代并保留 `supersedes_generation_id`（或等价谱系）；旧世代不可覆盖，只能标为非当前。
- partner+month 的 `compute`、`read`、`complete`、`close` 必须显式携带并校验同一 `generation_id`。旧请求迟到、跨世代拼接或完成后世代变化均返回冲突/阻断，不得拿旧完成覆盖新状态。

### Source readiness 合同

`SourceReadinessResult<T>` 至少包含 `source`、`partner_id`、`settlement_month`、`generation_id`、`state`、`observed_at`、稳定 `reason_code`，以及仅在合同允许时出现的 `data` / totals：

| state | 可证明事实 | 数据/金额规则 | 是否可参与 complete/close |
| --- | --- | --- | --- |
| `complete` | 同一世代的必需字段与覆盖范围全部成功取得，且有非空有效事实 | 返回经有限数与精度校验的数据；不得混入别的世代 | 是，仍需全部质量门通过 |
| `complete_empty` | 权威 source 对该 partner+month+generation 明确返回“完整但为空” | 可以返回显式空集合和 0，但必须保留 state、世代与证据；不能由 404/缺表/异常推导 | 是，仍需全部质量门通过 |
| `partial` | 只取得部分页、部分 sheet、部分来源或覆盖范围未闭合 | 保留已知值并标 partial；未知部分不补 0 | 否 |
| `stale` | 仅有较旧成功世代/上次成功值 | 可保留上次成功上下文供查看，但必须标旧世代且不可用于不可逆动作 | 否 |
| `unavailable` | source 未连接、无权限、暂不可达或合同不存在 | 不返回伪造的 `0` / `[]` / success | 否 |
| `error` | 请求、解析、校验或持久化失败 | 返回稳定错误码；不得吞错变空结果 | 否 |

任何消费者都不得用 truthy/falsey、行数或默认值把上述状态压成布尔 ready；只有同一世代的必要 sources 全部为 `complete` / `complete_empty`，且阻断标记为零，才可继续完成或关账。

### Integration Points

- Parser：复用现有 `statement-parser`，新增 normalized line builder，并把 parser revision 固定进世代。
- Config：读取逐院配置和规则版本；Phase 1A 必须用版本化固定 seed 支持三样本，三样本 seed 规则见 §6。
- Classifier：除既有项目名/前缀/备注匹配外，必须支持 `category_summary` 对“项目名称”列里的类别名做 keyword 匹配。
- Ledger：新增聚合收入账本和 OUT 台账；不改写现有 `case_revenue` 作为 Phase 1A 主目标。
- Tests：基于 `后端代码/server/tests/fixtures/statements/*.json`。

### Security & Privacy

- 患者姓名等敏感信息不得进入 PUBLIC PRD、fixture、日志或 canonical JSON；受控 SQLite raw payload 如确有业务必要，必须留在批准边界并以脱敏 `patient_ref` 对外投影。开发测试只使用已脱敏 fixture。
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
- canonical 最小差异包 JSON 数据结构。
- 六态 `SourceReadinessResult<T>` 与同世代消费门。
- 已关账世代不可重写的硬门；Phase 1A 不实现 adjustment/reclassification 流程本身。

### Out of Scope

- 温州、宁波、石门完整派生账本。
- 完整前端月结工作台。
- 历史规则影响预估。
- 已关账调整单。
- Excel/CSV 权威导出或复算输入。
- 普通期间冲突放行、普通 reopen、maker-checker adjustment/reclassification。

## 5. Risks & Roadmap

### Technical Risks

- 规范行字段过多导致首版实现过慢：先实现必需字段，长尾进入 `raw_payload`。
- 期间归属冲突导致错月入账：`period_conflict` 在 Phase 1A 必须双阻断且不可普通手工放行。
- 小计重复入账：`row_kind` 必须参与派生过滤。
- OUT 混入实验室毛利：派生规则必须按 `business_line=OUT` 单列。

### Rollout

- MVP：三样本 + 和睦家锚点后端通过。
- v1.1：加入最小 API 和导出数据结构。
- v1.2：接入基础前端月结视图。

## 6. v1.1 开发默认规则

### 6.1 行级归属月

`row_settlement_month` 的优先级为：用户选择 > header > 文件名 > sheet > 行日期。需要使用行日期时，默认取 `report_date`，因为报告出具通常代表可结算时间点。

- 赣州纯 OUT 样本必须按 `report_date` 派生行级月份。
- `statement_normalized_lines` 必须记录 `settlement_month_basis`，赣州验收期望值为 `report_date`。
- 若 `report_date` 缺失但存在送检/接收日期，Phase 1A 不自动换列入账，应生成质量标记并进入复核。

### 6.2 三样本固定 seed 分类规则

Phase 1A 先用固定 seed 规则覆盖三样本，productize 时再由逐院配置表达 `category/source_label -> business_line`。

东安 `category_summary` 的匹配对象是“项目名称”列里的类别名。

| 类别/关键词 | 默认业务线 | 说明 |
| --- | --- | --- |
| 常规病理诊断 | IN | 院内病理收入 |
| 免疫组化 / IHC | IN | 院内工序 |
| EBER | IN | 院内原位杂交/化学探针，**已确认归 IN（用户 2026-06-29）** |
| 特殊染色 | IN | 院内实物工序，**已确认归 IN（用户 2026-06-29）** |
| 冰冻 | IN | 院内工序 |
| P16 | IN | 院内工序 |
| HPV / HPV-E6E7 | OUT | 依赖默认目录或 seed，不得因目录缺失落 UNKNOWN |
| 基因检测 | OUT | 外送/外包检测 |
| FISH | OUT | 外送/外包检测 |

赣州纯外送整单固定为 `line_grain=out`、`business_line=OUT`，不要求逐 case 匹配。

平泉宽表固定 seed：

- `source_label='远程会诊结算'`：`business_line=OUT`。
- `source_label='免组结算金额'`：本 fixture 金额为 0 时保留规范行但不派生账本；若出现非零值，固定为 `business_line=UNKNOWN`、`classification_status=pending` 并生成阻断 `missing_rule`，Phase 1A 不猜 IN/OUT、不普通手工放行。

### 6.3 P&L 并表边界

`partner_month_revenue_ledger` 与 `out_settlement_ledger` 是 Phase 1A 新派生层；现有院级盈亏看板仍主要读取 `case_revenue` / `partner-pnl` 链路。

- Phase 1A 最小差异包必须标注 `ledger_scope='statement_internal'` 或等价字段，避免误以为现有 P&L 看板已经关账。
- Phase 1A 之后单独做并表任务：定义聚合账本、OUT 台账、病例级收入在院级 P&L 中的消费优先级和对账关系。
- 并表完成前，测试只证明后端规范行和派生账本正确，不承诺完整院级 P&L 闭合。

### 6.4 关账不可逆边界

- 原始 batch/raw row 永远不可覆盖；规范行、质量标记和派生账本按世代追加/重建，旧世代保留审计谱系。
- `period_conflict` 在 Phase 1A 始终 `blocks_posting=1` 且 `blocks_closing=1`；普通用户选择月份、改 flag 为 resolved、直接 `UPDATE` 或普通 reopen 都不得解除该门。
- `close` 必须绑定 partner+month+generation 和 canonical JSON artifact hash。进入 `closed` 后，任何普通 update/recompute/reopen 都必须以稳定冲突码失败，原世代及原始导入事实不变。
- 未来如需纠正，只能另立具名 `adjustment` / `reclassification` 工程合同，要求 maker 与 checker 分离、具名理由、before/after、原世代引用和不可删审计；该入口不属于 LOC-004A/LOC-004B 的 Phase 1A 授权。

## 7. Decided Contracts（LOC-004A G0）

1. **持久化事实**：Phase 1A 使用 SQLite 权威表；`statement_import_batches`、`statement_raw_rows`、`statement_normalized_lines`、`quality_flags`、`partner_month_revenue_ledger`、`out_settlement_ledger` 是 canonical facts。DTO 只是 API/内部投影，不接受 DTO-only 作为事实存储。
2. **差异包格式**：canonical machine artifact 固定为 JSON，并对 canonical serialization 计算 artifact hash。Excel/CSV 只能在后续独立范围中作为可选展示导出，不是权威、不回写、不作为复算输入。
3. **平泉期间冲突**：Phase 1A fail-closed，不允许普通手工选择 `2026-03` 放行。保留解析事实与冲突证据，但不得 `posted` / `closed`。未来纠正只能走 §6.4 的具名 adjustment/reclassification + maker-checker + audit 合同，不覆盖原始导入事实。

三项均为可测试合同；本节不再保留未决选择。

## 8. 三样本固定 expected 与 golden 边界

| Fixture | 同世代 expected | 阻断 / 派生结果 | 锚状态 |
| --- | --- | --- | --- |
| 东安 `out_category_summary__dongan_2601.json` | declared=`121016.9`；IN=`93264.9`；OUT=`27752.0`；IN+OUT 与 declared 差 `<=0.01` | FISH=0 规范行保留但不生成 0 金额 OUT ledger；subtotal/declared_total 不重复入账；无 `declared_total_mismatch` | Phase 1A `Candidate Anchor`，未进 CI 前不得称 Locked |
| 赣州 `out_outsourced_detail__ganzhou.json` | 全部 OUT；2026-01=`2570.4`、2026-02=`7534.8`、2026-03=`30114.0`，合计=`40219.2` | 每行 `settlement_month_basis='report_date'`；`lab_revenue_amount=0` 是已知 OUT 口径，不是未知补零；缺 report_date 时阻断 | Phase 1A `Candidate Anchor`，未进 CI 前不得称 Locked |
| 平泉 `out_consult_remote__pingquan_2603.json` | 远程会诊两行各 `308.7`，parsed/declared=`617.4`；来源列保留 | 文件/header 指向 2026-03、sheet 指向 202510，生成 `period_conflict` 双阻断；可保留规范行和解析金额，但不得生成可关账的 posted ledger，不得普通手工放行 | Phase 1A `Candidate Anchor`，未进 CI 前不得称 Locked |

和睦家 `G-REV-1 = 13152` 继续按 `docs/golden-registry.md` 作为既有 Locked Golden 回归守卫；它不因三样本 Candidate 而降级，也不把三样本自动升级为 Locked Golden。

## 9. LOC-004A 退出与下游边界

- 本 commit/PR 的状态是 `PM_APPROVED`：PM 已对本轮内容明确完成复核并授权合并，LOC-004A PRD 内容闸结束；该接受不替代 required checks、正式合并结果或任何下游实现/发布授权。
- LOC-004A 不等于 LOC-004B 已实现，不等于 PR 已合并，不等于 mockup/实现授权，不等于数据库迁移、发布或生产上线。
- LOC-004B 仍需以合并后的本 PRD 固定 SHA、PM 确认的工程 Issue、新一轮唯一 ownership/develop preflight 为入口；必须另做 schema、迁移、路由、消费者、RED→GREEN、变异和真跑验收。
- 当前规格没有剩余会改变 schema、财务口径或三样本 expected 的未决选择；新事实若推翻任一 decided contract，恢复为待修订并重新过 PM 闸，不在实现中静默改写。
