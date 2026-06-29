# Claude 对 codex Phase 0/1A 开发材料的优化（v1，concrete delta）

> ✅ **本文已被开发材料 v1.1 全部吸收**（见 `docs/prd/00-开发材料索引.md` §v1.1 吸收项）。留作评审记录，不再单独维护。

> 基于 codex 提交 9bf65d91 的 `docs/dev/*` + `docs/prd/PRD-1A`。验收锚数字已核验全对（findings/08）。本文是**可直接合入的具体改进**，按文件组织。给 codex 再做一版用。

## A. statement-import-schema-v1.md

### A1. 幂等键（防重复解析/重派生）—— 必补
- `statement_normalized_lines` 加唯一键（宽表一行多列=多条规范行，列是自然身份）：
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_lines_identity
    ON statement_normalized_lines(batch_id, source_row, source_column);
  ```
  重解析按此 upsert，不产生重复行。
- 派生账本（`partner_month_revenue_ledger` / `out_settlement_ledger`）：派生口径 = **按 batch_id 先删后插（幂等重建）**；并加守卫 `UNIQUE(source_line_id)`。否则同批次重派生会翻倍。

### A2. `declared_total_scope` —— 补字段（定稿 §6.4 有，schema 漏了）
normalized_lines 加 `declared_total_scope TEXT`（`batch` / `section` / `business_line`）。东安是 batch 级合计、分段单是 section 级；对账闭合要在对的层级比，否则 section 单会误判不平。

### A3. quality_flags 反范式 partner_id + settlement_month —— 建议补
工作台核心查询是"**这院这月什么阻断关账**"，现在只能 join batch。建议：
```sql
ALTER ... quality_flags 增加 partner_id TEXT, settlement_month TEXT;
CREATE INDEX IF NOT EXISTS idx_quality_flags_partner_month
  ON quality_flags(partner_id, settlement_month, blocks_closing);
```

### A4. `duplicate_file` 落地路径 —— 补说明
`idx_statement_batches_hash` 是部分唯一索引，重传同文件会让 INSERT 抛错。应用层必须 **catch 唯一冲突 → 返回 `duplicate_file` 质量标记 + 忽略/替换 选择，不能 500**。

### A5. 行级归属月来源可追溯 —— 补字段
normalized_lines 加 `settlement_month_basis TEXT`（`report_date` / `send_date` / `header` / `user_selected`），记录 `row_settlement_month` 是按哪个来源定的（配合 B1）。

## B. phase-1a-acceptance-tests.md

### B1. TC-GZ-02 必须 pin 日期列
赣州有 送检/接收/报告 三个日期列（本样本三者同月→巧合一致，规则上须定）。**默认按 `report_date`（报告出具→可结算）分月**，断言 `settlement_month_basis='report_date'`；2026-01=2570.4 / 02=7534.8 / 03=30114.0（已核验）。

### B2. TC-DA-02 加对账闭合断言
除 IN=93264.9 / OUT=27752.0，补：detail 行 IN+OUT 合计 == `declared_total=121016.9`（差 ≤0.01），且**不产生 `declared_total_mismatch`**。`row_kind=declared_total/subtotal` 不计入派生。

### B3. TC-PQ-02 期间冲突（已验证 fixture 实有，可直接测）
平泉 fixture：`sheet="平泉市医院202510月"`、标题/文件名 `...202603` → 真实冲突。断言：`period_conflict_flag=1`、生成 `period_conflict` flag(blocks_posting=1/blocks_closing=1)、`settlement_month` 未在确认前静默写入、批次不得进 `posted`。**宁波同理**（`sheet="2024.1月"` vs 文件名 `202602`）建议加 TC-NB-01。

### B4. 新增 TC-DUP-01 文件去重
同 hash 重传同一文件 → 生成 `duplicate_file`、**不产生第二个 batch、不重复 normalized_lines**（A1/A4）。

### B5. 新增 TC-RE-01 重派生幂等
同 batch 连续 post 两次 → `partner_month_revenue_ledger`/`out_settlement_ledger` 行数不翻倍（A1 删插重建）。

### B6. 东安 FISH=0 行口径
FISH 行 amount=0 → 规范行保留（line_grain=out），但**不派生 out_ledger 行**（或派生 amount=0，二选一明确）；不报缺号阻断。

## C. PRD-1A-最小对账闭环.md

### C1. 写清 3 样本固定 seed 规则（Phase 1A）
- **东安 category_summary**：在该院配置 seed 业务线——IN 关键词 `[常规病理诊断, 免疫组化, EBER, 特殊染色, 冰冻/术中, P16]`；OUT 关键词 `[HPV, 基因, FISH/荧光原位]`。匹配对象 = "项目名称"列的**类别名**。⚠️ **`HPV→OUT` 依赖默认目录含 HPV-E6E7 关键词（Epic G）**——Phase 1A seed 必须显式含，否则东安 HPV 落 UNKNOWN。
- **赣州 纯外送**：整单 `line_grain=out / business_line=OUT`，无须逐 case 匹配。
- **平泉 宽表**：列 `source_label="远程会诊结算" → OUT`；`"免组结算金额" → IN 候选(classification_status=pending，待人工确认)`。

### C2. category_summary 的分类模式 —— 明确这是 Phase 1A 要补的 classifier 能力
现 classifier 按 项目名/前缀/备注 匹配 config lines。category_summary 的 `item_name=类别名`（常规病理诊断/病理诊断HPV/…）。需 classifier 支持"**对类别名做 keyword 匹配**"（现有 keyword 逻辑基本可复用，但默认目录关键词要覆盖类别名用词）。在 PRD-1A Technical Spec 标注。

### C3. 新账本 ↔ 既有院级盈亏看板 并表 TODO
`partner_month_revenue_ledger` / `out_settlement_ledger` 是新派生层；现院级盈亏看板读 `case_revenue` / `partner-pnl`。**Phase 1A 只到后端通过**，但 PRD-1A 要显式标注"院级盈亏看板如何消费聚合账本/OUT 台账"是 Phase 1A 之后的**并表任务**，防两套收入口径并存却不对账。

## D. month-close-state-machine.md / quality-flag-matrix.md（小）
- 状态机 §3 推导补一条：存在未解决 `duplicate_file`(blocks_posting=1) → 该批次 `blocked`，不得进 `posted`。
- quality 矩阵 `owner_role` 英文枚举（finance/implementation/cost/admin）与定稿中文，落地统一：**存英文枚举、UI 显中文**，避免两处不一致。

## E. PRD-0（顺带）
- codex §7 默认决策认可。补一句：**T1.6 实现前先跑审计** `SELECT case_no, COUNT(DISTINCT partner_id) c FROM lis_cases GROUP BY case_no HAVING c>1`（及 `outbound_abc_details` 同口径）——审计结果决定 ABC 回填走精确复合键还是兼容单键。这是 Phase 0 第一步。

---
*下一步：codex 据本文再出一版 dev 材料 → 我整合后定稿 → 启动 Phase 0 编码。*
