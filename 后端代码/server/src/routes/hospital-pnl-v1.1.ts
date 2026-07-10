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
import { buildHospitalCmByPartner, buildHospitalCmTrend, buildHospitalCmTrendByPartner } from '../utils/hospital-cm-service.js'
import {
  buildPortfolioHealth,
  buildComparisonTable,
  toAccountSummary,
  PORTFOLIO_HEALTH_GATES_VERIFIED,
  computeReadiness,
  CURRENT_KNOWN_READINESS_INPUT,
  type ReadinessInput,
  type FixedPoolState,
} from '../utils/portfolio-health.js'
import { splitCaliberRatification } from '../utils/caliber-ratification.js' // 止损执法点：院级贡献毛利(拆分派生)输出自带「口径未认账」水印（LEG-2）

const router = Router()
const requireCostRead = requirePermission('cost_analysis', 'R')

// ────────────────────────────────────────────────────────────────────────────
// 就绪谓词消费端（route = portfolio-health.ts 注释里点名的「另 task·消费端」）——
//   把**真实探测的当前状态**喂给 computeReadiness，让 ready 由现实算出、不再手翻硬开关。
//   现实（三门未落地 / 池未认账 / 无已校验周期 / 首周期未校验）→ ready=false（诚实·影子模式）。
//   ⚠️ probe 只读、绝不臆造 ready=true；将来这些地基落地后从真实来源读，ready 自动转绿。
// ────────────────────────────────────────────────────────────────────────────

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }
}

/** asOf 归一：接受 `?asOf=YYYY-MM-DD` 注入（供测试/过期判定）；缺/坏 → 用 wall clock（route 层允许读时钟）。 */
function normAsOf(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return new Date().toISOString().slice(0, 10)
}

/**
 * 探测固定成本池认账状态（HON-5·denominator 条件）。
 * 本项目**尚无**「已认账固定成本池」持久表 → 一律返回**未配置**（不渲染 0·认账不可代签）。
 * ⚠️ `/health` 的 `?fixedPool=` query 是财务临时给的非认账值，**绝不**当已认账放行（认账绑值版本·业务方签）。
 * 将来 LEG-2 落地「固定成本池认账登记」表后从此读 { configured, value, version, ratifiedVersion }。
 */
function probeFixedPool(_db: DbLike): FixedPoolState {
  return { configured: false, value: null, version: null, ratifiedVersion: null }
}

/**
 * 探测「已结算 ∧ 过期间键校验」的完整周期数（history 条件·verifiedClosedPeriods）。
 * 本项目尚无「已校验完整结算周期」跟踪表 → 0（纯日历·加速不了·due=预计就绪日）。
 */
function probeVerifiedClosedPeriods(_db: DbLike): number {
  return 0
}

/** 探测数据地基三门（库存守恒/期间键/常量冻结）逐门绿否。无运行时持久校验态 → 全 false（fail-closed·诚实）。 */
function probeFoundationGates(_db: DbLike): ReadinessInput['foundationGatesGreen'] {
  return { inventory_conservation: false, period_key: false, constant_freeze: false }
}

/**
 * 组装就绪谓词输入（真实探测·非硬编码）。schedule（owner+死线）复用已登记的现实快照
 * `CURRENT_KNOWN_READINESS_INPUT`（LEG 登记的 due/owner），把探测到的真状态覆盖进去 + 注入 asOf 供过期判定。
 */
function probeReadinessInput(db: DbLike, asOf: string): ReadinessInput {
  return {
    ...CURRENT_KNOWN_READINESS_INPUT,
    foundationGatesGreen: probeFoundationGates(db),
    fixedPool: probeFixedPool(db),
    verifiedClosedPeriods: probeVerifiedClosedPeriods(db),
    asOf,
  }
}

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
    const db = getDatabase()
    const hospitals = buildHospitalCmByPartner(db, { serviceMonth })
    const summaries = hospitals.map((h) => toAccountSummary(h))
    const rows = buildComparisonTable(summaries) // 默认按绝对贡献降序
    // 附院级明细（状态/口径/三诚实字段）+ 同账户月度趋势（含逐月口径·供 ⑨ 口径变更竖标），对齐 comparison row 顺序。
    // 趋势**批量一次装载**（buildHospitalCmTrendByPartner·避免逐院 N+1 重建价格账本/同义词索引）。
    const byId = new Map(hospitals.map((h) => [h.partnerId, h]))
    const trendsByPartner = buildHospitalCmTrendByPartner(db)
    const enriched = rows.map((r) => ({
      ...r,
      detail: byId.get(r.partnerId) ?? null,
      trendPoints: trendsByPartner.get(r.partnerId) ?? [], // 同账户历史（③）·跨月口径变更可标（⑨）
    }))
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

/**
 * GET /readiness —— 就绪谓词清单（校准视图渲染这个·DEC-6 + LEG + 公理一）。
 * **始终可读**（cost_analysis:R）：校准态就是要把「为何还不能信绝对值」摊在用户眼前。
 * 返回 `computeReadiness(真实探测)` = { ready, checklist:[{key,met,owner,due,configError,overdue}], findings }。
 * query: asOf?（YYYY-MM-DD·注入过期判定·缺则 wall clock）
 */
router.get('/readiness', authenticateToken, requireCostRead, (req, res) => {
  try {
    const asOf = normAsOf((req.query as any).asOf)
    const readiness = computeReadiness(probeReadinessInput(getDatabase() as DbLike, asOf))
    success(res, { ...readiness, asOf, shadowNote, caliberRatification: splitCaliberRatification() }, '就绪谓词清单（校准视图）')
  } catch (e: any) {
    error(res, e.message)
  }
})

/**
 * GET /full-health —— 第 1 层**完整体检态**数据端点（覆盖倍数绝对判断已启用·仅就绪后可得）。
 *
 * ⚠️ **URL 后门焊到数据层**（专家终裁 §六.6·红线）：模式判定在**服务端**——就绪谓词为假时，
 *   本端点**本身不返回完整体检数据**（403 + 降级载荷·只回「为何被挡」的就绪清单），
 *   防有人绕过前端渲染逻辑、直接打 API 拿完整态数据。E2E 断言 `ready=false ⇒ 本端点 403/降级`。
 *   现实（探测 = 三门未绿/池未认账/历史 0/首周期未校验）→ ready=false → **恒 403**（诚实·影子期本就不该出完整判断）。
 *
 * query: serviceMonth?, asOf?
 */
router.get('/full-health', authenticateToken, requireCostRead, (req, res) => {
  try {
    const asOf = normAsOf((req.query as any).asOf)
    const readiness = computeReadiness(probeReadinessInput(getDatabase() as DbLike, asOf))
    if (!readiness.ready) {
      // 降级载荷：只回就绪清单（=为何被挡）+ 影子提示，**绝不含**任何完整体检数值（totalCm/coverageMultiple 等）。
      res.status(403).json({
        success: false,
        error: {
          code: 'READINESS_NOT_MET',
          message: '完整体检态未就绪：就绪谓词为假，完整数据不出门（影子模式·请用对照表/校准视图）。',
        },
        readiness, // 为何被挡（checklist + findings）——非完整体检数据本身
        shadowNote,
      })
      return
    }
    // ready=true（当前不可达·三门+认账+历史≥N+首周期全绿后才到）：完整体检态·绝对判断启用。
    const { serviceMonth } = req.query as any
    const fixedPool = probeFixedPool(getDatabase() as DbLike)
    const hospitals = buildHospitalCmByPartner(getDatabase(), { serviceMonth })
    const summaries = hospitals.map((h) => toAccountSummary(h))
    const health = buildPortfolioHealth(summaries, { fixedPool: fixedPool.value ?? 0 })
    success(
      res,
      { ...health, fullState: true, readiness, serviceMonth: serviceMonth ?? null, caliberRatification: splitCaliberRatification() },
      '完整体检态（第 1 层·覆盖倍数绝对判断已启用）',
    )
  } catch (e: any) {
    error(res, e.message)
  }
})

export default router
