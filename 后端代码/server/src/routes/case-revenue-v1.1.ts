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
import { backfillAbcPartnerIds } from '../utils/abc-partner-link.js'

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
    const lisExists = db.prepare('SELECT 1 FROM lis_cases WHERE case_no = ?')
    // 命中 LIS 且 LIS 有 partner 时以 LIS 的 partner 为权威，避免账单医院名别名/错字把收入落到与成本不同的 partner
    const lisCanonical = db.prepare('SELECT partner_id FROM lis_cases WHERE case_no = ? AND partner_id IS NOT NULL')
    const partnerByName = db.prepare('SELECT id FROM partners WHERE name = ? AND is_deleted = 0')

    // 明细按 (病理号,服务月) 分组，与聚合键一致，使「删旧+插新」在同一 case+月内成对
    const linesByCase = new Map<string, typeof agg.lines>()
    for (const ln of agg.lines) {
      const k = `${ln.caseNo}|${ln.serviceMonth}`
      const arr = linesByCase.get(k) || []
      arr.push(ln)
      linesByCase.set(k, arr)
    }

    const unmatched: string[] = []
    const nameMismatch: string[] = []
    let matchedToLis = 0
    // 整批事务：任一 case 失败则整体回滚（防「删了明细未补插」+ 并发交错）
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const c of agg.cases) {
        const lisRow = lisCanonical.get(c.caseNo) as { partner_id: string } | undefined
        let partnerId: string
        if (lisRow) {
          partnerId = lisRow.partner_id // LIS canonical（收入与成本归同一 partner）
          const byName = partnerByName.get(c.partnerName) as { id: string } | undefined
          if (byName && byName.id !== partnerId) nameMismatch.push(c.caseNo)
        } else {
          partnerId = partnerCache.get(c.partnerName) || ''
          if (!partnerId) {
            const ref = findOrCreatePartner(db, c.partnerName, uuidv4, { createdBy: operator })
            partnerId = ref.id
            partnerCache.set(c.partnerName, partnerId)
            if (ref.created) partnersCreated++
          }
        }
        // 命中/未命中按 LIS 中是否存在该病理号判定（与 partner 是否已知解耦）
        if (lisExists.get(c.caseNo)) matchedToLis++
        else unmatched.push(c.caseNo)
        upsertRev.run(`CR-${uuidv4()}`, c.caseNo, partnerId, c.partnerName, docNo || null, c.grossAmount, c.netAmount, c.discountRate, c.serviceMonth, c.lineCount, importBatch)
        delLines.run(c.caseNo, c.serviceMonth)
        const lns = linesByCase.get(`${c.caseNo}|${c.serviceMonth}`) || []
        lns.forEach((ln, i) => insLine.run(`CRL-${uuidv4()}`, ln.caseNo, ln.partnerName, i + 1, ln.specimenName, ln.chargeItem, ln.chargeCode,
          ln.unitPrice, ln.qty, ln.unit, ln.grossAmount, ln.discountRate, ln.netAmount, ln.chargeTime, ln.serviceMonth, importBatch))
      }
      backfillAbcPartnerIds(db) // 顺带把成本维度刷新到位，减少手动回填遗漏
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    success(res, {
      importBatch,
      caseCount: agg.cases.length,
      lineCount: agg.lines.length,
      grossTotal: agg.summary.grossTotal,
      netTotal: agg.summary.netTotal,
      discountRate: agg.summary.discountRate,
      serviceMonths: agg.summary.serviceMonths,
      partnersCreated,
      matchedToLis,
      unmatchedCount: unmatched.length,
      unmatchedCases: unmatched.slice(0, 100),
      nameMismatchCount: nameMismatch.length,
      nameMismatchCases: nameMismatch.slice(0, 100),
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
