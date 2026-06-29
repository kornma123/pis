/**
 * NGS 基因检测【外购转销】订单导入 + 产品目录 + 院级 NGS P&L。
 *
 * 业务（用户 2026-06-27 确认）：分子病理 NGS 外包第三方做，收入/成本走【独立渠道】（非 LIS、非院内对账单）。
 *  - 收入 = 给医院售价；成本 = 外包采购价(协议价)=外购直接成本（独立于 ABC）；毛利 = 售价 − 外包成本。
 * RBAC：导入/预览 = reconciliation W（数据导入）；目录/P&L 读 = cost_analysis R（成本利润敏感）。
 * 幂等：ngs_orders UNIQUE(order_no, product_name, order_month) upsert。
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission, requireAnyRole } from '../middleware/permissions.js'
import { findOrCreatePartner } from '../utils/partner-upsert.js'
import { aggregateNgsOrders } from '../utils/ngs-pnl.js'

const router = Router()
// codex HIGH-2：NGS 导入/预览写入售价/外包成本/毛利→进院级利润，须财务+管理员（与对账单导入一致）；
//   reconciliation W 含 technician/lab_director，会让非财务角色改利润数据，故收窄为 requireAnyRole('finance')。
const requireWrite = requireAnyRole('finance')
const requireCostRead = requirePermission('cost_analysis', 'R')

/** POST /import —— 导入 NGS 订单（落库，按医院归集；幂等 upsert） */
router.post('/import', authenticateToken, requireWrite, (req, res) => {
  try {
    const db = getDatabase()
    const { orders, docNo, confirm } = req.body as { orders: Record<string, unknown>[]; docNo?: string; confirm?: boolean }
    if (!Array.isArray(orders) || orders.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }

    const agg = aggregateNgsOrders(orders)
    if (agg.orders.length === 0) { error(res, '无有效 NGS 订单行', 'BAD_REQUEST', 400); return }

    // codex HIGH-3：缺外包成本→毛利被高估为售价、缺售价→毛利失真，会持久污染院级利润。
    //   非展示警告能兜住，须财务显式 confirm===true 才落库（严格布尔，与对账单门禁一致）。
    const confirmed = confirm === true
    if (!confirmed && (agg.summary.missingCostCount > 0 || agg.summary.missingPriceCount > 0)) {
      error(res,
        `NGS 订单缺外包成本 ${agg.summary.missingCostCount} 单 / 缺售价 ${agg.summary.missingPriceCount} 单，毛利会失真污染院级利润。请补全后重导，或重发带 confirm:true 显式确认入库。`,
        'NEEDS_CONFIRM', 409)
      return
    }

    const importBatch = `NGS-${docNo || uuidv4()}`
    const operator = (req as any).user?.id || null
    const partnerCache = new Map<string, string>()
    let partnersCreated = 0

    const upsert = db.prepare(`
      INSERT INTO ngs_orders (id, order_no, partner_id, partner_name, product_name, sell_price, outsource_cost, margin, order_month, import_batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_no, product_name, order_month) DO UPDATE SET
        partner_id = excluded.partner_id, partner_name = excluded.partner_name,
        sell_price = excluded.sell_price, outsource_cost = excluded.outsource_cost, margin = excluded.margin,
        import_batch = excluded.import_batch, updated_at = CURRENT_TIMESTAMP
    `)
    // 命中 LIS 的病理号以 LIS partner 为权威（收入与院内成本归同一医院）；否则按医院名 findOrCreatePartner
    const lisCanonical = db.prepare('SELECT partner_id FROM lis_cases WHERE case_no = ? AND partner_id IS NOT NULL')
    const partnerByName = db.prepare('SELECT id FROM partners WHERE name = ? AND is_deleted = 0')

    // 幂等前提：order_no + product_name 必须有。SQLite 中 UNIQUE 含 NULL 不去重 → 缺键行会在重导时重复，故跳过并报告（Codex 审查 HIGH）。
    const skippedNoKey = agg.orders.filter((o) => !o.orderNo || !o.productName).length
    const valid = agg.orders.filter((o) => o.orderNo && o.productName)
    if (valid.length === 0) { error(res, '所有订单缺少订单号或产品名，无法幂等导入（请补订单号/产品名后重试）', 'BAD_REQUEST', 400); return }

    const nameMismatch: string[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const o of valid) {
        let partnerId = ''
        const lisRow = lisCanonical.get(o.orderNo) as { partner_id: string } | undefined
        if (lisRow) {
          partnerId = lisRow.partner_id // LIS canonical（收入与院内成本归同一 partner）
          const byName = partnerByName.get(o.partnerName) as { id: string } | undefined
          if (byName && byName.id !== partnerId) nameMismatch.push(o.orderNo) // 医院名别名/错字 → 归属预警
        } else {
          partnerId = partnerCache.get(o.partnerName) || ''
          if (!partnerId) {
            const ref = findOrCreatePartner(db, o.partnerName, uuidv4, { createdBy: operator })
            partnerId = ref.id
            partnerCache.set(o.partnerName, partnerId)
            if (ref.created) partnersCreated++
          }
        }
        // order_month 缺失存 '' 而非 NULL，确保 UNIQUE(order_no,product_name,order_month) 真能去重（幂等）
        upsert.run(`NGS-${uuidv4()}`, o.orderNo, partnerId, o.partnerName, o.productName, o.sellPrice, o.outsourceCost, o.margin, o.orderMonth || '', importBatch)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    const importedRevenue = r2(valid.reduce((s, o) => s + o.sellPrice, 0))
    const importedCost = r2(valid.reduce((s, o) => s + o.outsourceCost, 0))
    const importedMargin = r2(importedRevenue - importedCost)

    success(res, {
      importBatch,
      parsedOrders: agg.summary.orderCount,
      imported: valid.length,
      skippedNoKey, // 缺订单号/产品名被跳过（无法幂等）
      revenueTotal: importedRevenue,
      costTotal: importedCost,
      marginTotal: importedMargin,
      marginRate: importedRevenue > 0 ? r2(importedMargin / importedRevenue * 100) / 100 : 0,
      orderMonths: agg.summary.orderMonths,
      partnersCreated,
      nameMismatchCount: nameMismatch.length,
      nameMismatchOrders: nameMismatch.slice(0, 100),
      missingCostCount: agg.summary.missingCostCount, // 外包成本缺失→毛利被高估，需补
      negativeMarginCount: agg.summary.negativeMarginCount,
    }, `导入 ${valid.length}/${agg.summary.orderCount} 单 NGS，收入 ¥${importedRevenue}，外包成本 ¥${importedCost}，毛利 ¥${importedMargin}` +
      (skippedNoKey ? `（跳过 ${skippedNoKey} 缺键单）` : '') + (agg.summary.missingCostCount ? `（${agg.summary.missingCostCount} 单缺外包成本，毛利偏高需核）` : ''))
  } catch (e: any) {
    error(res, e.message || '导入失败')
  }
})

/** POST /preview —— 干跑：解析+聚合 NGS 订单，不落库，返回汇总 + 告警 */
router.post('/preview', authenticateToken, requireWrite, (req, res) => {
  try {
    const { orders } = req.body as { orders: Record<string, unknown>[] }
    if (!Array.isArray(orders) || orders.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }
    const agg = aggregateNgsOrders(orders)
    success(res, {
      orderCount: agg.summary.orderCount,
      revenueTotal: agg.summary.revenueTotal,
      costTotal: agg.summary.costTotal,
      marginTotal: agg.summary.marginTotal,
      marginRate: agg.summary.marginRate,
      partnerNames: agg.summary.partnerNames,
      orderMonths: agg.summary.orderMonths,
      skippedRows: agg.summary.skippedRows,
      negativeMarginCount: agg.summary.negativeMarginCount,
      missingCostCount: agg.summary.missingCostCount,
      missingPriceCount: agg.summary.missingPriceCount,
      missingKeyCount: agg.summary.missingKeyCount,
      partners: agg.partners,
      warnings: [
        ...(agg.summary.missingKeyCount ? [`${agg.summary.missingKeyCount} 单缺订单号/产品名，导入时会跳过（无法幂等去重，重导会重复）`] : []),
        ...(agg.summary.missingCostCount ? [`${agg.summary.missingCostCount} 单缺外包成本(协议价)，毛利会被高估为售价，请补成本`] : []),
        ...(agg.summary.missingPriceCount ? [`${agg.summary.missingPriceCount} 单缺售价`] : []),
        ...(agg.summary.negativeMarginCount ? [`${agg.summary.negativeMarginCount} 单售价低于外包成本（亏本单），请核对`] : []),
        ...(agg.summary.orderMonths.length > 1 ? [`跨 ${agg.summary.orderMonths.length} 个月份，确认是否同一账期`] : []),
        ...(agg.summary.orderMonths.includes('') ? ['存在无法识别月份的订单，趋势/分月统计会缺失'] : []),
      ],
    }, '预览（未落库）')
  } catch (e: any) { error(res, e.message) }
})

/** GET /products —— NGS 产品参考目录 */
router.get('/products', authenticateToken, requireCostRead, (req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare(`SELECT * FROM ngs_products WHERE status = 'active' ORDER BY category, product_name`).all() as any[]
    successList(res, rows.map((r) => ({
      id: r.id, productName: r.product_name, category: r.category, geneCount: r.gene_count,
      sampleType: r.sample_type, clinicalMeaning: r.clinical_meaning, turnaroundDays: r.turnaround_days,
      guidePrice: r.guide_price, agreementPrice: r.agreement_price,
    })), 1, rows.length || 1, rows.length)
  } catch (e: any) { error(res, e.message) }
})

/** GET /partner-pnl —— 院级 NGS 外购转销 P&L（收入/外包成本/毛利），可按月份/医院过滤 */
router.get('/partner-pnl', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { orderMonth, partnerId } = req.query as any
    const db = getDatabase()
    let where = '1=1'
    const params: any[] = []
    if (orderMonth) { where += ' AND no.order_month = ?'; params.push(orderMonth) }
    if (partnerId) { where += ' AND no.partner_id = ?'; params.push(partnerId) }
    const rows = db.prepare(`
      SELECT no.partner_id AS partnerId, COALESCE(p.name, no.partner_name) AS partnerName,
             COUNT(*) AS orderCount, SUM(no.sell_price) AS revenueTotal,
             SUM(no.outsource_cost) AS costTotal, SUM(no.margin) AS marginTotal
      FROM ngs_orders no
      LEFT JOIN partners p ON p.id = no.partner_id
      WHERE ${where}
      GROUP BY no.partner_id
    `).all(...params) as any[]
    const list = rows.map((r) => {
      const revenueTotal = Math.round((Number(r.revenueTotal) || 0) * 100) / 100
      const marginTotal = Math.round((Number(r.marginTotal) || 0) * 100) / 100
      return {
        partnerId: r.partnerId, partnerName: r.partnerName,
        orderCount: Number(r.orderCount) || 0, revenueTotal,
        costTotal: Math.round((Number(r.costTotal) || 0) * 100) / 100, marginTotal,
        marginRate: revenueTotal > 0 ? Math.round((marginTotal / revenueTotal) * 10000) / 10000 : 0,
      }
    })
    list.sort((a, b) => b.marginTotal - a.marginTotal) // 毛利高者置顶（NGS 是利润贡献项）
    successList(res, list, 1, list.length || 1, list.length)
  } catch (e: any) { error(res, e.message) }
})

export default router
