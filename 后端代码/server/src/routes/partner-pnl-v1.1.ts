/**
 * 院级 P&L 视图 + ABC 成本维度回填（W6 + W5 完整）。
 * RBAC：P&L 读 = cost_analysis R（成本/利润敏感，财务/实验室主任可见）；回填 = reconciliation W（维护动作）。
 * ⛔ 红线：不改成本引擎；成本仅【按医院上卷既有 ABC 成本】。
 */
import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { backfillAbcPartnerIds } from '../utils/abc-partner-link.js'
import { buildPartnerPnl, loadCasePnlsWithCost, buildPartnerTrend } from '../utils/partner-pnl-service.js'

const router = Router()
const requireCostRead = requirePermission('cost_analysis', 'R')

/** POST /backfill-abc-partner —— 按 case_no 把医院维度回填到 ABC 成本明细（幂等可重跑） */
router.post('/backfill-abc-partner', authenticateToken, requirePermission('reconciliation', 'W'), (req, res) => {
  try {
    const r = backfillAbcPartnerIds(getDatabase())
    success(res, r, `回填 ${r.updated} 条 ABC 明细的医院维度`)
  } catch (e: any) { error(res, e.message) }
})

/** GET / —— 院级 P&L（实收 / 实验室收入 / 成本 / 毛利 / 完整度 / benchmark），可按服务月/医院过滤 */
router.get('/', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { serviceMonth, partnerId } = req.query as any
    const list = buildPartnerPnl(getDatabase(), { serviceMonth, partnerId })
    // 不分页（院数有限）；按毛利升序，负毛利（亏损院）置顶供筛查
    list.sort((a, b) => a.grossMargin - b.grossMargin)
    successList(res, list, 1, list.length || 1, list.length)
  } catch (e: any) { error(res, e.message) }
})

/** GET /cases —— case 级毛利下钻 / CM 筛查（flagged=负毛利优先），按服务月/医院过滤 */
router.get('/cases', authenticateToken, requireCostRead, (req, res) => {
  try {
    let { page = 1, pageSize = 50, serviceMonth, partnerId, onlyFlagged } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(500, Number(pageSize) || 50))
    let list = loadCasePnlsWithCost(getDatabase(), { serviceMonth, partnerId })
    if (onlyFlagged === 'true' || onlyFlagged === '1') list = list.filter((c) => c.flagged)
    list.sort((a, b) => a.grossMargin - b.grossMargin) // 负毛利置顶
    const total = list.length
    const slice = list.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
    successList(res, slice, page, pageSize, total)
  } catch (e: any) { error(res, e.message) }
})

/** GET /trend?partnerId= —— 某医院月度趋势（实收/实验室收入/成本/毛利 时序） */
router.get('/trend', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { partnerId } = req.query as any
    if (!partnerId) { error(res, 'partnerId 必填', 'INVALID_PARAMETER', 400); return }
    success(res, buildPartnerTrend(getDatabase(), partnerId))
  } catch (e: any) { error(res, e.message) }
})

export default router
