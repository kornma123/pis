import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { writeAuditLog } from '../utils/cost-runs.js'
import {
  classifyChargeItem,
  classifyCaseHints,
  computeReconcile,
  type BillCase,
  type LisCase,
} from '../utils/reconcile-account.js'
import { buildCaseMarkers, parseSlideCount } from '../utils/reconcile-compute.js'

export type ReconcileFaultStage =
  | 'afterBusiness'
  | 'beforeAudit'
  | 'afterAudit'
  | 'beforePostcondition'
  | 'beforeCommit'

export interface ReconcileFaults {
  at?: ReconcileFaultStage
}

export interface ReconcileBinding {
  partnerId: string
  settlementMonth: string
  statementGenerationId: string
  reconcileGenerationId: string
}

export class ReconcileLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const fail = (message: string, code: string, status: number): never => {
  throw new ReconcileLifecycleError(message, code, status)
}

export function isStrictSettlementMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

export function assertReconcileBinding(input: Partial<ReconcileBinding>): asserts input is ReconcileBinding {
  if (!input.partnerId || !input.statementGenerationId || !input.reconcileGenerationId) {
    fail(
      'partnerId, statementGenerationId and reconcileGenerationId are required',
      'GENERATION_BINDING_REQUIRED',
      400,
    )
  }
  if (!isStrictSettlementMonth(input.settlementMonth)) {
    fail('settlementMonth must be strict YYYY-(01..12)', 'INVALID_SETTLEMENT_MONTH', 400)
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function inject(faults: ReconcileFaults | undefined, at: ReconcileFaultStage): void {
  if (faults?.at === at) {
    throw new Error(`INJECTED_RECONCILIATION_FAULT:${at}`)
  }
}

function withImmediateTransaction<T>(
  db: any,
  faults: ReconcileFaults | undefined,
  work: () => T,
): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    inject(faults, 'beforeCommit')
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A successful COMMIT ends the transaction. All injected faults occur before it.
    }
    throw err
  }
}

interface StatementLine {
  id: string
  case_no: string | null
  item_name: string | null
  source_label: string
  amount: number
  business_line: string
  line_grain: string
}

interface SourceSnapshot {
  readiness: Record<string, unknown>
  readinessJson: string
  readinessHash: string
  bills: BillCase[]
  lis: LisCase[]
  confirmedLabRevenue: number | null
}

function buildSourceSnapshot(
  db: any,
  binding: ReconcileBinding,
  requireRevenue: boolean,
): SourceSnapshot {
  const batch = db.prepare(
    `SELECT id, partner_id, settlement_month, generation_id, is_current, status,
            raw_row_count, normalized_line_count
       FROM statement_import_batches
      WHERE partner_id = ? AND generation_id = ?`,
  ).get(binding.partnerId, binding.statementGenerationId) as any
  if (!batch) fail('statement generation does not match partner', 'STATEMENT_GENERATION_NOT_FOUND', 404)
  if (Number(batch.is_current) !== 1) fail('statement generation is stale', 'STALE_STATEMENT_GENERATION', 409)
  if (!['posted', 'computed', 'complete', 'closed'].includes(String(batch.status))) {
    fail('statement generation is not ready', 'STATEMENT_SOURCE_UNAVAILABLE', 409)
  }

  const rawCount = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM statement_raw_rows WHERE batch_id = ? AND generation_id = ?',
  ).get(batch.id, binding.statementGenerationId) as any).n)
  const normalizedCount = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM statement_normalized_lines WHERE batch_id = ? AND generation_id = ?',
  ).get(batch.id, binding.statementGenerationId) as any).n)
  if (rawCount !== Number(batch.raw_row_count) || normalizedCount !== Number(batch.normalized_line_count)) {
    fail('statement generation is partial', 'STATEMENT_SOURCE_PARTIAL', 409)
  }

  const blockingFlags = Number((db.prepare(
    `SELECT COUNT(*) AS n
       FROM quality_flags
      WHERE generation_id = ?
        AND partner_id = ?
        AND (blocks_posting = 1 OR blocks_closing = 1)`,
  ).get(binding.statementGenerationId, binding.partnerId) as any).n)
  if (blockingFlags !== 0) fail('statement generation has blocking quality flags', 'STATEMENT_SOURCE_BLOCKED', 409)

  const targetLines = db.prepare(
    `SELECT id, case_no, item_name, source_label, amount, business_line, line_grain
       FROM statement_normalized_lines
      WHERE batch_id = ?
        AND generation_id = ?
        AND partner_id = ?
        AND ledger_settlement_month = ?
        AND row_kind = 'detail'
      ORDER BY source_sheet, source_row, source_column, id`,
  ).all(
    batch.id,
    binding.statementGenerationId,
    binding.partnerId,
    binding.settlementMonth,
  ) as StatementLine[]
  if (targetLines.length === 0) {
    fail('target month has no authoritative statement facts', 'TARGET_MONTH_UNAVAILABLE', 409)
  }

  const expectedIn = targetLines
    .filter((line) => line.business_line === 'IN' && line.line_grain === 'aggregate' && Number(line.amount) !== 0)
    .map((line) => line.id)
    .sort()
  const expectedOut = targetLines
    .filter((line) => line.business_line === 'OUT' && Number(line.amount) !== 0)
    .map((line) => line.id)
    .sort()
  const actualIn = (db.prepare(
    `SELECT source_line_id
       FROM partner_month_revenue_ledger
      WHERE batch_id = ? AND generation_id = ? AND partner_id = ? AND settlement_month = ?
      ORDER BY source_line_id`,
  ).all(batch.id, binding.statementGenerationId, binding.partnerId, binding.settlementMonth) as any[])
    .map((row) => String(row.source_line_id))
  const actualOut = (db.prepare(
    `SELECT source_line_id
       FROM out_settlement_ledger
      WHERE batch_id = ? AND generation_id = ? AND partner_id = ? AND settlement_month = ?
      ORDER BY source_line_id`,
  ).all(batch.id, binding.statementGenerationId, binding.partnerId, binding.settlementMonth) as any[])
    .map((row) => String(row.source_line_id))
  if (stableJson(expectedIn) !== stableJson(actualIn) || stableJson(expectedOut) !== stableJson(actualOut)) {
    fail('target month ledger projection is partial or cross-generation', 'TARGET_LEDGER_PARTIAL', 409)
  }

  const billMap = new Map<string, BillCase>()
  for (const line of targetLines) {
    if (!line.case_no) continue
    const label = String(line.item_name ?? line.source_label ?? '')
    const lineType = classifyChargeItem(label)
    if (!lineType) continue
    const { count } = parseSlideCount(label, undefined)
    const current = billMap.get(line.case_no) ?? { caseNo: line.case_no, ihc: 0, ss: 0 }
    if (lineType === '免疫组化') {
      current.ihc += count
      current.ihcUnitPrice ??= Math.abs(Number(line.amount)) / count
    } else {
      current.ss += count
      current.ssUnitPrice ??= Math.abs(Number(line.amount)) / count
    }
    billMap.set(line.case_no, current)
  }
  if (billMap.size === 0) fail('target month statement facts cannot drive reconciliation', 'STATEMENT_SOURCE_UNAVAILABLE', 409)

  const lisRows = db.prepare(
    `SELECT case_no, ihc_count, special_stain_count
       FROM lis_cases
      WHERE partner_id = ?
        AND substr(replace(COALESCE(operate_time, ''), '/', '-'), 1, 7) = ?
      ORDER BY case_no, id`,
  ).all(binding.partnerId, binding.settlementMonth) as any[]
  if (lisRows.length === 0) fail('target month LIS facts are unavailable', 'LIS_SOURCE_UNAVAILABLE', 409)
  const lisMap = new Map<string, LisCase>()
  for (const row of lisRows) {
    if (!row.case_no) continue
    const current = lisMap.get(row.case_no) ?? { caseNo: row.case_no, ihc: 0, ss: 0 }
    current.ihc += Number(row.ihc_count) || 0
    current.ss += Number(row.special_stain_count) || 0
    lisMap.set(row.case_no, current)
  }

  const revenue = db.prepare(
    `SELECT COUNT(*) AS n, SUM(lab_revenue) AS amount
       FROM case_revenue
      WHERE partner_id = ? AND service_month = ?`,
  ).get(binding.partnerId, binding.settlementMonth) as any
  const revenueCount = Number(revenue.n)
  const confirmedLabRevenue = revenueCount > 0 ? Number(revenue.amount) : null
  if (requireRevenue && confirmedLabRevenue === null) {
    fail('confirmed lab revenue is unavailable', 'REVENUE_SOURCE_UNAVAILABLE', 409)
  }

  const bills = [...billMap.values()].sort((a, b) => a.caseNo.localeCompare(b.caseNo))
  const lis = [...lisMap.values()].sort((a, b) => a.caseNo.localeCompare(b.caseNo))
  const readiness = {
    partnerId: binding.partnerId,
    settlementMonth: binding.settlementMonth,
    statementGenerationId: binding.statementGenerationId,
    statementBatchId: batch.id,
    statementBatchMonth: batch.settlement_month,
    statementStatus: batch.status,
    targetLineIds: targetLines.map((line) => line.id),
    ledger: { expectedIn, actualIn, expectedOut, actualOut },
    lis,
    revenue: {
      available: confirmedLabRevenue !== null,
      rowCount: revenueCount,
      confirmedLabRevenue,
    },
  }
  const readinessJson = stableJson(readiness)
  return {
    readiness,
    readinessJson,
    readinessHash: sha256(readinessJson),
    bills,
    lis,
    confirmedLabRevenue,
  }
}

function readGeneration(db: any, reconcileGenerationId: string): any {
  return db.prepare(
    'SELECT * FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
  ).get(reconcileGenerationId) as any
}

function assertExactGeneration(db: any, binding: ReconcileBinding): any {
  const row = readGeneration(db, binding.reconcileGenerationId)
  if (!row) fail('reconciliation generation not found', 'RECONCILE_GENERATION_NOT_FOUND', 404)
  if (
    row.partner_id !== binding.partnerId
    || row.settlement_month !== binding.settlementMonth
    || row.statement_generation_id !== binding.statementGenerationId
  ) {
    fail('reconciliation generation binding mismatch', 'RECONCILE_GENERATION_MISMATCH', 409)
  }
  if (Number(row.is_current) !== 1) fail('reconciliation generation is stale', 'STALE_RECONCILE_GENERATION', 409)
  return row
}

function assertReadinessUnchanged(row: any, source: SourceSnapshot): void {
  if (row.source_readiness_hash !== source.readinessHash) {
    fail('source readiness changed; a new reconciliation generation is required', 'SOURCE_READINESS_CHANGED', 409)
  }
}

function assertPostcondition(db: any, binding: ReconcileBinding, status: string, action: string): void {
  const row = assertExactGeneration(db, binding)
  if (row.status !== status) throw new Error(`RECONCILIATION_POSTCONDITION:${status}`)
  const audit = db.prepare(
    `SELECT COUNT(*) AS n
       FROM abc_audit_logs
      WHERE module = 'account_reconcile'
        AND action = ?
        AND target_id = ?`,
  ).get(action, binding.reconcileGenerationId) as any
  if (Number(audit.n) !== 1) throw new Error(`RECONCILIATION_AUDIT_POSTCONDITION:${action}`)
}

export function computeAccountReconciliation(
  db: any,
  binding: ReconcileBinding,
  operator: string,
  faults?: ReconcileFaults,
): Record<string, unknown> {
  assertReconcileBinding(binding)
  return withImmediateTransaction(db, faults, () => {
    const source = buildSourceSnapshot(db, binding, false)
    const sameGeneration = readGeneration(db, binding.reconcileGenerationId)
    if (sameGeneration) {
      if (
        sameGeneration.partner_id !== binding.partnerId
        || sameGeneration.settlement_month !== binding.settlementMonth
        || sameGeneration.statement_generation_id !== binding.statementGenerationId
      ) {
        fail('reconciliation generation binding mismatch', 'RECONCILE_GENERATION_MISMATCH', 409)
      }
      if (Number(sameGeneration.is_current) !== 1) {
        fail('reconciliation generation is stale', 'STALE_RECONCILE_GENERATION', 409)
      }
      assertReadinessUnchanged(sameGeneration, source)
      if (sameGeneration.status !== 'pending') {
        fail('completed reconciliation facts cannot be recomputed', 'RECONCILIATION_FINAL', 409)
      }
      return JSON.parse(String(sameGeneration.snapshot_json))
    }

    const current = db.prepare(
      `SELECT * FROM account_reconcile_generations
        WHERE partner_id = ? AND settlement_month = ? AND is_current = 1`,
    ).get(binding.partnerId, binding.settlementMonth) as any
    if (current?.status === 'complete' || current?.status === 'closed') {
      fail('completed reconciliation facts cannot be reopened or superseded', 'RECONCILIATION_FINAL', 409)
    }
    if (current) {
      const changed = db.prepare(
        `UPDATE account_reconcile_generations
            SET is_current = 0, updated_at = CURRENT_TIMESTAMP
          WHERE reconcile_generation_id = ? AND is_current = 1 AND status = 'pending'`,
      ).run(current.reconcile_generation_id)
      if (Number(changed.changes) !== 1) fail('reconciliation generation changed concurrently', 'CAS_CONFLICT', 409)
    }

    const partner = db.prepare('SELECT name FROM partners WHERE id = ?').get(binding.partnerId) as any
    if (!partner) fail('partner not found', 'PARTNER_NOT_FOUND', 404)
    const result = computeReconcile(source.bills, source.lis)
    const hospitalMonth = db.prepare(
      'SELECT * FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?',
    ).get(binding.partnerId, binding.settlementMonth) as any
    const hospitalMonthId = hospitalMonth?.id ?? uuidv4()
    if (hospitalMonth) {
      db.prepare(
        `UPDATE reconcile_hospital_months
            SET partner_name = ?, status = '待复核', name_aligned = 1,
                match_rate = ?, match_status = ?, statement_ready = 1, lis_ready = 1,
                diff_count = ?, pending_count = ?, unmatched_count = ?,
                confirmed_lab_revenue = NULL, completed_at = NULL, completed_by = NULL,
                computed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).run(
        partner.name,
        result.matchRate,
        result.matchStatus,
        result.diffs.length,
        result.diffs.length,
        result.unmatched.length,
        hospitalMonthId,
      )
    } else {
      db.prepare(
        `INSERT INTO reconcile_hospital_months
          (id, partner_id, partner_name, service_month, status, name_aligned,
           match_rate, match_status, statement_ready, lis_ready,
           diff_count, pending_count, unmatched_count, computed_at)
         VALUES (?, ?, ?, ?, '待复核', 1, ?, ?, 1, 1, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).run(
        hospitalMonthId,
        binding.partnerId,
        partner.name,
        binding.settlementMonth,
        result.matchRate,
        result.matchStatus,
        result.diffs.length,
        result.diffs.length,
        result.unmatched.length,
      )
    }

    db.prepare('DELETE FROM reconcile_diffs WHERE hospital_month_id = ?').run(hospitalMonthId)
    const insertDiff = db.prepare(
      `INSERT INTO reconcile_diffs
        (id, hospital_month_id, partner_id, service_month, case_no, line_type,
         bill_count, lis_count, delta, amount_impact, system_hint, low_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const diff of result.diffs) {
      insertDiff.run(
        uuidv4(),
        hospitalMonthId,
        binding.partnerId,
        binding.settlementMonth,
        diff.caseNo,
        diff.lineType,
        diff.billCount,
        diff.lisCount,
        diff.delta,
        diff.amountImpact,
        diff.systemHint,
        diff.lowConfidence ? 1 : 0,
      )
    }

    db.prepare('DELETE FROM reconcile_case_hints WHERE hospital_month_id = ?').run(hospitalMonthId)
    const insertHint = db.prepare(
      `INSERT INTO reconcile_case_hints
        (id, hospital_month_id, partner_id, service_month, case_no,
         hint_type, marker_name, wax_no, occurrences)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const caseHints: Record<string, ReturnType<typeof classifyCaseHints>> = {}
    for (const [caseNo, markers] of buildCaseMarkers(
      db,
      binding.partnerId,
      binding.settlementMonth,
    )) {
      const hints = classifyCaseHints(markers)
      if (hints.length === 0) continue
      caseHints[caseNo] = hints
      for (const hint of hints) {
        insertHint.run(
          uuidv4(),
          hospitalMonthId,
          binding.partnerId,
          binding.settlementMonth,
          caseNo,
          hint.hintType,
          hint.markerName,
          hint.waxNo ?? null,
          hint.occurrences,
        )
      }
    }

    const snapshot = {
      ...binding,
      hospitalMonthId,
      status: 'pending',
      sourceReadiness: source.readiness,
      confirmedLabRevenue: source.confirmedLabRevenue,
      result,
      caseHints,
    }
    const snapshotJson = stableJson(snapshot)
    db.prepare(
      `INSERT INTO account_reconcile_generations
        (reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
         hospital_month_id, is_current, status, source_readiness_json,
         source_readiness_hash, snapshot_json, snapshot_hash)
       VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)`,
    ).run(
      binding.reconcileGenerationId,
      binding.partnerId,
      binding.settlementMonth,
      binding.statementGenerationId,
      hospitalMonthId,
      source.readinessJson,
      source.readinessHash,
      snapshotJson,
      sha256(snapshotJson),
    )
    inject(faults, 'afterBusiness')
    inject(faults, 'beforeAudit')
    writeAuditLog(
      db,
      'account_reconcile',
      'compute_generation',
      binding.reconcileGenerationId,
      {
        partnerId: binding.partnerId,
        settlementMonth: binding.settlementMonth,
        statementGenerationId: binding.statementGenerationId,
        snapshotHash: sha256(snapshotJson),
      },
      operator,
    )
    inject(faults, 'afterAudit')
    inject(faults, 'beforePostcondition')
    assertPostcondition(db, binding, 'pending', 'compute_generation')
    return snapshot
  })
}

export function readAccountReconciliation(db: any, binding: ReconcileBinding): Record<string, unknown> {
  assertReconcileBinding(binding)
  const row = assertExactGeneration(db, binding)
  return {
    ...JSON.parse(String(row.snapshot_json)),
    status: row.status,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
  }
}

export function completeAccountReconciliation(
  db: any,
  binding: ReconcileBinding,
  operator: string,
  faults?: ReconcileFaults,
): Record<string, unknown> {
  assertReconcileBinding(binding)
  return withImmediateTransaction(db, faults, () => {
    const row = assertExactGeneration(db, binding)
    if (row.status !== 'pending') fail('only pending reconciliation can complete', 'CAS_CONFLICT', 409)
    const source = buildSourceSnapshot(db, binding, true)
    assertReadinessUnchanged(row, source)
    const pending = Number((db.prepare(
      'SELECT COUNT(*) AS n FROM reconcile_diffs WHERE hospital_month_id = ? AND verdict IS NULL',
    ).get(row.hospital_month_id) as any).n)
    if (pending !== 0) fail('all differences must be reviewed before completion', 'RECONCILIATION_PENDING', 409)

    const generationUpdate = db.prepare(
      `UPDATE account_reconcile_generations
          SET status = 'complete', completed_at = CURRENT_TIMESTAMP,
              completed_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE reconcile_generation_id = ? AND is_current = 1 AND status = 'pending'`,
    ).run(operator, binding.reconcileGenerationId)
    if (Number(generationUpdate.changes) !== 1) fail('completion lost concurrent CAS', 'CAS_CONFLICT', 409)
    const hospitalUpdate = db.prepare(
      `UPDATE reconcile_hospital_months
          SET status = '复核完成', completed_at = CURRENT_TIMESTAMP,
              completed_by = ?, confirmed_lab_revenue = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = '待复核'`,
    ).run(operator, source.confirmedLabRevenue, row.hospital_month_id)
    if (Number(hospitalUpdate.changes) !== 1) fail('hospital-month completion lost concurrent CAS', 'CAS_CONFLICT', 409)

    inject(faults, 'afterBusiness')
    inject(faults, 'beforeAudit')
    writeAuditLog(db, 'account_reconcile', 'complete_generation', binding.reconcileGenerationId, {
      ...binding,
      confirmedLabRevenue: source.confirmedLabRevenue,
      sourceReadinessHash: source.readinessHash,
    }, operator)
    inject(faults, 'afterAudit')
    inject(faults, 'beforePostcondition')
    assertPostcondition(db, binding, 'complete', 'complete_generation')
    return {
      ...binding,
      hospitalMonthId: row.hospital_month_id,
      status: 'complete',
      confirmedLabRevenue: source.confirmedLabRevenue,
    }
  })
}

export function closeAccountReconciliation(
  db: any,
  binding: ReconcileBinding,
  operator: string,
  faults?: ReconcileFaults,
): Record<string, unknown> {
  assertReconcileBinding(binding)
  return withImmediateTransaction(db, faults, () => {
    const row = assertExactGeneration(db, binding)
    if (row.status !== 'complete') fail('only complete reconciliation can close', 'CAS_CONFLICT', 409)
    const source = buildSourceSnapshot(db, binding, true)
    assertReadinessUnchanged(row, source)
    const generationUpdate = db.prepare(
      `UPDATE account_reconcile_generations
          SET status = 'closed', closed_at = CURRENT_TIMESTAMP,
              closed_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE reconcile_generation_id = ? AND is_current = 1 AND status = 'complete'`,
    ).run(operator, binding.reconcileGenerationId)
    if (Number(generationUpdate.changes) !== 1) fail('close lost concurrent CAS', 'CAS_CONFLICT', 409)
    const hospitalUpdate = db.prepare(
      `UPDATE reconcile_hospital_months
          SET status = '已关账', closed_at = CURRENT_TIMESTAMP,
              closed_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = '复核完成'`,
    ).run(operator, row.hospital_month_id)
    if (Number(hospitalUpdate.changes) !== 1) fail('hospital-month close lost concurrent CAS', 'CAS_CONFLICT', 409)

    inject(faults, 'afterBusiness')
    inject(faults, 'beforeAudit')
    writeAuditLog(db, 'account_reconcile', 'close_generation', binding.reconcileGenerationId, {
      ...binding,
      sourceReadinessHash: source.readinessHash,
    }, operator)
    inject(faults, 'afterAudit')
    inject(faults, 'beforePostcondition')
    assertPostcondition(db, binding, 'closed', 'close_generation')
    return {
      ...binding,
      hospitalMonthId: row.hospital_month_id,
      status: 'closed',
    }
  })
}

export function forbidAccountReconciliationReopen(): never {
  return fail(
    'completed or closed reconciliation facts cannot be reopened; use a governed correction generation',
    'RECONCILIATION_REOPEN_FORBIDDEN',
    409,
  )
}
