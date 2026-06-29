# Phase 0 启动提示词（新会话粘这段）

> 复制下面整段到新 Claude Code 会话作为第一条消息。

---

任务：实现「配置驱动导入器 **Phase 0 — 可信度止血**」（PRD-0）。**TDD 红测试先行、守黄金 ¥13,152、后端全量零回归**。这是经路线图+开发材料两轮人机互评收敛后的开工第一阶段。

## 开局必读（按序）
1. `.claude/session-log.md`（当前状态置顶，含本任务来龙去脉）。
2. 记忆 `coreone-codex-deep-review`。
3. 代码与文档都在 worktree **`/Users/maxiaoyuan/Documents/coreone-bom-versioning`**（分支 `codex-rereview-p0-p6`）：
   - **PRD-0（主依据）**：`docs/prd/PRD-0-可信度止血.md`（含 §3 测试 TC1.0–TC6、§4 待定、§7 默认决策）。
   - 定稿路线图 §11：`docs/COREONE-配置驱动导入器-产品路线图-2026-06-29.md`。
   - 索引：`docs/prd/00-开发材料索引.md`。

## 工作目录与分支
`cd /Users/maxiaoyuan/Documents/coreone-bom-versioning` → `git checkout codex-rereview-p0-p6 && git pull` → `git checkout -b feat/phase0-correctness`。

## 范围（只做 PRD-0；不碰 Phase 1A 的规范行/派生账本/状态机）
- **T1 跨院串账全链路复合键 `(partner_id, case_no)`**：lis_cases 唯一键整表重建迁移 + LIS 导入 `ON CONFLICT(partner_id,case_no)` + 人工覆盖带 partner + P&L join 带 partner + ABC 回填/case 成本 rollup 带 partner。
- **T2 配置归一覆盖读/回滚路径**：`row2config` best-effort `normalizeConfig`（治历史 `discount.def=90`）+ rollback target 校验。
- **T3 NGS 缺成本/售价质量标记**：缺售价=硬 400；缺成本=落库+质量标记+P&L 默认排除/单列「未核 NGS 毛利」；响应返回 `missingPriceCount`/`missingCostCount`。

## 铁律
1. **第一步先跑 T1.0 跨院审计**（决定 ABC 回填口径）：
   `SELECT case_no, COUNT(DISTINCT partner_id) c FROM lis_cases GROUP BY case_no HAVING c>1;` + `outbound_abc_details` 同口径 + `partner_id IS NULL` 计数。歧义不得随机选院（codex §7.1）：保持未回填 + 质量信号；仅当审计证明 ABC 侧 case_no 全局唯一才允许兼容单键。
2. **TDD 红测试先行**：每条修复先写红测试看失败再修绿（PRD-0 §3 TC1.0–TC6）。
3. **守黄金**：和睦家 W4 25 case `labRevenueTotal=13152` 不回退（TC6）。
4. **后端全量零回归**：基线 `cd 后端代码/server && npx vitest run` = **448 通过**（12 个 `ECONNREFUSED ::1:3001` 是既有噪声、非真失败）；新增红测试后只增不减、tsc 净。
5. **lis_cases 整表重建迁移**仿已落地的 `case_revenue` 重建（`DatabaseManager.ts` 内，事务内幂等，迁移前审计；`partner_id IS NULL` 历史行不自动并入任意医院）。
6. 反复起/杀服务前先 `pkill -9 -f "src/app.ts"` 清僵尸（防锁 SQLite 库）。

## 关键文件
- `后端代码/server/src/database/DatabaseManager.ts`（lis_cases 唯一键 + 迁移；case_revenue 重建可参照）
- `src/routes/lis-cases-v1.1.ts`、`src/utils/lis-import.ts`（LIS 导入/覆盖）
- `src/utils/abc-partner-link.ts`（`backfillAbcPartnerIds` / `getCaseCostRollup` / `getPartnerCostRollup`）
- `src/utils/partner-pnl-service.ts`（P&L `JOIN lis_cases`）
- `src/utils/partner-config.ts`（`row2config` / `rollbackConfig`；`normalizeConfig` 已存在）
- `src/routes/ngs-v1.1.ts`、`src/utils/ngs-pnl.ts`、`partner-pnl-service`（NGS 并入）

## 完成标准（PRD-0 §5）
TC1.0–TC6 全绿 + 后端全量零回归 + 黄金 ¥13,152 绿 + §4/§7 三决策落实。完成后更新 `.claude/session-log.md`，并准备 Phase 0 PR（base 待定：`feat/partner-cost-profit` 或 `fix/codex-p0-p6`，届时确认）。

备注：EBER/特殊染色归 IN 已确认（属 Phase 1A seed，Phase 0 不涉及）。先做 PRD-0，不要顺手扩到 Phase 1A。
