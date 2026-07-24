import { beforeAll, describe, expect, it } from 'vitest'
import { getDb } from './p0-harness.js'
import {
  closeAccountReconciliation,
  completeAccountReconciliation,
  computeAccountReconciliation,
  readAccountReconciliation,
  ReconcileLifecycleError,
  type ReconcileBinding,
  type ReconcileFaultStage,
} from '../src/services/account-reconciliation-lifecycle.js'

let db: any
let sequence = 0

function seedGeneration(
  name: string,
  batchMonth: string,
  targetRows: Array<{ month: string; caseNo: string; item: string; amount: number; lisCount: number }>,
) {
  const suffix = `${name}-${++sequence}`
  const partnerId = `PT-LOC005-${suffix}`
  const statementGenerationId = `STMT-LOC005-${suffix}`
  const batchId = `BATCH-LOC005-${suffix}`
  db.prepare(
    `INSERT INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)`,
  ).run(partnerId, `CODE-${suffix}`, `Partner ${suffix}`)
  db.prepare(
    `INSERT INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
     VALUES (?, ?, ?, 'loc005-test', 'r1', 'c1', ?, ?, 1, ?, ?, 'posted')`,
  ).run(
    batchId,
    partnerId,
    `HASH-${suffix}`,
    batchMonth,
    statementGenerationId,
    targetRows.length,
    targetRows.length,
  )
  const raw = db.prepare(
    `INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
     VALUES (?, ?, ?, 'sheet', ?, ?)`,
  )
  const normalized = db.prepare(
    `INSERT INTO statement_normalized_lines
      (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
       case_no, item_name, source_sheet, source_row, source_column, source_label,
       template_family, row_kind, line_grain, business_line, amount_role, amount,
       classification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet', ?, 'amount', ?, 'loc005-test',
             'detail', 'case', 'IN', 'gross', ?, 'classified')`,
  )
  const lis = db.prepare(
    `INSERT INTO lis_cases
      (id, case_no, partner_id, ihc_count, special_stain_count, operate_time)
     VALUES (?, ?, ?, ?, 0, ?)`,
  )
  const revenue = db.prepare(
    `INSERT INTO case_revenue
      (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`,
  )
  targetRows.forEach((row, index) => {
    const sourceRow = index + 1
    raw.run(`RAW-${suffix}-${sourceRow}`, batchId, statementGenerationId, sourceRow, JSON.stringify(row))
    normalized.run(
      `LINE-${suffix}-${sourceRow}`,
      batchId,
      statementGenerationId,
      partnerId,
      batchMonth,
      row.month,
      row.caseNo,
      row.item,
      sourceRow,
      row.item,
      row.amount,
    )
    lis.run(
      `LIS-${suffix}-${sourceRow}`,
      row.caseNo,
      partnerId,
      row.lisCount,
      `${row.month}-15`,
    )
    revenue.run(
      `REV-${suffix}-${sourceRow}`,
      row.caseNo,
      partnerId,
      row.month,
      row.amount,
      row.amount,
      row.amount,
    )
  })
  return { partnerId, statementGenerationId }
}

function binding(
  source: { partnerId: string; statementGenerationId: string },
  settlementMonth: string,
  reconcileGenerationId: string,
): ReconcileBinding {
  return { ...source, settlementMonth, reconcileGenerationId }
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn()
    throw new Error(`expected ${code}`)
  } catch (err) {
    expect(err).toBeInstanceOf(ReconcileLifecycleError)
    expect((err as ReconcileLifecycleError).code).toBe(code)
  }
}

beforeAll(async () => {
  db = await getDb()
})

describe('LOC-005 generation/month binding and month-local close', () => {
  it('one statement generation may serve two target months without cross-month close', () => {
    const source = seedGeneration('multi-month', '2026-06', [
      { month: '2026-06', caseNo: 'CASE-JUN', item: '免疫组化染色*2', amount: 200, lisCount: 2 },
      { month: '2026-07', caseNo: 'CASE-JUL', item: '免疫组化染色*3', amount: 300, lisCount: 3 },
    ])
    const june = binding(source, '2026-06', 'RECON-JUNE')
    const july = binding(source, '2026-07', 'RECON-JULY')

    const juneSnapshot = computeAccountReconciliation(db, june, 'tester') as any
    const julySnapshot = computeAccountReconciliation(db, july, 'tester') as any
    expect(juneSnapshot.sourceReadiness.targetLineIds).toEqual(
      expect.arrayContaining([expect.stringContaining('multi-month')]),
    )
    expect(juneSnapshot.sourceReadiness.targetLineIds).not.toEqual(
      julySnapshot.sourceReadiness.targetLineIds,
    )
    expect(julySnapshot.result).toMatchObject({
      billCaseCount: 1,
      lisCaseCount: 1,
      matchedCaseCount: 1,
      matchRate: 1,
    })
    completeAccountReconciliation(db, june, 'tester')
    completeAccountReconciliation(db, july, 'tester')
    closeAccountReconciliation(db, june, 'tester')

    expect(readAccountReconciliation(db, june).status).toBe('closed')
    expect(readAccountReconciliation(db, july).status).toBe('complete')
    const batch = db.prepare(
      'SELECT status, is_current FROM statement_import_batches WHERE generation_id = ?',
    ).get(source.statementGenerationId) as any
    expect(batch).toMatchObject({ status: 'posted', is_current: 1 })
    expectCode(
      () => readAccountReconciliation(db, { ...june, settlementMonth: '2026-07' }),
      'RECONCILE_GENERATION_MISMATCH',
    )
  })

  it('a newer pending reconcile generation makes the old generation stably stale', () => {
    const source = seedGeneration('stale', '2026-08', [
      { month: '2026-08', caseNo: 'CASE-AUG', item: '免疫组化染色', amount: 100, lisCount: 1 },
    ])
    const oldBinding = binding(source, '2026-08', 'RECON-OLD')
    const newBinding = binding(source, '2026-08', 'RECON-NEW')
    computeAccountReconciliation(db, oldBinding, 'tester')
    computeAccountReconciliation(db, newBinding, 'tester')
    expectCode(() => readAccountReconciliation(db, oldBinding), 'STALE_RECONCILE_GENERATION')
    expect(readAccountReconciliation(db, newBinding).status).toBe('pending')
  })
})

describe('LOC-005 transaction rollback mutations', () => {
  const stages: ReconcileFaultStage[] = [
    'afterBusiness',
    'beforeAudit',
    'afterAudit',
    'beforePostcondition',
    'beforeCommit',
  ]

  it.each(stages)('%s fault rolls back snapshot, projection and success audit', (stage) => {
    const source = seedGeneration(`compute-fault-${stage}`, '2026-09', [
      { month: '2026-09', caseNo: `CASE-${stage}`, item: '免疫组化染色', amount: 100, lisCount: 1 },
    ])
    const target = binding(source, '2026-09', `RECON-${stage}`)
    expect(() => computeAccountReconciliation(db, target, 'tester', { at: stage })).toThrow(
      `INJECTED_RECONCILIATION_FAULT:${stage}`,
    )
    expect(db.prepare(
      'SELECT COUNT(*) AS n FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
    ).get(target.reconcileGenerationId).n).toBe(0)
    expect(db.prepare(
      'SELECT COUNT(*) AS n FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?',
    ).get(target.partnerId, target.settlementMonth).n).toBe(0)
    expect(db.prepare(
      `SELECT COUNT(*) AS n FROM abc_audit_logs
        WHERE module = 'account_reconcile' AND target_id = ?`,
    ).get(target.reconcileGenerationId).n).toBe(0)
  })

  it('complete audit fault rolls back both CAS writes and the success audit', () => {
    const source = seedGeneration('complete-fault', '2026-10', [
      { month: '2026-10', caseNo: 'CASE-OCT', item: '免疫组化染色', amount: 100, lisCount: 1 },
    ])
    const target = binding(source, '2026-10', 'RECON-COMPLETE-FAULT')
    const computed = computeAccountReconciliation(db, target, 'tester') as any
    expect(() => completeAccountReconciliation(db, target, 'tester', { at: 'afterAudit' })).toThrow(
      'INJECTED_RECONCILIATION_FAULT:afterAudit',
    )
    expect(readAccountReconciliation(db, target).status).toBe('pending')
    expect((db.prepare(
      'SELECT status FROM reconcile_hospital_months WHERE id = ?',
    ).get(computed.hospitalMonthId) as any).status).toBe('待复核')
    expect((db.prepare(
      `SELECT COUNT(*) AS n FROM abc_audit_logs
        WHERE action = 'complete_generation' AND target_id = ?`,
    ).get(target.reconcileGenerationId) as any).n).toBe(0)
  })
})

describe('LOC-005 conditional close CAS', () => {
  it('permits one close winner and emits exactly one success audit', () => {
    const source = seedGeneration('cas', '2026-11', [
      { month: '2026-11', caseNo: 'CASE-NOV', item: '免疫组化染色', amount: 100, lisCount: 1 },
    ])
    const target = binding(source, '2026-11', 'RECON-CAS')
    computeAccountReconciliation(db, target, 'tester')
    completeAccountReconciliation(db, target, 'tester')
    expect(closeAccountReconciliation(db, target, 'winner').status).toBe('closed')
    expectCode(() => closeAccountReconciliation(db, target, 'loser'), 'CAS_CONFLICT')
    expect((db.prepare(
      `SELECT COUNT(*) AS n FROM abc_audit_logs
        WHERE action = 'close_generation' AND target_id = ?`,
    ).get(target.reconcileGenerationId) as any).n).toBe(1)
  })
})
