/**
 * 财务收费单据导入 → 逐 case 实收（W4 收尾）。code-agnostic：只取金额 + 病理号匹配，不解析旧码语义。
 * RBAC：读 reconciliation R（挂载层）；写 reconciliation W（对账单 = 对账域）。
 *
 * 幂等：case_revenue UNIQUE(case_no, service_month) upsert；明细行按 (case_no, service_month) 先删后插。
 * 匹配：病理号 → lis_cases；对不上的进 unmatched 清单（有实收无数量 → 拆分不可信，需复核）。
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { findOrCreatePartner } from '../utils/partner-upsert.js'
import { aggregateBilling } from '../utils/billing-revenue.js'

const router = Router()
const requireWrite = requirePermission('reconciliation', 'W')

router.post('/import', authenticateToken, requireWrite, (req, res) => {
  try {
    const db = getDatabase()
    const { lines, docNo } = req.body as { lines: Record<string, unknown>[]; docNo?: string }
    if (!Array.isArray(lines) || lines.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }

    const agg = aggregateBilling(lines)
    if (agg.cases.length === 0) { error(res, '无有效收费明细行', 'BAD_REQUEST', 400); return }

    const importBatch = `REV-${Date.now()}`
    const operator = (req as any).user?.id || null
    const partnerCache = new Map<string, string>()
    let partnersCreated = 0

    const upsertRev = db.prepare(`
      INSERT INTO case_revenue (id, case_no, partner_id, partner_name, doc_no, gross_amount, net_amount, discount_rate, service_month, line_count, import_batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_no, service_month) DO UPDATE SET
        partner_id = excluded.partner_id, partner_name = excluded.partner_name, doc_no = excluded.doc_no,
        gross_amount = excluded.gross_amount, net_amount = excluded.net_amount, discount_rate = excluded.discount_rate,
        line_count = excluded.line_count, import_batch = excluded.import_batch, updated_at = CURRENT_TIMESTAMP
    `)
    const delLines = db.prepare('DELETE FROM case_revenue_lines WHERE case_no = ? AND service_month = ?')
    const insLine = db.prepare(`
      INSERT INTO case_revenue_lines (id, case_no, partner_name, seq, specimen_name, charge_item, charge_code, unit_price, qty, unit, gross_amount, discount_rate, net_amount, charge_time, service_month, import_batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const lisMatch = db.prepare('SELECT 1 FROM lis_cases WHERE case_no = ?')

    const unmatched: string[] = []
    let matchedToLis = 0
    for (const c of agg.cases) {
      let partnerId = partnerCache.get(c.partnerName)
      if (!partnerId) {
        const ref = findOrCreatePartner(db, c.partnerName, uuidv4, { createdBy: operator })
        partnerId = ref.id
        partnerCache.set(c.partnerName, partnerId)
        if (ref.created) partnersCreated++
      }
      upsertRev.run(`CR-${uuidv4()}`, c.caseNo, partnerId, c.partnerName, docNo || null, c.grossAmount, c.netAmount, c.discountRate, c.serviceMonth, c.lineCount, importBatch)
      delLines.run(c.caseNo, c.serviceMonth)
      if (lisMatch.get(c.caseNo)) matchedToLis++
      else unmatched.push(c.caseNo)
    }
    // 明细行
    let seqByCase: Record<string, number> = {}
    for (const ln of agg.lines) {
      seqByCase[ln.caseNo] = (seqByCase[ln.caseNo] || 0) + 1
      insLine.run(`CRL-${uuidv4()}`, ln.caseNo, ln.partnerName, seqByCase[ln.caseNo], ln.specimenName, ln.chargeItem, ln.chargeCode,
        ln.unitPrice, ln.qty, ln.unit, ln.grossAmount, ln.discountRate, ln.netAmount, ln.chargeTime, ln.serviceMonth, importBatch)
    }

    success(res, {
      importBatch,
      caseCount: agg.cases.length,
      lineCount: agg.lines.length,
      grossTotal: agg.summary.grossTotal,
      netTotal: agg.summary.netTotal,
      discountRate: agg.summary.discountRate,
      serviceMonths: agg.summary.serviceMonths,
      partnersMatched: partnerCache.size,
      partnersCreated,
      matchedToLis,
      unmatchedCount: unmatched.length,
      unmatchedCases: unmatched.slice(0, 100),
    }, `导入 ${agg.cases.length} case 实收 ¥${agg.summary.netTotal}（命中 LIS ${matchedToLis}，未命中 ${unmatched.length}）`)
  } catch (e: any) {
    error(res, e.message || '导入失败')
  }
})

/** POST /preview —— 干跑：解析+聚合账单，不落库，返回汇总 + LIS 匹配预判（导入向导第1步） */
router.post('/preview', authenticateToken, requireWrite, (req, res) => {
  try {
    const db = getDatabase()
    const { lines } = req.body as { lines: Record<string, unknown>[] }
    if (!Array.isArray(lines) || lines.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }
    const agg = aggregateBilling(lines)
    const lisMatch = db.prepare('SELECT 1 FROM lis_cases WHERE case_no = ?')
    const unmatched = agg.cases.filter((c) => !lisMatch.get(c.caseNo)).map((c) => c.caseNo)
    success(res, {
      caseCount: agg.cases.length,
      lineCount: agg.lines.length,
      grossTotal: agg.summary.grossTotal,
      netTotal: agg.summary.netTotal,
      discountRate: agg.summary.discountRate,
      partnerNames: agg.summary.partnerNames,
      serviceMonths: agg.summary.serviceMonths,
      skippedRows: agg.summary.skippedRows,
      unmatchedToLis: unmatched.length,
      unmatchedCases: unmatched.slice(0, 100),
      warnings: [
        ...(unmatched.length ? [`${unmatched.length} 个病理号在 LIS 中未找到（无数量→拆分不可信，需先导 LIS 或复核）`] : []),
        ...(agg.summary.serviceMonths.length > 1 ? [`跨 ${agg.summary.serviceMonths.length} 个服务月，确认是否同一账期`] : []),
      ],
    }, '预览（未落库）')
  } catch (e: any) { error(res, e.message) }
})

router.get('/', authenticateToken, (req, res) => {
  try {
    let { page = 1, pageSize = 20, partnerId, serviceMonth, keyword } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(200, Number(pageSize) || 20))
    const db = getDatabase()
    let where = '1=1'
    const params: any[] = []
    if (partnerId) { where += ' AND partner_id = ?'; params.push(partnerId) }
    if (serviceMonth) { where += ' AND service_month = ?'; params.push(serviceMonth) }
    if (keyword) { where += ' AND case_no LIKE ?'; params.push(`%${keyword}%`) }
    const total = (db.prepare(`SELECT COUNT(*) AS t FROM case_revenue WHERE ${where}`).get(...params) as any)?.t || 0
    const offset = (page - 1) * pageSize
    const rows = db.prepare(`SELECT * FROM case_revenue WHERE ${where} ORDER BY service_month DESC, case_no DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]
    successList(res, rows.map((r) => ({
      id: r.id, caseNo: r.case_no, partnerId: r.partner_id, partnerName: r.partner_name,
      grossAmount: r.gross_amount, netAmount: r.net_amount, discountRate: r.discount_rate,
      serviceMonth: r.service_month, lineCount: r.line_count,
    })), page, pageSize, total)
  } catch (e: any) { error(res, e.message) }
})

export default router
