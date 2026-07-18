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
import { Router, type Response } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { buildHospitalCmByPartner, buildHospitalCmTrend, buildHospitalCmTrendByPartner } from '../utils/hospital-cm-service.js'
import { HOSPITAL_CM_FORMULA_VERSION } from '../utils/hospital-cm.js'
import {
  buildPortfolioHealth,
  buildComparisonTable,
  toAccountSummary,
} from '../utils/portfolio-health.js'
import { splitCaliberRatification } from '../utils/caliber-ratification.js' // 止损执法点：院级贡献毛利(拆分派生)输出自带「口径未认账」水印（LEG-2）
import {
  FOUNDATION_PROBE_REASON_CODES,
  currentHospitalCmReadinessSourceFingerprint,
  getHospitalCmReadinessSnapshot,
  HospitalCmReadinessProbeError,
  recordHospitalCmFoundationProbeRun,
  shanghaiBusinessDate,
  type HospitalCmReadinessDb,
} from '../utils/hospital-cm-readiness-runtime.js'
import {
  createHospitalCmFixedPoolVersion,
  HospitalCmFixedPoolError,
  isHospitalCmFixedPoolServiceMonth,
  listHospitalCmFixedPoolVersions,
  readHospitalCmFixedPoolState,
  recordHospitalCmFixedPoolDecision,
} from '../utils/hospital-cm-fixed-pool.js'

const router = Router()
const requireCostRead = requirePermission('cost_analysis', 'R')
const requireCostWrite = requirePermission('cost_analysis', 'W')

// ────────────────────────────────────────────────────────────────────────────
// 就绪谓词消费端（route = portfolio-health.ts 注释里点名的「另 task·消费端」）——
//   把**真实探测的当前状态**喂给 computeReadiness，让 ready 由现实算出、不再手翻硬开关。
//   现实（三门未落地 / 池未认账 / 无已校验周期 / 首周期未校验）→ ready=false（诚实·影子模式）。
//   ⚠️ probe 只读、绝不臆造 ready=true；将来这些地基落地后从真实来源读，ready 自动转绿。
// ────────────────────────────────────────────────────────────────────────────

function actorOf(req: any): { userId: string; username: string } {
  return { userId: req.user?.userId, username: req.user?.username }
}

function bodyObject(req: any): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {}
}

function rejectUnsupportedBody(
  res: Response,
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const unsupported = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unsupported.length === 0) return false
  error(
    res,
    '固定成本池端点不接受调用者提交版本、操作人或 ready/ratified 结论字段',
    'FIXED_POOL_RESULT_INPUT_FORBIDDEN',
    400,
  )
  return true
}

function respondFixedPoolError(res: Response, cause: unknown, fallbackCode: string, fallbackMessage: string): void {
  if (cause instanceof HospitalCmFixedPoolError) {
    error(res, cause.message, cause.code, cause.status)
    return
  }
  console.error('[hospital-cm] fixed pool operation failed', cause)
  error(res, fallbackMessage, fallbackCode, 500)
}

/** 影子模式提示由本次请求的真实 readiness 派生，不再读取模块加载时的静态常量。 */
function shadowNoteFor(ready: boolean): string | undefined {
  return ready
    ? undefined
    : '影子模式：真实证据尚未满足全部就绪门 → 覆盖倍数只看趋势·完整体检数据不出门·输出仅供校准观察'
}

/**
 * GET /health —— 第 1 层组合体检（不点名任何账户）。
 * query: serviceMonth?, fixedPool?（固定成本池·财务给·非 P0 数据源·缺则覆盖倍数不可算标 null）
 */
router.get('/health', authenticateToken, requireCostRead, (req, res) => {
  try {
    const { serviceMonth } = req.query as any
    const fixedPoolRaw = Number((req.query as any).fixedPool)
    const fixedPool = Number.isFinite(fixedPoolRaw) && fixedPoolRaw > 0 ? fixedPoolRaw : null
    const hospitals = buildHospitalCmByPartner(getDatabase(), { serviceMonth })
    const summaries = hospitals.map((h) => toAccountSummary(h))
    const health = buildPortfolioHealth(summaries, { fixedPool })
    success(res, { ...health, serviceMonth: serviceMonth ?? null, shadowNote: shadowNoteFor(false), fixedPoolProvided: fixedPool != null, hospitalCmFormulaVersion: HOSPITAL_CM_FORMULA_VERSION, caliberRatification: splitCaliberRatification() }, '组合体检（第 1 层·只看趋势）')
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
    successList(res, enriched, 1, enriched.length || 1, enriched.length, { hospitalCmFormulaVersion: HOSPITAL_CM_FORMULA_VERSION, caliberRatification: splitCaliberRatification() })
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

/** GET /readiness/fixed-pools?serviceMonth=YYYY-MM —— 有权限的成本读者查月度版本/认账审计链。 */
router.get('/readiness/fixed-pools', authenticateToken, requireCostRead, (req, res) => {
  try {
    const unsupported = Object.keys(req.query).filter((key) => ![
      'serviceMonth', 'limit', 'beforeVersionEvent', 'beforeDecisionEvent',
    ].includes(key))
    if (unsupported.length > 0) {
      error(res, '固定成本池审计视图只接受 serviceMonth 与分页参数', 'UNSUPPORTED_QUERY_PARAMETER', 400)
      return
    }
    const serviceMonth = (req.query as any).serviceMonth
    if (!isHospitalCmFixedPoolServiceMonth(serviceMonth)) {
      error(res, 'serviceMonth 必须是合法 YYYY-MM', 'FIXED_POOL_SERVICE_MONTH_INVALID', 400)
      return
    }
    success(res, listHospitalCmFixedPoolVersions(getDatabase() as HospitalCmReadinessDb, serviceMonth, {
      limit: (req.query as any).limit,
      beforeVersionEvent: (req.query as any).beforeVersionEvent,
      beforeDecisionEvent: (req.query as any).beforeDecisionEvent,
    }), '固定成本池月度版本与认账审计链')
  } catch (cause) {
    respondFixedPoolError(res, cause, 'FIXED_POOL_READ_FAILED', '固定成本池记录读取失败')
  }
})

/** POST /readiness/fixed-pools —— 财务月度配置只追加新版本，不覆盖旧值。 */
router.post('/readiness/fixed-pools', authenticateToken, requireCostWrite, (req, res) => {
  try {
    const body = bodyObject(req)
    if (rejectUnsupportedBody(res, body, [
      'serviceMonth', 'amountMinor', 'currency', 'scopeAttestation',
      'sourceEvidenceRef', 'sourceEvidenceHash', 'changeReason',
    ])) return
    const version = createHospitalCmFixedPoolVersion(getDatabase() as HospitalCmReadinessDb, {
      serviceMonth: body.serviceMonth,
      amountMinor: body.amountMinor,
      currency: body.currency,
      scopeAttestation: body.scopeAttestation,
      sourceEvidenceRef: body.sourceEvidenceRef,
      sourceEvidenceHash: body.sourceEvidenceHash,
      changeReason: body.changeReason,
      actor: actorOf(req),
      idempotencyKey: req.get('Idempotency-Key'),
    })
    const readiness = getHospitalCmReadinessSnapshot(
      getDatabase() as HospitalCmReadinessDb,
      shanghaiBusinessDate(),
      { serviceMonth: version.serviceMonth },
    )
    success(
      res,
      { version, readiness },
      '固定成本池版本写入已记录或幂等返回；当前有效状态以 readiness 为准',
      201,
    )
  } catch (cause) {
    respondFixedPoolError(res, cause, 'FIXED_POOL_WRITE_FAILED', '固定成本池版本写入失败')
  }
})

function fixedPoolDecisionHandler(decision: 'RATIFIED' | 'REVOKED') {
  return (req: any, res: Response): void => {
    try {
      const body = bodyObject(req)
      if (rejectUnsupportedBody(res, body, ['expectedContentHash', 'evidenceRef', 'evidenceHash', 'reason'])) return
      const event = recordHospitalCmFixedPoolDecision(getDatabase() as HospitalCmReadinessDb, {
        versionId: req.params.versionId,
        decision,
        expectedContentHash: body.expectedContentHash,
        evidenceRef: body.evidenceRef,
        evidenceHash: body.evidenceHash,
        reason: body.reason,
        actor: actorOf(req),
        idempotencyKey: req.get('Idempotency-Key'),
      })
      const readiness = getHospitalCmReadinessSnapshot(
        getDatabase() as HospitalCmReadinessDb,
        shanghaiBusinessDate(),
        { serviceMonth: event.version.slice(0, 7) },
      )
      success(
        res,
        { decision: event, readiness },
        '固定成本池认账决策已记录或幂等返回；当前有效状态以 readiness 为准',
        201,
      )
    } catch (cause) {
      respondFixedPoolError(res, cause, 'FIXED_POOL_DECISION_FAILED', '固定成本池认账事件写入失败')
    }
  }
}

router.post(
  '/readiness/fixed-pools/:versionId/ratifications',
  authenticateToken,
  requireCostWrite,
  fixedPoolDecisionHandler('RATIFIED'),
)
router.post(
  '/readiness/fixed-pools/:versionId/revocations',
  authenticateToken,
  requireCostWrite,
  fixedPoolDecisionHandler('REVOKED'),
)

/**
 * GET /readiness —— 就绪谓词清单（校准视图渲染这个·DEC-6 + LEG + 公理一）。
 * **始终可读**（cost_analysis:R）：校准态就是要把「为何还不能信绝对值」摊在用户眼前。
 * 返回 `computeReadiness(真实探测)` = { ready, checklist:[{key,met,owner,due,configError,overdue}], findings }。
 * 不接受 `asOf` 或其它 URL 注入。过期判定只认服务器 Asia/Shanghai 业务日期，调用者不能回填旧日期隐藏逾期。
 */
router.get('/readiness', authenticateToken, requireCostRead, (req, res) => {
  try {
    if (Object.keys(req.query).length > 0) {
      error(res, 'readiness 的过期判定只认服务器业务日期，不接受 URL 时间注入', 'UNSUPPORTED_QUERY_PARAMETER', 400)
      return
    }
    const readiness = getHospitalCmReadinessSnapshot(getDatabase() as HospitalCmReadinessDb, shanghaiBusinessDate())
    success(res, { ...readiness, shadowNote: shadowNoteFor(readiness.ready), hospitalCmFormulaVersion: HOSPITAL_CM_FORMULA_VERSION, caliberRatification: splitCaliberRatification() }, '就绪谓词清单（校准视图）')
  } catch (e: any) {
    console.error('[hospital-cm] readiness read failed', e)
    error(res, '就绪状态读取失败，完整体检继续保持关闭', 'READINESS_READ_FAILED', 500)
  }
})

/**
 * POST /readiness/probes/foundation —— 显式重跑真实数据地基探针并追加证据。
 * 调用者只能给受控原因码与工单引用，不能提交 ready/met/passed/checks 等结论；结果全部由服务器读取当前数据库计算。
 */
router.post('/readiness/probes/foundation', authenticateToken, requireCostWrite, (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}
    const unsupported = Object.keys(body).filter((key) => !['reasonCode', 'ticketRef'].includes(key))
    if (unsupported.length > 0) {
      error(res, '探针端点不接受调用者提交检查结论或其它状态字段', 'READINESS_RESULT_INPUT_FORBIDDEN', 400)
      return
    }
    const reasonCode = typeof body.reasonCode === 'string' ? body.reasonCode.trim() : ''
    if (!FOUNDATION_PROBE_REASON_CODES.includes(reasonCode as any)) {
      error(res, `reasonCode 必须是 ${FOUNDATION_PROBE_REASON_CODES.join(' / ')}`, 'READINESS_PROBE_REASON_INVALID', 400)
      return
    }
    if (body.ticketRef != null && typeof body.ticketRef !== 'string') {
      error(res, 'ticketRef 必须是字符串', 'READINESS_PROBE_TICKET_REF_INVALID', 400)
      return
    }
    const db = getDatabase() as HospitalCmReadinessDb
    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: (req as any).user?.userId,
      triggeredByUsername: (req as any).user?.username,
      reasonCode: reasonCode as (typeof FOUNDATION_PROBE_REASON_CODES)[number],
      ticketRef: body.ticketRef as string | null | undefined,
      cooldownSeconds: 15 * 60,
    })
    const readiness = getHospitalCmReadinessSnapshot(db, shanghaiBusinessDate())
    success(res, { run, readiness }, '数据地基真实探针已执行并追加证据', 201)
  } catch (e: any) {
    if (e instanceof HospitalCmReadinessProbeError) error(res, e.message, e.code, e.status)
    else {
      console.error('[hospital-cm] foundation probe failed', e)
      error(res, '数据地基探针执行失败，未保存本次证据', 'READINESS_PROBE_INTERNAL_ERROR', 500)
    }
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
 * query: serviceMonth?。任何 `asOf` 参数不会参与判定；readiness 只认服务器业务日期。
 */
router.get('/full-health', authenticateToken, requireCostRead, (req, res) => {
  try {
    const rawServiceMonth = (req.query as any).serviceMonth
    if (rawServiceMonth != null && !isHospitalCmFixedPoolServiceMonth(rawServiceMonth)) {
      error(res, 'serviceMonth 必须是合法 YYYY-MM', 'FIXED_POOL_SERVICE_MONTH_INVALID', 400)
      return
    }
    const serviceMonth = isHospitalCmFixedPoolServiceMonth(rawServiceMonth) ? rawServiceMonth : null
    const readiness = getHospitalCmReadinessSnapshot(
      getDatabase() as HospitalCmReadinessDb,
      shanghaiBusinessDate(),
      serviceMonth == null ? {} : { serviceMonth },
    )
    if (!readiness.ready) {
      // 降级载荷：只回就绪清单（=为何被挡）+ 影子提示，**绝不含**任何完整体检数值（totalCm/coverageMultiple 等）。
      res.status(403).json({
        success: false,
        error: {
          code: 'READINESS_NOT_MET',
          message: '完整体检态未就绪：就绪谓词为假，完整数据不出门（影子模式·请用对照表/校准视图）。',
        },
        readiness, // 为何被挡（checklist + findings）——非完整体检数据本身
        shadowNote: shadowNoteFor(false),
      })
      return
    }
    // ready=true（当前不可达·三门+认账+历史≥N+首周期全绿后才到）：完整体检态·绝对判断启用。
    if (serviceMonth == null) {
      error(res, '完整体检必须绑定明确 serviceMonth，不允许隐式挑选固定池月份', 'FULL_HEALTH_SERVICE_MONTH_REQUIRED', 409)
      return
    }
    const fixedPool = readHospitalCmFixedPoolState(getDatabase() as HospitalCmReadinessDb, serviceMonth)
    const selectedVersionId = (readiness.sources.denominator as any).currentVersionId
    if (
      fixedPool.versionId == null
      || fixedPool.versionId !== selectedVersionId
      || fixedPool.ratifiedVersion !== fixedPool.version
      || fixedPool.value == null
    ) {
      error(res, '固定成本池快照与 readiness 所绑版本不一致，本次不返回数值', 'READINESS_SOURCE_CHANGED_DURING_READ', 409)
      return
    }
    const hospitals = buildHospitalCmByPartner(getDatabase(), { serviceMonth })
    const summaries = hospitals.map((h) => toAccountSummary(h))
    const health = buildPortfolioHealth(summaries, { fixedPool: fixedPool.value, gatesVerified: readiness.ready })
    if (currentHospitalCmReadinessSourceFingerprint(getDatabase() as HospitalCmReadinessDb, serviceMonth) !== readiness.sourceStateFingerprint) {
      error(res, '完整体检计算期间数据源发生变化，本次不返回数值；请重试', 'READINESS_SOURCE_CHANGED_DURING_READ', 409)
      return
    }
    success(
      res,
      { ...health, fullState: true, readiness, serviceMonth: serviceMonth ?? null, hospitalCmFormulaVersion: HOSPITAL_CM_FORMULA_VERSION, caliberRatification: splitCaliberRatification() },
      '完整体检态（第 1 层·覆盖倍数绝对判断已启用）',
    )
  } catch (e: any) {
    console.error('[hospital-cm] full-health read failed', e)
    error(res, '完整体检读取失败，本次不返回任何完整数值', 'FULL_HEALTH_READ_FAILED', 500)
  }
})

export default router
