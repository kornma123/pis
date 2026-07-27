import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const testDirectory = mkdtempSync(join(tmpdir(), 'coreone-loc005-r2-'))
const databasePath = join(testDirectory, 'loc005.sqlite')

process.env.NODE_ENV = 'test'
process.env.DATABASE_PATH = databasePath
process.env.COREONE_ALLOW_DATABASE_CREATE = '1'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'loc005-r2-test-secret-at-least-32-characters'

type Binding = {
  partnerId: string
  settlementMonth: string
  statementGenerationId: string
  reconcileGenerationId: string
}

let manager: typeof import('../src/database/DatabaseManager.js')
let lifecycle: typeof import('../src/services/account-reconciliation-lifecycle.js')
let db: any
let sequence = 0

function seedSource(options: {
  name: string
  month?: string
  amount?: unknown
  lisCount?: unknown
  revenueAmount?: unknown
}): Binding {
  const month = options.month ?? '2026-08'
  const suffix = `${options.name}-${++sequence}`
  const partnerId = `PT-LOC005-R2-${suffix}`
  const statementGenerationId = `STMT-LOC005-R2-${suffix}`
  const reconcileGenerationId = `RECON-LOC005-R2-${suffix}`
  const batchId = `BATCH-LOC005-R2-${suffix}`
  const caseNo = `CASE-LOC005-R2-${suffix}`
  const amount = options.amount ?? 100
  const lisCount = options.lisCount ?? 1
  const revenueAmount = Object.prototype.hasOwnProperty.call(options, 'revenueAmount')
    ? options.revenueAmount
    : amount

  db.prepare('INSERT INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)')
    .run(partnerId, `CODE-${suffix}`, `Partner ${suffix}`)
  db.prepare(`
    INSERT INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
    VALUES (?, ?, ?, 'loc005-r2-test', 'r1', 'c1', ?, ?, 1, 1, 1, 'posted')
  `).run(batchId, partnerId, `HASH-${suffix}`, month, statementGenerationId)
  db.prepare(`
    INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
    VALUES (?, ?, ?, 'sheet', 1, ?)
  `).run(`RAW-${suffix}`, batchId, statementGenerationId, JSON.stringify({ caseNo, amount }))
  db.prepare(`
    INSERT INTO statement_normalized_lines
      (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
       case_no, item_name, source_sheet, source_row, source_column, source_label,
       template_family, row_kind, line_grain, business_line, amount_role, amount,
       classification_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet', 1, 'amount', ?,
            'loc005-r2-test', 'detail', 'case', 'IN', 'gross', ?, 'classified')
  `).run(
    `LINE-${suffix}`,
    batchId,
    statementGenerationId,
    partnerId,
    month,
    month,
    caseNo,
    '免疫组化染色*1',
    '免疫组化染色*1',
    amount,
  )
  db.prepare(`
    INSERT INTO lis_cases
      (id, case_no, partner_id, ihc_count, special_stain_count, operate_time)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(`LIS-${suffix}`, caseNo, partnerId, lisCount, `${month}-15`)
  db.prepare(`
    INSERT INTO case_revenue
      (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
    VALUES (?, ?, ?, ?, 100, 100, ?, 'statement')
  `).run(`REV-${suffix}`, caseNo, partnerId, month, revenueAmount)

  return { partnerId, settlementMonth: month, statementGenerationId, reconcileGenerationId }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(lifecycle.ReconcileLifecycleError)
    expect((error as InstanceType<typeof lifecycle.ReconcileLifecycleError>).code).toBe(code)
  }
}

function setAdminActive(active: boolean): void {
  db.prepare('UPDATE users SET status = ?, is_deleted = 0 WHERE id = ?')
    .run(active ? 1 : 0, 'USER-001')
}

beforeAll(async () => {
  manager = await import('../src/database/DatabaseManager.js')
  lifecycle = await import('../src/services/account-reconciliation-lifecycle.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
})

afterAll(() => {
  manager.closeDatabase()
  const realDirectory = resolve(testDirectory)
  const realTempRoot = resolve(tmpdir())
  if (!realDirectory.startsWith(`${realTempRoot}\\`) && !realDirectory.startsWith(`${realTempRoot}/`)) {
    throw new Error(`unsafe test cleanup path: ${realDirectory}`)
  }
  rmSync(realDirectory, { recursive: true, force: true })
})

describe('LOC-005 R2 canonical source truth', () => {
  it('stores the canonical statement readiness and canonical artifact hash', () => {
    const binding = seedSource({ name: 'canonical-source' })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any

    expect(snapshot.sourceReadiness.statement).toMatchObject({
      source: 'statement',
      state: 'complete',
      generation_id: binding.statementGenerationId,
    })
    expect(snapshot.statementArtifactHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    const row = db.prepare(`
      SELECT source_readiness_json, statement_artifact_hash
      FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId) as any
    expect(JSON.parse(row.source_readiness_json).statement.state).toBe('complete')
    expect(row.statement_artifact_hash).toBe(snapshot.statementArtifactHash)
  })

  it.each([
    ['NaN/text', 'NaN'],
    ['non-canonical precision', 100.12345],
  ])('fails closed for %s statement amounts', (_label, amount) => {
    const binding = seedSource({ name: `bad-statement-${String(_label)}`, amount })
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, binding, 'USER-001'),
      'NON_CANONICAL_STATEMENT_AMOUNT',
    )
  })

  it('does not turn NULL confirmed revenue into zero at completion', () => {
    const binding = seedSource({ name: 'null-revenue', revenueAmount: null })
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, binding, 'USER-001'),
      'REVENUE_AMOUNT_UNAVAILABLE',
    )
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId).n).toBe(0)
  })
})

describe('LOC-005 R2 legacy binding and decision freeze', () => {
  it('keeps an unbound legacy closed hospital-month immutable across restart', () => {
    const binding = seedSource({ name: 'legacy-closed' })
    db.prepare(`
      INSERT INTO reconcile_hospital_months
        (id, partner_id, partner_name, service_month, status, closed_at, closed_by)
      VALUES ('HM-LEGACY-CLOSED', ?, 'Legacy partner', ?, 'legacy-closed', CURRENT_TIMESTAMP, 'legacy-user')
    `).run(binding.partnerId, binding.settlementMonth)

    expectCode(
      () => lifecycle.computeAccountReconciliation(db, binding, 'USER-001'),
      'LEGACY_CLOSED_RECONCILIATION_REQUIRES_BACKFILL',
    )
    expect(() => db.prepare(`
      UPDATE reconcile_hospital_months SET status = 'pending' WHERE id = 'HM-LEGACY-CLOSED'
    `).run()).toThrow(/CLOSED_HOSPITAL_MONTH_IMMUTABLE/)

    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    expect(() => db.prepare(`
      UPDATE reconcile_hospital_months SET status = 'pending' WHERE id = 'HM-LEGACY-CLOSED'
    `).run()).toThrow(/CLOSED_HOSPITAL_MONTH_IMMUTABLE/)
  })

  it('freezes decision facts at complete and close revalidates the completion hash', () => {
    const binding = seedSource({ name: 'decision-freeze', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const diff = db.prepare(
      'SELECT * FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(snapshot.hospitalMonthId) as any
    db.prepare(`
      UPDATE reconcile_diffs
      SET verdict = '漏收，需要补收', verdict_reason = 'R2 reviewed',
          verdict_by = 'USER-001', verdict_at = CURRENT_TIMESTAMP, follow_up = 'supplement'
      WHERE id = ?
    `).run(diff.id)
    db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, case_no, amount, case_count,
         status, operator, review_status, submitted_by)
      VALUES ('SO-R2-DECISION', ?, ?, ?, ?, 100, 1, '待补收', 'USER-001',
              'pending_review', 'USER-001')
    `).run(binding.partnerId, binding.settlementMonth, diff.id, diff.case_no)

    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    const completed = db.prepare(`
      SELECT completion_artifact_json, completion_artifact_hash
      FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId) as any
    expect(completed.completion_artifact_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.parse(completed.completion_artifact_json).decisions).toHaveLength(1)
    expect(() => db.prepare(`
      UPDATE reconcile_diffs SET verdict_reason = 'tampered' WHERE id = ?
    `).run(diff.id)).toThrow(/FINAL_RECONCILIATION_DECISIONS_IMMUTABLE/)

    db.exec('DROP TRIGGER trg_reconcile_diff_final_immutable')
    db.prepare('UPDATE reconcile_diffs SET verdict_reason = ? WHERE id = ?').run('tampered', diff.id)
    expectCode(
      () => lifecycle.closeAccountReconciliation(db, binding, 'USER-001'),
      'DECISION_SET_CHANGED',
    )
    expect(lifecycle.readAccountReconciliation(db, binding).status).toBe('complete')
    manager.upgradeAccountReconciliationSchema(db)
  })
})

describe('LOC-005 R2 lock-time actor and connection safety', () => {
  it('revalidates active account_reconcile:W for compute, complete, and close', () => {
    const computeBinding = seedSource({ name: 'revoked-compute' })
    setAdminActive(false)
    try {
      expectCode(
        () => lifecycle.computeAccountReconciliation(db, computeBinding, 'USER-001'),
        'ACTOR_PERMISSION_REVOKED',
      )
    } finally {
      setAdminActive(true)
    }

    const completeBinding = seedSource({ name: 'revoked-complete' })
    lifecycle.computeAccountReconciliation(db, completeBinding, 'USER-001')
    setAdminActive(false)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, completeBinding, 'USER-001'),
        'ACTOR_PERMISSION_REVOKED',
      )
    } finally {
      setAdminActive(true)
    }
    expect(lifecycle.readAccountReconciliation(db, completeBinding).status).toBe('pending')

    const closeBinding = seedSource({ name: 'revoked-close' })
    lifecycle.computeAccountReconciliation(db, closeBinding, 'USER-001')
    lifecycle.completeAccountReconciliation(db, closeBinding, 'USER-001')
    setAdminActive(false)
    try {
      expectCode(
        () => lifecycle.closeAccountReconciliation(db, closeBinding, 'USER-001'),
        'ACTOR_PERMISSION_REVOKED',
      )
    } finally {
      setAdminActive(true)
    }
    expect(lifecycle.readAccountReconciliation(db, closeBinding).status).toBe('complete')

    const denialRows = db.prepare(`
      SELECT action, detail, operator FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND action LIKE '%_denied'
      ORDER BY created_at, id
    `).all() as any[]
    expect(denialRows.map(row => row.action).sort()).toEqual([
      'close_generation_denied',
      'complete_generation_denied',
      'compute_generation_denied',
    ])
    for (const row of denialRows) {
      expect(row.operator).toBe('USER-001')
      expect(Object.keys(JSON.parse(row.detail)).sort()).toEqual([
        'partnerId',
        'reasonCode',
        'reconcileGenerationId',
        'settlementMonth',
      ])
    }
  })

  it('invalidates a shared handle when ROLLBACK fails, leaves no partial, and retries on replacement', () => {
    const binding = seedSource({ name: 'rollback-command-failure' })
    const failedHandle = db
    const originalExec = failedHandle.exec.bind(failedHandle)
    failedHandle.exec = (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('INJECTED_ROLLBACK_COMMAND_FAILURE')
      return originalExec(sql)
    }

    expect(() => lifecycle.computeAccountReconciliation(
      failedHandle,
      binding,
      'USER-001',
      { at: 'afterBusiness' },
    )).toThrow(/INJECTED_RECONCILIATION_FAULT:afterBusiness/)

    db = manager.getDatabase()
    const replaced = db !== failedHandle
    expect(replaced).toBe(true)
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId).n).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND target_id = ?
    `).get(binding.reconcileGenerationId).n).toBe(0)
    expect(lifecycle.computeAccountReconciliation(db, binding, 'USER-001')).toMatchObject({
      reconcileGenerationId: binding.reconcileGenerationId,
      status: 'pending',
    })
  })
})
