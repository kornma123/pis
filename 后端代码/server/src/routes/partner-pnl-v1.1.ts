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
import { auditCrossPartnerCaseNos } from '../utils/cross-partner-audit.js'
import {
  buildPartnerPnl,
  buildPartnerTrend,
  loadCasePnlsWithCostEvidence,
  type PartnerPnlWithEvidence,
  type PnlTrendPointWithEvidence,
  type WithheldEvidenceCase,
} from '../utils/partner-pnl-service.js'
import { splitCaliberRatification } from '../utils/caliber-ratification.js' // 止损执法点：labRevenue/grossMargin(拆分派生)输出自带「口径未认账」水印（LEG-2）
import { toEvidenceWireState } from '../utils/evidence-fact.js'

const router = Router()
const requireCostRead = requirePermission('cost_analysis', 'R')

/**
 * LOC-015 具名不可用 wire 映射：证据不可信 -> 金额/计数/率一律 null +
 * `evidence.status='unavailable'`，绝不把 unknown 折成 0 或成功金额发布。
 */
function partnerPnlRowWire(p: PartnerPnlWithEvidence): Record<string, unknown> {
  if (p.evidenceUnavailable) {
    return {
      ...p,
      netRevenueTotal: null,
      labRevenueTotal: null,
      diagnosisRevenueTotal: null,
      costTotal: null,
      grossMargin: null,
      marginRate: null,
      avgLabRevenuePerCase: null,
      avgCostPerCase: null,
      avgMarginPerCase: null,
      ngsRevenue: null,
      ngsCost: null,
      ngsMargin: null,
      ngsOrderCount: null,
      ngsUnconfirmedRevenue: null,
      ngsUnconfirmedCount: null,
      totalMargin: null,
      evidence: toEvidenceWireState(p.evidenceUnavailable.issues),
    }
  }
  return { ...p, evidence: { status: 'ok' } }
}

function trendPointWire(p: PnlTrendPointWithEvidence): Record<string, unknown> {
  if (p.evidenceUnavailable) {
    return {
      ...p,
      netRevenueTotal: null,
      labRevenueTotal: null,
      costTotal: null,
      grossMargin: null,
      caseCount: null,
      evidence: toEvidenceWireState(p.evidenceUnavailable.issues),
    }
  }
  return { ...p, evidence: { status: 'ok' } }
}

function withheldCaseWire(w: WithheldEvidenceCase): Record<string, unknown> {
  return {
    caseNo: w.caseNo,
    partnerId: w.partnerId,
    partnerName: null,
    serviceScope: 'technical_only',
    serviceMonth: w.serviceMonth ?? undefined,
    netRevenue: null,
    techRatio: null,
    diagnosisRatio: null,
    inScopeRatio: null,
    labRevenue: null,
    quality: 'no_quantities',
    revenueSource: 'estimated',
    outRevenue: null,
    costTotal: null,
    grossMargin: null,
    marginRate: null,
    flagged: false,
    evidence: toEvidenceWireState(w.issues),
  }
}

/** POST /backfill-abc-partner —— 按 (partner_id, case_no) 精确把医院维度回填到 ABC 成本明细（歧义不回填，幂等可重跑）。
 *  附跨院同号审计报告（PRD-0 T1.0/§7.3）：歧义 case_no 不回填，供 ops 识别待人工补院的成本。 */
router.post('/backfill-abc-partner', authenticateToken, requirePermission('reconciliation', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const r = backfillAbcPartnerIds(db)
    const audit = auditCrossPartnerCaseNos(db)
    success(res, { ...r, audit }, `回填 ${r.updated} 条 ABC 明细的医院维度` + (r.skippedAmbiguous ? `（${r.skippedAmbiguous} 条跨院同号歧义未回填，待人工补院）` : ''))
  } catch (e: any) { error(res, e.message) }
})

/** GET /cross-partner-audit —— 跨院同号审计报告（迁移/运维诊断：跨院撞号、NULL partner、ABC 回填歧义计数）。 */
router.get('/cross-partner-audit', authenticateToken, requireCostRead, (_req, res) => {
  try {
    success(res, auditCrossPartnerCaseNos(getDatabase()), '跨院同号审计')
  } catch (e: any) { error(res, e.message) }
})

/** GET / —— 院级 P&L（实收 / 实验室收入 / 成本 / 毛利 / 完整度 / benchmark），可按服务月/医院过滤 */
router.get('/', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { serviceMonth, partnerId } = req.query as any
    const list = buildPartnerPnl(getDatabase(), { serviceMonth, partnerId })
    // 不分页（院数有限）；按毛利升序，负毛利（亏损院）置顶供筛查
    list.sort((a, b) => a.grossMargin - b.grossMargin)
    successList(res, list.map(partnerPnlRowWire), 1, list.length || 1, list.length, { caliberRatification: splitCaliberRatification() })
  } catch (e: any) { error(res, e.message) }
})

/** GET /cases —— case 级毛利下钻 / CM 筛查（flagged=负毛利优先），按服务月/医院过滤 */
router.get('/cases', authenticateToken, requireCostRead, (req, res) => {
  try {
    let { page = 1, pageSize = 50, serviceMonth, partnerId, onlyFlagged } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(500, Number(pageSize) || 50))
    const { rows, withheld } = loadCasePnlsWithCostEvidence(getDatabase(), { serviceMonth, partnerId })
    let cleanWire = rows.map((c) => ({ ...c, evidence: { status: 'ok' } }))
    if (onlyFlagged === 'true' || onlyFlagged === '1') cleanWire = cleanWire.filter((c) => c.flagged)
    cleanWire.sort((a, b) => a.grossMargin - b.grossMargin) // 负毛利置顶
    // 污染 case 永远在列（不得被 onlyFlagged/排序吞掉），排在干净行之后
    const allWire = [...cleanWire, ...withheld.map(withheldCaseWire)]
    const total = allWire.length
    const slice = allWire.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
    successList(res, slice, page, pageSize, total, { caliberRatification: splitCaliberRatification() })
  } catch (e: any) { error(res, e.message) }
})

/** GET /trend?partnerId= —— 某医院月度趋势（实收/实验室收入/成本/毛利 时序） */
router.get('/trend', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { partnerId } = req.query as any
    if (!partnerId) { error(res, 'partnerId 必填', 'INVALID_PARAMETER', 400); return }
    success(res, buildPartnerTrend(getDatabase(), partnerId).map(trendPointWire))
  } catch (e: any) { error(res, e.message) }
})

export default router
