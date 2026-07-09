/**
 * 院级贡献毛利（P0 内圈·标准成本口径）—— 两层框架 API（组合体检 + 人看对照表）。
 *
 * ⚠️ 与现有 `/api/v1/partner-pnl`（ABC 全成本 grossMargin·中圈 lane）**并存不改**（ADR-003：一条瀑布·贡献毛利独占去留信号）。
 *    本 lane = P0 spec 的直算贡献毛利，走**四轮外审收敛终稿**的两层框架（不排名/不打分/不自动清单）。
 *
 * RBAC（Q11/E·§10）：读 = `cost_analysis:R`（复用 partner-pnl 现有读门禁·**零 MODULES 漂移**）。
 * 影子模式（终稿 §5）：三门 A/B/C 未验收 → 响应显式标 `shadowMode`·输出不得进经营研判。
 * 后视镜（§5·Q10#3）：靠对账/三件套导入天然滞后 → 响应带 `dataAsOf` 概念（这里透出 serviceMonth）。
 */
import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { buildHospitalCmByPartner, buildHospitalCmTrend } from '../utils/hospital-cm-service.js'
import { buildPortfolioHealth, buildComparisonTable, toAccountSummary, PORTFOLIO_HEALTH_GATES_VERIFIED } from '../utils/portfolio-health.js'
import { splitCaliberRatification } from '../utils/caliber-ratification.js' // 止损执法点：院级贡献毛利(拆分派生)输出自带「口径未认账」水印（LEG-2）

const router = Router()
const requireCostRead = requirePermission('cost_analysis', 'R')

/** 影子模式提示（三门未验收前·随每个响应带·让"输出不得进经营研判"是被看到的）。 */
const shadowNote = PORTFOLIO_HEALTH_GATES_VERIFIED
  ? undefined
  : '影子模式：三门(库存守恒/期间键/常量冻结)未验收 + 标准成本校准里程碑未过 → 覆盖倍数只看趋势·经营线未定(CM_TARGET 未拍板)·输出仅供观察、不得进经营研判'

/**
 * GET /health —— 第 1 层组合体检（不点名任何账户）。
 * query: serviceMonth?, fixedPool?（固定成本池·财务给·非 P0 数据源·缺则覆盖倍数不可算标 null）
 */
router.get('/health', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { serviceMonth } = req.query as any
    const fixedPoolRaw = Number((req.query as any).fixedPool)
    const fixedPool = Number.isFinite(fixedPoolRaw) && fixedPoolRaw > 0 ? fixedPoolRaw : 0
    const hospitals = buildHospitalCmByPartner(getDatabase(), { serviceMonth })
    const summaries = hospitals.map((h) => toAccountSummary(h))
    const health = buildPortfolioHealth(summaries, { fixedPool })
    success(res, { ...health, serviceMonth: serviceMonth ?? null, shadowNote, fixedPoolProvided: fixedPool > 0, caliberRatification: splitCaliberRatification() }, '组合体检（第 1 层·只看趋势）')
  } catch (e: any) {
    error(res, e.message)
  }
})

/**
 * GET / —— 第 2 层人看对照表（默认按**绝对贡献降序**·不提供按率排序默认视图·系统不排名/不打分/不生成清单）。
 * query: serviceMonth?
 */
router.get('/', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { serviceMonth } = req.query as any
    const hospitals = buildHospitalCmByPartner(getDatabase(), { serviceMonth })
    const summaries = hospitals.map((h) => toAccountSummary(h))
    const rows = buildComparisonTable(summaries) // 默认按绝对贡献降序
    // 附院级明细（状态/口径/三诚实字段），对齐 comparison row 顺序
    const byId = new Map(hospitals.map((h) => [h.partnerId, h]))
    const enriched = rows.map((r) => ({ ...r, detail: byId.get(r.partnerId) ?? null }))
    successList(res, enriched, 1, enriched.length || 1, enriched.length, { caliberRatification: splitCaliberRatification() })
  } catch (e: any) {
    error(res, e.message)
  }
})

/** GET /trend?partnerId= —— 某院贡献毛利月度趋势（同账户历史·供对照表 trend 列）。 */
router.get('/trend', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { partnerId } = req.query as any
    if (!partnerId) { error(res, 'partnerId 必填', 'INVALID_PARAMETER', 400); return }
    // /trend 返回裸时序数组（形状不改·防破坏消费者）；水印在同页 overview/`/` 响应上已带，与趋势图同视线。
    success(res, buildHospitalCmTrend(getDatabase(), partnerId))
  } catch (e: any) {
    error(res, e.message)
  }
})

export default router
