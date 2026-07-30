/**
 * 账实核对 API（Phase 1）—— ①复核总览 / ②复核工作台 / ③补收追踪 + 状态机。
 *
 * 权限：挂载层 requirePermission('account_reconcile','R')（财务/管理员/实验室主任可读）；写端点再要 'W'（财务/管理员）。
 * 口径见 utils/reconcile-account.ts（差异=账单片数vsLIS物理片数·6认定原因·补收gate）+ reconcile-compute.ts（取数落库）。
 * 状态机（§4）：院·月 待复核→复核完成→已关账；反向 复核完成→待复核、已关账→复核完成（反关账）均**必填理由+记经手人**。
 * 碰钱/口径的写经 writeAuditLog→abc_audit_logs；全站写另由 auditWrite 自动落 operation_logs。
 */
import { Router } from 'express'
import { getDatabase, TRUSTED_TERMINAL_HOSPITAL_MONTH_SHAPE_SQL } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  setSuccessAuditMetadata,
  suppressSuccessAuditForRequest,
} from '../middleware/audit-log.js'
import { assertNotSelfReview } from '../middleware/authz-combinators.js'
import { writeAuditLog } from '../utils/cost-runs.js'
import { recordOverride } from '../utils/override-log.js'
import { buildReconcileInputs, runReconcile, partnerMonthLabRate, tryCloseHospitalMonth } from '../utils/reconcile-compute.js'
import { computeReconcile, VERDICT_REASONS, type VerdictReason } from '../utils/reconcile-account.js'
import {
  assertReconcileBinding,
  closeAccountReconciliation,
  completeAccountReconciliation,
  computeAccountReconciliation,
  forbidAccountReconciliationReopen,
  isStrictSettlementMonth,
  readAccountReconciliation,
  ReconcileLifecycleError,
  setAccountReconciliationVerdict,
  type ReconcileBinding,
} from '../services/account-reconciliation-lifecycle.js'
import { splitCaliberRatification } from '../utils/caliber-ratification.js' // 止损执法点：confirmedLabRevenue(拆分派生)输出自带「口径未认账」水印（LEG-2）

const router = Router()

const operatorOf = (req: any): string => req.user?.username ?? req.user?.userId ?? 'unknown'
const actorUserIdOf = (req: any): string => String(req.user?.userId ?? '')
const PRE_LOC005_ROUTES_ENABLED = false
const BINDING_KEYS = [
  'partnerId',
  'settlementMonth',
  'statementGenerationId',
  'reconcileGenerationId',
] as const

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every(key => allowedKeys.has(key))
}

function rejectUnknownBodyKeys(res: any, value: unknown, allowed: readonly string[]): boolean {
  if (hasOnlyKeys(value, allowed)) return false
  error(res, 'request body contains unsupported fields', 'BAD_REQUEST', 400)
  return true
}

// R3-3：被取代旧代的补收单彻底冻结是既定口径（trigger 层 RAISE(ABORT,...) 硬冻结），
// 但该稳定信号不能透成被掩码的裸 500——映射为可诊断的 409 稳定码；其余未知错误仍走 500。
function errorSupplementLifecycle(res: any, err: any): void {
  if (String(err?.message ?? '').includes('SUPPLEMENT_GENERATION_BINDING_MISMATCH')) {
    error(res, '该补收单属于已被取代的旧对账代次，已彻底冻结', 'SUPPLEMENT_GENERATION_BINDING_MISMATCH', 409)
    return
  }
  error(res, err.message)
}

function lifecycleAuditMetadata(
  action: string,
  binding: ReconcileBinding,
  extra: Record<string, string | boolean> = {},
): Record<string, string | boolean> {
  return {
    action,
    partnerId: binding.partnerId,
    settlementMonth: binding.settlementMonth,
    statementGenerationId: binding.statementGenerationId,
    reconcileGenerationId: binding.reconcileGenerationId,
    ...extra,
  }
}

const bindingFrom = (source: any): ReconcileBinding => ({
  partnerId: String(source?.partnerId ?? '').trim(),
  settlementMonth: source?.settlementMonth,
  statementGenerationId: String(source?.statementGenerationId ?? '').trim(),
  reconcileGenerationId: String(source?.reconcileGenerationId ?? '').trim(),
})

const lifecycleError = (res: any, err: unknown): void => {
  if (err instanceof ReconcileLifecycleError) {
    error(res, err.message, err.code, err.status)
    return
  }
  error(res, err instanceof Error ? err.message : 'account reconciliation failed')
}

// LOC-005 authoritative generation-bound lifecycle. These handlers are registered
// before the predecessor endpoints below, so no legacy month-only write is reachable.
router.post('/compute', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    if (rejectUnknownBodyKeys(res, req.body, BINDING_KEYS)) return
    const binding = bindingFrom(req.body)
    assertReconcileBinding(binding)
    const result = computeAccountReconciliation(getDatabase(), binding, actorUserIdOf(req))
    setSuccessAuditMetadata(res, lifecycleAuditMetadata('compute', binding))
    success(res, result)
  } catch (err) {
    lifecycleError(res, err)
  }
})

if (PRE_LOC005_ROUTES_ENABLED) router['get']('/generation', (req, res) => {
  try {
    const binding = bindingFrom(req.query)
    assertReconcileBinding(binding)
    success(res, readAccountReconciliation(getDatabase(), binding))
  } catch (err) {
    lifecycleError(res, err)
  }
})

// GET /overview?settlementMonth= —— 月份级代次发现 + 看板：前端唯一取得四元组 binding 的入口。
// 汇总三源（当前 statement 批 / 院·月行 / 当前对账代），每院给齐 binding 与展示字段。
router.get('/overview', (req, res) => {
  try {
    const settlementMonth = req.query.settlementMonth
    if (!isStrictSettlementMonth(settlementMonth)) {
      return error(res, 'settlementMonth must be strict YYYY-(01..12)', 'INVALID_SETTLEMENT_MONTH', 400)
    }
    const db = getDatabase()
    const batches = db.prepare(`
      SELECT b.partner_id, p.name AS partner_name, b.generation_id, b.status AS batch_status
        FROM statement_import_batches b
        LEFT JOIN partners p ON p.id = b.partner_id
       WHERE b.settlement_month = ? AND b.is_current = 1
    `).all(settlementMonth) as any[]
    const hospitalMonths = db.prepare(
      'SELECT * FROM reconcile_hospital_months WHERE service_month = ? ORDER BY partner_name',
    ).all(settlementMonth) as any[]
    const generations = db.prepare(`
      SELECT * FROM account_reconcile_generations
       WHERE settlement_month = ? AND is_current = 1
    `).all(settlementMonth) as any[]

    const byPartner = new Map<string, any>()
    const ensure = (partnerId: string) => {
      if (!byPartner.has(partnerId)) byPartner.set(partnerId, { partnerId })
      return byPartner.get(partnerId)
    }
    for (const batch of batches) {
      const item = ensure(String(batch.partner_id))
      item.partnerName = item.partnerName ?? batch.partner_name ?? null
      item.statementGenerationId = batch.generation_id
      item.statementBatchStatus = batch.batch_status
    }
    for (const generation of generations) {
      const item = ensure(String(generation.partner_id))
      item.reconcileGenerationId = generation.reconcile_generation_id
      item.generationStatus = generation.status
      item.hospitalMonthId = generation.hospital_month_id
      item.reconcileStatementGenerationId = generation.statement_generation_id
      item.statementGenerationId = item.statementGenerationId ?? generation.statement_generation_id
    }
    for (const hm of hospitalMonths) {
      const item = ensure(String(hm.partner_id))
      item.id = hm.id
      item.partnerName = hm.partner_name
      item.serviceMonth = hm.service_month
      item.status = hm.status
      item.matchRate = hm.match_rate
      item.matchStatus = hm.match_status
      item.statementReady = !!hm.statement_ready
      item.lisReady = !!hm.lis_ready
      item.diffCount = hm.diff_count
      item.pendingCount = hm.pending_count
      item.unmatchedCount = hm.unmatched_count
      item.confirmedLabRevenue = hm.confirmed_lab_revenue
      item.hospitalMonthId = item.hospitalMonthId ?? hm.id
    }
    const items = [...byPartner.values()].map((item) => ({
      id: item.id ?? null,
      partnerId: item.partnerId,
      partnerName: item.partnerName ?? null,
      serviceMonth: settlementMonth,
      status: item.status ?? null,
      matchRate: item.matchRate ?? null,
      matchStatus: item.matchStatus ?? null,
      statementReady: item.statementReady ?? false,
      lisReady: item.lisReady ?? false,
      diffCount: item.diffCount ?? 0,
      pendingCount: item.pendingCount ?? 0,
      unmatchedCount: item.unmatchedCount ?? 0,
      confirmedLabRevenue: item.confirmedLabRevenue ?? null,
      hospitalMonthId: item.hospitalMonthId ?? null,
      statementGenerationId: item.statementGenerationId ?? null,
      statementBatchStatus: item.statementBatchStatus ?? null,
      reconcileGenerationId: item.reconcileGenerationId ?? null,
      reconcileStatementGenerationId: item.reconcileStatementGenerationId ?? null,
      generationStatus: item.generationStatus ?? null,
    })).sort((a, b) => String(a.partnerName ?? a.partnerId).localeCompare(String(b.partnerName ?? b.partnerId)))

    const computed = items.filter((item) => item.id !== null)
    const 补收实收 = Math.round(
      (db.prepare(`SELECT COALESCE(SUM(collected_revenue),0) s FROM supplement_orders WHERE collected_month = ? AND status = '已补收'`)
        .get(settlementMonth) as { s: number }).s * 100,
    ) / 100
    // #93-A 裁决 A 保守口径（derived quarantine）+ #94-P1-1 严格形状：确认实收只认
    // 完整命中 TRUSTED_TERMINAL_HOSPITAL_MONTH_SHAPE_SQL 的终态月——与启动扫描
    // ensureReconcileTerminalHospitalMonthIntegrity 同一 SQL 片段（binding + 同院/同月/
    // 同行/current generation 之外，复核完成须 completed_at canonical + completed_by
    // trim 非空 + closed 字段全空；已关账须两组 canonical 时间 + 两操作者 trim 非空）。
    // 无 binding 或字段残缺/矛盾的终态（历史遗留与 trigger 被摘窗口伪造数据级不可区分）
    // 保留历史可见性与看板状态计数，但 confirmedLabRevenue 一律不计入，也不迁成正常完成态。
    const provenancedTerminal = new Set(
      (db.prepare(`
        SELECT hm.id AS id
          FROM reconcile_hospital_months hm
          JOIN account_reconcile_hospital_month_bindings binding
            ON binding.hospital_month_id = hm.id
          JOIN account_reconcile_generations generation
            ON generation.reconcile_generation_id = binding.reconcile_generation_id
         WHERE hm.service_month = ?
           AND (${TRUSTED_TERMINAL_HOSPITAL_MONTH_SHAPE_SQL})
      `).all(settlementMonth) as Array<{ id: string }>).map(row => String(row.id)),
    )
    const base确认实收 = computed
      .filter((item) => (item.status === '复核完成' || item.status === '已关账')
        && item.id !== null && provenancedTerminal.has(String(item.id)))
      .reduce((sum, item) => sum + (Number(item.confirmedLabRevenue) || 0), 0)
    const board = {
      total: computed.length,
      待复核: computed.filter((item) => item.status === '待复核').length,
      复核完成: computed.filter((item) => item.status === '复核完成').length,
      已关账: computed.filter((item) => item.status === '已关账').length,
      补收实收,
      确认实收: Math.round((base确认实收 + 补收实收) * 100) / 100,
    }
    success(res, { settlementMonth, items, board, caliberRatification: splitCaliberRatification() })
  } catch (err: any) {
    error(res, err.message)
  }
})

router.get('/workbench', (req, res) => {
  try {
    const binding = bindingFrom(req.query)
    assertReconcileBinding(binding)
    const snapshot = readAccountReconciliation(getDatabase(), binding) as any
    const diffs = (getDatabase().prepare(
      `SELECT * FROM reconcile_diffs
        WHERE hospital_month_id = ?
          AND reconcile_generation_id = ?
        ORDER BY case_no, line_type`,
    ).all(snapshot.hospitalMonthId, binding.reconcileGenerationId) as any[]).map((row) => ({
      id: row.id,
      caseNo: row.case_no,
      lineType: row.line_type,
      billCount: row.bill_count,
      lisCount: row.lis_count,
      delta: row.delta,
      amountImpact: row.amount_impact,
      systemHint: row.system_hint,
      lowConfidence: !!row.low_confidence,
      verdict: row.verdict,
      verdictReason: row.verdict_reason,
      verdictBy: row.verdict_by,
      followUp: row.follow_up,
    }))
    success(res, {
      snapshot,
      diffs,
      caseHints: snapshot.caseHints ?? {},
      caliberRatification: splitCaliberRatification(),
    })
  } catch (err) {
    lifecycleError(res, err)
  }
})

router.post('/hospital-months/:id/complete', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    if (rejectUnknownBodyKeys(res, req.body, BINDING_KEYS)) return
    const binding = bindingFrom(req.body)
    assertReconcileBinding(binding)
    const current = readAccountReconciliation(getDatabase(), binding) as any
    if (current.hospitalMonthId !== req.params.id) {
      return error(res, 'hospital-month binding mismatch', 'RECONCILE_GENERATION_MISMATCH', 409)
    }
    const result = completeAccountReconciliation(getDatabase(), binding, actorUserIdOf(req))
    setSuccessAuditMetadata(res, lifecycleAuditMetadata('complete', binding, {
      hospitalMonthId: req.params.id,
    }))
    success(res, result)
  } catch (err) {
    lifecycleError(res, err)
  }
})

router.post('/close', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    if (rejectUnknownBodyKeys(res, req.body, ['items'])) return
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : []
    if (rawItems.length !== 1) {
      return error(
        res,
        'exactly one month-level generation binding is required',
        'GENERATION_BINDING_REQUIRED',
        400,
      )
    }
    if (!rawItems.every((item: unknown) => hasOnlyKeys(item, BINDING_KEYS))) {
      return error(res, 'close item contains unsupported fields', 'BAD_REQUEST', 400)
    }
    const closed = rawItems.map((item: any) => {
      const binding = bindingFrom(item)
      assertReconcileBinding(binding)
      return closeAccountReconciliation(getDatabase(), binding, actorUserIdOf(req))
    })
    const binding = bindingFrom(rawItems[0])
    setSuccessAuditMetadata(res, lifecycleAuditMetadata('close', binding))
    success(res, { closed })
  } catch (err) {
    lifecycleError(res, err)
  }
})

router.post('/hospital-months/:id/reopen', requirePermission('account_reconcile', 'W'), (_req, res) => {
  try {
    forbidAccountReconciliationReopen()
  } catch (err) {
    lifecycleError(res, err)
  }
})

router.post('/hospital-months/:id/reopen-close', requirePermission('account_reconcile', 'W'), (_req, res) => {
  try {
    forbidAccountReconciliationReopen()
  } catch (err) {
    lifecycleError(res, err)
  }
})

// POST /compute —— 跑某院某月账实核对并落库（写）
router.use('/__pre_loc005', (_req, res) => {
  error(
    res,
    'month-only reconciliation endpoints were removed by LOC-005',
    'GENERATION_BINDING_REQUIRED',
    410,
  )
})

if (PRE_LOC005_ROUTES_ENABLED) router['post']('/__pre_loc005/compute', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const partnerId = String(req.body?.partnerId ?? '').trim()
    const serviceMonth = String(req.body?.serviceMonth ?? '').trim()
    if (!partnerId) return error(res, '缺 partnerId', 'BAD_REQUEST', 400)
    if (!/^\d{4}-\d{2}$/.test(serviceMonth)) return error(res, 'serviceMonth 需 YYYY-MM', 'BAD_REQUEST', 400)
    let out
    try {
      out = runReconcile(db, partnerId, serviceMonth, operatorOf(req))
    } catch (e: any) {
      if (e.code === 'PERIOD_CLOSED') return error(res, e.message, 'PERIOD_CLOSED', 409)
      throw e
    }
    writeAuditLog(db, 'account_reconcile', 'compute', out.hospitalMonthId,
      { partnerId, serviceMonth, matchStatus: out.matchStatus, diffCount: out.diffCount }, operatorOf(req))
    success(res, out, '账实核对已计算')
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /overview?serviceMonth= —— ①复核总览：各院列表 + 状态 + 匹配率 + 差异数 + 看板汇总
if (PRE_LOC005_ROUTES_ENABLED) router['get']('/__pre_loc005/overview', (req, res) => {
  try {
    const db = getDatabase()
    const serviceMonth = String(req.query.serviceMonth ?? '').trim()
    if (!/^\d{4}-\d{2}$/.test(serviceMonth)) return error(res, 'serviceMonth 需 YYYY-MM', 'BAD_REQUEST', 400)
    const rows = db
      .prepare(`SELECT * FROM reconcile_hospital_months WHERE service_month = ? ORDER BY partner_name`)
      .all(serviceMonth) as any[]
    const list = rows.map((r) => ({
      id: r.id,
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      serviceMonth: r.service_month,
      status: r.status,
      matchRate: r.match_rate,
      matchStatus: r.match_status,
      statementReady: !!r.statement_ready,
      lisReady: !!r.lis_ready,
      diffCount: r.diff_count,
      pendingCount: r.pending_count,
      unmatchedCount: r.unmatched_count,
      confirmedLabRevenue: r.confirmed_lab_revenue,
    }))
    // 补收实收：本月收回的补收（已补收·计入本月）折实收，计入确认实收（往月漏收记本月，上月定版不动）。
    const 补收实收 = Math.round(
      (db.prepare(`SELECT COALESCE(SUM(collected_revenue),0) s FROM supplement_orders WHERE collected_month = ? AND status = '已补收'`)
        .get(serviceMonth) as { s: number }).s * 100,
    ) / 100
    const base确认实收 = list.filter((x) => x.status === '复核完成' || x.status === '已关账')
      .reduce((s, x) => s + (Number(x.confirmedLabRevenue) || 0), 0)
    const board = {
      total: list.length,
      待复核: list.filter((x) => x.status === '待复核').length,
      复核完成: list.filter((x) => x.status === '复核完成').length,
      已关账: list.filter((x) => x.status === '已关账').length,
      补收实收,
      确认实收: Math.round((base确认实收 + 补收实收) * 100) / 100,
    }
    successList(res, list, 1, list.length || 1, list.length, { board, caliberRatification: splitCaliberRatification() })
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /workbench?partnerId=&serviceMonth= —— ②复核工作台：院·月头 + 逐差异(含认定态) + 未匹配单列
if (PRE_LOC005_ROUTES_ENABLED) router['get']('/__pre_loc005/workbench', (req, res) => {
  try {
    const db = getDatabase()
    const partnerId = String(req.query.partnerId ?? '').trim()
    const serviceMonth = String(req.query.serviceMonth ?? '').trim()
    if (!partnerId || !/^\d{4}-\d{2}$/.test(serviceMonth)) return error(res, '缺 partnerId 或 serviceMonth(YYYY-MM)', 'BAD_REQUEST', 400)
    const hm = db.prepare('SELECT * FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?').get(partnerId, serviceMonth) as any
    if (!hm) return error(res, '该院该月尚未计算（先 /compute）', 'NOT_FOUND', 404)
    const diffs = (db.prepare('SELECT * FROM reconcile_diffs WHERE hospital_month_id = ? ORDER BY case_no, line_type').all(hm.id) as any[]).map((d) => ({
      id: d.id,
      caseNo: d.case_no,
      lineType: d.line_type,
      billCount: d.bill_count,
      lisCount: d.lis_count,
      delta: d.delta,
      amountImpact: d.amount_impact,
      systemHint: d.system_hint,
      lowConfidence: !!d.low_confidence,
      verdict: d.verdict,
      verdictReason: d.verdict_reason,
      verdictBy: d.verdict_by,
      followUp: d.follow_up,
    }))
    // 未匹配列表按需重算（无认定态，安全）
    const { bills, lis } = buildReconcileInputs(db, partnerId, serviceMonth)
    const unmatched = computeReconcile(bills, lis).unmatched
    // ③ 逐抗体细粒度初判线索（返工/多病灶）按 case 分组——附加提示，供逐差异下钻
    const hintRows = db.prepare('SELECT case_no, hint_type, marker_name, wax_no, occurrences FROM reconcile_case_hints WHERE hospital_month_id = ? ORDER BY case_no, hint_type').all(hm.id) as any[]
    const caseHints: Record<string, Array<{ hintType: string; markerName: string; waxNo: string | null; occurrences: number }>> = {}
    for (const h of hintRows) {
      ;(caseHints[h.case_no] ??= []).push({ hintType: h.hint_type, markerName: h.marker_name, waxNo: h.wax_no, occurrences: h.occurrences })
    }
    success(res, {
      hospitalMonth: {
        id: hm.id, partnerId: hm.partner_id, partnerName: hm.partner_name, serviceMonth: hm.service_month,
        status: hm.status, matchRate: hm.match_rate, matchStatus: hm.match_status,
        statementReady: !!hm.statement_ready, lisReady: !!hm.lis_ready,
        diffCount: hm.diff_count, pendingCount: hm.pending_count, unmatchedCount: hm.unmatched_count,
        confirmedLabRevenue: hm.confirmed_lab_revenue,
      },
      diffs,
      unmatched,
      caseHints,
      caliberRatification: splitCaliberRatification(), // confirmedLabRevenue 拆分派生 → 带「口径未认账」水印
    })
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /diffs/:id/verdict —— 认定（写）：填 6 认定原因之一 → 定下家；漏收驱动补收
router.post('/diffs/:id/verdict', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    if (rejectUnknownBodyKeys(res, req.body, [...BINDING_KEYS, 'reason', 'note'])) return
    const binding = bindingFrom(req.body)
    assertReconcileBinding(binding)
    const reason = String(req.body?.reason ?? '') as VerdictReason
    if (!VERDICT_REASONS.includes(reason)) return error(res, `认定原因须是：${VERDICT_REASONS.join(' / ')}`, 'BAD_REQUEST', 400)
    const note = req.body?.note != null ? String(req.body.note) : null
    const result = setAccountReconciliationVerdict(
        getDatabase(),
        binding,
        req.params.id,
        reason,
        note,
        actorUserIdOf(req),
        operatorOf(req),
      )
    if (result.duplicate === true) {
      // An exact replay is a read-equivalent acknowledgement. Keep the trusted
      // actor intact while suppressing only this request's duplicate success row.
      suppressSuccessAuditForRequest(req)
    } else {
      setSuccessAuditMetadata(res, lifecycleAuditMetadata('verdict', binding, {
        diffId: req.params.id,
        duplicate: false,
      }))
    }
    success(
      res,
      result,
      '已认定',
    )
  } catch (err) {
    lifecycleError(res, err)
  }
})

// POST /hospital-months/:id/complete —— 复核完成（写）：前置=差异全认定
if (PRE_LOC005_ROUTES_ENABLED) router['post']('/__pre_loc005/hospital-months/:id/complete', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const hm = db.prepare('SELECT * FROM reconcile_hospital_months WHERE id = ?').get(req.params.id) as any
    if (!hm) return error(res, '院·月不存在', 'NOT_FOUND', 404)
    if (hm.status === '已关账') return error(res, '已关账·无需复核完成', 'CONFLICT', 409)
    if (hm.status === '复核完成') return error(res, '已复核完成（如需重算请先重新打开）', 'CONFLICT', 409)
    const pending = (db.prepare('SELECT COUNT(*) AS n FROM reconcile_diffs WHERE hospital_month_id = ? AND verdict IS NULL').get(hm.id) as { n: number }).n
    if (pending > 0) return error(res, `还有 ${pending} 条差异待认定，不能复核完成`, 'PRECONDITION', 400)
    const confirmed = (db.prepare('SELECT COALESCE(SUM(lab_revenue), 0) AS s FROM case_revenue WHERE partner_id = ? AND service_month = ?').get(hm.partner_id, hm.service_month) as { s: number }).s
    db.prepare(`UPDATE reconcile_hospital_months SET status = '复核完成', completed_at = CURRENT_TIMESTAMP, completed_by = ?, confirmed_lab_revenue = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(operatorOf(req), confirmed, hm.id)
    writeAuditLog(db, 'account_reconcile', 'complete', hm.id, { partnerId: hm.partner_id, serviceMonth: hm.service_month, confirmedLabRevenue: confirmed }, operatorOf(req))
    success(res, { id: hm.id, status: '复核完成', confirmedLabRevenue: confirmed, caliberRatification: splitCaliberRatification() }, '复核完成')
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /hospital-months/:id/reopen —— 反向：复核完成 → 待复核（写·必填理由+记经手人）
if (PRE_LOC005_ROUTES_ENABLED) router['post']('/__pre_loc005/hospital-months/:id/reopen', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const reason = String(req.body?.reason ?? '').trim()
    if (!reason) return error(res, '反向操作必填理由', 'BAD_REQUEST', 400)
    const hm = db.prepare('SELECT * FROM reconcile_hospital_months WHERE id = ?').get(req.params.id) as any
    if (!hm) return error(res, '院·月不存在', 'NOT_FOUND', 404)
    if (hm.status !== '复核完成') return error(res, '仅「复核完成」可重新打开', 'CONFLICT', 409)
    db.prepare(`UPDATE reconcile_hospital_months SET status = '待复核', reopened_at = CURRENT_TIMESTAMP, reopen_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(reason, hm.id)
    writeAuditLog(db, 'account_reconcile', 'reopen', hm.id, { reason }, operatorOf(req))
    success(res, { id: hm.id, status: '待复核' }, '已重新打开')
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /close —— 关账（写）：部分关账+挂起；前置=复核完成；定版不可逆
if (PRE_LOC005_ROUTES_ENABLED) router['post']('/__pre_loc005/close', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const serviceMonth = String(req.body?.serviceMonth ?? '').trim()
    const partnerIds: string[] = Array.isArray(req.body?.partnerIds) ? req.body.partnerIds.map((x: any) => String(x)) : []
    if (!/^\d{4}-\d{2}$/.test(serviceMonth)) return error(res, 'serviceMonth 需 YYYY-MM', 'BAD_REQUEST', 400)
    if (!partnerIds.length) return error(res, '需选择要关账的院（partnerIds）', 'BAD_REQUEST', 400)
    const operator = operatorOf(req)
    const closed: string[] = []
    const skipped: Array<{ partnerId: string; reason: string }> = []
    for (const partnerId of partnerIds) {
      const hm = db.prepare('SELECT * FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?').get(partnerId, serviceMonth) as any
      if (!hm) { skipped.push({ partnerId, reason: '未计算' }); continue }
      if (hm.status === '已关账') { skipped.push({ partnerId, reason: '已关账' }); continue }
      if (hm.status !== '复核完成') { skipped.push({ partnerId, reason: '未复核完成（挂起）' }); continue }
      if (!tryCloseHospitalMonth(db, hm.id, operator)) {
        skipped.push({ partnerId, reason: '状态已变化（挂起）' })
        continue
      }
      writeAuditLog(db, 'account_reconcile', 'close', hm.id, { partnerId, serviceMonth, confirmedLabRevenue: hm.confirmed_lab_revenue }, operator)
      closed.push(partnerId)
    }
    success(res, { serviceMonth, closed, skipped }, `关账完成：${closed.length} 家已关账，${skipped.length} 家挂起`)
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /hospital-months/:id/reopen-close —— 反关账（写·慎用·必填理由）：已关账 → 复核完成
if (PRE_LOC005_ROUTES_ENABLED) router['post']('/__pre_loc005/hospital-months/:id/reopen-close', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const reason = String(req.body?.reason ?? '').trim()
    if (!reason) return error(res, '反关账必填理由', 'BAD_REQUEST', 400)
    const hm = db.prepare('SELECT * FROM reconcile_hospital_months WHERE id = ?').get(req.params.id) as any
    if (!hm) return error(res, '院·月不存在', 'NOT_FOUND', 404)
    if (hm.status !== '已关账') return error(res, '仅「已关账」可反关账', 'CONFLICT', 409)
    db.prepare(`UPDATE reconcile_hospital_months SET status = '复核完成', reopened_at = CURRENT_TIMESTAMP, reopen_reason = ?, closed_at = NULL, closed_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(reason, hm.id)
    writeAuditLog(db, 'account_reconcile', 'reopen_close', hm.id, { reason }, operatorOf(req))
    success(res, { id: hm.id, status: '复核完成' }, '已反关账')
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /supplements?serviceMonth=&status= —— ③补收追踪：补收单列表 + 汇总
router.get('/supplements', (req, res) => {
  try {
    const db = getDatabase()
    const serviceMonth = String(req.query.serviceMonth ?? '').trim()
    const status = String(req.query.status ?? '').trim()
    const where: string[] = []
    const params: any[] = []
    if (serviceMonth) { where.push('service_month = ?'); params.push(serviceMonth) }
    if (status) { where.push('status = ?'); params.push(status) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = db.prepare(`SELECT * FROM supplement_orders ${whereSql} ORDER BY created_at DESC`).all(...params) as any[]
    const list = rows.map((r) => ({
      id: r.id, partnerId: r.partner_id, serviceMonth: r.service_month, sourceDiffId: r.source_diff_id,
      caseNo: r.case_no, amount: r.amount, caseCount: r.case_count, status: r.status,
      collectedAt: r.collected_at, collectedMonth: r.collected_month, collectedRevenue: r.collected_revenue,
      giveUpReason: r.give_up_reason, operator: r.operator,
      reviewStatus: r.review_status ?? 'pending_review', submittedBy: r.submitted_by, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
    }))
    const sum = (s: string) => list.filter((x) => x.status === s).reduce((a, x) => a + (Number(x.amount) || 0), 0)
    const round2 = (n: number) => Math.round(n * 100) / 100
    const board = {
      待补收金额: sum('待补收'), 已补收金额: sum('已补收'), 已放弃金额: sum('已放弃'),
      已补收实收: round2(list.filter((x) => x.status === '已补收').reduce((a, x) => a + (Number(x.collectedRevenue) || 0), 0)),
      待补收数: list.filter((x) => x.status === '待补收').length,
      待签发数: list.filter((x) => x.status === '待补收' && x.reviewStatus !== 'approved').length,
      补收率: (() => { const done = sum('已补收'); const tot = done + sum('待补收'); return tot > 0 ? done / tot : 0 })(),
    }
    successList(res, list, 1, list.length || 1, list.length, { board })
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /supplements/:id/approve —— 独立签发（写·SoD）：唯一把补收单 pending_review → approved 的入口。
// 项D 止血核心：认定人（submitted_by）不能签发自己提交的补收单——检测与处方分离、人闸居中，
// 仿老对账 reconciliation-v1.1.ts:502 的 SELF_REVIEW_FORBIDDEN 自审拦截。签发后方可 collect。
router.post('/supplements/:id/approve', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const operator = operatorOf(req)
    const so = db.prepare('SELECT * FROM supplement_orders WHERE id = ?').get(req.params.id) as any
    if (!so) return error(res, '补收单不存在', 'NOT_FOUND', 404)
    if (so.status !== '待补收') return error(res, '仅「待补收」补收单可签发', 'CONFLICT', 409)
    if (so.review_status === 'approved') return error(res, '已签发', 'CONFLICT', 409)
    // SoD：不能签发自己提交/发起的补收单（认定人≠签发人）。提升进具名守卫，判定与响应逐字节不变。
    // fail-closed：submitted_by 缺失（空串/NULL）视为数据缺陷 → 拒签发，绝不因短路跳过 SoD（对抗复核 D-①）。
    if (!assertNotSelfReview(res, { submitterId: so.submitted_by, actorId: operator, message: '不能签发自己提交的补收单（或提交人缺失）', failClosedOnMissing: true })) return
    db.prepare(`UPDATE supplement_orders SET review_status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(operator, so.id)
    writeAuditLog(db, 'account_reconcile', 'supplement_approve', so.id, { amount: so.amount, submittedBy: so.submitted_by ?? null }, operator)
    // 项⑦ 统一旁路台账：签发是人工把补收单推过 pending→approved 的旁路点，汇入 override_log 供旁路频率体检。
    recordOverride(db, {
      gateType: 'supplement_approve', module: 'account_reconcile', targetId: so.id, operator,
      reason: String(req.body?.reason ?? '').trim() || '独立复核签发·SoD 通过',
      before: { reviewStatus: 'pending_review', submittedBy: so.submitted_by ?? null, amount: so.amount },
      after: { reviewStatus: 'approved', reviewedBy: operator },
    })
    success(res, { id: so.id, reviewStatus: 'approved', reviewedBy: operator }, '已签发补收单')
  } catch (err: any) {
    errorSupplementLifecycle(res, err)
  }
})

// POST /supplements/:id/collect —— 已补收（写）：计入本月实收（默认取 collectedMonth）
router.post('/supplements/:id/collect', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    // R8 P1-3：collectedMonth 真 strict——仅字段完全缺席才默认当月；字段存在时不做
    // String()/trim() 救赎，原始值直接过 strict validator，且置于一切 DB/资源状态
    // 查询之前——whitespace/array/object/null/'' 在各资源状态（不存在/已补收/未签发）
    // 下均稳定 400 INVALID_COLLECTED_MONTH 且零业务/审计写。DB 层由
    // trg_reconcile_supplement_collected_month_* trigger（typeof='text' 且字节长恰 7）
    // 与启动 legacy 扫描兜底，防直接 SQL/历史脏数据使收入聚合静默漏计。
    const rawCollectedMonth: unknown = req.body?.collectedMonth
    if (rawCollectedMonth !== undefined && !isStrictSettlementMonth(rawCollectedMonth)) {
      return error(res, '收款月份须为 YYYY-MM 格式（月份 01-12）', 'INVALID_COLLECTED_MONTH', 400)
    }
    const collectedMonth = rawCollectedMonth === undefined
      ? new Date().toISOString().slice(0, 7)
      : rawCollectedMonth
    const db = getDatabase()
    const so = db.prepare('SELECT * FROM supplement_orders WHERE id = ?').get(req.params.id) as any
    if (!so) return error(res, '补收单不存在', 'NOT_FOUND', 404)
    if (so.status === '已补收') return error(res, '已是已补收', 'CONFLICT', 409)
    // 人闸（项D 止血）：未经独立签发（approve）的补收单不可收款——防「认定人一步直发真金追加收费单」。
    if (so.review_status !== 'approved') return error(res, '补收单未经独立复核签发，不可收款', 'NOT_APPROVED', 409)
    // 折实收：账单口径 amount ×（原漏收月的**实验室工序行扣率**）；计入 collectedMonth 的实收。
    //   只读 case_revenue_lines 算扣率、**不写收入侧**（保护 golden）。
    //   不变量（防重复计）：漏收的补收只经补收单进实收，**绝不把这笔钱回填 case_revenue**——
    //   否则复核完成快照(Σlab_revenue)会与补收实收同时含它、双计。计费用错类走「待外部更正」另路，不驱动补收。
    const rate = partnerMonthLabRate(db, so.partner_id, so.service_month)
    const collectedRevenue = Math.round(Number(so.amount) * rate * 100) / 100
    db.prepare(`UPDATE supplement_orders SET status = '已补收', collected_at = CURRENT_TIMESTAMP, collected_month = ?, collected_revenue = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(collectedMonth, collectedRevenue, so.id)
    writeAuditLog(db, 'account_reconcile', 'supplement_collect', so.id, { amount: so.amount, collectedMonth, collectedRevenue, rate }, operatorOf(req))
    success(res, { id: so.id, status: '已补收', collectedMonth, collectedRevenue }, '已标记补收，计入本月实收')
  } catch (err: any) {
    errorSupplementLifecycle(res, err)
  }
})

// POST /supplements/:id/giveup —— 已放弃（写·必填理由）
router.post('/supplements/:id/giveup', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const reason = String(req.body?.reason ?? '').trim()
    if (!reason) return error(res, '放弃补收必填理由', 'BAD_REQUEST', 400)
    const so = db.prepare('SELECT * FROM supplement_orders WHERE id = ?').get(req.params.id) as any
    if (!so) return error(res, '补收单不存在', 'NOT_FOUND', 404)
    // 放弃即退出实收：清 collected_revenue/collected_month（防已补收→放弃后残留折实收显示；金额聚合本就按 status 过滤，此为一致性）。
    db.prepare(`UPDATE supplement_orders SET status = '已放弃', collected_revenue = NULL, collected_month = NULL, give_up_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, so.id)
    writeAuditLog(db, 'account_reconcile', 'supplement_giveup', so.id, { amount: so.amount, reason }, operatorOf(req))
    success(res, { id: so.id, status: '已放弃' }, '已放弃补收')
  } catch (err: any) {
    errorSupplementLifecycle(res, err)
  }
})

// POST /supplements/:id/reopen —— 反向（写·必填理由）：已补收/已放弃 → 待补收
router.post('/supplements/:id/reopen', requirePermission('account_reconcile', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const reason = String(req.body?.reason ?? '').trim()
    if (!reason) return error(res, '反向操作必填理由', 'BAD_REQUEST', 400)
    const so = db.prepare('SELECT * FROM supplement_orders WHERE id = ?').get(req.params.id) as any
    if (!so) return error(res, '补收单不存在', 'NOT_FOUND', 404)
    if (so.status === '待补收') return error(res, '已是待补收', 'CONFLICT', 409)
    // 反向回待补收 → 复核态一并回退 pending_review（恢复后须重新独立签发才可再收款，防绕过人闸）。
    db.prepare(`UPDATE supplement_orders SET status = '待补收', review_status = 'pending_review', reviewed_by = NULL, reviewed_at = NULL, collected_at = NULL, collected_month = NULL, collected_revenue = NULL, give_up_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(so.id)
    writeAuditLog(db, 'account_reconcile', 'supplement_reopen', so.id, { reason, from: so.status }, operatorOf(req))
    success(res, { id: so.id, status: '待补收' }, '已恢复待补收')
  } catch (err: any) {
    errorSupplementLifecycle(res, err)
  }
})

export default router
