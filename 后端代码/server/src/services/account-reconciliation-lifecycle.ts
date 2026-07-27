import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { userHasCurrentPermission } from '../middleware/permissions.js'
import { writeAuditLog } from '../utils/cost-runs.js'
import {
  classifyChargeItem,
  classifyCaseHints,
  computeReconcile,
  drivesSupplement,
  verdictFollowUp,
  type BillCase,
  type LisCase,
  type VerdictReason,
} from '../utils/reconcile-account.js'
import { buildCaseMarkers, parseSlideCount } from '../utils/reconcile-compute.js'
import {
  buildCanonicalStatementArtifact,
  canonicalJson,
} from './statement-canonical-artifact.js'
import {
  readStatementSourceReadiness,
  type SourceReadinessResult,
} from './statement-source-readiness.js'

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
  return canonicalJson(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function prefixedSha256(value: string): string {
  return `sha256:${sha256(value)}`
}

function inject(faults: ReconcileFaults | undefined, at: ReconcileFaultStage): void {
  if (faults?.at === at) {
    throw new Error(`INJECTED_RECONCILIATION_FAULT:${at}`)
  }
}

function withImmediateTransaction<T>(
  db: any,
  faults: ReconcileFaults | undefined,
  action: 'compute_generation' | 'verdict_generation' | 'complete_generation' | 'close_generation',
  binding: ReconcileBinding,
  actorUserId: string,
  work: () => T,
): T {
  db.exec('BEGIN IMMEDIATE')
  let transactionEnded = false
  try {
    if (!actorUserId || !userHasCurrentPermission(db, actorUserId, 'account_reconcile', 'W')) {
      writeAuditLog(
        db,
        'account_reconcile',
        `${action}_denied`,
        binding.reconcileGenerationId,
        {
          partnerId: binding.partnerId,
          settlementMonth: binding.settlementMonth,
          reconcileGenerationId: binding.reconcileGenerationId,
          reasonCode: 'ACTOR_PERMISSION_REVOKED',
        },
        actorUserId || 'unknown',
      )
      db.exec('COMMIT')
      transactionEnded = true
      fail('actor is inactive or no longer has account_reconcile:W', 'ACTOR_PERMISSION_REVOKED', 403)
    }
    const result = work()
    inject(faults, 'beforeCommit')
    db.exec('COMMIT')
    transactionEnded = true
    return result
  } catch (err) {
    if (transactionEnded) throw err
    try {
      db.exec('ROLLBACK')
    } catch {
      try {
        if (typeof db.invalidateConnection === 'function') db.invalidateConnection()
        else if (typeof db.close === 'function') db.close()
      } catch {
        // The unsafe handle is already detached when invalidateConnection is available.
      }
    }
    throw err
  }
}

interface StatementLine {
  id: string
  case_no: string | null
  item_name: string | null
  source_label: string
  amount: unknown
  business_line: string
  line_grain: string
}

interface SourceSnapshot {
  readiness: Record<string, unknown>
  readinessJson: string
  readinessHash: string
  statementArtifactHash: string
  bills: BillCase[]
  lis: LisCase[]
  confirmedLabRevenue: number | null
}

const DECIMAL_SCALE = 10_000
const MAX_SCALED_DECIMAL = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_UNAMBIGUOUS_NUMBER_AMOUNT = 2 ** 39
const CANONICAL_DECIMAL_TEXT = /^-?(?:0|[1-9]\d{0,13})(?:\.(\d{1,4}))?$/

interface CanonicalAmountFact {
  value: number
  units: bigint
}

function canonicalAmountFact(
  value: unknown,
  code: string,
  label: string,
  canonicalText?: unknown,
): CanonicalAmountFact {
  if (canonicalText !== undefined && canonicalText !== null) {
    if (typeof canonicalText !== 'string' || !CANONICAL_DECIMAL_TEXT.test(canonicalText)) {
      fail(`${label} exceeds canonical DECIMAL(18,4) precision`, code, 409)
    }
    const decimalText = canonicalText as string
    const negative = decimalText.startsWith('-')
    const unsigned = negative ? decimalText.slice(1) : decimalText
    const [whole, fraction = ''] = unsigned.split('.')
    const units = BigInt(whole) * BigInt(DECIMAL_SCALE)
      + BigInt(fraction.padEnd(4, '0'))
    const signedUnits = negative ? -units : units
    if (signedUnits > MAX_SCALED_DECIMAL || signedUnits < -MAX_SCALED_DECIMAL) {
      fail(`${label} exceeds the scaled safe-integer boundary`, code, 409)
    }
    const numeric = Number(decimalText)
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || !Number.isFinite(numeric)
      || value !== numeric
    ) {
      fail(`${label} does not match its canonical decimal text`, code, 409)
    }
    return { value: numeric, units: signedUnits }
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} is unavailable or non-numeric`, code, 409)
  }
  const numeric = value as number
  if (Math.abs(numeric) >= MAX_UNAMBIGUOUS_NUMBER_AMOUNT) {
    fail(`${label} requires canonical decimal text before Number conversion`, code, 409)
  }
  const scaled = numeric * DECIMAL_SCALE
  const roundedScaled = Math.round(scaled)
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2
  if (
    !Number.isSafeInteger(roundedScaled)
    || Math.abs(scaled - roundedScaled) > tolerance
  ) {
    fail(`${label} exceeds canonical DECIMAL(18,4) precision`, code, 409)
  }
  return {
    value: roundedScaled / DECIMAL_SCALE,
    units: BigInt(roundedScaled),
  }
}

export function canonicalReconciliationAmount(
  value: unknown,
  code: string,
  label: string,
  canonicalText?: unknown,
): number {
  return canonicalAmountFact(value, code, label, canonicalText).value
}

export function canonicalReconciliationCount(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || !Number.isSafeInteger(value)
  ) {
    fail(`${label} is unavailable or invalid`, 'LIS_SOURCE_UNAVAILABLE', 409)
  }
  return value as number
}

const canonicalAmount = canonicalReconciliationAmount
const canonicalCount = canonicalReconciliationCount

function buildSourceSnapshot(
  db: any,
  binding: ReconcileBinding,
  requireRevenue: boolean,
): SourceSnapshot {
  const batch = db.prepare(
    `SELECT id, partner_id, settlement_month, generation_id, artifact_hash
       FROM statement_import_batches
      WHERE partner_id = ? AND generation_id = ?`,
  ).get(binding.partnerId, binding.statementGenerationId) as any
  if (!batch) fail('statement generation does not match partner', 'STATEMENT_GENERATION_NOT_FOUND', 404)
  const statementReadiness = readStatementSourceReadiness(
    db,
    binding.partnerId,
    String(batch.settlement_month),
    binding.statementGenerationId,
  ) as SourceReadinessResult
  if (!['complete', 'complete_empty'].includes(statementReadiness.state)) {
    fail(
      `statement source is not complete: ${statementReadiness.reason_code}`,
      'STATEMENT_SOURCE_NOT_COMPLETE',
      409,
    )
  }
  const statementArtifact = buildCanonicalStatementArtifact(db, binding.statementGenerationId)
  if (batch.artifact_hash && batch.artifact_hash !== statementArtifact.artifactHash) {
    fail('canonical statement artifact hash changed', 'STATEMENT_ARTIFACT_HASH_MISMATCH', 409)
  }
  for (const [label, amount] of Object.entries({
    parsed_total: statementArtifact.artifact.parsed_total,
    in_amount: statementArtifact.artifact.in_amount,
    out_amount: statementArtifact.artifact.out_amount,
    unknown_amount: statementArtifact.artifact.unknown_amount,
  })) {
    canonicalAmount(amount, 'NON_CANONICAL_STATEMENT_AMOUNT', `statement artifact ${label}`)
  }
  if (statementArtifact.artifact.declared_total !== null) {
    canonicalAmount(
      statementArtifact.artifact.declared_total,
      'NON_CANONICAL_STATEMENT_AMOUNT',
      'statement artifact declared_total',
    )
  }
  const canonicalFactAmounts = db.prepare(`
    SELECT 'statement_normalized_lines:' || id AS fact_ref, amount
      FROM statement_normalized_lines WHERE generation_id = ?
    UNION ALL
    SELECT 'partner_month_revenue_ledger:' || id AS fact_ref, settlement_amount AS amount
      FROM partner_month_revenue_ledger WHERE generation_id = ?
    UNION ALL
    SELECT 'out_settlement_ledger:' || id AS fact_ref, settlement_amount AS amount
      FROM out_settlement_ledger WHERE generation_id = ?
    ORDER BY fact_ref
  `).all(
    binding.statementGenerationId,
    binding.statementGenerationId,
    binding.statementGenerationId,
  ) as Array<{ fact_ref: string; amount: unknown }>
  for (const fact of canonicalFactAmounts) {
    canonicalAmount(
      fact.amount,
      'NON_CANONICAL_STATEMENT_AMOUNT',
      `canonical statement fact ${fact.fact_ref}`,
    )
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
  const targetAmounts = new Map<string, number>()
  for (const line of targetLines) {
    targetAmounts.set(
      line.id,
      canonicalAmount(line.amount, 'NON_CANONICAL_STATEMENT_AMOUNT', `statement line ${line.id}`),
    )
  }

  const expectedIn = targetLines
    .filter((line) =>
      line.business_line === 'IN'
      && line.line_grain === 'aggregate'
      && targetAmounts.get(line.id) !== 0
    )
    .map((line) => line.id)
    .sort()
  const expectedOut = targetLines
    .filter((line) => line.business_line === 'OUT' && targetAmounts.get(line.id) !== 0)
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
      current.ihcUnitPrice ??= Math.abs(targetAmounts.get(line.id)!) / count
    } else {
      current.ss += count
      current.ssUnitPrice ??= Math.abs(targetAmounts.get(line.id)!) / count
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
    current.ihc += canonicalCount(row.ihc_count, `LIS ihc_count ${row.case_no}`)
    current.ss += canonicalCount(row.special_stain_count, `LIS special_stain_count ${row.case_no}`)
    lisMap.set(row.case_no, current)
  }

  const revenueRows = db.prepare(
    `SELECT id, lab_revenue, lab_revenue_canonical, revenue_source
       FROM case_revenue
      WHERE partner_id = ? AND service_month = ?
      ORDER BY id`,
  ).all(binding.partnerId, binding.settlementMonth) as Array<{
    id: string
    lab_revenue: unknown
    lab_revenue_canonical: unknown
    revenue_source: unknown
  }>
  let confirmedLabRevenue: number | null = null
  const revenueSources = revenueRows.map(row => String(row.revenue_source ?? 'missing'))
  const canonicalRevenueSources = revenueRows.length > 0
    && revenueRows.every(row => row.revenue_source === 'statement' || row.revenue_source === 'corrected')
  if (canonicalRevenueSources) {
    let scaledTotal = 0n
    for (const row of revenueRows) {
      const amount = canonicalAmountFact(
        row.lab_revenue,
        'REVENUE_AMOUNT_UNAVAILABLE',
        `confirmed revenue ${row.id}`,
        row.lab_revenue_canonical,
      )
      if (amount.value < 0) {
        fail(`confirmed revenue ${row.id} is negative`, 'REVENUE_AMOUNT_UNAVAILABLE', 409)
      }
      scaledTotal += amount.units
      if (scaledTotal > MAX_SCALED_DECIMAL) {
        fail('confirmed revenue total exceeds the scaled safe-integer boundary', 'REVENUE_AMOUNT_UNAVAILABLE', 409)
      }
    }
    confirmedLabRevenue = Number(scaledTotal) / DECIMAL_SCALE
  }
  if (requireRevenue && confirmedLabRevenue === null) {
    fail('confirmed lab revenue is unavailable', 'REVENUE_SOURCE_UNAVAILABLE', 409)
  }

  const bills = [...billMap.values()].sort((a, b) => a.caseNo.localeCompare(b.caseNo))
  const lis = [...lisMap.values()].sort((a, b) => a.caseNo.localeCompare(b.caseNo))
  const readiness = {
    statement: statementReadiness,
    statementArtifactHash: statementArtifact.artifactHash,
    targetLineIds: targetLines.map((line) => line.id),
    ledger: { expectedIn, actualIn, expectedOut, actualOut },
    lis: {
      partnerId: binding.partnerId,
      settlementMonth: binding.settlementMonth,
      rowCount: lisRows.length,
      cases: lis,
    },
    revenue: {
      available: confirmedLabRevenue !== null,
      rowCount: revenueRows.length,
      sourceKinds: revenueSources,
      confirmedLabRevenue,
    },
  }
  const readinessJson = stableJson(readiness)
  return {
    readiness,
    readinessJson,
    readinessHash: sha256(readinessJson),
    statementArtifactHash: statementArtifact.artifactHash,
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
  if (row.statement_artifact_hash !== source.statementArtifactHash) {
    fail('canonical statement artifact changed', 'STATEMENT_ARTIFACT_HASH_MISMATCH', 409)
  }
}

interface CompletionArtifact {
  schemaVersion: 'account-reconciliation-completion/v1'
  binding: ReconcileBinding
  hospitalMonthId: string
  sourceReadinessHash: string
  statementArtifactHash: string
  confirmedLabRevenue: number
  decisions: Array<Record<string, unknown>>
  supplements: Array<Record<string, unknown>>
}

function buildCompletionArtifact(
  db: any,
  binding: ReconcileBinding,
  row: any,
  source: SourceSnapshot,
): { artifact: CompletionArtifact; json: string; hash: string } {
  if (source.confirmedLabRevenue === null) {
    fail('confirmed lab revenue is unavailable', 'REVENUE_SOURCE_UNAVAILABLE', 409)
  }
  const confirmedLabRevenue = source.confirmedLabRevenue as number
  const decisions = (db.prepare(`
    SELECT id, case_no, line_type, bill_count, lis_count, delta, amount_impact,
           verdict, verdict_reason, verdict_by, verdict_at, follow_up
      FROM reconcile_diffs
     WHERE hospital_month_id = ?
     ORDER BY case_no, line_type, id
  `).all(row.hospital_month_id) as any[]).map(decision => {
    if (!decision.verdict) {
      fail('all differences must be reviewed before completion', 'RECONCILIATION_PENDING', 409)
    }
    return {
      id: String(decision.id),
      caseNo: String(decision.case_no),
      lineType: String(decision.line_type),
      billCount: canonicalCount(decision.bill_count, `decision bill_count ${decision.id}`),
      lisCount: canonicalCount(decision.lis_count, `decision lis_count ${decision.id}`),
      delta: canonicalAmount(
        decision.delta,
        'NON_CANONICAL_DECISION_AMOUNT',
        `decision delta ${decision.id}`,
      ),
      amountImpact: canonicalAmount(
        decision.amount_impact,
        'NON_CANONICAL_DECISION_AMOUNT',
        `decision amount_impact ${decision.id}`,
      ),
      verdict: String(decision.verdict),
      verdictReason: decision.verdict_reason === null ? null : String(decision.verdict_reason),
      verdictBy: decision.verdict_by === null ? null : String(decision.verdict_by),
      verdictAt: decision.verdict_at === null ? null : String(decision.verdict_at),
      followUp: decision.follow_up === null ? null : String(decision.follow_up),
    }
  })
  const supplements = (db.prepare(`
    SELECT supplement.id, supplement.source_diff_id, supplement.partner_id,
           supplement.service_month, supplement.case_no, supplement.amount,
           supplement.case_count, supplement.submitted_by
      FROM supplement_orders supplement
      JOIN reconcile_diffs decision ON decision.id = supplement.source_diff_id
     WHERE decision.hospital_month_id = ?
       AND supplement.reconcile_generation_id = ?
     ORDER BY supplement.source_diff_id, supplement.id
  `).all(row.hospital_month_id, binding.reconcileGenerationId) as any[]).map(supplement => ({
    id: String(supplement.id),
    sourceDiffId: String(supplement.source_diff_id),
    partnerId: String(supplement.partner_id),
    settlementMonth: String(supplement.service_month),
    caseNo: supplement.case_no === null ? null : String(supplement.case_no),
    amount: canonicalAmount(
      supplement.amount,
      'NON_CANONICAL_DECISION_AMOUNT',
      `supplement amount ${supplement.id}`,
    ),
    caseCount: canonicalCount(supplement.case_count, `supplement case_count ${supplement.id}`),
    submittedBy: supplement.submitted_by === null ? null : String(supplement.submitted_by),
  }))
  const artifact: CompletionArtifact = {
    schemaVersion: 'account-reconciliation-completion/v1',
    binding,
    hospitalMonthId: String(row.hospital_month_id),
    sourceReadinessHash: source.readinessHash,
    statementArtifactHash: source.statementArtifactHash,
    confirmedLabRevenue,
    decisions,
    supplements,
  }
  const json = stableJson(artifact)
  return { artifact, json, hash: prefixedSha256(json) }
}

function assertHospitalMonthBinding(db: any, binding: ReconcileBinding, hospitalMonthId: string): void {
  const hospitalMonth = db.prepare(`
    SELECT reconcile_generation_id, binding_state
      FROM account_reconcile_hospital_month_bindings
     WHERE hospital_month_id = ?
  `).get(hospitalMonthId) as any
  if (
    hospitalMonth?.reconcile_generation_id !== binding.reconcileGenerationId
    || hospitalMonth?.binding_state !== 'bound'
  ) {
    fail('hospital-month generation binding changed', 'RECONCILE_GENERATION_MISMATCH', 409)
  }
}

function bindHospitalMonth(db: any, binding: ReconcileBinding, hospitalMonthId: string): void {
  db.prepare(`
    INSERT INTO account_reconcile_hospital_month_bindings
      (hospital_month_id, reconcile_generation_id, binding_state, updated_at)
    VALUES (?, ?, 'bound', CURRENT_TIMESTAMP)
    ON CONFLICT(hospital_month_id) DO UPDATE SET
      reconcile_generation_id = excluded.reconcile_generation_id,
      binding_state = 'bound',
      updated_at = CURRENT_TIMESTAMP
  `).run(hospitalMonthId, binding.reconcileGenerationId)
}

function assertPostcondition(db: any, binding: ReconcileBinding, status: string, action: string): void {
  const row = assertExactGeneration(db, binding)
  if (row.status !== status) throw new Error(`RECONCILIATION_POSTCONDITION:${status}`)
  const hospitalMonth = db.prepare(`
    SELECT reconcile_generation_id, binding_state
      FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
  `).get(row.hospital_month_id) as any
  if (
    hospitalMonth?.reconcile_generation_id !== binding.reconcileGenerationId
    || hospitalMonth?.binding_state !== 'bound'
  ) {
    throw new Error('RECONCILIATION_HOSPITAL_MONTH_BINDING_POSTCONDITION')
  }
  if (
    status !== 'pending'
    && (!row.completion_artifact_json || !row.completion_artifact_hash)
  ) {
    throw new Error('RECONCILIATION_COMPLETION_ARTIFACT_POSTCONDITION')
  }
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
  return withImmediateTransaction(db, faults, 'compute_generation', binding, operator, () => {
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
    const hospitalMonthBinding = hospitalMonth
      ? db.prepare(`
          SELECT reconcile_generation_id
            FROM account_reconcile_hospital_month_bindings
           WHERE hospital_month_id = ?
        `).get(hospitalMonth.id)
      : undefined
    if (hospitalMonth?.closed_at && !hospitalMonthBinding) {
      fail(
        'legacy closed reconciliation requires an explicit governed generation backfill',
        'LEGACY_CLOSED_RECONCILIATION_REQUIRES_BACKFILL',
        409,
      )
    }
    if (hospitalMonth?.closed_at) {
      fail('completed reconciliation facts cannot be reopened or superseded', 'RECONCILIATION_FINAL', 409)
    }
    const hospitalMonthId = hospitalMonth?.id ?? uuidv4()
    if (hospitalMonth) {
      db.prepare(
        `UPDATE reconcile_hospital_months
            SET partner_name = ?, status = '待复核', name_aligned = 1,
                match_rate = ?, match_status = ?, statement_ready = 1, lis_ready = 1,
                diff_count = ?, pending_count = ?, unmatched_count = ?,
                confirmed_lab_revenue = NULL, completed_at = NULL, completed_by = NULL,
                computed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND closed_at IS NULL`,
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
      statementArtifactHash: source.statementArtifactHash,
      confirmedLabRevenue: source.confirmedLabRevenue,
      result,
      caseHints,
    }
    const snapshotJson = stableJson(snapshot)
    db.prepare(
      `INSERT INTO account_reconcile_generations
        (reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
         hospital_month_id, is_current, status, source_readiness_json,
         source_readiness_hash, statement_artifact_hash, snapshot_json, snapshot_hash)
       VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, ?)`,
    ).run(
      binding.reconcileGenerationId,
      binding.partnerId,
      binding.settlementMonth,
      binding.statementGenerationId,
      hospitalMonthId,
      source.readinessJson,
      source.readinessHash,
      source.statementArtifactHash,
      snapshotJson,
      sha256(snapshotJson),
    )
    bindHospitalMonth(db, binding, hospitalMonthId)
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
        statementArtifactHash: source.statementArtifactHash,
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

export function setAccountReconciliationVerdict(
  db: any,
  binding: ReconcileBinding,
  diffId: string,
  reason: VerdictReason,
  note: string | null,
  actorUserId: string,
  operator: string,
  faults?: ReconcileFaults,
): Record<string, unknown> {
  assertReconcileBinding(binding)
  return withImmediateTransaction(db, faults, 'verdict_generation', binding, actorUserId, () => {
    const row = readGeneration(db, binding.reconcileGenerationId)
    if (!row) {
      fail('reconciliation generation is stale or unavailable', 'STALE_RECONCILE_GENERATION', 409)
    }
    if (
      row.partner_id !== binding.partnerId
      || row.settlement_month !== binding.settlementMonth
      || row.statement_generation_id !== binding.statementGenerationId
      || Number(row.is_current) !== 1
    ) {
      fail('reconciliation generation is stale or mismatched', 'STALE_RECONCILE_GENERATION', 409)
    }
    if (row.status !== 'pending') {
      fail('completed reconciliation decisions are immutable', 'RECONCILIATION_FINAL', 409)
    }
    assertHospitalMonthBinding(db, binding, row.hospital_month_id)

    const diff = db.prepare(`
      SELECT * FROM reconcile_diffs
       WHERE id = ? AND hospital_month_id = ?
    `).get(diffId, row.hospital_month_id) as any
    if (!diff) {
      fail('reconciliation difference is stale or unavailable', 'STALE_RECONCILIATION_DIFF', 409)
    }
    const followUp = verdictFollowUp(reason)
    const pendingBefore = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM reconcile_diffs
       WHERE hospital_month_id = ? AND verdict IS NULL
    `).get(row.hospital_month_id) as any).n)
    const auditBefore = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(diff.id) as any).n)

    if (
      diff.verdict === reason
      && (diff.verdict_reason ?? null) === note
      && diff.follow_up === followUp
    ) {
      const pendingSupplements = Number((db.prepare(`
        SELECT COUNT(*) AS n FROM supplement_orders
         WHERE source_diff_id = ?
           AND reconcile_generation_id = ?
           AND status = '待补收'
      `).get(diff.id, binding.reconcileGenerationId) as any).n)
      if (
        (drivesSupplement(reason) && pendingSupplements !== 1)
        || (!drivesSupplement(reason) && pendingSupplements !== 0)
      ) {
        fail('verdict replay state is inconsistent', 'VERDICT_REPLAY_STATE_MISMATCH', 409)
      }
      return {
        id: diff.id,
        verdict: reason,
        followUp,
        pendingCount: pendingBefore,
        duplicate: true,
      }
    }

    const changed = db.prepare(`
      UPDATE reconcile_diffs
         SET verdict = ?, verdict_reason = ?, verdict_by = ?,
             verdict_at = CURRENT_TIMESTAMP, follow_up = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND hospital_month_id = ?
         AND (
           verdict IS NOT ?
           OR verdict_reason IS NOT ?
           OR follow_up IS NOT ?
         )
    `).run(
      reason,
      note,
      operator,
      followUp,
      diff.id,
      row.hospital_month_id,
      reason,
      note,
      followUp,
    )
    if (Number(changed.changes) !== 1) {
      fail('verdict lost concurrent CAS', 'CAS_CONFLICT', 409)
    }

    db.prepare(`
      DELETE FROM supplement_orders
       WHERE source_diff_id = ?
         AND reconcile_generation_id = ?
         AND status = '待补收'
    `).run(diff.id, binding.reconcileGenerationId)
    if (drivesSupplement(reason)) {
      db.prepare(`
        INSERT INTO supplement_orders
          (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
           case_no, amount, case_count, status, operator, review_status, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, '待补收', ?, 'pending_review', ?)
      `).run(
        uuidv4(),
        diff.partner_id,
        diff.service_month,
        diff.id,
        binding.reconcileGenerationId,
        diff.case_no,
        canonicalAmount(
          diff.amount_impact,
          'NON_CANONICAL_DECISION_AMOUNT',
          `decision amount_impact ${diff.id}`,
        ),
        operator,
        operator,
      )
    }

    const pending = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM reconcile_diffs
       WHERE hospital_month_id = ? AND verdict IS NULL
    `).get(row.hospital_month_id) as any).n)
    const hospitalUpdate = db.prepare(`
      UPDATE reconcile_hospital_months
         SET pending_count = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND closed_at IS NULL
    `).run(pending, row.hospital_month_id)
    if (Number(hospitalUpdate.changes) !== 1) {
      fail('hospital-month verdict update lost concurrent CAS', 'CAS_CONFLICT', 409)
    }

    inject(faults, 'afterBusiness')
    inject(faults, 'beforeAudit')
    writeAuditLog(db, 'account_reconcile', 'verdict', diff.id, {
      ...binding,
      reason,
      followUp,
      caseNo: diff.case_no,
      amountImpact: diff.amount_impact,
    }, operator)
    inject(faults, 'afterAudit')
    inject(faults, 'beforePostcondition')

    const persisted = db.prepare(`
      SELECT verdict, verdict_reason, follow_up FROM reconcile_diffs
       WHERE id = ? AND hospital_month_id = ?
    `).get(diff.id, row.hospital_month_id) as any
    const auditAfter = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(diff.id) as any).n)
    const expectedSupplements = drivesSupplement(reason) ? 1 : 0
    const pendingSupplements = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM supplement_orders
       WHERE source_diff_id = ?
         AND reconcile_generation_id = ?
         AND status = '待补收'
    `).get(diff.id, binding.reconcileGenerationId) as any).n)
    if (
      persisted?.verdict !== reason
      || (persisted?.verdict_reason ?? null) !== note
      || persisted?.follow_up !== followUp
      || pendingSupplements !== expectedSupplements
      || auditAfter !== auditBefore + 1
    ) {
      throw new Error('RECONCILIATION_VERDICT_POSTCONDITION')
    }
    return {
      id: diff.id,
      verdict: reason,
      followUp,
      pendingCount: pending,
      duplicate: false,
    }
  })
}

export function completeAccountReconciliation(
  db: any,
  binding: ReconcileBinding,
  operator: string,
  faults?: ReconcileFaults,
): Record<string, unknown> {
  assertReconcileBinding(binding)
  return withImmediateTransaction(db, faults, 'complete_generation', binding, operator, () => {
    const row = assertExactGeneration(db, binding)
    if (row.status !== 'pending') fail('only pending reconciliation can complete', 'CAS_CONFLICT', 409)
    assertHospitalMonthBinding(db, binding, row.hospital_month_id)
    const source = buildSourceSnapshot(db, binding, true)
    assertReadinessUnchanged(row, source)
    const pending = Number((db.prepare(
      'SELECT COUNT(*) AS n FROM reconcile_diffs WHERE hospital_month_id = ? AND verdict IS NULL',
    ).get(row.hospital_month_id) as any).n)
    if (pending !== 0) fail('all differences must be reviewed before completion', 'RECONCILIATION_PENDING', 409)
    const completion = buildCompletionArtifact(db, binding, row, source)

    const generationUpdate = db.prepare(
      `UPDATE account_reconcile_generations
          SET status = 'complete', completed_at = CURRENT_TIMESTAMP,
              completed_by = ?, completion_artifact_json = ?,
              completion_artifact_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE reconcile_generation_id = ? AND is_current = 1 AND status = 'pending'`,
    ).run(
      operator,
      completion.json,
      completion.hash,
      binding.reconcileGenerationId,
    )
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
      statementArtifactHash: source.statementArtifactHash,
      completionArtifactHash: completion.hash,
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
  return withImmediateTransaction(db, faults, 'close_generation', binding, operator, () => {
    const row = assertExactGeneration(db, binding)
    if (row.status !== 'complete') fail('only complete reconciliation can close', 'CAS_CONFLICT', 409)
    assertHospitalMonthBinding(db, binding, row.hospital_month_id)
    const source = buildSourceSnapshot(db, binding, true)
    assertReadinessUnchanged(row, source)
    const completion = buildCompletionArtifact(db, binding, row, source)
    if (
      row.completion_artifact_json !== completion.json
      || row.completion_artifact_hash !== completion.hash
    ) {
      fail('completion decision set changed', 'DECISION_SET_CHANGED', 409)
    }
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
      statementArtifactHash: source.statementArtifactHash,
      completionArtifactHash: completion.hash,
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
