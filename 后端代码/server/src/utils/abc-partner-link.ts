/**
 * ABC 成本明细 ↔ 合作医院 维度链接（W6）。
 *
 * ⛔ 红线：**不改成本引擎算法**。仅按 case_no 把 lis_cases.partner_id 回填到 outbound_abc_details.partner_id，
 * 使既有 ABC 成本可【按医院上卷】。纯维度链接、可重算（增量纠错架构：派生层全量重跑）。
 */

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes?: number }; all: (...a: unknown[]) => unknown[] }
}

/**
 * 回填 outbound_abc_details.partner_id（按 case_no ← lis_cases）。幂等。
 *
 * PRD-0 T1.6 精确优先、拒绝歧义：仅当 case_no 在 lis_cases 精确对应【单一】非空 partner 时回填；
 * 跨院同号（对应多 partner）→ 不回填（不得随机选院，否则成本串院比收入串账更隐蔽），计入 skippedAmbiguous 报告。
 */
export function backfillAbcPartnerIds(db: DbLike): { updated: number; skippedAmbiguous: number; clearedAmbiguous: number } {
  // 1) 精确回填：case_no 在 lis_cases 唯一对应单一非空 partner。
  const res = db.prepare(`
    UPDATE outbound_abc_details
    SET partner_id = (
      SELECT lc.partner_id FROM lis_cases lc
      WHERE lc.case_no = outbound_abc_details.case_no AND lc.partner_id IS NOT NULL
      LIMIT 1)
    WHERE case_no IS NOT NULL
      AND (SELECT COUNT(DISTINCT lc.partner_id) FROM lis_cases lc
           WHERE lc.case_no = outbound_abc_details.case_no AND lc.partner_id IS NOT NULL) = 1
  `).run()
  // 2) 收敛清歧义：case_no 后来变跨院歧义（对应多 partner）→ 把早先单院回填的 partner_id 清回 NULL。
  //    否则历史回填值滞留 = 隐蔽成本串院（§6/§7.1「歧义保持未回填」）。保证回填幂等且收敛到当前真相。
  const cleared = db.prepare(`
    UPDATE outbound_abc_details
    SET partner_id = NULL
    WHERE case_no IS NOT NULL AND partner_id IS NOT NULL
      AND (SELECT COUNT(DISTINCT lc.partner_id) FROM lis_cases lc
           WHERE lc.case_no = outbound_abc_details.case_no AND lc.partner_id IS NOT NULL) > 1
  `).run()
  const amb = db.prepare(`
    SELECT COUNT(*) AS n FROM outbound_abc_details d
    WHERE d.case_no IS NOT NULL
      AND (SELECT COUNT(DISTINCT lc.partner_id) FROM lis_cases lc
           WHERE lc.case_no = d.case_no AND lc.partner_id IS NOT NULL) > 1
  `).get() as { n?: number } | undefined
  return { updated: Number(res?.changes) || 0, skippedAmbiguous: Number(amb?.n) || 0, clearedAmbiguous: Number(cleared?.changes) || 0 }
}

/** case 成本 rollup 复合键（T1.5）：partner_id + case_no，跨院同号成本不混算。partner_id 为空（含未回填的歧义行）归到空院键，不串入任何医院。 */
const CASE_KEY_SEP = '\u0000'
export function caseCostKey(partnerId: string | null | undefined, caseNo: string): string {
  return `${partnerId ?? ''}${CASE_KEY_SEP}${caseNo}`
}

export interface PartnerCost {
  partnerId: string
  costTotal: number
  rows: number
}

// 与既有 ABC 口径一致（cost-calculator.ts / abc-v1.1.ts）：只计已核算成本，排除待核算/异常/作废。
const COST_OK = "COALESCE(cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception', 'voided')"
const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** 按医院上卷 ABC 成本（total_cost）。可选服务月(cost_month)过滤。 */
export function getPartnerCostRollup(db: DbLike, opts: { serviceMonth?: string } = {}): Map<string, PartnerCost> {
  let where = `partner_id IS NOT NULL AND ${COST_OK}`
  const params: unknown[] = []
  if (opts.serviceMonth) { where += ' AND cost_month = ?'; params.push(opts.serviceMonth) }
  const rows = db.prepare(`
    SELECT partner_id AS partnerId, COALESCE(SUM(total_cost), 0) AS costTotal, COUNT(*) AS rows
    FROM outbound_abc_details WHERE ${where} GROUP BY partner_id
  `).all(...params) as Array<{ partnerId: string; costTotal: number; rows: number }>
  const map = new Map<string, PartnerCost>()
  for (const r of rows) map.set(r.partnerId, { partnerId: r.partnerId, costTotal: r2(r.costTotal), rows: Number(r.rows) })
  return map
}

/**
 * 按 case 上卷 ABC 成本（total_cost）。供 case 级毛利下钻/CM 筛查。
 * T1.5：键 = (partner_id, case_no) 复合键（caseCostKey），跨院同号成本不混算。查询方用 caseCostKey(partnerId, caseNo) 取值。
 */
export function getCaseCostRollup(db: DbLike, opts: { serviceMonth?: string } = {}): Map<string, number> {
  let where = `case_no IS NOT NULL AND ${COST_OK}`
  const params: unknown[] = []
  if (opts.serviceMonth) { where += ' AND cost_month = ?'; params.push(opts.serviceMonth) }
  const rows = db.prepare(`
    SELECT partner_id AS partnerId, case_no AS caseNo, COALESCE(SUM(total_cost), 0) AS costTotal
    FROM outbound_abc_details WHERE ${where} GROUP BY partner_id, case_no
  `).all(...params) as Array<{ partnerId: string | null; caseNo: string; costTotal: number }>
  const map = new Map<string, number>()
  for (const r of rows) map.set(caseCostKey(r.partnerId, r.caseNo), r2(r.costTotal))
  return map
}

/** 某医院按 cost_month 上卷成本（趋势用：成本归到自己的成本月，避免按 case lifetime 串月重复计）。 */
export function getPartnerCostByMonth(db: DbLike, partnerId: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT cost_month AS m, COALESCE(SUM(total_cost), 0) AS costTotal
    FROM outbound_abc_details WHERE partner_id = ? AND cost_month IS NOT NULL AND ${COST_OK} GROUP BY cost_month
  `).all(partnerId) as Array<{ m: string; costTotal: number }>
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.m, r2(r.costTotal))
  return map
}
