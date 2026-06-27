/**
 * ABC 成本明细 ↔ 合作医院 维度链接（W6）。
 *
 * ⛔ 红线：**不改成本引擎算法**。仅按 case_no 把 lis_cases.partner_id 回填到 outbound_abc_details.partner_id，
 * 使既有 ABC 成本可【按医院上卷】。纯维度链接、可重算（增量纠错架构：派生层全量重跑）。
 */

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes?: number }; all: (...a: unknown[]) => unknown[] }
}

/** 回填 outbound_abc_details.partner_id（按 case_no ← lis_cases）。返回更新行数。幂等。 */
export function backfillAbcPartnerIds(db: DbLike): { updated: number } {
  const res = db.prepare(`
    UPDATE outbound_abc_details
    SET partner_id = (SELECT lc.partner_id FROM lis_cases lc WHERE lc.case_no = outbound_abc_details.case_no)
    WHERE case_no IS NOT NULL
      AND EXISTS (SELECT 1 FROM lis_cases lc WHERE lc.case_no = outbound_abc_details.case_no AND lc.partner_id IS NOT NULL)
  `).run()
  return { updated: Number(res?.changes) || 0 }
}

export interface PartnerCost {
  partnerId: string
  costTotal: number
  rows: number
}

/** 按医院上卷 ABC 成本（total_cost）。可选服务月(cost_month)过滤。 */
export function getPartnerCostRollup(db: DbLike, opts: { serviceMonth?: string } = {}): Map<string, PartnerCost> {
  let where = "partner_id IS NOT NULL AND cost_status != 'voided'"
  const params: unknown[] = []
  if (opts.serviceMonth) { where += ' AND cost_month = ?'; params.push(opts.serviceMonth) }
  const rows = db.prepare(`
    SELECT partner_id AS partnerId, COALESCE(SUM(total_cost), 0) AS costTotal, COUNT(*) AS rows
    FROM outbound_abc_details WHERE ${where} GROUP BY partner_id
  `).all(...params) as Array<{ partnerId: string; costTotal: number; rows: number }>
  const map = new Map<string, PartnerCost>()
  for (const r of rows) map.set(r.partnerId, { partnerId: r.partnerId, costTotal: Math.round((Number(r.costTotal) + Number.EPSILON) * 100) / 100, rows: Number(r.rows) })
  return map
}

/** 按 case 上卷 ABC 成本（total_cost）。供 case 级毛利下钻/CM 筛查。 */
export function getCaseCostRollup(db: DbLike, opts: { serviceMonth?: string } = {}): Map<string, number> {
  let where = "case_no IS NOT NULL AND cost_status != 'voided'"
  const params: unknown[] = []
  if (opts.serviceMonth) { where += ' AND cost_month = ?'; params.push(opts.serviceMonth) }
  const rows = db.prepare(`
    SELECT case_no AS caseNo, COALESCE(SUM(total_cost), 0) AS costTotal
    FROM outbound_abc_details WHERE ${where} GROUP BY case_no
  `).all(...params) as Array<{ caseNo: string; costTotal: number }>
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.caseNo, Math.round((Number(r.costTotal) + Number.EPSILON) * 100) / 100)
  return map
}
