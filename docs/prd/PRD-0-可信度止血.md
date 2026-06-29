# PRD-0：可信度止血（Phase 0）

> 对应路线图【最终定稿】§11。目标 = 让**当前已有链路不再污染数据**，不引入新产品功能。全部已决策、可 TDD、不依赖产品 Epic。
> 周期：1–2 周。守护红线：黄金 ¥13,152 不回退、后端全量零回归（基线 448 通过 + 本 PRD 新增红测试）。

## 1. 范围
**In scope**：① 跨院串账全链路复合键 `(partner_id, case_no)`；② 配置读/回滚路径归一；③ NGS 缺成本/售价质量标记。
**Out of scope**：规范行/聚合账本/月结工作台/状态机（PRD-1A）；v0 死锁（Phase 1B 建档向导）；NGS 读路由 RBAC（Epic C）；弹层焦点（独立小修）。

## 2. 任务拆分

### T1 — 跨院串账：全链路复合键 `(partner_id, case_no)`（最大项）
> 背景：PR#10 已把 `case_revenue` 唯一键改为 `(partner_id, case_no, service_month)`，但 `lis_cases`/ABC/P&L 读链路仍按 `case_no` 单键（codex 04 CRITICAL 实证）。本任务补齐全链路。

| 子任务 | 文件 | 改动 |
|---|---|---|
| T1.1 lis_cases 唯一键 | `database/DatabaseManager.ts:321` | `case_no TEXT NOT NULL UNIQUE` → 整表重建迁移为 `UNIQUE(partner_id, case_no)`（仿 case_revenue 重建迁移，事务内幂等；迁移前审计重复键） |
| T1.2 LIS 导入幂等 | `routes/lis-cases-v1.1.ts:41`、`utils/lis-import.ts` | `ON CONFLICT(case_no)` → `ON CONFLICT(partner_id, case_no)`；导入前先 upsert partner、确保 partner_id 非空 |
| T1.3 人工覆盖 | `routes/lis-cases-v1.1.ts`（specimen 覆盖等） | 覆盖/查询的 WHERE 带 partner_id |
| T1.4 P&L 收入 join | `utils/partner-pnl-service.ts:57` | `LEFT JOIN lis_cases lc ON lc.case_no = cr.case_no` → `ON lc.partner_id = cr.partner_id AND lc.case_no = cr.case_no` |
| T1.5 case 成本 rollup | `utils/abc-partner-link.ts`（`getCaseCostRollup`/`getPartnerCostRollup`/`getPartnerCostByMonth`） | 按 case 汇总改 `(partner_id, case_no)`，case 级下钻不串院 |
| T1.6 ABC 回填（**有设计难点，见 §4**） | `utils/abc-partner-link.ts:13` `backfillAbcPartnerIds` | 现按 `case_no` 把 lis_cases.partner_id 回填到 outbound_abc_details；复合键下 case_no 可能对应多院 → 需定回填口径 |

### T2 — 配置归一覆盖读/回滚路径
| 子任务 | 文件 | 改动 |
|---|---|---|
| T2.1 读路径归一 | `utils/partner-config.ts:213` `row2config` | `JSON.parse(json)` → `try { return normalizeConfig(JSON.parse(json)) } catch { return JSON.parse(json) }`（best-effort：治历史 `discount.def=90`，但解析坏配置不致 loadConfig 崩） |
| T2.2 回滚校验 | `utils/partner-config.ts` `rollbackConfig` | 回滚 target 写新版本前 normalize；无法 normalize 的坏历史版本返回明确错误（路由 400），不生成 current |

### T3 — NGS 缺成本/售价质量标记
| 子任务 | 文件 | 改动 |
|---|---|---|
| T3.1 缺值不入利润事实 | `routes/ngs-v1.1.ts` import | 缺 outsource_cost/sell_price 的订单：要么硬 400 不落库；要么落库但写质量标记 + `confirmed_incomplete` 列，P&L 默认排除/单列。**口径见 §4 待定**。响应同时返回 `missingPriceCount` |
| T3.2 P&L 排除/单列 | `utils/partner-pnl-service.ts`（NGS 并入） | 未核成本 NGS 不混入正常 `totalMargin`，单列「未核 NGS 毛利」或排除 |

## 3. 测试用例（红测试先行，每个先红后绿）
- **TC1 跨院同号（已有 statement-commit 测试，补 P&L/ABC 链路）**：A、B 两院各导入 LIS `S26-DUP` + 各自 case_revenue + 各自 ABC 成本 → `buildPartnerPnl({partnerId:B})` 只读 B 的 LIS 数量/成本，不串 A；`getCaseCostRollup` 不把 A/B 同号成本混算。
- **TC2 LIS 导入跨院不覆盖**：先导 A 的 `S26-DUP`，再导 B 的 `S26-DUP` → 两条 lis_cases 都在，A 的 partner_id/数量不被 B 覆盖。
- **TC3 配置历史坏扣率**：直接写一条 `config_json` 含 `discount.def=90` 的历史版本 → `loadConfig`/`peekConfig` 读出后 `discount.def===0.9`；缺结算列的行 settle 不再 ×90。
- **TC4 回滚坏版本**：rollback 到含坏扣率的历史版本 → 新 current 已归一（或 400 拒绝），不带坏值。
- **TC5 NGS 缺成本**：import `{订单号,产品名,售价:8500}` 无成本 → 按 §4 口径：硬 400 或 落库+质量标记+P&L 不计入正常毛利；响应含 `missingPriceCount`。
- **TC6 黄金回归（防护红线）**：和睦家 W4 25 case → labRevenueTotal=¥13,152 不变。
- **全量回归**：后端 ≥448 通过，0 真失败。

## 4. ⚠️ 待互评决策（PRD-0 内部，需 codex/团队定）
1. **ABC 回填归属（T1.6）**：`outbound_abc_details` 有 `case_no`，复合键后单 `case_no` 可能对应多院的 lis_cases。回填 partner_id 的口径？
   - 选项 A：ABC 明细也带 `partner_id` 来源（如成本计算时已知送检院）→ 回填按 `(partner_id, case_no)` 精确匹配。
   - 选项 B：`case_no` 在 ABC 侧实际全局唯一（成本由实验室自己产生、不会跨院撞号）→ 维持单键回填，仅 lis_cases/收入侧用复合键。**需确认 ABC case_no 是否真会跨院撞。**
2. **NGS 缺成本口径（T3.1）**：硬 400 拒绝 vs 落库+质量标记+P&L 排除。硬 400 更稳但财务可能确有"先入收入待补成本"的诉求；质量标记更柔但要加列。建议：**缺售价=硬 400（算不出金额）；缺成本=落库+质量标记+P&L 单列**（与定稿 §8 阻断矩阵一致）。
3. **lis_cases 重建迁移**：是否有历史数据已存在跨院同号（迁移前需审计：`SELECT case_no, COUNT(DISTINCT partner_id) FROM lis_cases GROUP BY case_no HAVING COUNT(DISTINCT partner_id)>1`）。若有，迁移策略？

## 5. 验收
- §3 全部测试绿；后端全量零回归；黄金 ¥13,152 绿。
- §4 三个决策有结论并落进实现。
- 跨院同号在 LIS/ABC/P&L 全链路不再串（TC1/TC2 证）。

## 6. 风险
- lis_cases 重建迁移触及 LIS 子系统（W3）→ 需全 LIS 相关测试零回归。
- ABC 回填口径若选错 → 成本串院（比收入串账更隐蔽）→ §4.1 必须先定。

## 7. 本轮开发默认决策（供评审确认）

> 目的：让开发可以先写红测试和迁移设计，不再因为 §4 三个问题停摆。若评审发现代码证据相反，再在实现前调整。

1. **ABC 回填归属默认采用“精确优先、拒绝歧义”**：
   - 若 `outbound_abc_details.partner_id` 已存在或可从成本源可靠取得，则按 `(partner_id, case_no)` 精确回填。
   - 若 ABC 明细只有 `case_no`，且该 `case_no` 在 `lis_cases` 中对应多个 `partner_id`，不得随机选一个；保持未回填并产生待处理质量信号或回填报告。
   - 只有在迁移审计证明 ABC 侧 `case_no` 实际全局唯一时，才允许单键回填作为兼容路径。

2. **NGS 缺值默认口径**：
   - 缺售价：硬 400，原因是无法确定收入金额。
   - 缺外包成本：允许落库，但必须写质量标记；P&L 默认排除正常毛利或单列“未核 NGS 毛利”，不得按 0 成本计入正常毛利。
   - 响应必须返回 `missingPriceCount` / `missingCostCount`，便于前端显示待补事项。

3. **历史跨院同号迁移策略**：
   - 迁移前必须输出审计结果：同 `case_no` 是否跨多个 `partner_id`，以及是否存在 `partner_id IS NULL`。
   - 对 `partner_id IS NULL` 的历史 LIS 行，不得自动并入任意医院；应保持待修复状态，或由迁移脚本生成审计清单后人工补 partner。
   - 若发现现有 `UNIQUE(case_no)` 已经导致不同医院数据被覆盖，迁移不尝试恢复被覆盖数据，只保证新结构不再继续串账，并在迁移报告中明确历史不可恢复范围。
