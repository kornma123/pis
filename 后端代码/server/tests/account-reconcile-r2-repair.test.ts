import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

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
    revenueSource?: string
    revenueCanonical?: string
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
  const revenueSource = options.revenueSource ?? 'statement'

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
    VALUES (?, ?, ?, ?, 100, 100, ?, ?)
  `).run(`REV-${suffix}`, caseNo, partnerId, month, revenueAmount, revenueSource)
  if (options.revenueCanonical !== undefined) {
    db.prepare('UPDATE case_revenue SET lab_revenue_canonical = ? WHERE id = ?')
      .run(options.revenueCanonical, `REV-${suffix}`)
  }

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

function expectDatabaseMutationBlocked(
  connection: DatabaseSync,
  mutation: () => unknown,
  expected: RegExp,
): void {
  connection.exec('SAVEPOINT loc005_mutation_probe')
  let caught: unknown
  try {
    mutation()
  } catch (error) {
    caught = error
  } finally {
    connection.exec('ROLLBACK TO loc005_mutation_probe')
    connection.exec('RELEASE loc005_mutation_probe')
  }
  expect(caught).toBeInstanceOf(Error)
  expect(String(caught)).toMatch(expected)
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

  it.each(['estimated', 'unknown', 'other'])(
    'fails closed when confirmed revenue uses the %s source kind',
    (revenueSource) => {
      const binding = seedSource({ name: `bad-revenue-source-${revenueSource}`, revenueSource })
      lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, binding, 'USER-001'),
        'REVENUE_SOURCE_UNAVAILABLE',
      )
      expect(lifecycle.readAccountReconciliation(db, binding).status).toBe('pending')
    },
  )

  it('fails closed for a mixed canonical and estimated revenue set', () => {
    const binding = seedSource({ name: 'mixed-revenue-source' })
    db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
      VALUES ('REV-ESTIMATED-MIXED', 'CASE-ESTIMATED-MIXED', ?, ?, 1, 1, 1, 'estimated')
    `).run(binding.partnerId, binding.settlementMonth)

    lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    expectCode(
      () => lifecycle.completeAccountReconciliation(db, binding, 'USER-001'),
      'REVENUE_SOURCE_UNAVAILABLE',
    )
  })

  it('accepts the DECIMAL(18,4) scaled-safe boundary and rejects the next unit', () => {
    const accepted = seedSource({
      name: 'scaled-safe-accepted',
      revenueAmount: 900719925474.0991,
      revenueCanonical: '900719925474.0991',
    })
    lifecycle.computeAccountReconciliation(db, accepted, 'USER-001')
    expect(lifecycle.completeAccountReconciliation(db, accepted, 'USER-001'))
      .toMatchObject({ confirmedLabRevenue: 900719925474.0991 })

    const rejected = seedSource({
      name: 'scaled-safe-rejected',
      revenueAmount: 900719925474.0992,
    })
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, rejected, 'USER-001'),
      'REVENUE_AMOUNT_UNAVAILABLE',
    )
  })

  it('rejects a high-value fifth decimal before Number rounding can erase it', () => {
    expectCode(
      () => lifecycle.canonicalReconciliationAmount(
        900719925474.09915,
        'REVENUE_AMOUNT_UNAVAILABLE',
        'high-value fifth decimal',
      ),
      'REVENUE_AMOUNT_UNAVAILABLE',
    )
  })

  it('rejects a high-value fifth decimal through the persisted revenue entry', () => {
    const binding = seedSource({
      name: 'high-fifth-decimal-entry',
      revenueAmount: 900719925474.09915,
      revenueCanonical: '900719925474.09915',
    })
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, binding, 'USER-001'),
      'REVENUE_AMOUNT_UNAVAILABLE',
    )
  })

  it('rejects the SQLite REAL fifth-decimal counterexample without magnitude epsilon', () => {
    expectCode(
      () => lifecycle.canonicalReconciliationAmount(
        200000000000.00006,
        'REVENUE_AMOUNT_UNAVAILABLE',
        'SQLite REAL fifth decimal',
      ),
      'REVENUE_AMOUNT_UNAVAILABLE',
    )
    expect(lifecycle.canonicalReconciliationAmount(
      200000000000.0001,
      'REVENUE_AMOUNT_UNAVAILABLE',
      'SQLite REAL canonical four decimals',
    )).toBe(200000000000.0001)
  })

  it('rejects a persisted SQLite REAL fifth decimal in statement and revenue facts with zero generation write', () => {
    const statementBinding = seedSource({
      name: 'sqlite-real-fifth-statement',
      amount: 200000000000.00006,
      revenueAmount: 100,
    })
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, statementBinding, 'USER-001'),
      'NON_CANONICAL_STATEMENT_AMOUNT',
    )
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).get(statementBinding.reconcileGenerationId).n)).toBe(0)

    const revenueBinding = seedSource({
      name: 'sqlite-real-fifth-revenue',
      revenueAmount: 200000000000.00006,
    })
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, revenueBinding, 'USER-001'),
      'REVENUE_AMOUNT_UNAVAILABLE',
    )
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).get(revenueBinding.reconcileGenerationId).n)).toBe(0)
  })

  it('accepts the persisted SQLite REAL canonical four-decimal counterpart', () => {
    const binding = seedSource({
      name: 'sqlite-real-four-decimal',
      revenueAmount: 200000000000.0001,
    })
    lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    expect(lifecycle.completeAccountReconciliation(db, binding, 'USER-001'))
      .toMatchObject({ status: 'complete', confirmedLabRevenue: 200000000000.0001 })
  })

  it.each([
    ['decision', 'reconcile_diffs'],
    ['supplement', 'supplement_orders'],
  ])('rejects a persisted SQLite REAL fifth decimal in the %s completion artifact', (_label, table) => {
    const binding = seedSource({ name: `sqlite-real-fifth-${_label}`, lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      binding,
      diff.id,
      '漏收，需补收',
      null,
      'USER-001',
      'admin',
    )
    if (table === 'reconcile_diffs') {
      db.prepare('UPDATE reconcile_diffs SET amount_impact = ? WHERE id = ?')
        .run(200000000000.00006, diff.id)
    } else {
      db.prepare('UPDATE supplement_orders SET amount = ? WHERE source_diff_id = ?')
        .run(200000000000.00006, diff.id)
    }

    expectCode(
      () => lifecycle.completeAccountReconciliation(db, binding, 'USER-001'),
      'NON_CANONICAL_DECISION_AMOUNT',
    )
    expect(db.prepare(`
      SELECT status, completion_artifact_json, completion_artifact_hash
        FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId)).toMatchObject({
      status: 'pending',
      completion_artifact_json: null,
      completion_artifact_hash: null,
    })
  })

  it('accepts corrected revenue as canonical', () => {
    const binding = seedSource({ name: 'corrected-revenue', revenueSource: 'corrected' })
    lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    expect(lifecycle.completeAccountReconciliation(db, binding, 'USER-001'))
      .toMatchObject({ status: 'complete', confirmedLabRevenue: 100 })
  })

  it.each([
    ['precision > 4', 1.00001],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['text', '1.0000'],
    ['object', { value: 1 }],
    ['array', [1]],
  ])('rejects %s at the production DECIMAL(18,4) boundary', (_label, value) => {
    expectCode(
      () => lifecycle.canonicalReconciliationAmount(
        value,
        'NON_CANONICAL_STATEMENT_AMOUNT',
        `mutation ${_label}`,
      ),
      'NON_CANONICAL_STATEMENT_AMOUNT',
    )
  })

  it.each([
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['text', '1'],
    ['object', { value: 1 }],
    ['array', [1]],
  ])('rejects %s at the production count boundary', (_label, value) => {
    expectCode(
      () => lifecycle.canonicalReconciliationCount(value, `mutation ${_label}`),
      'LIS_SOURCE_UNAVAILABLE',
    )
  })
})

describe('LOC-005 R2 verdict generation transaction and lineage', () => {
  it('rejects a stale diff after another connection supersedes its generation', () => {
    const binding = seedSource({ name: 'verdict-stale-double-connection', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const staleDiff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    const successAuditBefore = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'verdict'
    `).get().n)

    const successor = {
      ...binding,
      reconcileGenerationId: `${binding.reconcileGenerationId}-SUCCESSOR`,
    }
    const secondConnection = new DatabaseSync(databasePath)
    secondConnection.exec('PRAGMA foreign_keys = ON')
    try {
      lifecycle.computeAccountReconciliation(secondConnection, successor, 'USER-001')
    } finally {
      secondConnection.close()
    }

    expectCode(
      () => lifecycle.setAccountReconciliationVerdict(
        db,
        binding,
        staleDiff.id,
        '漏收，需补收',
        null,
        'USER-001',
        'admin',
      ),
      'STALE_RECONCILE_GENERATION',
    )
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?
    `).get(staleDiff.id).n)).toBe(0)
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'verdict'
    `).get().n)).toBe(successAuditBefore)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each(['afterBusiness', 'beforeAudit', 'afterAudit', 'beforePostcondition', 'beforeCommit'] as const)(
    'rolls verdict, supplement, and success audit back at %s',
    (at) => {
      const binding = seedSource({ name: `verdict-fault-${at}`, lisCount: 2 })
      const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
      const diff = db.prepare(
        'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
      ).get(String(snapshot.hospitalMonthId)) as { id: string }

      expect(() => lifecycle.setAccountReconciliationVerdict(
        db,
        binding,
        diff.id,
        '漏收，需补收',
        null,
        'USER-001',
        'admin',
        { at },
      )).toThrow(`INJECTED_RECONCILIATION_FAULT:${at}`)
      expect(db.prepare('SELECT verdict FROM reconcile_diffs WHERE id = ?').get(diff.id).verdict).toBeNull()
      expect(Number(db.prepare(
        'SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?',
      ).get(diff.id).n)).toBe(0)
      expect(Number(db.prepare(`
        SELECT COUNT(*) AS n FROM abc_audit_logs
         WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
      `).get(diff.id).n)).toBe(0)
    },
  )

  it('revalidates actor permission under lock with zero success writes', () => {
    const binding = seedSource({ name: 'verdict-revoked', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    setAdminActive(false)
    try {
      expectCode(
        () => lifecycle.setAccountReconciliationVerdict(
          db,
          binding,
          diff.id,
          '漏收，需补收',
          null,
          'USER-001',
          'admin',
        ),
        'ACTOR_PERMISSION_REVOKED',
      )
    } finally {
      setAdminActive(true)
    }
    expect(db.prepare('SELECT verdict FROM reconcile_diffs WHERE id = ?').get(diff.id).verdict).toBeNull()
    expect(Number(db.prepare(
      'SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?',
    ).get(diff.id).n)).toBe(0)
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(diff.id).n)).toBe(0)
  })

  it('persists verifiable supplement foreign keys and generation binding across restart', () => {
    const binding = seedSource({ name: 'supplement-lineage-restart', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      binding,
      diff.id,
      '漏收，需补收',
      null,
      'USER-001',
      'admin',
    )
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(supplement_orders)').all() as Array<{
      from: string
      table: string
    }>
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'source_diff_id', table: 'reconcile_diffs' }),
      expect.objectContaining({
        from: 'reconcile_generation_id',
        table: 'account_reconcile_generations',
      }),
    ]))
    const supplement = db.prepare(`
      SELECT source_diff_id, reconcile_generation_id
        FROM supplement_orders WHERE source_diff_id = ?
    `).get(diff.id) as {
      source_diff_id: string
      reconcile_generation_id: string
    }
    expect(supplement).toEqual({
      source_diff_id: diff.id,
      reconcile_generation_id: binding.reconcileGenerationId,
    })

    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare(`
      SELECT source_diff_id, reconcile_generation_id
        FROM supplement_orders WHERE source_diff_id = ?
    `).get(diff.id)).toEqual(supplement)
    expect(() => db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id)
      VALUES ('SO-BAD-GENERATION', ?, ?, ?, 'WRONG-GENERATION')
    `).run(binding.partnerId, binding.settlementMonth, diff.id))
      .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH|FOREIGN KEY constraint failed/)
  })

  it('rejects raw SQL with a source diff but no reconcile generation on a fresh schema', () => {
    const binding = seedSource({ name: 'supplement-null-generation', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }

    expect(() => db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id)
      VALUES ('SO-NULL-GENERATION', ?, ?, ?, NULL)
    `).run(binding.partnerId, binding.settlementMonth, diff.id))
      .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH|CHECK constraint failed/)
  })

  it('rejects a source-only raw supplement when its hospital-month has no generation, including after restart', () => {
    const binding = seedSource({ name: 'supplement-source-only-no-generation' })
    const hospitalMonthId = `HM-NO-GENERATION-${++sequence}`
    const diffId = `DIFF-NO-GENERATION-${sequence}`
    db.prepare(`
      INSERT INTO reconcile_hospital_months
        (id, partner_id, partner_name, service_month)
      VALUES (?, ?, 'No generation partner', ?)
    `).run(hospitalMonthId, binding.partnerId, binding.settlementMonth)
    db.prepare(`
      INSERT INTO reconcile_diffs
        (id, hospital_month_id, partner_id, service_month, case_no, line_type)
      VALUES (?, ?, ?, ?, 'CASE-NO-GENERATION', '免疫组化')
    `).run(diffId, hospitalMonthId, binding.partnerId, binding.settlementMonth)

    expect(() => db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id)
      VALUES ('SO-NO-GENERATION-FRESH', ?, ?, ?, NULL)
    `).run(binding.partnerId, binding.settlementMonth, diffId))
      .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH|CHECK constraint failed/)
    expect(db.prepare(
      "SELECT id FROM supplement_orders WHERE id = 'SO-NO-GENERATION-FRESH'",
    ).get()).toBeUndefined()

    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()

    expect(() => db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id)
      VALUES ('SO-NO-GENERATION-RESTART', ?, ?, ?, NULL)
    `).run(binding.partnerId, binding.settlementMonth, diffId))
      .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH|CHECK constraint failed/)
    expect(db.prepare(
      "SELECT id FROM supplement_orders WHERE id = 'SO-NO-GENERATION-RESTART'",
    ).get()).toBeUndefined()
  })

  it('rejects rebinding a current supplement to a stale generation', () => {
    const binding = seedSource({ name: 'supplement-stale-update', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      binding,
      diff.id,
      '漏收，需补收',
      null,
      'USER-001',
      'admin',
    )
    const staleGenerationId = `${binding.reconcileGenerationId}-STALE`
    db.prepare(`
      INSERT INTO account_reconcile_generations
        (reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
         hospital_month_id, is_current, status, source_readiness_json, source_readiness_hash,
         statement_artifact_hash, snapshot_json, snapshot_hash)
      SELECT ?, partner_id, settlement_month, statement_generation_id,
             hospital_month_id, 0, 'pending', source_readiness_json, source_readiness_hash,
             statement_artifact_hash, snapshot_json, snapshot_hash
        FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).run(staleGenerationId, binding.reconcileGenerationId)

    expect(() => db.prepare(`
      UPDATE supplement_orders
         SET reconcile_generation_id = ?
       WHERE source_diff_id = ?
    `).run(staleGenerationId, diff.id))
      .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
  })

  it('rejects every non-lineage update of a supplement after its pending generation becomes stale, including after restart', () => {
    const binding = seedSource({ name: 'supplement-stale-non-lineage-update', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      binding,
      diff.id,
      '漏收，需补收',
      null,
      'USER-001',
      'admin',
    )
    db.prepare(`
      UPDATE account_reconcile_generations
         SET is_current = 0
       WHERE reconcile_generation_id = ?
    `).run(binding.reconcileGenerationId)

    const rejectStaleUpdates = (connection: DatabaseSync) => {
      expect(() => connection.prepare(`
        UPDATE supplement_orders SET amount = 99 WHERE source_diff_id = ?
      `).run(diff.id)).toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
      expect(() => connection.prepare(`
        UPDATE supplement_orders SET status = '已放弃' WHERE source_diff_id = ?
      `).run(diff.id)).toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
      expect(connection.prepare(`
        SELECT amount, status FROM supplement_orders WHERE source_diff_id = ?
      `).get(diff.id)).toMatchObject({ amount: 100, status: '待补收' })
    }

    rejectStaleUpdates(db)
    manager.closeDatabase()
    const restarted = new DatabaseSync(databasePath)
    restarted.exec('PRAGMA foreign_keys = ON')
    rejectStaleUpdates(restarted)
    restarted.prepare(`
      UPDATE account_reconcile_generations
         SET is_current = 1
       WHERE reconcile_generation_id = ?
    `).run(binding.reconcileGenerationId)
    restarted.close()
    manager.initializeDatabase()
    db = manager.getDatabase()
  })

  it('builds the completion artifact from supplements bound to the exact generation only', () => {
    const binding = seedSource({ name: 'supplement-artifact-generation', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      binding,
      diff.id,
      '漏收，需补收',
      null,
      'USER-001',
      'admin',
    )
    const currentSupplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(diff.id) as { id: string }
    const staleGenerationId = `${binding.reconcileGenerationId}-ARTIFACT-STALE`
    db.prepare(`
      INSERT INTO account_reconcile_generations
        (reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
         hospital_month_id, is_current, status, source_readiness_json, source_readiness_hash,
         statement_artifact_hash, snapshot_json, snapshot_hash)
      SELECT ?, partner_id, settlement_month, statement_generation_id,
             hospital_month_id, 0, 'pending', source_readiness_json, source_readiness_hash,
             statement_artifact_hash, snapshot_json, snapshot_hash
        FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).run(staleGenerationId, binding.reconcileGenerationId)

    let supplementIds: string[] = []
    try {
      const insertTrigger = db.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'trg_reconcile_supplement_generation_insert'
      `).get() as { sql: string }
      db.exec('DROP TRIGGER trg_reconcile_supplement_generation_insert')
      db.prepare(`
        INSERT INTO supplement_orders
          (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
           case_no, amount, case_count, submitted_by)
        SELECT 'SO-STALE-ARTIFACT', partner_id, service_month, source_diff_id, ?, case_no,
               amount, case_count, submitted_by
          FROM supplement_orders WHERE id = ?
      `).run(staleGenerationId, currentSupplement.id)
      db.exec(insertTrigger.sql)

      lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
      const completed = db.prepare(`
        SELECT completion_artifact_json FROM account_reconcile_generations
        WHERE reconcile_generation_id = ?
      `).get(binding.reconcileGenerationId) as { completion_artifact_json: string }
      supplementIds = JSON.parse(completed.completion_artifact_json).supplements
        .map((supplement: { id: string }) => supplement.id)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_no_delete')
      db.prepare("DELETE FROM supplement_orders WHERE id = 'SO-STALE-ARTIFACT'").run()
      manager.upgradeAccountReconciliationSchema(db)
    }
    expect(supplementIds).toEqual([currentSupplement.id])
  })

  it('fails a forward upgrade and every restart when a legacy diff cannot bind one current pending generation', () => {
    const binding = seedSource({ name: 'supplement-forward-fail', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      binding,
      diff.id,
      '漏收，需补收',
      null,
      'USER-001',
      'admin',
    )
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    const legacyHospitalMonthId = `HM-LEGACY-UNBINDABLE-${++sequence}`
    const legacyDiffId = `DIFF-LEGACY-UNBINDABLE-${sequence}`
    const legacyPartnerId = `PT-LEGACY-UNBINDABLE-${sequence}`
    db.prepare(`
      INSERT INTO reconcile_hospital_months
        (id, partner_id, partner_name, service_month)
      VALUES (?, ?, 'Legacy unbindable partner', '2026-11')
    `).run(legacyHospitalMonthId, legacyPartnerId)
    db.prepare(`
      INSERT INTO reconcile_diffs
        (id, hospital_month_id, partner_id, service_month, case_no, line_type)
      VALUES (?, ?, ?, '2026-11', ?, '免疫组化')
    `).run(
      legacyDiffId,
      legacyHospitalMonthId,
      legacyPartnerId,
      `CASE-LEGACY-UNBINDABLE-${sequence}`,
    )

    const upgradePath = join(testDirectory, `forward-upgrade-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(upgradePath)
    let legacy = new DatabaseSync(upgradePath)
    try {
      legacy.exec('PRAGMA foreign_keys = OFF')
      legacy.exec(`
        DROP TABLE supplement_orders;
        CREATE TABLE supplement_orders (
          id TEXT PRIMARY KEY,
          partner_id TEXT NOT NULL,
          service_month TEXT NOT NULL,
          source_diff_id TEXT,
          case_no TEXT,
          amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
          case_count INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT '待补收',
          collected_at DATETIME,
          collected_month TEXT,
          collected_revenue DECIMAL(18, 4),
          give_up_reason TEXT,
          operator TEXT,
          review_status TEXT NOT NULL DEFAULT 'pending_review',
          submitted_by TEXT,
          reviewed_by TEXT,
          reviewed_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(source_diff_id) REFERENCES reconcile_diffs(id) ON DELETE RESTRICT
        );
      `)
      legacy.prepare(`
        INSERT INTO supplement_orders
          (id, partner_id, service_month, source_diff_id, amount, case_count, submitted_by)
        VALUES ('SO-LEGACY-UNBINDABLE', ?, ?, ?, 1, 1, 'legacy')
      `).run(legacyPartnerId, '2026-11', legacyDiffId)
      legacy.exec('PRAGMA foreign_keys = ON')

      expect(() => manager.upgradeAccountReconciliationSchema(legacy))
        .toThrow(/SUPPLEMENT_SOURCE_GENERATION_BACKFILL_REQUIRED/)
      expect((legacy.prepare('PRAGMA table_info(supplement_orders)').all() as Array<{ name: string }>)
        .some(column => column.name === 'reconcile_generation_id')).toBe(false)
    } finally {
      legacy.close()
    }

    legacy = new DatabaseSync(upgradePath)
    try {
      legacy.exec('PRAGMA foreign_keys = ON')
      expect(() => manager.upgradeAccountReconciliationSchema(legacy))
        .toThrow(/SUPPLEMENT_SOURCE_GENERATION_BACKFILL_REQUIRED/)
      expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      legacy.close()
    }
  })

  it('upgrades a predecessor complete-month database: diff backfill runs after legacy trigger drop', () => {
    // R3-1：父版分支库（diffs 无代次列 + 父版终版冻结 trigger 对 complete/closed 月的任意
    // UPDATE 一律 ABORT）升级时，backfill UPDATE 必须排在旧 trigger DROP 之后，
    // 否则旧 trigger 把回填打死、升级事务回滚、每次开机都失败。
    const binding = seedSource({ name: 'predecessor-complete-upgrade', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      binding,
      diff.id,
      '漏收，需补收',
      null,
      'USER-001',
      'admin',
    )
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')

    const upgradePath = join(testDirectory, `predecessor-complete-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(upgradePath)
    let legacy = new DatabaseSync(upgradePath)
    try {
      legacy.exec('PRAGMA foreign_keys = OFF')
      // 回滚到父版形状：diffs 去掉代次列（父版无此列）。
      // 注意：supplement 侧 5 个 trigger 的子查询引用 reconcile_diffs，重建 diffs 表期间会悬空，
      // 故先摘掉；升级函数本就会在数据迁移前 DROP 全部旧 trigger、迁移后重装新版，
      // 且升级过程不写 supplement 行，这些 trigger 在升级路径上不参与点火。
      legacy.exec(`
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_insert;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_update;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_immutable;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_no_insert;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_no_delete;
        DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable;
        DROP TRIGGER IF EXISTS trg_reconcile_diff_final_no_insert;
        DROP TRIGGER IF EXISTS trg_reconcile_diff_final_no_delete;
        CREATE TABLE reconcile_diffs__parent_shape (
          id TEXT PRIMARY KEY,
          hospital_month_id TEXT NOT NULL,
          partner_id TEXT NOT NULL,
          service_month TEXT NOT NULL,
          case_no TEXT NOT NULL,
          line_type TEXT NOT NULL,
          bill_count DECIMAL(18, 4) NOT NULL DEFAULT 0,
          lis_count DECIMAL(18, 4) NOT NULL DEFAULT 0,
          delta DECIMAL(18, 4) NOT NULL DEFAULT 0,
          amount_impact DECIMAL(18, 4) NOT NULL DEFAULT 0,
          system_hint TEXT,
          low_confidence INTEGER NOT NULL DEFAULT 0,
          verdict TEXT,
          verdict_reason TEXT,
          verdict_by TEXT,
          verdict_at DATETIME,
          follow_up TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO reconcile_diffs__parent_shape (
          id, hospital_month_id, partner_id, service_month, case_no, line_type,
          bill_count, lis_count, delta, amount_impact, system_hint, low_confidence,
          verdict, verdict_reason, verdict_by, verdict_at, follow_up, created_at, updated_at
        )
        SELECT id, hospital_month_id, partner_id, service_month, case_no, line_type,
               bill_count, lis_count, delta, amount_impact, system_hint, low_confidence,
               verdict, verdict_reason, verdict_by, verdict_at, follow_up, created_at, updated_at
          FROM reconcile_diffs;
        DROP TABLE reconcile_diffs;
        ALTER TABLE reconcile_diffs__parent_shape RENAME TO reconcile_diffs;
      `)
      // 父版终版冻结三 trigger（对 complete/closed 月的 diff 任意写一律 ABORT，不区分列）。
      legacy.exec(`
        CREATE TRIGGER trg_reconcile_diff_final_immutable
        BEFORE UPDATE ON reconcile_diffs
        WHEN EXISTS (
          SELECT 1 FROM account_reconcile_generations generation
          WHERE generation.hospital_month_id = OLD.hospital_month_id
            AND generation.status IN ('complete', 'closed')
        )
        BEGIN
          SELECT RAISE(ABORT, 'FINAL_RECONCILIATION_DECISIONS_IMMUTABLE');
        END
      `)
      legacy.exec(`
        CREATE TRIGGER trg_reconcile_diff_final_no_insert
        BEFORE INSERT ON reconcile_diffs
        WHEN EXISTS (
          SELECT 1 FROM account_reconcile_generations generation
          WHERE generation.hospital_month_id = NEW.hospital_month_id
            AND generation.status IN ('complete', 'closed')
        )
        BEGIN
          SELECT RAISE(ABORT, 'FINAL_RECONCILIATION_DECISIONS_IMMUTABLE');
        END
      `)
      legacy.exec(`
        CREATE TRIGGER trg_reconcile_diff_final_no_delete
        BEFORE DELETE ON reconcile_diffs
        WHEN EXISTS (
          SELECT 1 FROM account_reconcile_generations generation
          WHERE generation.hospital_month_id = OLD.hospital_month_id
            AND generation.status IN ('complete', 'closed')
        )
        BEGIN
          SELECT RAISE(ABORT, 'FINAL_RECONCILIATION_DECISIONS_IMMUTABLE');
        END
      `)
      legacy.exec('PRAGMA foreign_keys = ON')

      // 升级必须成功（backfill 排在旧 trigger DROP 之后）。
      expect(() => manager.upgradeAccountReconciliationSchema(legacy)).not.toThrow()

      // 该院·月全部 diff 回填为当前代。
      const stamped = legacy.prepare(`
        SELECT DISTINCT reconcile_generation_id FROM reconcile_diffs
        WHERE hospital_month_id = ?
      `).all(String(snapshot.hospitalMonthId)) as Array<{ reconcile_generation_id: string }>
      expect(stamped).toEqual([{ reconcile_generation_id: binding.reconcileGenerationId }])

      // 终版冻结仍由重装的新 trigger 守护：complete 月 diff 的篡改 UPDATE 仍须被拒。
      expect(() => legacy.prepare(
        'UPDATE reconcile_diffs SET verdict = ? WHERE hospital_month_id = ?',
      ).run('篡改', String(snapshot.hospitalMonthId))).toThrow(/FINAL_RECONCILIATION_DECISIONS_IMMUTABLE/)
      expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      legacy.close()
    }

    // 重启幂等：同一库再跑一遍升级仍成功、状态不变。
    legacy = new DatabaseSync(upgradePath)
    try {
      legacy.exec('PRAGMA foreign_keys = ON')
      expect(() => manager.upgradeAccountReconciliationSchema(legacy)).not.toThrow()
      const stamped = legacy.prepare(`
        SELECT DISTINCT reconcile_generation_id FROM reconcile_diffs
        WHERE hospital_month_id = ?
      `).all(String(snapshot.hospitalMonthId)) as Array<{ reconcile_generation_id: string }>
      expect(stamped).toEqual([{ reconcile_generation_id: binding.reconcileGenerationId }])
    } finally {
      legacy.close()
    }
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

  it('hard-gates complete generation and hospital-month facts on fresh schema and restart', () => {
    const binding = seedSource({ name: 'complete-finality-fresh' })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    const hospitalMonthId = String(snapshot.hospitalMonthId)

    const assertFinality = (connection: DatabaseSync) => {
      const generationMutations = [
        'is_current = 0',
        "status = 'pending'",
        'completed_at = NULL',
        "completed_by = 'attacker'",
        'closed_at = CURRENT_TIMESTAMP',
      ]
      for (const assignment of generationMutations) {
        expectDatabaseMutationBlocked(
          connection,
          () => connection.prepare(`
            UPDATE account_reconcile_generations SET ${assignment}
             WHERE reconcile_generation_id = ?
          `).run(binding.reconcileGenerationId),
          /COMPLETE_RECONCILIATION_FINAL/,
        )
      }
      const hospitalMonthMutations = [
        "status = '待复核'",
        'completed_at = NULL',
        "completed_by = 'attacker'",
        'confirmed_lab_revenue = 0',
      ]
      for (const assignment of hospitalMonthMutations) {
        expectDatabaseMutationBlocked(
          connection,
          () => connection.prepare(`
            UPDATE reconcile_hospital_months SET ${assignment} WHERE id = ?
          `).run(hospitalMonthId),
          /COMPLETE_HOSPITAL_MONTH_FINAL/,
        )
      }
    }

    assertFinality(db)
    const successor = {
      ...binding,
      reconcileGenerationId: `${binding.reconcileGenerationId}-REVIVE`,
    }
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, successor, 'USER-001'),
      'RECONCILIATION_FINAL',
    )
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).get(successor.reconcileGenerationId).n)).toBe(0)

    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    assertFinality(db)
    expect(lifecycle.closeAccountReconciliation(db, binding, 'USER-001'))
      .toMatchObject({ status: 'closed' })
  })

  it('installs complete finality hard gates during predecessor upgrade and preserves them on restart', () => {
    const binding = seedSource({ name: 'complete-finality-upgrade' })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    const upgradePath = join(testDirectory, `complete-finality-upgrade-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(upgradePath)

    const assertUpgradedFinality = (connection: DatabaseSync) => {
      expectDatabaseMutationBlocked(
        connection,
        () => connection.prepare(`
          UPDATE account_reconcile_generations SET is_current = 0
           WHERE reconcile_generation_id = ?
        `).run(binding.reconcileGenerationId),
        /COMPLETE_RECONCILIATION_FINAL/,
      )
      expectDatabaseMutationBlocked(
        connection,
        () => connection.prepare(`
          UPDATE account_reconcile_generations SET status = 'pending'
           WHERE reconcile_generation_id = ?
        `).run(binding.reconcileGenerationId),
        /COMPLETE_RECONCILIATION_FINAL/,
      )
      expectDatabaseMutationBlocked(
        connection,
        () => connection.prepare(`
          UPDATE reconcile_hospital_months SET status = '待复核' WHERE id = ?
        `).run(String(snapshot.hospitalMonthId)),
        /COMPLETE_HOSPITAL_MONTH_FINAL/,
      )
    }

    let predecessor = new DatabaseSync(upgradePath)
    try {
      predecessor.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_complete_finality')
      predecessor.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_complete_finality')
      manager.upgradeAccountReconciliationSchema(predecessor)
      assertUpgradedFinality(predecessor)
    } finally {
      predecessor.close()
    }

    predecessor = new DatabaseSync(upgradePath)
    try {
      predecessor.exec('PRAGMA foreign_keys = ON')
      assertUpgradedFinality(predecessor)
    } finally {
      predecessor.close()
    }
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
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
         case_no, amount, case_count,
         status, operator, review_status, submitted_by)
      VALUES ('SO-R2-DECISION', ?, ?, ?, ?, ?, 100, 1, '待补收', 'USER-001',
              'pending_review', 'USER-001')
    `).run(
      binding.partnerId,
      binding.settlementMonth,
      diff.id,
      binding.reconcileGenerationId,
      diff.case_no,
    )

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
      'verdict_generation_denied',
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

describe('LOC-005 R2 respin — supplement lifecycle and governed regeneration', () => {
  it('allows supplement lifecycle updates while its generation stays current after complete and close', () => {
    const binding = seedSource({ name: 'supplement-lifecycle-after-final', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(diff.id) as { id: string }

    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')

    db.prepare(`
      UPDATE supplement_orders
         SET review_status = 'approved', reviewed_by = 'USER-002', reviewed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(supplement.id)
    db.prepare(`
      UPDATE supplement_orders
         SET status = '已补收', collected_at = CURRENT_TIMESTAMP, collected_month = '2026-09',
             collected_revenue = 100, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(supplement.id)
    db.prepare(`
      UPDATE supplement_orders
         SET status = '待补收', collected_at = NULL, collected_month = NULL,
             collected_revenue = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(supplement.id)
    db.prepare(`
      UPDATE supplement_orders
         SET status = '已放弃', give_up_reason = '确认无法收回', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(supplement.id)

    expect(() => db.prepare(
      'UPDATE supplement_orders SET amount = 999 WHERE id = ?',
    ).run(supplement.id)).toThrow(/FINAL_RECONCILIATION_DECISIONS_IMMUTABLE/)

    lifecycle.closeAccountReconciliation(db, binding, 'USER-001')
    db.prepare(`
      UPDATE supplement_orders
         SET status = '待补收', give_up_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(supplement.id)
    const persisted = db.prepare(
      'SELECT status, review_status FROM supplement_orders WHERE id = ?',
    ).get(supplement.id) as { status: string; review_status: string }
    expect(persisted).toMatchObject({ status: '待补收', review_status: 'approved' })
  })

  it('refuses to supersede a generation that still has open supplements with an explicit 409', () => {
    const binding = seedSource({ name: 'supersede-open-supplement', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const diffCountBefore = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)).n)

    const nextBinding = {
      ...binding,
      reconcileGenerationId: `${binding.reconcileGenerationId}-NEXT`,
    }
    expectCode(
      () => lifecycle.computeAccountReconciliation(db, nextBinding, 'USER-001'),
      'RECONCILE_GENERATION_HAS_OPEN_SUPPLEMENTS',
    )

    expect(db.prepare(`
      SELECT is_current, status FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId)).toMatchObject({ is_current: 1, status: 'pending' })
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(nextBinding.reconcileGenerationId).n)).toBe(0)
    expect(Number(db.prepare(
      'SELECT COUNT(*) AS n FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(String(snapshot.hospitalMonthId)).n)).toBe(diffCountBefore)
  })

  it('supersedes a generation whose supplements are all terminal, freezing them as history across restart', () => {
    const binding = seedSource({ name: 'supersede-terminal-supplement', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const hospitalMonthId = String(snapshot.hospitalMonthId)
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(diff.id) as { id: string }
    db.prepare(`
      UPDATE supplement_orders
         SET review_status = 'approved', reviewed_by = 'USER-002', reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(supplement.id)
    db.prepare(`
      UPDATE supplement_orders
         SET status = '已补收', collected_at = CURRENT_TIMESTAMP, collected_month = '2026-09',
             collected_revenue = 100
       WHERE id = ?
    `).run(supplement.id)

    const nextBinding = {
      ...binding,
      reconcileGenerationId: `${binding.reconcileGenerationId}-NEXT`,
    }
    const nextSnapshot = lifecycle.computeAccountReconciliation(db, nextBinding, 'USER-001') as any
    expect(nextSnapshot.status).toBe('pending')

    expect(db.prepare(`
      SELECT is_current, status FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId)).toMatchObject({ is_current: 0, status: 'pending' })
    expect(db.prepare(`
      SELECT is_current, status FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(nextBinding.reconcileGenerationId)).toMatchObject({ is_current: 1, status: 'pending' })

    const oldDiff = db.prepare(
      'SELECT reconcile_generation_id, verdict FROM reconcile_diffs WHERE id = ?',
    ).get(diff.id) as { reconcile_generation_id: string | null; verdict: string }
    expect(oldDiff.reconcile_generation_id).toBe(binding.reconcileGenerationId)
    expect(oldDiff.verdict).toBe('漏收，需补收')
    const nextDiffs = db.prepare(`
      SELECT id, reconcile_generation_id FROM reconcile_diffs
       WHERE hospital_month_id = ? AND reconcile_generation_id = ?
    `).all(hospitalMonthId, nextBinding.reconcileGenerationId) as Array<{
      id: string
      reconcile_generation_id: string
    }>
    expect(nextDiffs.length).toBe(1)
    expect(nextDiffs[0].id).not.toBe(diff.id)

    expectCode(
      () => lifecycle.setAccountReconciliationVerdict(
        db, nextBinding, diff.id, '核对无误', null, 'USER-001', 'admin',
      ),
      'STALE_RECONCILIATION_DIFF',
    )
    expect(() => db.prepare(
      `UPDATE supplement_orders SET status = '已放弃', give_up_reason = 'stale' WHERE id = ?`,
    ).run(supplement.id)).toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH/)

    lifecycle.setAccountReconciliationVerdict(
      db, nextBinding, nextDiffs[0].id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, nextBinding, 'USER-001')
    const completed = db.prepare(`
      SELECT completion_artifact_json FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(nextBinding.reconcileGenerationId) as { completion_artifact_json: string }
    const artifact = JSON.parse(completed.completion_artifact_json) as {
      decisions: Array<{ id: string }>
    }
    expect(artifact.decisions.map(decision => decision.id)).toEqual([nextDiffs[0].id])

    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    expect(db.prepare(`
      SELECT is_current FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId)).toMatchObject({ is_current: 0 })
    expect(() => db.prepare(
      `UPDATE supplement_orders SET amount = 100 WHERE id = ?`,
    ).run(supplement.id)).toThrow(/FINAL_RECONCILIATION_DECISIONS_IMMUTABLE|SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
  })

  it('rejects confirmed revenue totals beyond the scaled safe-integer boundary at compute without leaving a generation', () => {
    const binding = seedSource({
      name: 'revenue-total-overflow',
      lisCount: 1,
      revenueAmount: 600000000000,
      revenueCanonical: '600000000000.0000',
    })
    db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
      VALUES (?, ?, ?, ?, 600000000000, 600000000000, 600000000000, 'statement')
    `).run(`REV-EXTRA-${binding.partnerId}`, `CASE-EXTRA-${binding.partnerId}`,
      binding.partnerId, binding.settlementMonth)
    db.prepare('UPDATE case_revenue SET lab_revenue_canonical = ? WHERE id = ?')
      .run('600000000000.0000', `REV-EXTRA-${binding.partnerId}`)

    expectCode(
      () => lifecycle.computeAccountReconciliation(db, binding, 'USER-001'),
      'REVENUE_AMOUNT_UNAVAILABLE',
    )
    expect(Number(db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId).n)).toBe(0)
  })
})

describe('LOC-005 R4 lineage hard-gate closure', () => {
  // R4 夹具：G1 漏收认定 → 补收单走完「已补收」终结 → supersede 出 G2(当前 pending)。
  // 旧代 diff 因被终结补收单引用而在 supersede 中存活（compute 只删无引用 diff），
  // 形成「同院·同月·不同代」的存活 diff ——跨代绑定攻击的对象。
  function seedSupersededWithSurvivingDiff(name: string) {
    const binding = seedSource({ name, lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const hospitalMonthId = String(snapshot.hospitalMonthId)
    const oldDiff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, oldDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const oldSupplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(oldDiff.id) as { id: string }
    db.prepare(`
      UPDATE supplement_orders
         SET review_status = 'approved', reviewed_by = 'USER-002', reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(oldSupplement.id)
    db.prepare(`
      UPDATE supplement_orders
         SET status = '已补收', collected_at = CURRENT_TIMESTAMP, collected_month = '2026-09',
             collected_revenue = 100
       WHERE id = ?
    `).run(oldSupplement.id)
    const nextBinding = {
      ...binding,
      reconcileGenerationId: `${binding.reconcileGenerationId}-NEXT`,
    }
    lifecycle.computeAccountReconciliation(db, nextBinding, 'USER-001')
    const nextDiff = db.prepare(`
      SELECT id FROM reconcile_diffs
       WHERE hospital_month_id = ? AND reconcile_generation_id = ?
    `).get(hospitalMonthId, nextBinding.reconcileGenerationId) as { id: string }
    return { binding, nextBinding, hospitalMonthId, oldDiff, nextDiff, oldSupplement }
  }

  // 绕过 insert trigger 造出一行错配单（旧代 diff + 当前代），模拟未来写路径/回填工具缺陷；
  // 返回触发器原文以便调用后原样重装（文本运行时从 sqlite_master 读取，含 R4 修复）。
  function injectLineageMismatch(rowId: string, oldDiffId: string, generationId: string, templateSupplementId: string): void {
    const insertTrigger = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'trg_reconcile_supplement_generation_insert'
    `).get() as { sql: string }
    db.exec('DROP TRIGGER trg_reconcile_supplement_generation_insert')
    db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
         case_no, amount, case_count, submitted_by)
      SELECT ?, partner_id, service_month, ?, ?, case_no, amount, case_count, submitted_by
        FROM supplement_orders WHERE id = ?
    `).run(rowId, oldDiffId, generationId, templateSupplementId)
    db.exec(insertTrigger.sql)
  }

  it('rejects binding a current-generation supplement to a superseded-generation diff', () => {
    const fixture = seedSupersededWithSurvivingDiff('r4-cross-generation-insert')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        INSERT INTO supplement_orders
          (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
           case_no, amount, case_count, submitted_by)
        SELECT 'SO-R4-CROSS-INSERT', partner_id, service_month, ?, ?, case_no,
               amount, case_count, submitted_by
          FROM supplement_orders WHERE id = ?
      `).run(fixture.oldDiff.id, fixture.nextBinding.reconcileGenerationId, fixture.oldSupplement.id)
    }, /SUPPLEMENT_GENERATION_BINDING_MISMATCH/)

    // 同代对照：同样的裸 SQL 绑定「本代 diff + 本代」必须仍然放行（守卫不误伤合法写入）。
    db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
         case_no, amount, case_count, submitted_by)
      SELECT 'SO-R4-SAME-GEN-CONTROL', partner_id, service_month, ?, ?, case_no,
             amount, case_count, submitted_by
        FROM supplement_orders WHERE id = ?
    `).run(fixture.nextDiff.id, fixture.nextBinding.reconcileGenerationId, fixture.oldSupplement.id)
    db.prepare("DELETE FROM supplement_orders WHERE id = 'SO-R4-SAME-GEN-CONTROL'").run()
  })

  it('rejects rebinding a current supplement onto a superseded-generation diff', () => {
    const fixture = seedSupersededWithSurvivingDiff('r4-cross-generation-update')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const nextSupplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }

    // NEW 侧：把当前代补收单改绑到旧代 diff。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE supplement_orders SET source_diff_id = ? WHERE id = ?')
        .run(fixture.oldDiff.id, nextSupplement.id)
    }, /SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
  })

  it('freezes every update of a lineage-mismatched supplement row', () => {
    const fixture = seedSupersededWithSurvivingDiff('r4-mismatched-row-freeze')
    injectLineageMismatch(
      'SO-R4-MISMATCH',
      fixture.oldDiff.id,
      fixture.nextBinding.reconcileGenerationId,
      fixture.oldSupplement.id,
    )
    try {
      // OLD 侧：错配行一旦存在，任何 UPDATE（含收款/放弃等生命周期写）一律被拒。
      expectDatabaseMutationBlocked(db, () => {
        db.prepare("UPDATE supplement_orders SET amount = 88 WHERE id = 'SO-R4-MISMATCH'").run()
      }, /SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
      expectDatabaseMutationBlocked(db, () => {
        db.prepare("UPDATE supplement_orders SET status = '已补收', collected_revenue = 88 WHERE id = 'SO-R4-MISMATCH'").run()
      }, /SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
    } finally {
      db.prepare("DELETE FROM supplement_orders WHERE id = 'SO-R4-MISMATCH'").run()
    }
  })

  it('fails startup validation and every retry when a supplement lineage-mismatches its source diff generation', () => {
    const fixture = seedSupersededWithSurvivingDiff('r4-startup-lineage-probe')
    const probePath = join(testDirectory, `r4-lineage-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const probe = new DatabaseSync(probePath)
    try {
      probe.exec('DROP TRIGGER trg_reconcile_supplement_generation_insert')
      probe.prepare(`
        INSERT INTO supplement_orders
          (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
           case_no, amount, case_count, submitted_by)
        SELECT 'SO-R4-STARTUP', partner_id, service_month, ?, ?, case_no,
               amount, case_count, submitted_by
          FROM supplement_orders WHERE id = ?
      `).run(fixture.oldDiff.id, fixture.nextBinding.reconcileGenerationId, fixture.oldSupplement.id)

      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH:SO-R4-STARTUP/)
      // fail-closed 稳定：库未被升级事务污染、外键检查为空、重试仍拒。
      expect(probe.prepare('PRAGMA foreign_key_check').all().length).toBe(0)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH:SO-R4-STARTUP/)
    } finally {
      probe.close()
    }
  })

  it('fails complete while a bound supplement lineage-mismatches the generation fact set', () => {
    const fixture = seedSupersededWithSurvivingDiff('r4-complete-lineage-guard')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    injectLineageMismatch(
      'SO-R4-COMPLETE',
      fixture.oldDiff.id,
      fixture.nextBinding.reconcileGenerationId,
      fixture.oldSupplement.id,
    )
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      db.prepare("DELETE FROM supplement_orders WHERE id = 'SO-R4-COMPLETE'").run()
    }

    // 清掉错配行后同一代 complete 必须成功（纵深守卫不误伤正常关账链）。
    lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    expect(db.prepare(`
      SELECT status FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(fixture.nextBinding.reconcileGenerationId)).toMatchObject({ status: 'complete' })
    const completed = db.prepare(`
      SELECT completion_artifact_json FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(fixture.nextBinding.reconcileGenerationId) as { completion_artifact_json: string }
    const artifact = JSON.parse(completed.completion_artifact_json) as {
      decisions: Array<{ id: string }>
      supplements: Array<{ id: string, sourceDiffId: string }>
    }
    expect(artifact.decisions.map(decision => decision.id)).toEqual([fixture.nextDiff.id])
    expect(artifact.supplements.map(supplement => supplement.id)).toEqual([])
  })
})
