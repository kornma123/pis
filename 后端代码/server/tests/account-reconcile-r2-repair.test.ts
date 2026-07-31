import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

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
let VERDICT_REASONS: readonly string[]
let db: any
let sequence = 0

// UDF 是 SQLite 连接级状态：凡会在已安装 trigger 上写入的 raw 测试连接一律经本包装器
//（new DatabaseSync 后立即注册 coreone_completion_artifact_valid，同名幂等替换），
// 防止合法测试写入因连接未注册报 no such function 而失真。
// 唯一例外：「raw probe upgrade→write 注册证明」用例必须直接 new DatabaseSync、
// 先 upgrade 再写，不得经本包装器预注册掩盖 upgrade 头部单一注册入口。
function openRegisteredTestDatabase(location: string): DatabaseSync {
  const connection = new DatabaseSync(location)
  manager.registerCoreoneSqlFunctions(connection)
  return connection
}

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

// R4/R5 共用夹具：G1 漏收认定 → 补收单走完「已补收」终结 → supersede 出 G2(当前 pending)。
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

beforeAll(async () => {
  manager = await import('../src/database/DatabaseManager.js')
  lifecycle = await import('../src/services/account-reconciliation-lifecycle.js')
  VERDICT_REASONS = (await import('../src/utils/reconcile-account.js')).VERDICT_REASONS
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
    const secondConnection = openRegisteredTestDatabase(databasePath)
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
    const restarted = openRegisteredTestDatabase(databasePath)
    restarted.exec('PRAGMA foreign_keys = ON')
    rejectStaleUpdates(restarted)
    // #87：is_current 0→1 复活已被 trg_account_reconcile_pending_state_guard 拒绝
    //（应用无任何复活流，直写复活=攻击形状）。此处是夹具恢复而非业务流，摘 guard 恢复；
    // 紧随的 initializeDatabase 经升级函数 DROP+CREATE 重装全部 trigger（含本 guard）。
    restarted.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_pending_state_guard')
    restarted.prepare(`
      UPDATE account_reconcile_generations
         SET is_current = 1
       WHERE reconcile_generation_id = ?
    `).run(binding.reconcileGenerationId)
    restarted.close()
    manager.initializeDatabase()
    db = manager.getDatabase()
  })

  it('rejects completion while a stale-generation supplement references the fact set, then completes cleanly after governed cleanup', () => {
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

      // R5 语义强化：反向错配（旧代单 → 本代 diff）不再是「静默过滤出 artifact」，
      // 而是与正向同权——complete fail-closed 拒绝定版，绝不产出 decisions/supplements 内部不一致的 artifact。
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, binding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_no_delete')
      db.prepare("DELETE FROM supplement_orders WHERE id = 'SO-STALE-ARTIFACT'").run()
      manager.upgradeAccountReconciliationSchema(db)
    }

    // 治理清理后 complete 成功，artifact 精确只含本代补收单（原「exact generation only」纯度断言保留）。
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    const completed = db.prepare(`
      SELECT completion_artifact_json FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId) as { completion_artifact_json: string }
    const supplementIds = JSON.parse(completed.completion_artifact_json).supplements
      .map((supplement: { id: string }) => supplement.id)
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
    let legacy = openRegisteredTestDatabase(upgradePath)
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

    legacy = openRegisteredTestDatabase(upgradePath)
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
    let legacy = openRegisteredTestDatabase(upgradePath)
    try {
      legacy.exec('PRAGMA foreign_keys = OFF')
      // 回滚到父版形状：diffs 去掉代次列（父版无此列）。
      // 注意：supplement 侧 5 个 trigger 的子查询引用 reconcile_diffs，重建 diffs 表期间会悬空，
      // 故先摘掉；升级函数本就会在数据迁移前 DROP 全部旧 trigger、迁移后重装新版，
      // 且升级过程不写 supplement 行，这些 trigger 在升级路径上不参与点火。
      // P1 事实集封存后，complete_finality / pending_state_guard 的期望事实子查询同样
      // 引用 reconcile_diffs——DROP TABLE/RENAME 会让 SQLite 重解析全部 trigger 体，
      // 悬空即「error in trigger: no such table」，故与 supplement 侧一并先摘除。
      legacy.exec(`
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_insert;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_update;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_immutable;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_no_insert;
        DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_no_delete;
        DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable;
        DROP TRIGGER IF EXISTS trg_reconcile_diff_final_no_insert;
        DROP TRIGGER IF EXISTS trg_reconcile_diff_final_no_delete;
        DROP TRIGGER IF EXISTS trg_account_reconcile_complete_finality;
        DROP TRIGGER IF EXISTS trg_account_reconcile_pending_state_guard;
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
    legacy = openRegisteredTestDatabase(upgradePath)
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
    // #93-A 起终态直插只能经 trigger 被摘窗口构造（生产等价：闸落地后唯一注入路径；
    // 本夹具模拟的就是 predecessor 遗留的无绑定终态行，测试意图不变）。
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_pending_insert_shape')
    db.prepare(`
      INSERT INTO reconcile_hospital_months
        (id, partner_id, partner_name, service_month, status, closed_at, closed_by)
      VALUES ('HM-LEGACY-CLOSED', ?, 'Legacy partner', ?, 'legacy-closed', CURRENT_TIMESTAMP, 'legacy-user')
    `).run(binding.partnerId, binding.settlementMonth)
    manager.upgradeAccountReconciliationSchema(db)

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

    let predecessor = openRegisteredTestDatabase(upgradePath)
    try {
      predecessor.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_complete_finality')
      predecessor.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_complete_finality')
      manager.upgradeAccountReconciliationSchema(predecessor)
      assertUpgradedFinality(predecessor)
    } finally {
      predecessor.close()
    }

    predecessor = openRegisteredTestDatabase(upgradePath)
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
      SET verdict = '漏收，需补收', verdict_reason = 'R2 reviewed',
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
    // P1 事实集封存：被篡改的决定事实使 stored artifact ≠ 当前事实集——开机扫描与
    // close 的 hash 重算同权 fail-closed（真实不变量升级，非新增松动）。
    expect(() => manager.upgradeAccountReconciliationSchema(db)).toThrow(
      new RegExp(`RECONCILE_GENERATION_COMPLETION_MALFORMED:${binding.reconcileGenerationId}`),
    )
    // 恢复事实（手动摘窗期内可写），随后 upgrade 重装全部闸并转绿——共享库零污染，
    // 后续用例的 boot/upgrade 不继承本例的篡改行。
    db.prepare('UPDATE reconcile_diffs SET verdict_reason = ? WHERE id = ?').run('R2 reviewed', diff.id)
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
  // seedSupersededWithSurvivingDiff 已提升到文件级（R5 describe 共用）。

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
    const probe = openRegisteredTestDatabase(probePath)
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

describe('LOC-005 R5 lineage guard direction closure and stale-delete freeze', () => {
  // R5 反向注入：pending 窗口无任何 trigger 拦 diff 的代次改写（trg_reconcile_diff_final_*
  // 只在月内有 complete/closed 代时生效）——把存活旧代 diff 的代次直接改写成当前代，
  // 即造出复核者指出的反向形状：旧代补收单(gen=G1) → diff(gen=G2)。
  function rewriteDiffGeneration(diffId: string, generationId: string): void {
    db.prepare('UPDATE reconcile_diffs SET reconcile_generation_id = ? WHERE id = ?')
      .run(generationId, diffId)
  }

  it('rejects complete when a stale-generation supplement references a current-generation diff (inverse mismatch)', () => {
    const fixture = seedSupersededWithSurvivingDiff('r5-inverse-complete')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    // R6 起 diff 身份列由 trg_reconcile_diff_identity_immutable 冻结——摘掉它模拟
    // DDL 级攻击者，验证守卫层独立于 trigger 兜底（清理段统一重装）。
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
    rewriteDiffGeneration(fixture.oldDiff.id, fixture.nextBinding.reconcileGenerationId)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      // 共享库必须复原。RED 态下若 complete 竟成功，月内已出现 complete 代、
      // diff 终版 trigger 会拦恢复——先摘再恢复，最后走升级函数统一重装+启动探针自检。
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable')
      rewriteDiffGeneration(fixture.oldDiff.id, fixture.binding.reconcileGenerationId)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('rejects close when the inverse mismatch is injected after completion', () => {
    const fixture = seedSupersededWithSurvivingDiff('r5-inverse-close')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    // complete 后 trg_reconcile_diff_final_immutable 会拦 diff UPDATE——绕过它注入
    // （直接 SQL 攻击者的等价能力），验证 artifact 守卫独立于 trigger 兜底：
    // close 重建 artifact 时守卫先于 hash 比对 fail-closed。
    const diffTrigger = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'trg_reconcile_diff_final_immutable'
    `).get() as { sql: string }
    db.exec('DROP TRIGGER trg_reconcile_diff_final_immutable')
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
    rewriteDiffGeneration(fixture.oldDiff.id, fixture.nextBinding.reconcileGenerationId)
    db.exec(diffTrigger.sql)
    try {
      expectCode(
        () => lifecycle.closeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable')
      rewriteDiffGeneration(fixture.oldDiff.id, fixture.binding.reconcileGenerationId)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('does not flag consistent stale pairs and completes with only exact-generation supplements in the artifact', () => {
    // 反向候选集的误伤对照：一致旧代对（S→D 同为 G1）不属于本代事实集、不得候选；
    // G2 complete 成功且 artifact 精确只含 G2 补收单。
    const fixture = seedSupersededWithSurvivingDiff('r5-consistent-stale-pair')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const nextSupplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    const completed = db.prepare(`
      SELECT completion_artifact_json FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(fixture.nextBinding.reconcileGenerationId) as { completion_artifact_json: string }
    const artifact = JSON.parse(completed.completion_artifact_json) as {
      supplements: Array<{ id: string, sourceDiffId: string }>
    }
    expect(artifact.supplements.map(supplement => supplement.id)).toEqual([nextSupplement.id])
  })

  it('rejects deleting a terminated supplement of a superseded generation before the successor completes', () => {
    // P2（继承债）：旧 no_delete 只在「diff 所在月有 complete/closed 代」时拒删——
    // supersede 后 successor 完成前的窗口内旧代终结单可被 DELETE（毁审计痕 + 旧 diff
    // 变无引用后被 compute 连删）。修复后按 OLD 所在代直判：is_current=0 即拒删。
    const fixture = seedSupersededWithSurvivingDiff('r5-stale-delete-window')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('DELETE FROM supplement_orders WHERE id = ?').run(fixture.oldSupplement.id)
    }, /FINAL_RECONCILIATION_DECISIONS_IMMUTABLE/)
  })

  it('keeps the current-generation supplement revoke path deletable (verdict scoped-DELETE control)', () => {
    // 不误伤对照：应用层唯一 DELETE（verdict 改判的 scoped DELETE，lifecycle:1088，
    // 锁定当前 pending 代 + 待补收）必须仍放行。
    const fixture = seedSupersededWithSurvivingDiff('r5-current-delete-control')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const nextSupplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    const deleted = db.prepare(`
      DELETE FROM supplement_orders
       WHERE source_diff_id = ? AND reconcile_generation_id = ? AND status = '待补收'
    `).run(fixture.nextDiff.id, fixture.nextBinding.reconcileGenerationId)
    expect(Number(deleted.changes)).toBe(1)
    expect(db.prepare(
      'SELECT COUNT(*) AS n FROM supplement_orders WHERE id = ?',
    ).get(nextSupplement.id)).toMatchObject({ n: 0 })
  })

  it('keeps rejecting the stale delete after a boot-time trigger reinstall', () => {
    // trigger 文本唯一定义点在升级函数、每次 boot 重装——重装后窗口期拒删口径不变。
    const fixture = seedSupersededWithSurvivingDiff('r5-stale-delete-reinstall')
    manager.upgradeAccountReconciliationSchema(db)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('DELETE FROM supplement_orders WHERE id = ?').run(fixture.oldSupplement.id)
    }, /FINAL_RECONCILIATION_DECISIONS_IMMUTABLE/)
  })

  it('fails startup validation on the inverse mismatch as well (boot probe is bidirectional)', () => {
    // 层间等价对照：开机谱系探针本就是双向全局校验，反向形状同样拒启——
    // R5 把 complete/close 时的 artifact 守卫补齐到同一方向完备性。
    const fixture = seedSupersededWithSurvivingDiff('r5-inverse-startup-probe')
    const probePath = join(testDirectory, `r5-inverse-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const probe = openRegisteredTestDatabase(probePath)
    try {
      // R6 起拷贝库带 identity trigger——先摘再注入（探针层独立验证）。
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
      probe.prepare('UPDATE reconcile_diffs SET reconcile_generation_id = ? WHERE id = ?')
        .run(fixture.nextBinding.reconcileGenerationId, fixture.oldDiff.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
    } finally {
      probe.close()
    }
  })

  it('rejects complete when a current-generation diff is drifted to another month in the pending window', () => {
    // 面板扩展形状：pending 窗口同样无 trigger 拦 diff 的 hospital_month_id 改写——
    // 把本代补收单引用的本代 diff 跨月搬移（gen 一致、月漂移），旧守卫候选虽命中
    // 但代次一致判无违例，artifact 查询再静默丢掉该单。守卫的月谓词补上这一类。
    const fixture = seedSupersededWithSurvivingDiff('r5-month-drift-complete')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const rewriteMonth = (monthId: string) => {
      db.prepare('UPDATE reconcile_diffs SET hospital_month_id = ? WHERE id = ?')
        .run(monthId, fixture.nextDiff.id)
    }
    // R6 起月键同属冻结身份列——摘 identity trigger 注入（守卫层独立验证）。
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
    rewriteMonth('hospital-month-drifted-out')
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      // RED 态下 complete 若竟成功，月内已出现 complete 代——同 inverse 测试的恢复姿势。
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable')
      rewriteMonth(fixture.hospitalMonthId)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('closes a cleanly completed month with a byte-identical artifact rebuild (added predicates are no-ops on a clean DB)', () => {
    // 兼容钉：守卫三谓词与 artifact 查询的显式代次条件在干净库上必须是恒真/恒等——
    // complete→close 全链路成功，且 close 前后的定版 artifact 逐字节一致
    //（close 内部重建 artifact 做 hash 比对，成功即字节级证明；此处再显式比对一次）。
    const fixture = seedSupersededWithSurvivingDiff('r5-close-compat')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    const readArtifact = () => (db.prepare(`
      SELECT completion_artifact_json FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(fixture.nextBinding.reconcileGenerationId) as { completion_artifact_json: string })
      .completion_artifact_json
    const artifactBeforeClose = readArtifact()
    lifecycle.closeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    expect(readArtifact()).toBe(artifactBeforeClose)
    const closed = db.prepare(`
      SELECT status FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(fixture.nextBinding.reconcileGenerationId) as { status: string }
    expect(closed.status).toBe('closed')
  })
})

describe('LOC-005 R6 partner/month identity closure', () => {
  // R6（对 e785c649 增量 R2 P1）：R5 守卫只钉代次与 hospital_month_id，
  // diff/supplement 自身的 partner_id/service_month 在 pending 窗口可漂移（无 trigger 拦），
  // artifact decisions 又不存这些键——complete 把伪造键写进定版、close hash 兜底失明。
  // 修复三层：complete/close 守卫 + 开机探针 + binding/新 identity trigger 同查 partner/月键；
  // artifact decisions 纳入 partnerId/serviceMonth 作为定版身份事实。

  it('freezes diff identity columns at the DB layer (new identity trigger)', () => {
    const fixture = seedSupersededWithSurvivingDiff('r6-diff-key-trigger')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE reconcile_diffs SET partner_id = ? WHERE id = ?')
        .run('partner-drifted', fixture.nextDiff.id)
    }, /RECONCILE_DIFF_IDENTITY_IMMUTABLE/)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE reconcile_diffs SET service_month = ? WHERE id = ?')
        .run('1999-12', fixture.nextDiff.id)
    }, /RECONCILE_DIFF_IDENTITY_IMMUTABLE/)
    // 面板修订（completeness #2 / refuter 遗漏形状）：case_no/line_type 同为身份列，
    // pending 窗口漂移会被 artifact 定版错误归因——identity trigger 一并冻结。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE reconcile_diffs SET case_no = ? WHERE id = ?')
        .run('CASE-DRIFTED-R6', fixture.nextDiff.id)
    }, /RECONCILE_DIFF_IDENTITY_IMMUTABLE/)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE reconcile_diffs SET line_type = ? WHERE id = ?')
        .run('line-type-drifted', fixture.nextDiff.id)
    }, /RECONCILE_DIFF_IDENTITY_IMMUTABLE/)
  })

  it('rejects complete when a fact-set diff partner/month key is drifted (guard layer)', () => {
    // 摘 identity trigger 模拟 DDL 级攻击者——守卫层必须独立 fail-closed。
    // 用无补收单的本代 diff（先给核对无误 verdict 过决策完备检查），
    // 覆盖「守卫候选集锚不到、只能靠 decisions 身份断言兜底」的形状。
    const fixture = seedSupersededWithSurvivingDiff('r6-diff-key-guard')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
    db.prepare('UPDATE reconcile_diffs SET partner_id = ? WHERE id = ?')
      .run('partner-drifted', fixture.nextDiff.id)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      // RED 态下 complete 若竟成功，月内已出现 complete 代——先摘终版 trigger 再恢复，
      // 最后走升级函数统一重装+启动探针自检（R5 同款姿势；identity trigger 已由升级函数重装）。
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable')
      db.prepare('UPDATE reconcile_diffs SET partner_id = ? WHERE id = ?')
        .run(fixture.nextBinding.partnerId, fixture.nextDiff.id)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('rejects complete when a fact-set diff hospital-month is drifted (guard layer)', () => {
    // 面板 completeness #1：hospital_month_id 漂移的无补收单 diff 会同时躲过
    // 「按 hospital_month_id 过滤」的断言与 artifact 查询（静默丢行）——
    // 断言必须按代次单键扫描、把 hospital_month_id 列为被检谓词，独立兜底。
    const fixture = seedSupersededWithSurvivingDiff('r6-diff-hm-drift-guard')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
    db.prepare('UPDATE reconcile_diffs SET hospital_month_id = ? WHERE id = ?')
      .run('HM-GHOST-R6', fixture.nextDiff.id)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      // 同上级联防御：RED 态 complete 竟成功则终版 trigger 拦恢复——先摘再恢复再重装。
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable')
      db.prepare('UPDATE reconcile_diffs SET hospital_month_id = ? WHERE id = ?')
        .run(fixture.hospitalMonthId, fixture.nextDiff.id)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('rejects supplement partner/month key drift at the DB layer (extended binding trigger)', () => {
    const fixture = seedSupersededWithSurvivingDiff('r6-supplement-key-binding')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE supplement_orders SET partner_id = ? WHERE id = ?')
        .run('partner-drifted', supplement.id)
    }, /SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE supplement_orders SET service_month = ? WHERE id = ?')
        .run('1999-12', supplement.id)
    }, /SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
    // 面板修订（refuter 遗漏形状）：supplement.case_no 进 artifact supplements 数组，
    // binding trigger 补 diff↔supplement 病例号等值，pending 窗口漂移一并拒。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE supplement_orders SET case_no = ? WHERE id = ?')
        .run('CASE-DRIFTED-R6', supplement.id)
    }, /SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
  })

  it('rejects complete when a supplement key is drifted past a dropped binding trigger (guard layer)', () => {
    const fixture = seedSupersededWithSurvivingDiff('r6-supplement-key-guard')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_update')
    db.prepare('UPDATE supplement_orders SET partner_id = ? WHERE id = ?')
      .run('partner-drifted', supplement.id)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      // 同上级联防御：RED 态 complete 竟成功则终版 trigger 拦恢复——先摘再恢复再重装。
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_immutable')
      db.prepare('UPDATE supplement_orders SET partner_id = ? WHERE id = ?')
        .run(fixture.nextBinding.partnerId, supplement.id)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('rejects complete when a supplement case_no is drifted past a dropped binding trigger (guard layer)', () => {
    // 面板修订（refuter 遗漏形状 / completeness #2 同族）：摘 binding trigger 后
    // supplement.case_no 漂移会被 artifact supplements 定版——守卫补 case_no 谓词兜底。
    const fixture = seedSupersededWithSurvivingDiff('r6-supplement-caseno-guard')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id, case_no FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string, case_no: string }
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_update')
    db.prepare('UPDATE supplement_orders SET case_no = ? WHERE id = ?')
      .run('CASE-DRIFTED-R6', supplement.id)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      // 同上级联防御：RED 态 complete 竟成功则终版 trigger 拦恢复——先摘再恢复再重装。
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_immutable')
      db.prepare('UPDATE supplement_orders SET case_no = ? WHERE id = ?')
        .run(supplement.case_no, supplement.id)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('rejects close when a diff key is injected after completion (guard fires before hash compare)', () => {
    // 复核者剧本的完整复刻：complete 后摘 trigger 改 diff 键再装回——
    // artifact decisions 已含键、守卫先于 hash 兜底 fail-closed。
    const fixture = seedSupersededWithSurvivingDiff('r6-post-complete-close')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable')
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
    db.prepare('UPDATE reconcile_diffs SET service_month = ? WHERE id = ?')
      .run('1999-12', fixture.nextDiff.id)
    try {
      expectCode(
        () => lifecycle.closeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      db.prepare('UPDATE reconcile_diffs SET service_month = ? WHERE id = ?')
        .run(fixture.nextBinding.settlementMonth, fixture.nextDiff.id)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('fails startup validation on partner/month key mismatches (extended boot probe)', () => {
    const fixture = seedSupersededWithSurvivingDiff('r6-boot-probe')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    // 探针 A：supplement 键漂移（摘 binding update trigger 注入）。
    const probeAPath = join(testDirectory, `r6-probe-a-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probeAPath)
    const probeA = openRegisteredTestDatabase(probeAPath)
    try {
      probeA.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_update')
      probeA.prepare('UPDATE supplement_orders SET partner_id = ? WHERE id = ?')
        .run('partner-drifted', supplement.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probeA))
        .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
    } finally {
      probeA.close()
    }
    // 探针 B：diff 键漂移（摘 identity trigger 注入）。
    const probeBPath = join(testDirectory, `r6-probe-b-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probeBPath)
    const probeB = openRegisteredTestDatabase(probeBPath)
    try {
      probeB.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
      probeB.prepare('UPDATE reconcile_diffs SET service_month = ? WHERE id = ?')
        .run('1999-12', fixture.nextDiff.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probeB))
        .toThrow(/SUPPLEMENT_GENERATION_BINDING_MISMATCH/)
    } finally {
      probeB.close()
    }
  })

  it('stores partner/month keys in artifact decisions as finalized identity facts', () => {
    const fixture = seedSupersededWithSurvivingDiff('r6-artifact-decisions-keys')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    const completed = db.prepare(`
      SELECT completion_artifact_json FROM account_reconcile_generations
      WHERE reconcile_generation_id = ?
    `).get(fixture.nextBinding.reconcileGenerationId) as { completion_artifact_json: string }
    const artifact = JSON.parse(completed.completion_artifact_json) as {
      decisions: Array<{ id: string, partnerId?: string, serviceMonth?: string }>
    }
    const decision = artifact.decisions.find(entry => entry.id === fixture.nextDiff.id)
    expect(decision?.partnerId).toBe(fixture.nextBinding.partnerId)
    expect(decision?.serviceMonth).toBe(fixture.nextBinding.settlementMonth)
  })

  it('keeps generation rows undeletable (P3 control: comment correction matches the live schema)', () => {
    // P3：R5 注释误称 generations 表无 BEFORE DELETE trigger——
    // trg_account_reconcile_no_delete（init-only，:3188）实际无条件拒删，本例钉死该行为。
    const fixture = seedSupersededWithSurvivingDiff('r6-generation-delete-control')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('DELETE FROM account_reconcile_generations WHERE reconcile_generation_id = ?')
        .run(fixture.binding.reconcileGenerationId)
    }, /IMMUTABLE_RECONCILIATION_FACT/)
  })
})

describe('LOC-005 R7 diff-anchored boot scan and collected-month integrity', () => {
  it('fails startup on supplement-less diff identity drift (diff-anchored scan)', () => {
    // R7 P1-1：启动扫描独立锚定所有已绑代 diff——supplement 锚定探针对无补收单引用的
    // diff（本夹具 nextDiff）天然失明；generation 悬空/hospital_month_id/partner_id/
    // service_month 四种漂移各备一枚探针库，必须在 trigger 重装前 fail-closed。
    const fixture = seedSupersededWithSurvivingDiff('r7-diff-scan')
    const injections: Array<{ label: string; sql: string; value: string }> = [
      { label: 'partner', sql: 'UPDATE reconcile_diffs SET partner_id = ? WHERE id = ?', value: 'PT-GHOST-R7' },
      { label: 'month', sql: 'UPDATE reconcile_diffs SET service_month = ? WHERE id = ?', value: '1999-12' },
      { label: 'hm', sql: 'UPDATE reconcile_diffs SET hospital_month_id = ? WHERE id = ?', value: 'HM-GHOST-R7' },
      { label: 'generation', sql: 'UPDATE reconcile_diffs SET reconcile_generation_id = ? WHERE id = ?', value: 'GEN-GHOST-R7' },
    ]
    for (const injection of injections) {
      const probePath = join(testDirectory, `r7-diff-${injection.label}-${++sequence}.sqlite`)
      db.prepare('VACUUM INTO ?').run(probePath)
      const probe = openRegisteredTestDatabase(probePath)
      try {
        probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
        probe.prepare(injection.sql).run(injection.value, fixture.nextDiff.id)
        expect(() => manager.upgradeAccountReconciliationSchema(probe))
          .toThrow(/RECONCILE_DIFF_GENERATION_IDENTITY_MISMATCH/)
      } finally {
        probe.close()
      }
    }
    // 对照：无漂移拷贝开机放行（扫描不误伤合法库）。
    const cleanPath = join(testDirectory, `r7-diff-clean-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(cleanPath)
    const clean = openRegisteredTestDatabase(cleanPath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(clean)).not.toThrow()
    } finally {
      clean.close()
    }
  })

  it('blocks invalid collected_month via DB triggers and rejects startup on legacy dirty rows', () => {
    // R7 P1-2 第二/三道：DB trigger 拦直接 SQL 非法 collected_month；启动 legacy 扫描
    // 拦历史脏数据（摘 trigger 注入的脏行在开机时 fail-closed）。合法值对照不误伤。
    const fixture = seedSupersededWithSurvivingDiff('r7-collected-month')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('UPDATE supplement_orders SET collected_month = ? WHERE id = ?')
        .run('2026-13', supplement.id)
    }, /SUPPLEMENT_COLLECTED_MONTH_INVALID/)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare('INSERT INTO supplement_orders (id, partner_id, service_month, collected_month) VALUES (?, ?, ?, ?)')
        .run(`SO-R7-DIRTY-${++sequence}`, fixture.nextBinding.partnerId, fixture.nextBinding.settlementMonth, '2026-1')
    }, /SUPPLEMENT_COLLECTED_MONTH_INVALID/)
    // 合法值对照：直写放行，随后还原（不污染主库后续用例）。
    db.prepare('UPDATE supplement_orders SET collected_month = ? WHERE id = ?')
      .run('2026-10', supplement.id)
    const written = db.prepare('SELECT collected_month FROM supplement_orders WHERE id = ?')
      .get(supplement.id) as { collected_month: string }
    expect(written.collected_month).toBe('2026-10')
    db.prepare('UPDATE supplement_orders SET collected_month = NULL WHERE id = ?')
      .run(supplement.id)

    // legacy 扫描：拷贝库内摘 update trigger 注入历史脏行，开机扫描必须拒启并带出行 id。
    const probePath = join(testDirectory, `r7-collected-legacy-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const probe = openRegisteredTestDatabase(probePath)
    try {
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_collected_month_update')
      probe.prepare('UPDATE supplement_orders SET collected_month = ? WHERE id = ?')
        .run('2026-13', supplement.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/SUPPLEMENT_COLLECTED_MONTH_INVALID/)
    } finally {
      probe.close()
    }
  })
})

describe('LOC-005 R8 row-presence guards, NULL-generation gate and strict collected-month storage', () => {
  it('rejects NULL/empty-string id rows at startup instead of masking later dirty rows (P1-1 boot side)', () => {
    // R8 P1-1：SQLite 普通表 TEXT PRIMARY KEY 允许 NULL/''；.get() 返回 {id:NULL} 对象
    // （行存在）但 row?.id 为假——真值判断下该脏行不可见，且 LIMIT 1 下遮住后续脏行。
    // 探针 A：单条 NULL-id 漂移行今天开机竟放行；探针 B：NULL-id 行与正常 id 脏行并存，
    // 修复后逐条被带出（修复首条后重启仍拒，证明遮挡解除）；探针 C：''-id 行纵深扫描拒启。
    const fixture = seedSupersededWithSurvivingDiff('r8-null-id-scan')
    const extra = seedSource({ name: 'r8-null-id-extra', lisCount: 2 })
    lifecycle.computeAccountReconciliation(db, extra, 'USER-001')
    const extraDiff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE reconcile_generation_id = ?',
    ).get(extra.reconcileGenerationId) as { id: string }

    // 探针 A：NULL-id 漂移行——真值判断下行存在却被当「无行」放行
    const probeAPath = join(testDirectory, `r8-null-id-a-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probeAPath)
    const probeA = openRegisteredTestDatabase(probeAPath)
    try {
      probeA.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
      probeA.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_row_id_update')
      probeA.prepare('UPDATE reconcile_diffs SET id = NULL, partner_id = ? WHERE id = ?')
        .run('PT-GHOST-R8', fixture.nextDiff.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probeA))
        .toThrow(/RECONCILE_DIFF_GENERATION_IDENTITY_MISMATCH:<null>/)
    } finally {
      probeA.close()
    }

    // 探针 B：遮挡——NULL-id 脏行 + 正常 id 脏行并存；首轮拒启并带出首条，
    // 就地修复被带出的行后重启必须继续拒启（剩余脏行浮出水面，LIMIT 1 遮挡解除）。
    const probeBPath = join(testDirectory, `r8-null-id-b-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probeBPath)
    const probeB = openRegisteredTestDatabase(probeBPath)
    try {
      probeB.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
      probeB.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_row_id_update')
      probeB.prepare('UPDATE reconcile_diffs SET id = NULL, partner_id = ? WHERE id = ?')
        .run('PT-GHOST-R8', fixture.nextDiff.id)
      probeB.prepare('UPDATE reconcile_diffs SET partner_id = ? WHERE id = ?')
        .run('PT-GHOST-R8', extraDiff.id)
      let first: unknown
      try {
        manager.upgradeAccountReconciliationSchema(probeB)
      } catch (error) {
        first = error
      }
      expect(String(first)).toMatch(/RECONCILE_DIFF_GENERATION_IDENTITY_MISMATCH/)
      // 启动事务已回滚，注入仍在库内；修复被带出的那条（id 为 NULL 的行或正常 id 行）
      if (String(first).endsWith(':<null>')) {
        probeB.prepare('UPDATE reconcile_diffs SET id = ?, partner_id = ? WHERE id IS NULL')
          .run(fixture.nextDiff.id, fixture.nextBinding.partnerId)
      } else {
        probeB.prepare('UPDATE reconcile_diffs SET partner_id = ? WHERE id = ?')
          .run(extra.partnerId, extraDiff.id)
      }
      expect(() => manager.upgradeAccountReconciliationSchema(probeB))
        .toThrow(/RECONCILE_DIFF_GENERATION_IDENTITY_MISMATCH/)
    } finally {
      probeB.close()
    }

    // 探针 C：''-id 行（键未漂移，纯主键空值）——纵深扫描拒启；
    // 身份表主键空值只能经直接 SQL 产生（全部应用写者用 uuid），fail-closed 不误伤。
    const probeCPath = join(testDirectory, `r8-empty-id-c-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probeCPath)
    const probeC = openRegisteredTestDatabase(probeCPath)
    try {
      probeC.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
      probeC.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_row_id_update')
      probeC.prepare(`UPDATE reconcile_diffs SET id = '' WHERE id = ?`)
        .run(fixture.nextDiff.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probeC))
        .toThrow(/RECONCILE_ROW_ID_EMPTY:reconcile_diffs/)
    } finally {
      probeC.close()
    }
  })

  it('rejects complete when a NULL-id supplement carries lineage drift (P1-1 guard side)', () => {
    // R8 P1-1 complete 侧：谱系守卫 SELECT supplement.id ... LIMIT 1 返回 {id:NULL}
    // 时真值判断放行——漂移补收单带伪造键进定版。行存在必须视同命中。
    const fixture = seedSupersededWithSurvivingDiff('r8-null-id-guard')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_generation_update')
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_row_id_update')
    db.prepare('UPDATE supplement_orders SET id = NULL, partner_id = ? WHERE id = ?')
      .run('PT-GHOST-R8', supplement.id)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      // RED 态 complete 竟成功则月内已出 complete 代——先摘终版 trigger 再恢复，
      // 最后走升级函数统一重装+启动探针自检（R6 同款姿势）。
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_final_immutable')
      db.prepare(`
        UPDATE supplement_orders SET id = ?, partner_id = ?
         WHERE rowid = (SELECT rowid FROM supplement_orders WHERE id IS NULL)
      `).run(supplement.id, fixture.nextBinding.partnerId)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('rejects complete when a NULL-id diff carries key drift (P1-1 decisions assert side)', () => {
    // R8 P1-1 断言侧：decisions 身份断言 SELECT id FROM reconcile_diffs ... LIMIT 1
    // 同型失明——{id:NULL} 被当真值判断的「无行」，漂移 diff 静默进定版。
    const fixture = seedSupersededWithSurvivingDiff('r8-null-id-assert')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '核对无误', null, 'USER-001', 'admin',
    )
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_row_id_update')
    db.prepare('UPDATE reconcile_diffs SET id = NULL, partner_id = ? WHERE id = ?')
      .run('PT-GHOST-R8', fixture.nextDiff.id)
    try {
      expectCode(
        () => lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001'),
        'RECONCILIATION_LINEAGE_MISMATCH',
      )
    } finally {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_immutable')
      db.prepare('UPDATE reconcile_diffs SET id = ?, partner_id = ? WHERE id IS NULL')
        .run(fixture.nextDiff.id, fixture.nextBinding.partnerId)
      manager.upgradeAccountReconciliationSchema(db)
    }
  })

  it('rejects startup and restart when a current-shape diff carries NULL generation (P1-2)', () => {
    // R8 P1-2：reconcile_generation_id 列已存在（当前形状）时 IS NULL = 当前库损坏——
    // 绝不静默回填（回填按当前代修复键、掩盖 drift）；首次启动与重启（事务回滚后脏行
    // 仍在）均 fail-closed。predecessor schema（列原本不存在）的兼容回填不受影响，
    // 由既有 R3-1 绿测钉住。
    const fixture = seedSupersededWithSurvivingDiff('r8-null-gen')
    const probePath = join(testDirectory, `r8-null-gen-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const probe = openRegisteredTestDatabase(probePath)
    try {
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_identity_immutable')
      probe.prepare('UPDATE reconcile_diffs SET reconcile_generation_id = NULL WHERE id = ?')
        .run(fixture.nextDiff.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/RECONCILE_DIFF_GENERATION_NULL/)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/RECONCILE_DIFF_GENERATION_NULL/)
    } finally {
      probe.close()
    }
    // 对照：unbound legacy（院·月无当前代可绑）NULL-gen diff 不拦截——
    // 与 R2「无代遗留月显式不绑」治理形状及 #83 口径一致。
    // 独立新 partner（不 compute），避免与夹具既有月份撞 partner+month 唯一键。
    const legacyPartner = seedSource({ name: 'r8-unbound-partner' })
    const legacyPath = join(testDirectory, `r8-null-gen-legacy-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(legacyPath)
    const legacy = openRegisteredTestDatabase(legacyPath)
    try {
      const legacyMonthId = `HM-R8-UNBOUND-${sequence}`
      legacy.prepare(`
        INSERT INTO reconcile_hospital_months (id, partner_id, partner_name, service_month)
        VALUES (?, ?, 'R8 unbound legacy partner', ?)
      `).run(legacyMonthId, legacyPartner.partnerId, legacyPartner.settlementMonth)
      legacy.prepare(`
        INSERT INTO reconcile_diffs (id, hospital_month_id, partner_id, service_month, case_no, line_type)
        VALUES (?, ?, ?, ?, 'CASE-R8-UNBOUND', '免疫组化')
      `).run(`DIFF-R8-UNBOUND-${sequence}`, legacyMonthId, legacyPartner.partnerId, legacyPartner.settlementMonth)
      expect(() => manager.upgradeAccountReconciliationSchema(legacy)).not.toThrow()
    } finally {
      legacy.close()
    }
  })

  it('blocks non-text/NUL-padded collected_month at DB triggers and legacy scan (P1-3 DB side)', () => {
    // R8 P1-3 DB 侧：typeof 必须 'text' 且字节长度恰 7——SQLite length() 与 GLOB 对
    // TEXT 均在首个 NUL 处截断，'2026-12'||char(0)||'junk' 会骗过既有子句；必须
    // length(CAST(... AS BLOB))=7 计全字节。BLOB/INTEGER typeof 一并拒绝。
    const fixture = seedSupersededWithSurvivingDiff('r8-collected-strict')
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`UPDATE supplement_orders SET collected_month = '2026-12' || char(0) || 'junk' WHERE id = ?`)
        .run(supplement.id)
    }, /SUPPLEMENT_COLLECTED_MONTH_INVALID/)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`INSERT INTO supplement_orders (id, partner_id, service_month, collected_month) VALUES (?, ?, ?, x'323032362D3132')`)
        .run(`SO-R8-BLOB-${++sequence}`, fixture.nextBinding.partnerId, fixture.nextBinding.settlementMonth)
    }, /SUPPLEMENT_COLLECTED_MONTH_INVALID/)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`INSERT INTO supplement_orders (id, partner_id, service_month, collected_month) VALUES (?, ?, ?, 202612)`)
        .run(`SO-R8-INT-${++sequence}`, fixture.nextBinding.partnerId, fixture.nextBinding.settlementMonth)
    }, /SUPPLEMENT_COLLECTED_MONTH_INVALID/)
    // legacy 扫描：摘 update trigger 注入 NUL 脏行，开机扫描必须拒启
    const probePath = join(testDirectory, `r8-collected-nul-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const probe = openRegisteredTestDatabase(probePath)
    try {
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_supplement_collected_month_update')
      probe.prepare(`UPDATE supplement_orders SET collected_month = '2026-12' || char(0) || 'junk' WHERE id = ?`)
        .run(supplement.id)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/SUPPLEMENT_COLLECTED_MONTH_INVALID/)
    } finally {
      probe.close()
    }
  })
})

// ---------------------------------------------------------------------------
// FUP #85：managed 主连接 foreign_keys 显式钉版（不依赖 Node 版本默认值）。
// 夹具为 statement-normalized-lines.test.ts createFixedPredecessorSchema 的剪枝复刻
// （该文件非本任务 owned，不可编辑或跨文件 import；CREATE TABLE 列序与
// STATEMENT_*_PREDECESSOR_COLUMNS 逐序一致，仅裁剪数据行数与 trigger/index）。
// ---------------------------------------------------------------------------

function foreignKeysPragmaValue(connection: DatabaseSync): number {
  return Number(
    (connection.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined)
      ?.foreign_keys ?? 0,
  )
}

function createPhase1APredecessorFixture(database: DatabaseSync, withInvalidLineage = false): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE statement_import_batches (
      id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, partner_name TEXT, source_file TEXT,
      source_hash TEXT NOT NULL, template_family TEXT NOT NULL, parser_revision TEXT NOT NULL,
      config_revision TEXT NOT NULL,
      settlement_month TEXT NOT NULL CHECK(settlement_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
      generation_id TEXT NOT NULL UNIQUE, supersedes_generation_id TEXT,
      is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)), source_sheet TEXT,
      declared_total DECIMAL(18,4), raw_row_count INTEGER NOT NULL CHECK(raw_row_count >= 0),
      normalized_line_count INTEGER NOT NULL CHECK(normalized_line_count >= 0),
      status TEXT NOT NULL DEFAULT 'parsed'
        CHECK(status IN ('parsed', 'posted', 'computed', 'complete', 'closed', 'error', 'unavailable')),
      artifact_hash TEXT, uploaded_by TEXT,
      completed_at DATETIME, completed_by TEXT, closed_at DATETIME, closed_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(partner_id, settlement_month, source_hash, parser_revision, config_revision),
      UNIQUE(id, generation_id),
      UNIQUE(id, generation_id, partner_id, settlement_month)
    );
    CREATE TABLE statement_raw_rows (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL, source_sheet TEXT,
      source_row INTEGER NOT NULL CHECK(source_row >= 1), row_json TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id) REFERENCES statement_import_batches(id, generation_id),
      UNIQUE(generation_id, source_sheet, source_row)
    );
    CREATE TABLE statement_normalized_lines (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      partner_id TEXT NOT NULL, settlement_month TEXT NOT NULL, row_settlement_month TEXT,
      settlement_month_basis TEXT, case_no TEXT, external_subject_key TEXT, item_name TEXT,
      source_sheet TEXT, source_row INTEGER NOT NULL, source_column TEXT NOT NULL,
      source_label TEXT NOT NULL, template_family TEXT NOT NULL,
      row_kind TEXT NOT NULL CHECK(row_kind IN ('detail', 'subtotal', 'declared_total', 'header', 'note')),
      line_grain TEXT NOT NULL CHECK(line_grain IN ('case', 'aggregate', 'out', 'joint', 'adjustment', 'retainer')),
      business_line TEXT NOT NULL CHECK(business_line IN ('IN', 'OUT', 'UNKNOWN', 'NEUTRAL', 'EXCLUDED')),
      amount_role TEXT NOT NULL,
      amount DECIMAL(18,4) NOT NULL, classification_status TEXT NOT NULL, rule_id TEXT,
      rule_version TEXT, report_date TEXT, raw_payload TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id, partner_id, settlement_month)
        REFERENCES statement_import_batches(id, generation_id, partner_id, settlement_month),
      UNIQUE(generation_id, source_sheet, source_row, source_column, amount_role),
      UNIQUE(id, generation_id, batch_id),
      UNIQUE(id, generation_id, batch_id, partner_id, settlement_month)
    );
    CREATE TABLE quality_flags (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, flag_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('blocking', 'warning', 'info')),
      owner_role TEXT NOT NULL, resolution_action TEXT NOT NULL,
      blocks_posting INTEGER NOT NULL CHECK(blocks_posting IN (0, 1)),
      blocks_closing INTEGER NOT NULL CHECK(blocks_closing IN (0, 1)), partner_id TEXT NOT NULL,
      settlement_month TEXT NOT NULL, related_batch_id TEXT NOT NULL, related_line_id TEXT,
      reason_code TEXT NOT NULL, message TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(related_batch_id, generation_id, partner_id, settlement_month)
        REFERENCES statement_import_batches(id, generation_id, partner_id, settlement_month),
      FOREIGN KEY(related_line_id, generation_id, related_batch_id, partner_id, settlement_month)
        REFERENCES statement_normalized_lines(id, generation_id, batch_id, partner_id, settlement_month)
    );
    CREATE TABLE partner_month_revenue_ledger (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      partner_id TEXT NOT NULL, settlement_month TEXT NOT NULL, source_line_id TEXT NOT NULL UNIQUE,
      category_label TEXT, business_line TEXT NOT NULL CHECK(business_line = 'IN'),
      settlement_amount DECIMAL(18,4) NOT NULL,
      ledger_scope TEXT NOT NULL DEFAULT 'statement_internal' CHECK(ledger_scope = 'statement_internal'),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id) REFERENCES statement_import_batches(id, generation_id),
      FOREIGN KEY(source_line_id, generation_id, batch_id)
        REFERENCES statement_normalized_lines(id, generation_id, batch_id)
    );
    CREATE TABLE out_settlement_ledger (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      partner_id TEXT NOT NULL, settlement_month TEXT NOT NULL, source_line_id TEXT NOT NULL UNIQUE,
      out_type TEXT NOT NULL, item_name TEXT, external_subject_key TEXT,
      settlement_amount DECIMAL(18,4) NOT NULL,
      lab_revenue_amount DECIMAL(18,4) NOT NULL DEFAULT 0 CHECK(lab_revenue_amount = 0),
      ledger_scope TEXT NOT NULL DEFAULT 'statement_internal' CHECK(ledger_scope = 'statement_internal'),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id) REFERENCES statement_import_batches(id, generation_id),
      FOREIGN KEY(source_line_id, generation_id, batch_id)
        REFERENCES statement_normalized_lines(id, generation_id, batch_id)
    );
    INSERT INTO statement_import_batches (
      id, partner_id, source_file, source_hash, template_family, parser_revision, config_revision,
      settlement_month, generation_id, source_sheet, raw_row_count, normalized_line_count, status
    ) VALUES (
      'B-PRE', 'PT-PRE', 'pre.xlsx', 'sha256:predecessor', 'category_summary',
      'parser-phase1a-v1', 'seed-phase1a-v1', '2026-01', 'GEN-PRE', 'Sheet1', 1, 1, 'parsed'
    );
    INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
      VALUES ('RAW-PRE', 'B-PRE', 'GEN-PRE', 'Sheet1', 1, '[]');
    INSERT INTO statement_normalized_lines (
      id, batch_id, generation_id, partner_id, settlement_month, row_settlement_month,
      settlement_month_basis, source_sheet, source_row, source_column, source_label,
      template_family, row_kind, line_grain, business_line, amount_role, amount,
      classification_status, raw_payload
    ) VALUES (
      'LINE-PRE', 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', NULL, 'import_month',
      'Sheet1', 1, 'A', 'pre', 'category_summary', 'detail', 'aggregate', 'IN',
      'settlement', 1, 'classified', '{}'
    );
    INSERT INTO statement_normalized_lines (
      id, batch_id, generation_id, partner_id, settlement_month, row_settlement_month,
      settlement_month_basis, source_sheet, source_row, source_column, source_label,
      template_family, row_kind, line_grain, business_line, amount_role, amount,
      classification_status, raw_payload
    ) VALUES (
      'LINE-PRE-2', 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', NULL, 'import_month',
      'Sheet1', 2, 'A2', 'pre', 'category_summary', 'detail', 'aggregate', 'IN',
      'settlement', 1, 'classified', '{}'
    );
    INSERT INTO quality_flags (
      id, generation_id, flag_type, severity, owner_role, resolution_action,
      blocks_posting, blocks_closing, partner_id, settlement_month,
      related_batch_id, related_line_id, reason_code, message
    ) VALUES ('FLAG-PRE-1', 'GEN-PRE', 'pre_flag_1', 'info', 'finance', 'none', 0, 0,
      'PT-PRE', '2026-01', 'B-PRE', NULL, 'PRE_FLAG_1', 'predecessor fixture');
    INSERT INTO partner_month_revenue_ledger (
      id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
      category_label, business_line, settlement_amount, ledger_scope
    ) VALUES ('PML-PRE-1', 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', 'LINE-PRE',
      'pre', 'IN', 1, 'statement_internal');
    INSERT INTO out_settlement_ledger (
      id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
      out_type, item_name, external_subject_key, settlement_amount, lab_revenue_amount, ledger_scope
    ) VALUES ('OUT-PRE-1', 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', 'LINE-PRE',
      'pre', 'pre', NULL, 1, 0, 'statement_internal')
  `)
  if (withInvalidLineage) {
    // 与源夹具同形：坏行的 partner/month 与批次不一致——predecessor 自身 FK 查不出，
    // 拷入 canonical schema（lineage FK 到批次四元组）后 foreign_key_check 才失败。
    database.exec('PRAGMA foreign_keys = OFF')
    database.exec(`
      INSERT INTO partner_month_revenue_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        category_label, business_line, settlement_amount, ledger_scope
      ) VALUES (
        'PML-PRE-BAD', 'B-PRE', 'GEN-PRE', 'PT-OTHER', '2026-02', 'LINE-PRE-2',
        'bad', 'IN', 1, 'statement_internal'
      )
    `)
    database.exec('PRAGMA foreign_keys = ON')
  }
}

describe('LOC-005 FUP #85 managed-connection foreign_keys explicit pinning', () => {
  it('pins foreign_keys = 1 on the managed connection on fresh open and across restart', () => {
    expect(foreignKeysPragmaValue(db)).toBe(1)
    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    expect(foreignKeysPragmaValue(db)).toBe(1)
  })

  it('fails closed when the read-back cannot confirm foreign_keys = 1', () => {
    // SQLite 在事务内把 foreign_keys 开关变更当 no-op：FK=0 连接 BEGIN 后调用钉版函数，
    // 读回仍为 0，必须 fail-closed（稳定可诊断错误，不静默继续）。
    const probe = openRegisteredTestDatabase(':memory:')
    try {
      probe.exec('PRAGMA foreign_keys = OFF')
      expect(foreignKeysPragmaValue(probe)).toBe(0)
      probe.exec('BEGIN')
      expect(() => manager.assertManagedConnectionForeignKeys(probe, 'probe'))
        .toThrow(/DATABASE_FOREIGN_KEYS_UNAVAILABLE:probe:0/)
      probe.exec('ROLLBACK')
      // 事务外：显式 ON + 读回 = 1，放行
      expect(() => manager.assertManagedConnectionForeignKeys(probe, 'probe')).not.toThrow()
      expect(foreignKeysPragmaValue(probe)).toBe(1)
    } finally {
      probe.close()
    }
  })

  it('restores foreign_keys = 1 after Phase-1A upgrade success even when entered with 0', () => {
    const predecessor = openRegisteredTestDatabase(':memory:')
    try {
      createPhase1APredecessorFixture(predecessor)
      predecessor.exec('PRAGMA foreign_keys = OFF')
      expect(foreignKeysPragmaValue(predecessor)).toBe(0)
      expect(manager.upgradeStatementPhase1ASchema(predecessor)).toBe('upgraded')
      // 进入前为 0 本身就是失防；迁移成功后必须钉回 1，不能按进入前值恢复为 0
      expect(foreignKeysPragmaValue(predecessor)).toBe(1)
    } finally {
      predecessor.close()
    }
  })

  it('restores foreign_keys = 1 after injected Phase-1A upgrade failure even when entered with 0', () => {
    const predecessor = openRegisteredTestDatabase(':memory:')
    try {
      createPhase1APredecessorFixture(predecessor, true)
      predecessor.exec('PRAGMA foreign_keys = OFF')
      expect(foreignKeysPragmaValue(predecessor)).toBe(0)
      expect(() => manager.upgradeStatementPhase1ASchema(predecessor))
        .toThrow(/STATEMENT_PHASE1A_UPGRADE_FAILED/)
      expect(foreignKeysPragmaValue(predecessor)).toBe(1)
    } finally {
      predecessor.close()
    }
  })

  it('keeps FK RESTRICT rejecting dangling deletes after business triggers are dropped, with empty foreign_key_check', () => {
    // 钉版（本例修复前即为绿）：摘掉业务层 trg_reconcile_diff_final_no_delete 后，
    // 删被已终结补收单引用的 diff 仍被数据库层 FK 拒绝，且 foreign_key_check 为空——
    // 证明 FK 防线真实承重，而不是依赖 trigger 单点。
    const fixture = seedSupersededWithSurvivingDiff('fk85-restrict')
    const probePath = join(testDirectory, `fk85-restrict-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const probe = openRegisteredTestDatabase(probePath)
    try {
      probe.exec('PRAGMA foreign_keys = ON')
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_diff_final_no_delete')
      expect(() => probe.prepare('DELETE FROM reconcile_diffs WHERE id = ?').run(fixture.oldDiff.id))
        .toThrow(/FOREIGN KEY constraint failed/)
      expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      probe.close()
    }
  })

  it('releases the connection handle when open-path pinning fails (主控复核点 1)', () => {
    // openManagedDatabase 的钉版失败路径：fail-closed 的同时必须 close 新连接，
    // 不能泄漏句柄。用事务内 pragma no-op 制造真实的钉版失败态。
    const probe = openRegisteredTestDatabase(':memory:')
    probe.exec('PRAGMA foreign_keys = OFF')
    probe.exec('BEGIN')
    expect(() => manager.assertForeignKeysPinnedOrClose(probe, 'open-probe'))
      .toThrow(/DATABASE_FOREIGN_KEYS_UNAVAILABLE:open-probe:0/)
    // 句柄已释放：对关闭连接的任何操作必须报错，而不是静默可用
    expect(() => probe.prepare('SELECT 1')).toThrow()
  })

  it('preserves the original migration error when Phase-1A re-pinning fails (主控复核点 2)', () => {
    // 钉版失败的真实病理态 = 迁移失败后连接仍在事务内（ROLLBACK 未成功），
    // 此时 pragma no-op、读回为 0。诊断合同：原迁移错误上下文不得被钉版错误覆盖。
    const probe = openRegisteredTestDatabase(':memory:')
    try {
      probe.exec('PRAGMA foreign_keys = OFF')
      probe.exec('BEGIN')
      const original = new Error('STATEMENT_PHASE1A_UPGRADE_FAILED: injected boom')
      // 单调用单捕获：对同一错误对象同时断言原迁移错误与钉版错误两段都在
      let combined: unknown
      try {
        manager.repinForeignKeysAfterMigration(probe, 'statement-phase1a-upgrade', original)
      } catch (error) {
        combined = error
      }
      expect(String(combined)).toMatch(/STATEMENT_PHASE1A_UPGRADE_FAILED: injected boom/)
      expect(String(combined)).toMatch(/DATABASE_FOREIGN_KEYS_UNAVAILABLE:statement-phase1a-upgrade:0/)
      // 无原错误时：钉版错误原样抛出（bare）
      expect(() => manager.repinForeignKeysAfterMigration(probe, 'statement-phase1a-upgrade', null))
        .toThrow(/DATABASE_FOREIGN_KEYS_UNAVAILABLE:statement-phase1a-upgrade:0/)
      probe.exec('ROLLBACK')
      // 事务外钉版成功：不抛错，读回 = 1，原错误由调用方自行抛出
      expect(() => manager.repinForeignKeysAfterMigration(probe, 'statement-phase1a-upgrade', original))
        .not.toThrow()
      expect(foreignKeysPragmaValue(probe)).toBe(1)
    } finally {
      probe.close()
    }
  })

  it('re-pins foreign_keys = 1 when BEGIN IMMEDIATE fails on lock contention (主控复核点 3)', () => {
    // 真实锁竞争：连接 A 持 BEGIN IMMEDIATE（RESERVED 锁），连接 B 为合法 predecessor
    // 且 busy_timeout=0——B 的 BEGIN IMMEDIATE 必失败，而 PRAGMA OFF 已先生效。
    // 合同：函数抛出、错误保留原始锁失败上下文，且 B 不得被留在 FK=0。
    const probePath = join(testDirectory, `phase1a-busy-${++sequence}.sqlite`)
    const probeB = openRegisteredTestDatabase(probePath)
    try {
      createPhase1APredecessorFixture(probeB)
      probeB.exec('PRAGMA busy_timeout = 0')
      const probeA = openRegisteredTestDatabase(probePath)
      try {
        probeA.exec('BEGIN IMMEDIATE')
        let caught: unknown
        try {
          manager.upgradeStatementPhase1ASchema(probeB)
        } catch (error) {
          caught = error
        }
        expect(String(caught)).toMatch(/STATEMENT_PHASE1A_UPGRADE_FAILED/)
        expect(String(caught)).toMatch(/database is locked/)
        expect(foreignKeysPragmaValue(probeB)).toBe(1)
      } finally {
        probeA.close()
      }
    } finally {
      probeB.close()
    }
  })
})

// ---------------------------------------------------------------------------
// FUP #95：四身份表主键写入侧硬闸（INSERT NULL/'' 与 UPDATE NULL/''/改 ID 即拒）。
// 防代打纪律（主控 2026-07-29 纠偏）：
// - UPDATE 承重探针一律在独立 probe 上跑：事务外 FK=OFF（读回确认 0），
//   generation 另 DROP trg_account_reconcile_immutable_fact（其 <> 谓词已拦 A→B/A→''，
//   不摘则新 guard 缺失也绿=假绿），目标行一律 pending（避开 finality trigger 的 IS NOT 谓词）；
//   断言新 guard 专属错误码（EMPTY 带 $ 锚与启动扫描的 :<rowid> 码区分）与零写；
//   每个 probe 收尾 FK 回 ON + 读回 1 + foreign_key_check 为空，不留关 FK 的「绿」。
// - INSERT 探针 FK=ON 主库直跑，其余列/FK 全部合法，只坏主键。
// - 错误码合同：EMPTY(NULL/'')与 IMMUTABLE(A→B)由同一只 UPDATE trigger 体内
//   两段 SELECT RAISE ... WHERE 顺序求值区分，不依赖多 trigger 创建顺序。
// ---------------------------------------------------------------------------

describe('LOC-005 FUP #95 identity-table row-id write guards', () => {
  type RowIdFixture = ReturnType<typeof seedSupersededWithSurvivingDiff> & {
    g2SupplementId?: string
  }
  const rowIdTargets = [
    { label: 'reconcile_diffs', idColumn: 'id', extraDrops: [] as string[] },
    { label: 'supplement_orders', idColumn: 'id', extraDrops: [] as string[] },
    {
      label: 'account_reconcile_generations',
      idColumn: 'reconcile_generation_id',
      extraDrops: ['trg_account_reconcile_immutable_fact'],
    },
    { label: 'reconcile_hospital_months', idColumn: 'id', extraDrops: [] as string[] },
  ] as const

  function pickRowId(target: (typeof rowIdTargets)[number], fixture: RowIdFixture): string {
    switch (target.label) {
      case 'reconcile_diffs':
        return fixture.nextDiff.id
      case 'supplement_orders':
        return String(fixture.g2SupplementId)
      case 'account_reconcile_generations':
        return fixture.nextBinding.reconcileGenerationId
      case 'reconcile_hospital_months':
        return fixture.hospitalMonthId
    }
  }

  function seedRowIdFixture(name: string): RowIdFixture {
    const fixture = seedSupersededWithSurvivingDiff(name) as RowIdFixture
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.nextBinding, fixture.nextDiff.id, '漏收，需补收', null, 'USER-001', 'admin',
    )
    fixture.g2SupplementId = (db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(fixture.nextDiff.id) as { id: string }).id
    return fixture
  }

  // 例 1（四表各一 it）：UPDATE 写入侧承重探针——独立 probe + FK=OFF（读回 0）+
  // 代打 trigger 摘除 + pending 目标行；断新 guard 专属错误码与零写；
  // 收尾 FK=ON + 读回 1 + foreign_key_check 为空。
  for (const target of rowIdTargets) {
    it(`rejects UPDATE to empty/NULL/changed row id on ${target.label} (probe, FK off, de-conflicted)`, () => {
      const fixture = seedRowIdFixture(`rowid-update-${target.label}`)
      const probePath = join(testDirectory, `rowid-update-${target.label}-${++sequence}.sqlite`)
      db.prepare('VACUUM INTO ?').run(probePath)
      const probe = openRegisteredTestDatabase(probePath)
      try {
        probe.exec('PRAGMA foreign_keys = OFF')
        expect(foreignKeysPragmaValue(probe)).toBe(0)
        for (const drop of target.extraDrops) {
          probe.exec(`DROP TRIGGER IF EXISTS ${drop}`)
        }
        const targetId = pickRowId(target, fixture)
        expectDatabaseMutationBlocked(probe, () => {
          probe.prepare(`UPDATE ${target.label} SET ${target.idColumn} = '' WHERE ${target.idColumn} = ?`)
            .run(targetId)
        }, new RegExp(`RECONCILE_ROW_ID_EMPTY:${target.label}$`))
        expectDatabaseMutationBlocked(probe, () => {
          probe.prepare(`UPDATE ${target.label} SET ${target.idColumn} = NULL WHERE ${target.idColumn} = ?`)
            .run(targetId)
        }, new RegExp(`RECONCILE_ROW_ID_EMPTY:${target.label}$`))
        expectDatabaseMutationBlocked(probe, () => {
          probe.prepare(`UPDATE ${target.label} SET ${target.idColumn} = ? WHERE ${target.idColumn} = ?`)
            .run(`DRIFTED-${target.label}`, targetId)
        }, new RegExp(`RECONCILE_ROW_ID_IMMUTABLE:${target.label}$`))
        // 零写：原 ID 行仍在，空/NULL/漂移 ID 均不存在
        expect(
          probe.prepare(`SELECT ${target.idColumn} AS id FROM ${target.label} WHERE ${target.idColumn} = ?`)
            .get(targetId),
        ).toEqual({ id: targetId })
        const dirty = probe.prepare(`
          SELECT COUNT(*) AS n FROM ${target.label}
           WHERE ${target.idColumn} IS NULL OR ${target.idColumn} = '' OR ${target.idColumn} = ?
        `).get(`DRIFTED-${target.label}`) as { n: number }
        expect(dirty.n).toBe(0)
        // 收尾：FK 回 ON + 读回 1 + foreign_key_check 为空
        probe.exec('PRAGMA foreign_keys = ON')
        expect(foreignKeysPragmaValue(probe)).toBe(1)
        expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        probe.close()
      }
    })
  }

  // 例 2（四表各一 it）：INSERT 写入侧探针——FK=ON 主库直跑，其余列/FK 全合法只坏主键；
  // 断新 guard 专属错误码与全表零脏行。
  const insertLegalWriters: Record<string, (fixture: RowIdFixture, badId: string | null) => void> = {
    reconcile_diffs: (fixture, badId) => {
      db.prepare(`
        INSERT INTO reconcile_diffs (id, hospital_month_id, partner_id, service_month, case_no, line_type)
        VALUES (?, ?, ?, ?, ?, '少收')
      `).run(
        badId, fixture.hospitalMonthId, fixture.binding.partnerId, fixture.binding.settlementMonth,
        `CASE-RID95-${++sequence}`,
      )
    },
    supplement_orders: (fixture, badId) => {
      db.prepare('INSERT INTO supplement_orders (id, partner_id, service_month) VALUES (?, ?, ?)')
        .run(badId, fixture.binding.partnerId, fixture.binding.settlementMonth)
    },
    account_reconcile_generations: (fixture, badId) => {
      db.prepare(`
        INSERT INTO account_reconcile_generations (
          reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
          hospital_month_id, source_readiness_json, source_readiness_hash,
          statement_artifact_hash, snapshot_json, snapshot_hash
        ) VALUES (?, ?, '2099-01', ?, ?, '{}', 'rid95', 'rid95', '{}', 'rid95')
      `).run(badId, fixture.binding.partnerId, fixture.binding.statementGenerationId, fixture.hospitalMonthId)
    },
    reconcile_hospital_months: (_fixture, badId) => {
      db.prepare('INSERT INTO reconcile_hospital_months (id, partner_id, service_month) VALUES (?, ?, ?)')
        .run(badId, `PT-RID95-${++sequence}`, '2099-01')
    },
  }

  for (const target of rowIdTargets) {
    it(`rejects INSERT with NULL or empty row id on ${target.label} (FK on, otherwise-legal row)`, () => {
      const fixture = seedRowIdFixture(`rowid-insert-${target.label}`)
      expectDatabaseMutationBlocked(db, () => {
        insertLegalWriters[target.label](fixture, null)
      }, new RegExp(`RECONCILE_ROW_ID_EMPTY:${target.label}$`))
      expectDatabaseMutationBlocked(db, () => {
        insertLegalWriters[target.label](fixture, '')
      }, new RegExp(`RECONCILE_ROW_ID_EMPTY:${target.label}$`))
      const dirty = db.prepare(`
        SELECT COUNT(*) AS n FROM ${target.label} WHERE ${target.idColumn} IS NULL OR ${target.idColumn} = ''
      `).get() as { n: number }
      expect(dirty.n).toBe(0)
    })
  }

  it('keeps legitimate verdict, supplement-collect, complete and close writes green', () => {
    // 不误伤对照：合法写者从不改写主键——verdict / 补收审批与收款 / complete / close 全绿。
    const fixture = seedRowIdFixture('rowid-legit')
    db.prepare(`
      UPDATE supplement_orders
         SET review_status = 'approved', reviewed_by = 'USER-002', reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(String(fixture.g2SupplementId))
    db.prepare(`
      UPDATE supplement_orders
         SET status = '已补收', collected_at = CURRENT_TIMESTAMP, collected_month = '2026-09',
             collected_revenue = 100
       WHERE id = ?
    `).run(String(fixture.g2SupplementId))
    lifecycle.completeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    lifecycle.closeAccountReconciliation(db, fixture.nextBinding, 'USER-001')
    expect(
      db.prepare('SELECT id FROM supplement_orders WHERE id = ?').get(String(fixture.g2SupplementId)),
    ).toEqual({ id: String(fixture.g2SupplementId) })
    const closed = db.prepare(`
      SELECT status FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(fixture.nextBinding.reconcileGenerationId) as { status: string }
    expect(closed.status).toBe('closed')
  })

  // 例 4（四表各一 it）：历史脏行逐表首启/重启——INSERT 造脏（不碰既有引用链，无扫描代打），
  // 摘新 guard 后写入 ''-id 行；首启拒 → 重启（事务回滚脏行仍在，第二次是独立完整运行）再拒 →
  // DELETE 脏行恢复 → FK=ON+读回 1+check 空 → 第三次 upgrade 成功。
  const historyDirtyWriters: Record<string, (connection: DatabaseSync, fixture: RowIdFixture) => void> = {
    reconcile_diffs: (connection, fixture) => {
      connection.prepare(`
        INSERT INTO reconcile_diffs
          (id, hospital_month_id, partner_id, service_month, case_no, line_type, reconcile_generation_id)
        VALUES ('', ?, ?, ?, ?, '少收', ?)
      `).run(
        fixture.hospitalMonthId, fixture.binding.partnerId, fixture.binding.settlementMonth,
        `CASE-RID95-DIRTY-${++sequence}`, fixture.nextBinding.reconcileGenerationId,
      )
    },
    supplement_orders: (connection, fixture) => {
      connection.prepare('INSERT INTO supplement_orders (id, partner_id, service_month) VALUES (?, ?, ?)')
        .run('', fixture.binding.partnerId, fixture.binding.settlementMonth)
    },
    account_reconcile_generations: (connection, fixture) => {
      // 与 fixture 同一合法 partner/month/statement/hospital binding（后续 #87 binding
      // 启动扫描不会在此行上代打）；is_current=0 绕开 partial current unique，
      // 新行无下游引用（无 diff/supplement 指向它）。
      connection.prepare(`
        INSERT INTO account_reconcile_generations (
          reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
          hospital_month_id, is_current, source_readiness_json, source_readiness_hash,
          statement_artifact_hash, snapshot_json, snapshot_hash
        ) VALUES ('', ?, ?, ?, ?, 0, '{}', 'rid95', 'rid95', '{}', 'rid95')
      `).run(
        fixture.binding.partnerId, fixture.binding.settlementMonth,
        fixture.binding.statementGenerationId, fixture.hospitalMonthId,
      )
    },
    reconcile_hospital_months: (connection, fixture) => {
      connection.prepare('INSERT INTO reconcile_hospital_months (id, partner_id, service_month) VALUES (?, ?, ?)')
        .run('', fixture.binding.partnerId, '2099-01')
    },
  }

  const rowIdGuardTriggerNames: Record<string, string[]> = {
    reconcile_diffs: ['trg_reconcile_diff_row_id_insert', 'trg_reconcile_diff_row_id_update'],
    supplement_orders: ['trg_reconcile_supplement_row_id_insert', 'trg_reconcile_supplement_row_id_update'],
    account_reconcile_generations: [
      'trg_account_reconcile_generation_row_id_insert',
      'trg_account_reconcile_generation_row_id_update',
    ],
    reconcile_hospital_months: [
      'trg_reconcile_hospital_month_row_id_insert',
      'trg_reconcile_hospital_month_row_id_update',
    ],
  }

  for (const target of rowIdTargets) {
    it(`catches pre-existing dirty row id on ${target.label} at first boot and restart, then recovers`, () => {
      const fixture = seedRowIdFixture(`rowid-history-${target.label}`)
      const probePath = join(testDirectory, `rowid-history-${target.label}-${++sequence}.sqlite`)
      db.prepare('VACUUM INTO ?').run(probePath)
      const probe = openRegisteredTestDatabase(probePath)
      try {
        // 摘新 guard（修复前不存在则 DROP IF EXISTS 无效果）后 INSERT ''-id 历史脏行；
        // INSERT 造脏不碰既有引用链，FK=ON 下其余列/FK 全合法，无扫描代打。
        for (const name of rowIdGuardTriggerNames[target.label]) {
          probe.exec(`DROP TRIGGER IF EXISTS ${name}`)
        }
        historyDirtyWriters[target.label](probe, fixture)
        // 首启拒启
        expect(() => manager.upgradeAccountReconciliationSchema(probe))
          .toThrow(new RegExp(`RECONCILE_ROW_ID_EMPTY:${target.label}:`))
        // 重启仍拒启（启动事务回滚，脏行仍在——第二次是独立完整运行，非首启余波）
        expect(() => manager.upgradeAccountReconciliationSchema(probe))
          .toThrow(new RegExp(`RECONCILE_ROW_ID_EMPTY:${target.label}:`))
        // 恢复：DELETE 脏行（generations 的 init-only no_delete 需先摘）
        if (target.label === 'account_reconcile_generations') {
          probe.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_no_delete')
        }
        probe.prepare(`DELETE FROM ${target.label} WHERE ${target.idColumn} = ''`).run()
        // FK 回 ON + 读回 1 + foreign_key_check 为空（全程未关 FK，幂等确认）
        probe.exec('PRAGMA foreign_keys = ON')
        expect(foreignKeysPragmaValue(probe)).toBe(1)
        expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        // 第三次 upgrade 成功（扫描放行 + trigger 重装就位）
        expect(() => manager.upgradeAccountReconciliationSchema(probe)).not.toThrow()
      } finally {
        probe.close()
      }
    })
  }
})

describe('LOC-005 FUP #87 trigger single authority, pending state machines, binding relation guards and boot fail-closed scans', () => {
  // #87 勘误后有效合同（Issue #87 body 2026-07-29 勘误版）：
  // a) trigger 单一权威——init 段不再保存漂移副本；trg_account_reconcile_no_delete /
  //    trg_account_reconcile_closed_immutable 纳入每次 boot 的 DROP+CREATE 部署集合；
  //    fresh/存量启动后实际 sqlite_master 集合与关键 SQL 文本由本文件的权威清单钉版。
  // b) pending generation 状态机 DB 闸：直接 SQL pending→closed/非法 status、is_current
  //    0→1 复活拒绝；合法退役(1→0)、pending→complete、complete→closed 不误伤。
  // c) pending hospital-month 状态机 DB 闸：pending 窗口（completed_at/closed_at 均 NULL）
  //    的关账字段伪写、非法/直接关账状态、malformed 完成、reopen 伪造全拒；
  //    合法 compute/verdict/complete/close 全链路绿。
  // d) binding 行级关系闸：hospital_month_id 漂移全拒；generation INSERT 必须存在且
  //    hospital_month_id 等值；UPDATE 还必须指向当前代（合法 upsert rebind 总是指向
  //    刚 INSERT 的 is_current=1 新代，同月 stale 代漂移被 NOT_CURRENT 拒）。
  // e) 启动 fail-closed：bindings 表先存判定（同 R8 P1-2 列先存范式）——仅真 predecessor
  //    （表原本不存在）才 backfill；当前形状库不再经 INSERT OR IGNORE 静默修；
  //    缺 binding / 悬空 generation / binding↔generation 医院月不等值三扫描各自独立命中。

  const normalizeTriggerSql = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  // 权威关键文本（钉版对象：P1-C 起 immutable_fact 十列全 NULL-safe IS NOT——原 `<>`
  // 三值旁路在 statement_artifact_hash NULL 时放行 NULL↔value 漂移；两只原 init-only
  // 部署缺口不变）。两侧均经 normalizeTriggerSql 归一，格式漂移不造成假红，语义漂移必红。
  const AUTHORITATIVE_TRIGGER_TEXTS: Record<string, string> = {
    trg_account_reconcile_immutable_fact: `
      CREATE TRIGGER trg_account_reconcile_immutable_fact
      BEFORE UPDATE ON account_reconcile_generations
      WHEN OLD.reconcile_generation_id IS NOT NEW.reconcile_generation_id
        OR OLD.partner_id IS NOT NEW.partner_id
        OR OLD.settlement_month IS NOT NEW.settlement_month
        OR OLD.statement_generation_id IS NOT NEW.statement_generation_id
        OR OLD.hospital_month_id IS NOT NEW.hospital_month_id
        OR OLD.source_readiness_json IS NOT NEW.source_readiness_json
        OR OLD.source_readiness_hash IS NOT NEW.source_readiness_hash
        OR OLD.statement_artifact_hash IS NOT NEW.statement_artifact_hash
        OR OLD.snapshot_json IS NOT NEW.snapshot_json
        OR OLD.snapshot_hash IS NOT NEW.snapshot_hash
      BEGIN
        SELECT RAISE(ABORT, 'IMMUTABLE_RECONCILIATION_FACT');
      END`,
    trg_account_reconcile_no_delete: `
      CREATE TRIGGER trg_account_reconcile_no_delete
      BEFORE DELETE ON account_reconcile_generations
      BEGIN
        SELECT RAISE(ABORT, 'IMMUTABLE_RECONCILIATION_FACT');
      END`,
    trg_account_reconcile_closed_immutable: `
      CREATE TRIGGER trg_account_reconcile_closed_immutable
      BEFORE UPDATE ON account_reconcile_generations
      WHEN OLD.status = 'closed'
      BEGIN
        SELECT RAISE(ABORT, 'CLOSED_RECONCILIATION_IMMUTABLE');
      END`,
  }

  // 权威集合（钉版对象）：升级函数每次 boot DROP+CREATE 的全部 reconcile 族 trigger。
  // trg_hcm_% 族属 hospital-cm-period-evidence 模块自有权威（IF NOT EXISTS 安装），不在本清单。
  // 任何一只从升级函数部署集合移除/新增而不同步本清单 → 本清单钉版测试红。
  const AUTHORITATIVE_TRIGGER_SET: Record<string, string[]> = {
    reconcile_diffs: [
      'trg_reconcile_diff_row_id_insert',
      'trg_reconcile_diff_row_id_update',
      'trg_reconcile_diff_final_immutable',
      'trg_reconcile_diff_final_no_insert',
      'trg_reconcile_diff_final_no_delete',
      'trg_reconcile_diff_identity_immutable',
    ],
    supplement_orders: [
      'trg_reconcile_supplement_row_id_insert',
      'trg_reconcile_supplement_row_id_update',
      'trg_reconcile_supplement_generation_insert',
      'trg_reconcile_supplement_generation_update',
      'trg_reconcile_supplement_final_immutable',
      'trg_reconcile_supplement_final_no_insert',
      'trg_reconcile_supplement_final_no_delete',
      'trg_reconcile_supplement_collected_month_insert',
      'trg_reconcile_supplement_collected_month_update',
    ],
    account_reconcile_generations: [
      'trg_account_reconcile_generation_row_id_insert',
      'trg_account_reconcile_generation_row_id_update',
      'trg_account_reconcile_immutable_fact',
      'trg_account_reconcile_completion_immutable',
      'trg_account_reconcile_complete_finality',
      'trg_account_reconcile_no_delete',
      'trg_account_reconcile_closed_immutable',
      'trg_account_reconcile_pending_state_guard',
    ],
    reconcile_hospital_months: [
      'trg_reconcile_hospital_month_row_id_insert',
      'trg_reconcile_hospital_month_row_id_update',
      'trg_reconcile_hospital_month_closed_immutable',
      'trg_reconcile_hospital_month_complete_finality',
      'trg_reconcile_hospital_month_pending_guard',
      'trg_reconcile_hospital_month_pending_identity_freeze',
      'trg_reconcile_hospital_month_pending_insert_shape',
    ],
    account_reconcile_hospital_month_bindings: [
      'trg_reconcile_binding_final_immutable',
      'trg_reconcile_binding_closed_no_insert',
      'trg_reconcile_binding_final_no_delete',
      'trg_reconcile_binding_month_immutable',
      'trg_reconcile_binding_generation_relation_insert',
      'trg_reconcile_binding_generation_relation_update',
    ],
    account_reconcile_completion_legacy_provenance: [
      'trg_reconcile_legacy_provenance_no_insert',
      'trg_reconcile_legacy_provenance_no_update',
      'trg_reconcile_legacy_provenance_no_delete',
    ],
  }
  const RECONCILE_GUARD_TABLES = Object.keys(AUTHORITATIVE_TRIGGER_SET)

  function reconcileTriggerNames(connection: DatabaseSync): Record<string, string[]> {
    const rows = connection.prepare(`
      SELECT tbl_name AS tbl, name AS name
        FROM sqlite_master
       WHERE type = 'trigger' AND name NOT LIKE 'trg_hcm_%'
    `).all() as Array<{ tbl: string; name: string }>
    const grouped: Record<string, string[]> = {}
    for (const table of RECONCILE_GUARD_TABLES) grouped[table] = []
    for (const row of rows) {
      if (RECONCILE_GUARD_TABLES.includes(row.tbl)) grouped[row.tbl].push(row.name)
    }
    for (const table of RECONCILE_GUARD_TABLES) grouped[table].sort()
    return grouped
  }

  function triggerSqlByName(connection: DatabaseSync, name: string): string {
    const row = connection.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
    ).get(name) as { sql: string } | undefined
    if (!row) throw new Error(`trigger missing: ${name}`)
    return String(row.sql)
  }

  function vacuumProbe(label: string): DatabaseSync {
    const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    return openRegisteredTestDatabase(probePath)
  }

  function seedPendingMonth(name: string) {
    const binding = seedSource({ name, lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    return { binding, hospitalMonthId: String(snapshot.hospitalMonthId) }
  }

  // ── a) trigger 单一权威与钉版 ──────────────────────────────────────────────

  it('keeps a single trigger authority: no IF-NOT-EXISTS drift copies of the reconcile family remain in DatabaseManager source', () => {
    // 源码级钉版：init 段不得再保存 reconcile 族 trigger 副本——升级函数是唯一权威。
    // IF NOT EXISTS 形状是漂移副本的机械签名（升级函数用plain CREATE TRIGGER），
    // 修复前 init 段恰有 5 只（immutable_fact 9 条件漂移版/no_delete/closed_immutable/
    // 两只 complete_finality），本断言修复前必红。
    const sourcePath = fileURLToPath(new URL('../src/database/DatabaseManager.ts', import.meta.url))
    const source = readFileSync(sourcePath, 'utf8')
    const driftCopies = source.match(
      /CREATE TRIGGER IF NOT EXISTS trg_(account_reconcile|reconcile_hospital_month|reconcile_binding|reconcile_diff|reconcile_supplement)[\w]*/g,
    )
    expect(driftCopies).toBeNull()
  })

  it('reinstalls authoritative texts over stale no_delete/closed_immutable/immutable_fact on existing databases at boot', () => {
    // 部署缺口 RED：两只原 init-only trigger 不在重装集合时，存量库上的陈旧文本
    // （此处模拟为改写过 RAISE 消息/少条件的版本）开机后仍残留；纳入重装集合后被权威文本替换。
    // immutable_fact 腿修复前即绿（升级函数历来重装它）——作为钉版对照保留。
    const probe = vacuumProbe('87-stale-text')
    try {
      probe.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_immutable_fact')
      probe.exec(`
        CREATE TRIGGER trg_account_reconcile_immutable_fact
        BEFORE UPDATE ON account_reconcile_generations
        WHEN OLD.reconcile_generation_id <> NEW.reconcile_generation_id
          OR OLD.partner_id <> NEW.partner_id
          OR OLD.settlement_month <> NEW.settlement_month
          OR OLD.statement_generation_id <> NEW.statement_generation_id
          OR OLD.hospital_month_id <> NEW.hospital_month_id
          OR OLD.source_readiness_json <> NEW.source_readiness_json
          OR OLD.source_readiness_hash <> NEW.source_readiness_hash
          OR OLD.snapshot_json <> NEW.snapshot_json
          OR OLD.snapshot_hash <> NEW.snapshot_hash
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_RECONCILIATION_FACT');
        END
      `)
      probe.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_no_delete')
      probe.exec(`
        CREATE TRIGGER trg_account_reconcile_no_delete
        BEFORE DELETE ON account_reconcile_generations
        BEGIN
          SELECT RAISE(ABORT, 'STALE_NO_DELETE_TEXT');
        END
      `)
      probe.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_closed_immutable')
      probe.exec(`
        CREATE TRIGGER trg_account_reconcile_closed_immutable
        BEFORE UPDATE ON account_reconcile_generations
        WHEN OLD.status = 'closed'
        BEGIN
          SELECT RAISE(ABORT, 'STALE_CLOSED_TEXT');
        END
      `)
      manager.upgradeAccountReconciliationSchema(probe)
      for (const [name, text] of Object.entries(AUTHORITATIVE_TRIGGER_TEXTS)) {
        expect(normalizeTriggerSql(triggerSqlByName(probe, name)))
          .toBe(normalizeTriggerSql(text))
      }
    } finally {
      probe.close()
    }
  })

  it('pins the full reconcile trigger set and key texts after dropping the whole family and rebooting an existing database', () => {
    // 部署集合钉版：把探针库上 reconcile 族 trigger 全部摘掉后开机——升级函数必须
    // 按权威清单重装全集（缺任意一只 CREATE → 集合不齐 → 红；多任何一只 → 红）。
    // 修复前 5 只新 guard 不存在于任何重装路径 → 集合必缺 → 本例必红。
    const probe = vacuumProbe('87-trigger-set')
    try {
      for (const names of Object.values(reconcileTriggerNames(probe))) {
        for (const name of names) probe.exec(`DROP TRIGGER IF EXISTS ${name}`)
      }
      expect(Object.values(reconcileTriggerNames(probe)).flat()).toEqual([])
      manager.upgradeAccountReconciliationSchema(probe)
      const actual = reconcileTriggerNames(probe)
      for (const table of RECONCILE_GUARD_TABLES) {
        expect(actual[table]).toEqual([...AUTHORITATIVE_TRIGGER_SET[table]].sort())
      }
      for (const [name, text] of Object.entries(AUTHORITATIVE_TRIGGER_TEXTS)) {
        expect(normalizeTriggerSql(triggerSqlByName(probe, name)))
          .toBe(normalizeTriggerSql(text))
      }
    } finally {
      probe.close()
    }
  })

  // ── b) pending generation 状态机 DB 闸 ────────────────────────────────────

  it('rejects direct pending→closed and out-of-state-machine status writes on a pending generation (zero write)', () => {
    const { binding } = seedPendingMonth('87-gen-pending')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = 'attacker'
         WHERE reconcile_generation_id = ?
      `).run(binding.reconcileGenerationId)
    }, /PENDING_RECONCILIATION_TRANSITION_INVALID/)
    // 非法 status：修复前由 DDL CHECK 以通用 constraint 文案拒绝；修复后 BEFORE trigger
    // 先于约束检查以专属稳定码拒绝（BEFORE trigger 先求值，本断言钉的是新码归属）。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_generations SET status = 'garbage'
         WHERE reconcile_generation_id = ?
      `).run(binding.reconcileGenerationId)
    }, /PENDING_RECONCILIATION_TRANSITION_INVALID/)
    const row = db.prepare(`
      SELECT status, closed_at, closed_by FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId) as { status: string; closed_at: unknown; closed_by: unknown }
    expect(row).toMatchObject({ status: 'pending', closed_at: null, closed_by: null })
  })

  it('rejects is_current resurrection 0→1 on a retired pending generation while allowing legal retirement 1→0 (probe)', () => {
    // 退役(1→0)=合法 supersede 形状（本例显式钉放行）；复活(0→1)=攻击形状
    //（stale 事实集复活为当前代，应用无任何复活流）。探针库上退役后无同院月当前代，
    // partial unique index 不代打——拒复活完全由新 guard 承重。
    const { binding } = seedPendingMonth('87-gen-resurrect')
    const probe = vacuumProbe('87-gen-resurrect')
    try {
      const retired = probe.prepare(`
        UPDATE account_reconcile_generations SET is_current = 0
         WHERE reconcile_generation_id = ? AND is_current = 1 AND status = 'pending'
      `).run(binding.reconcileGenerationId)
      expect(Number(retired.changes)).toBe(1)
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          UPDATE account_reconcile_generations SET is_current = 1
           WHERE reconcile_generation_id = ?
        `).run(binding.reconcileGenerationId)
      }, /PENDING_RECONCILIATION_CURRENT_RESURRECT/)
      const row = probe.prepare(`
        SELECT is_current FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(binding.reconcileGenerationId) as { is_current: number }
      expect(Number(row.is_current)).toBe(0)
    } finally {
      probe.close()
    }
  })

  it('keeps the legal compute→verdict→complete→close chain green through every new guard', () => {
    // 不误伤对照：generation pending→complete→closed 与医院月 待复核→复核完成→已关账
    // 全链路真实跑通（verdict 走 '核对无误' 无补收单；#95 合法流例已覆盖补收收款腿）。
    const binding = seedSource({ name: '87-legal-chain', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const hospitalMonthId = String(snapshot.hospitalMonthId)
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    lifecycle.closeAccountReconciliation(db, binding, 'USER-001')
    const generation = db.prepare(`
      SELECT status, is_current FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId) as { status: string; is_current: number }
    expect(generation).toMatchObject({ status: 'closed', is_current: 1 })
    const month = db.prepare(`
      SELECT status, completed_by, closed_by FROM reconcile_hospital_months WHERE id = ?
    `).get(hospitalMonthId) as { status: string; completed_by: string; closed_by: string }
    expect(month).toMatchObject({ status: '已关账', completed_by: 'USER-001', closed_by: 'USER-001' })
    const bindingRow = db.prepare(`
      SELECT reconcile_generation_id AS generationId
        FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
    `).get(hospitalMonthId) as { generationId: string }
    expect(bindingRow.generationId).toBe(binding.reconcileGenerationId)
  })

  // ── c) pending hospital-month 状态机 DB 闸 ────────────────────────────────

  it('rejects forged close fields on a pending hospital month (zero write)', () => {
    const { hospitalMonthId } = seedPendingMonth('87-month-close-forge')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET status = '已关账', closed_at = CURRENT_TIMESTAMP, closed_by = 'attacker'
         WHERE id = ?
      `).run(hospitalMonthId)
    }, /PENDING_HOSPITAL_MONTH_CLOSE_FORGED/)
    const row = db.prepare(
      'SELECT status, closed_at, closed_by FROM reconcile_hospital_months WHERE id = ?',
    ).get(hospitalMonthId) as { status: string; closed_at: unknown; closed_by: unknown }
    expect(row).toMatchObject({ status: '待复核', closed_at: null, closed_by: null })
  })

  it('rejects direct-close and garbage status values on a pending hospital month (zero write)', () => {
    const { hospitalMonthId } = seedPendingMonth('87-month-status')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`UPDATE reconcile_hospital_months SET status = '已关账' WHERE id = ?`)
        .run(hospitalMonthId)
    }, /PENDING_HOSPITAL_MONTH_TRANSITION_INVALID/)
    // 医院月 status 无 DDL CHECK——garbage 值修复前真实落库（真 RED），修复后专属码拒。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`UPDATE reconcile_hospital_months SET status = 'bogus' WHERE id = ?`)
        .run(hospitalMonthId)
    }, /PENDING_HOSPITAL_MONTH_TRANSITION_INVALID/)
    const row = db.prepare(
      'SELECT status FROM reconcile_hospital_months WHERE id = ?',
    ).get(hospitalMonthId) as { status: string }
    expect(row.status).toBe('待复核')
  })

  it('rejects malformed completion writes on a pending hospital month (zero write)', () => {
    const { hospitalMonthId } = seedPendingMonth('87-month-complete-malformed')
    // 只翻状态不带终结字段：后续 complete_finality 窗口不接管（completed_at 仍 NULL），
    // 假「复核完成」永远卡死且绕过终结保护——必须在写入侧拒。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`UPDATE reconcile_hospital_months SET status = '复核完成' WHERE id = ?`)
        .run(hospitalMonthId)
    }, /PENDING_HOSPITAL_MONTH_COMPLETION_MALFORMED/)
    // 只写终结字段不翻状态：待复核行携带完成留痕=矛盾形状（合法 compute 显式写 NULL）。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET completed_at = CURRENT_TIMESTAMP, completed_by = 'attacker'
         WHERE id = ?
      `).run(hospitalMonthId)
    }, /PENDING_HOSPITAL_MONTH_COMPLETION_MALFORMED/)
    const row = db.prepare(
      'SELECT status, completed_at, completed_by FROM reconcile_hospital_months WHERE id = ?',
    ).get(hospitalMonthId) as { status: string; completed_at: unknown; completed_by: unknown }
    expect(row).toMatchObject({ status: '待复核', completed_at: null, completed_by: null })
  })

  it('rejects forged reopen fields on a pending hospital month (zero write)', () => {
    // reopened_at/reopen_reason 在 pending 窗口无合法写者（唯一历史写者是已禁用且
    // 被 complete_finality/closed_immutable 拦截的 pre-LOC005 reopen 路由）。
    const { hospitalMonthId } = seedPendingMonth('87-month-reopen-forge')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET reopened_at = CURRENT_TIMESTAMP, reopen_reason = 'forged'
         WHERE id = ?
      `).run(hospitalMonthId)
    }, /PENDING_HOSPITAL_MONTH_REOPEN_FORGED/)
    const row = db.prepare(
      'SELECT reopened_at, reopen_reason FROM reconcile_hospital_months WHERE id = ?',
    ).get(hospitalMonthId) as { reopened_at: unknown; reopen_reason: unknown }
    expect(row).toMatchObject({ reopened_at: null, reopen_reason: null })
  })

  // ── c2) #92 pending 医院月身份冻结（partner_id/service_month 两键）────────────

  it('rejects partner_id drift on a pending hospital month (zero write; fresh schema, real restart, reconcile-authority-only)', () => {
    // #92：partner_id 是医院月身份键——pending 窗口直改会把整月差异/补收事实集静默
    // 挂到别院（月行仍在原 id，diff/supplement 自带 partner_id 不动 → 跨主体拼接）。
    // 现状诚实口径：hcm 周期证据模块的侧挂 trigger（trg_hcm_reconcile_identity_immutable，
    // IF-NOT-EXISTS 安装、明确不在 reconcile 重装权威集）偶然挡住了此写——本域身份
    // 不变量不能寄生于另一模块的侧 trigger（该模块退役/漂移即静默失守）。本测试
    // 前两段断「行为」（fresh/真实 restart 下必须零写失败，两 trigger 均可为拦者）；
    // 第三段断「归属」：探针库摘掉 hcm 侧 trigger 后只剩 reconcile 单一权威——
    // 修复前漂移真实落库（RED），修复后由新权威 trigger 以专属码拒绝（GREEN）。
    // UNIQUE(partner_id, service_month) 只挡撞键，漂移值用全新串规避。
    const { binding, hospitalMonthId } = seedPendingMonth('92-month-identity-partner')
    const drifted = `PARTNER-DRIFT-92-${++sequence}`
    const driftProbe = (connection: DatabaseSync, expected: RegExp) => {
      expectDatabaseMutationBlocked(connection, () => {
        connection.prepare(`
          UPDATE reconcile_hospital_months SET partner_id = ? WHERE id = ?
        `).run(drifted, hospitalMonthId)
      }, expected)
      const row = connection.prepare(
        'SELECT partner_id, service_month FROM reconcile_hospital_months WHERE id = ?',
      ).get(hospitalMonthId) as { partner_id: string; service_month: string }
      expect(row).toMatchObject({
        partner_id: binding.partnerId,
        service_month: binding.settlementMonth,
      })
    }
    driftProbe(db, /PENDING_HOSPITAL_MONTH_IDENTITY_DRIFT|RECONCILE_MONTH_IDENTITY_IMMUTABLE/)
    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    driftProbe(db, /PENDING_HOSPITAL_MONTH_IDENTITY_DRIFT|RECONCILE_MONTH_IDENTITY_IMMUTABLE/)
    const probe = vacuumProbe('92-identity-partner')
    try {
      probe.exec('DROP TRIGGER trg_hcm_reconcile_identity_immutable')
      manager.upgradeAccountReconciliationSchema(probe)
      driftProbe(probe, /PENDING_HOSPITAL_MONTH_IDENTITY_DRIFT/)
    } finally {
      probe.close()
    }
  })

  it('rejects service_month drift on a pending hospital month (zero write; fresh schema, real restart, reconcile-authority-only)', () => {
    // #92：service_month 同身份键——直改把整月事实集静默挂到别月（账期错位）。
    // 结构同上单；漂移值 '2099-12' 与本院（每测试唯一 partner）不构成既有
    // UNIQUE 键，拒绝只能来自 trigger。
    const { binding, hospitalMonthId } = seedPendingMonth('92-month-identity-month')
    const driftProbe = (connection: DatabaseSync, expected: RegExp) => {
      expectDatabaseMutationBlocked(connection, () => {
        connection.prepare(`
          UPDATE reconcile_hospital_months SET service_month = '2099-12' WHERE id = ?
        `).run(hospitalMonthId)
      }, expected)
      const row = connection.prepare(
        'SELECT partner_id, service_month FROM reconcile_hospital_months WHERE id = ?',
      ).get(hospitalMonthId) as { partner_id: string; service_month: string }
      expect(row).toMatchObject({
        partner_id: binding.partnerId,
        service_month: binding.settlementMonth,
      })
    }
    driftProbe(db, /PENDING_HOSPITAL_MONTH_IDENTITY_DRIFT|RECONCILE_MONTH_IDENTITY_IMMUTABLE/)
    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    driftProbe(db, /PENDING_HOSPITAL_MONTH_IDENTITY_DRIFT|RECONCILE_MONTH_IDENTITY_IMMUTABLE/)
    const probe = vacuumProbe('92-identity-month')
    try {
      probe.exec('DROP TRIGGER trg_hcm_reconcile_identity_immutable')
      manager.upgradeAccountReconciliationSchema(probe)
      driftProbe(probe, /PENDING_HOSPITAL_MONTH_IDENTITY_DRIFT/)
    } finally {
      probe.close()
    }
  })

  it('keeps legal pending-window and lifecycle writes green through the identity freeze (verdict/complete/close)', () => {
    // #92 正控：身份冻结只钉 partner_id/service_month 两键——lifecycle 五个合法
    // UPDATE（compute 重算/verdict 的 pending_count/revenue prime/complete 状态+
    // 时间戳+收入/close 状态+时间戳）均不改两键，必须照常绿零误伤。completed
    // 窗口的身份冻结仍归 complete_finality（中途探针证明正交不失）、closed 窗口
    // 归 closed_immutable——三窗各司其职不重叠。
    const { binding, hospitalMonthId } = seedPendingMonth('92-month-identity-legal')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    // completed 窗口正交合同：身份漂移由 complete_finality 以自有码拒绝（既有行为不变）。
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE reconcile_hospital_months SET partner_id = 'PARTNER-DRIFT-92-COMPLETED' WHERE id = ?
      `).run(hospitalMonthId)
    }, /COMPLETE_HOSPITAL_MONTH_FINAL|RECONCILE_MONTH_IDENTITY_IMMUTABLE/)
    expect(lifecycle.closeAccountReconciliation(db, binding, 'USER-001'))
      .toMatchObject({ status: 'closed' })
    const row = db.prepare(
      'SELECT status, partner_id, service_month FROM reconcile_hospital_months WHERE id = ?',
    ).get(hospitalMonthId) as { status: string; partner_id: string; service_month: string }
    expect(row).toMatchObject({
      status: '已关账',
      partner_id: binding.partnerId,
      service_month: binding.settlementMonth,
    })
  })

  // ── c3) #93-A 终态 hospital-month INSERT 闸与启动终态一致性扫描 ────────────

  it('rejects terminal-state hospital month INSERT (zero write; fresh schema and real restart)', () => {
    // A/P1：完成/关账/#92 身份闸均为 BEFORE UPDATE，INSERT 此前只查非空 id——直接
    // SQL 可插入 status='已关账'+confirmed_lab_revenue=999999+completed_*/closed_*=
    // attacker 的伪造终态行，重启放行且 overview 纳入确认实收。新 BEFORE INSERT 闸
    // 只放行严格 pending 形状（lifecycle/reconcile-compute 两个合法 INSERT 均为该
    // 形状：status='待复核'、终态四字段 NULL、revenue NULL、reopen 两字段 NULL）。
    // 修复前三种伪造形状全部真实落库（助手 SAVEPOINT 回滚保证零残留）→ RED。
    const forgedId = `HM-93-FORGED-${++sequence}`
    const forgedPartner = `PT-93-FORGED-${sequence}`
    const terminalShapes = [
      `INSERT INTO reconcile_hospital_months
         (id, partner_id, partner_name, service_month, status, confirmed_lab_revenue,
          completed_at, completed_by, closed_at, closed_by)
       VALUES ('${forgedId}-closed', '${forgedPartner}', 'Forged closed', '2099-01', '已关账',
               999999, CURRENT_TIMESTAMP, 'attacker', CURRENT_TIMESTAMP, 'attacker')`,
      `INSERT INTO reconcile_hospital_months
         (id, partner_id, partner_name, service_month, status, confirmed_lab_revenue,
          completed_at, completed_by)
       VALUES ('${forgedId}-complete', '${forgedPartner}-2', 'Forged complete', '2099-01',
               '复核完成', 888888, CURRENT_TIMESTAMP, 'attacker')`,
      `INSERT INTO reconcile_hospital_months
         (id, partner_id, partner_name, service_month, status, confirmed_lab_revenue)
       VALUES ('${forgedId}-revenue', '${forgedPartner}-3', 'Forged revenue', '2099-01',
               '待复核', 777777)`,
    ]
    const assertInsertsBlocked = (connection: DatabaseSync) => {
      for (const sql of terminalShapes) {
        expectDatabaseMutationBlocked(connection, () => {
          connection.exec(sql)
        }, /PENDING_HOSPITAL_MONTH_INSERT_SHAPE/)
      }
      expect(connection.prepare(`
        SELECT COUNT(*) AS n FROM reconcile_hospital_months WHERE id LIKE ?
      `).get(`${forgedId}-%`)).toMatchObject({ n: 0 })
    }
    assertInsertsBlocked(db)
    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
    assertInsertsBlocked(db)
  })

  it('fails boot when a bound terminal month drifts from its generation (trigger-drop window; first and second boot)', () => {
    // A/P1 启动扫描：有 binding 的终态月必须与所绑 current generation 同院/同月/
    // 同终态（artifact 有效性由既有 completion-shape 扫描在同次 upgrade 内接力）。
    // 漂移经 trigger 被摘窗口注入（complete_finality 冻结 service_month、hcm 侧
    // identity trigger 也挡，均先摘），修复前无任何终态一致性扫描 → 开机放行
    // （RED）；修复后 fail-closed 且同库二次启动一致（幂等）。探针隔离零共享污染。
    const { binding, hospitalMonthId } = seedPendingMonth('93-terminal-scan')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    const probe = vacuumProbe('93-terminal-scan')
    try {
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_complete_finality')
      probe.exec('DROP TRIGGER IF EXISTS trg_hcm_reconcile_identity_immutable')
      probe.prepare(`
        UPDATE reconcile_hospital_months SET service_month = '2099-01' WHERE id = ?
      `).run(hospitalMonthId)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/RECONCILE_HOSPITAL_MONTH_TERMINAL_MISMATCH/)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/RECONCILE_HOSPITAL_MONTH_TERMINAL_MISMATCH/)
    } finally {
      probe.close()
    }
  })

  // ── d) binding 行级关系闸 ─────────────────────────────────────────────────

  it('rejects binding UPDATE repointing to the stale same-month generation (zero write)', () => {
    // #87 主攻击形状：pending 窗口把 binding 直改到同月 stale（is_current=0）旧代——
    // 存在且等值但非当前代；assertHospitalMonthBinding 只在业务动作时 409 延迟发现。
    const fixture = seedSupersededWithSurvivingDiff('87-binding-stale')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ?
         WHERE hospital_month_id = ?
      `).run(fixture.binding.reconcileGenerationId, fixture.hospitalMonthId)
    }, /RECONCILE_BINDING_GENERATION_NOT_CURRENT/)
    const row = db.prepare(`
      SELECT reconcile_generation_id AS generationId
        FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
    `).get(fixture.hospitalMonthId) as { generationId: string }
    expect(row.generationId).toBe(fixture.nextBinding.reconcileGenerationId)
  })

  it('rejects binding UPDATE repointing to another month generation (zero write)', () => {
    // 目标=other 的 stale 旧代：属于 other 的月（与 binding 月不等值）、supersede 后
    // 已从 other binding 解绑（UNIQUE(reconcile_generation_id) 不代打）、FK 存在
    //（FK 不代打）——修复前真实放行；修复后 MISMATCH 段先于 NOT CURRENT 段命中
    //（同体两段顺序 SELECT RAISE，与 #95 row-id update guard 同范式，不靠创建顺序）。
    const fixture = seedSupersededWithSurvivingDiff('87-binding-crossmonth')
    const other = seedSupersededWithSurvivingDiff('87-binding-crossmonth-other')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ?
         WHERE hospital_month_id = ?
      `).run(other.binding.reconcileGenerationId, fixture.hospitalMonthId)
    }, /RECONCILE_BINDING_GENERATION_MISMATCH/)
    const row = db.prepare(`
      SELECT reconcile_generation_id AS generationId
        FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
    `).get(fixture.hospitalMonthId) as { generationId: string }
    expect(row.generationId).toBe(fixture.nextBinding.reconcileGenerationId)
  })

  it('rejects binding UPDATE of hospital_month_id (zero write)', () => {
    // 目标=直插的独立月 C（无 generation、无 binding——PK(hospital_month_id) 不代打）;
    // FK 存在不代打——修复前真实放行。
    const fixture = seedSupersededWithSurvivingDiff('87-binding-month-drift')
    const monthCId = `HM-87-D3-${++sequence}`
    db.prepare('INSERT INTO reconcile_hospital_months (id, partner_id, service_month) VALUES (?, ?, ?)')
      .run(monthCId, fixture.binding.partnerId, '2099-04')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET hospital_month_id = ?
         WHERE hospital_month_id = ?
      `).run(monthCId, fixture.hospitalMonthId)
    }, /RECONCILE_BINDING_MONTH_IMMUTABLE/)
    const rows = db.prepare(`
      SELECT hospital_month_id AS monthId FROM account_reconcile_hospital_month_bindings
       WHERE reconcile_generation_id = ?
    `).all(fixture.nextBinding.reconcileGenerationId) as Array<{ monthId: string }>
    expect(rows).toEqual([{ monthId: fixture.hospitalMonthId }])
  })

  it('rejects binding INSERT whose generation belongs to another hospital month (zero write)', () => {
    // 构造：无 generation 的独立月 C + 属于月 B 的未绑 standalone 代 G（is_current=0，
    // 绕 partial current unique、绕 UNIQUE(reconcile_generation_id)——无约束代打）。
    // 修复前 FK/UNIQUE 全部合法直插成功；修复后关系闸以等值谓词拒。
    const fixture = seedPendingMonth('87-binding-insert-mismatch')
    const monthCId = `HM-87-C-${++sequence}`
    const standaloneGenerationId = `GEN-87-STANDALONE-${++sequence}`
    db.prepare('INSERT INTO reconcile_hospital_months (id, partner_id, service_month) VALUES (?, ?, ?)')
      .run(monthCId, fixture.binding.partnerId, '2099-02')
    db.prepare(`
      INSERT INTO account_reconcile_generations (
        reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
        hospital_month_id, is_current, source_readiness_json, source_readiness_hash,
        statement_artifact_hash, snapshot_json, snapshot_hash
      ) VALUES (?, ?, ?, ?, ?, 0, '{}', 'rid87', 'rid87', '{}', 'rid87')
    `).run(
      standaloneGenerationId,
      fixture.binding.partnerId,
      '2099-02',
      fixture.binding.statementGenerationId,
      fixture.hospitalMonthId,
    )
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        INSERT INTO account_reconcile_hospital_month_bindings
          (hospital_month_id, reconcile_generation_id, binding_state)
        VALUES (?, ?, 'bound')
      `).run(monthCId, standaloneGenerationId)
    }, /RECONCILE_BINDING_GENERATION_MISMATCH/)
    const orphan = db.prepare(`
      SELECT COUNT(*) AS n FROM account_reconcile_hospital_month_bindings
       WHERE hospital_month_id = ? OR reconcile_generation_id = ?
    `).get(monthCId, standaloneGenerationId) as { n: number }
    expect(Number(orphan.n)).toBe(0)
  })

  it('rejects binding INSERT with a dangling generation (probe, FK off, then FK restored)', () => {
    // 悬空代 INSERT：FK 会代打，故在独立 probe 上 FK=OFF（读回 0）仅用于证明
    // 关系闸自身承重；SAVEPOINT 回滚脏写后 FK=ON 读回 1 + foreign_key_check 为空。
    const fixture = seedPendingMonth('87-binding-insert-dangling')
    const probe = vacuumProbe('87-binding-insert-dangling')
    try {
      probe.exec('PRAGMA foreign_keys = OFF')
      expect(foreignKeysPragmaValue(probe)).toBe(0)
      const monthCId = `HM-87-DANGLE-${++sequence}`
      probe.prepare('INSERT INTO reconcile_hospital_months (id, partner_id, service_month) VALUES (?, ?, ?)')
        .run(monthCId, fixture.binding.partnerId, '2099-03')
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          INSERT INTO account_reconcile_hospital_month_bindings
            (hospital_month_id, reconcile_generation_id, binding_state)
          VALUES (?, 'GHOST-GEN-87', 'bound')
        `).run(monthCId)
      }, /RECONCILE_BINDING_GENERATION_MISMATCH/)
      probe.exec('PRAGMA foreign_keys = ON')
      expect(foreignKeysPragmaValue(probe)).toBe(1)
      expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      probe.close()
    }
  })

  it('keeps the legal supersede rebind green through the new relation guards', () => {
    // 不误伤对照：每次 supersede 夹具都经 bindHospitalMonth upsert（ON CONFLICT
    // DO UPDATE reconcile_generation_id）真实穿过新 UPDATE 关系闸——新代在 bind 前
    // 已以 is_current=1 INSERT，存在+等值+当前代三谓词全放行。本例钉死最终结果。
    const fixture = seedSupersededWithSurvivingDiff('87-binding-legal')
    const row = db.prepare(`
      SELECT reconcile_generation_id AS generationId, binding_state AS state
        FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
    `).get(fixture.hospitalMonthId) as { generationId: string; state: string }
    expect(row).toEqual({ generationId: fixture.nextBinding.reconcileGenerationId, state: 'bound' })
  })

  // ── e) 启动 fail-closed 扫描 ───────────────────────────────────────────────

  it('fails closed at first boot and restart when a current-shape database lost a binding, then recovers', () => {
    // 缺 binding：当前形状库（bindings 表先存）不得经 INSERT OR IGNORE 静默修复——
    // pending 窗口 binding_final_no_delete 不拦 DELETE，遗留缺绑必须由启动扫描带出。
    // 修复前开机静默回补（本例必红）；修复后首启+重启均拒，恢复后第三次开机绿。
    const fixture = seedSupersededWithSurvivingDiff('87-scan-missing')
    const probe = vacuumProbe('87-scan-missing')
    try {
      probe.prepare(`
        DELETE FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
      `).run(fixture.hospitalMonthId)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(new RegExp(`RECONCILE_BINDING_MISSING:${fixture.hospitalMonthId}`))
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(new RegExp(`RECONCILE_BINDING_MISSING:${fixture.hospitalMonthId}`))
      // 恢复：关系闸放行（generation 存在且等值），第三次开机绿
      probe.prepare(`
        INSERT INTO account_reconcile_hospital_month_bindings
          (hospital_month_id, reconcile_generation_id, binding_state)
        VALUES (?, ?, 'bound')
      `).run(fixture.hospitalMonthId, fixture.nextBinding.reconcileGenerationId)
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).not.toThrow()
    } finally {
      probe.close()
    }
  })

  it('fails closed on a dangling binding generation at first boot and restart, then recovers', () => {
    // 悬空 generation：FK=ON 下无法直接造成（UPDATE 被 FK 拒），摘关系闸+FK=OFF 造脏；
    // 开机扫描必须独立于 FK 命中（FK 只拦写入，拦不了已入库的悬空）。
    const fixture = seedSupersededWithSurvivingDiff('87-scan-dangling')
    const probe = vacuumProbe('87-scan-dangling')
    try {
      probe.exec('PRAGMA foreign_keys = OFF')
      expect(foreignKeysPragmaValue(probe)).toBe(0)
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_binding_generation_relation_update')
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = 'GHOST-GEN-87-DANGLING'
         WHERE hospital_month_id = ?
      `).run(fixture.hospitalMonthId)
      probe.exec('PRAGMA foreign_keys = ON')
      expect(foreignKeysPragmaValue(probe)).toBe(1)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(new RegExp(`RECONCILE_BINDING_GENERATION_DANGLING:${fixture.hospitalMonthId}`))
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(new RegExp(`RECONCILE_BINDING_GENERATION_DANGLING:${fixture.hospitalMonthId}`))
      // 恢复（关系闸已被摘除于事务外，拒启开机的 ROLLBACK 不恢复它——直写恢复）；
      // FK 校验为空后第三次开机绿（升级函数重装全部 guard）。
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ?
         WHERE hospital_month_id = ?
      `).run(fixture.nextBinding.reconcileGenerationId, fixture.hospitalMonthId)
      expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).not.toThrow()
    } finally {
      probe.close()
    }
  })

  it('fails closed on binding↔generation hospital-month mismatch at first boot and restart, then recovers', () => {
    // 不等值：两院月 binding 互换 generation——缺 binding 扫描（按月查存在性）与
    // 悬空扫描（按代查存在性）双双不命中，只有等值扫描能独立带出。
    // 三步交换绕 UNIQUE(reconcile_generation_id)；FK=OFF 仅为临时占位值。
    const fixtureA = seedSupersededWithSurvivingDiff('87-scan-mismatch-a')
    const fixtureB = seedSupersededWithSurvivingDiff('87-scan-mismatch-b')
    const generationA = fixtureA.nextBinding.reconcileGenerationId
    const generationB = fixtureB.nextBinding.reconcileGenerationId
    const probe = vacuumProbe('87-scan-mismatch')
    try {
      probe.exec('PRAGMA foreign_keys = OFF')
      expect(foreignKeysPragmaValue(probe)).toBe(0)
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_binding_generation_relation_update')
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = 'TMP-87-SWAP' WHERE hospital_month_id = ?
      `).run(fixtureA.hospitalMonthId)
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ? WHERE hospital_month_id = ?
      `).run(generationA, fixtureB.hospitalMonthId)
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ? WHERE hospital_month_id = ?
      `).run(generationB, fixtureA.hospitalMonthId)
      probe.exec('PRAGMA foreign_keys = ON')
      expect(foreignKeysPragmaValue(probe)).toBe(1)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/RECONCILE_BINDING_GENERATION_MONTH_MISMATCH:/)
      expect(() => manager.upgradeAccountReconciliationSchema(probe))
        .toThrow(/RECONCILE_BINDING_GENERATION_MONTH_MISMATCH:/)
      probe.exec('PRAGMA foreign_keys = OFF')
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = 'TMP-87-SWAP-BACK' WHERE hospital_month_id = ?
      `).run(fixtureA.hospitalMonthId)
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ? WHERE hospital_month_id = ?
      `).run(generationB, fixtureB.hospitalMonthId)
      probe.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ? WHERE hospital_month_id = ?
      `).run(generationA, fixtureA.hospitalMonthId)
      probe.exec('PRAGMA foreign_keys = ON')
      expect(foreignKeysPragmaValue(probe)).toBe(1)
      expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).not.toThrow()
    } finally {
      probe.close()
    }
  })

  it('keeps predecessor first-bind backfill green and rebuilds bindings on first upgrade', () => {
    // 合法 predecessor：bindings 表原本不存在 → 建表 + 按当前代 backfill 是首次绑定
    // 正路（不误伤）；backfill 产物必须满足三扫描（存在/等值由 SELECT 构造保证）。
    const fixture = seedSupersededWithSurvivingDiff('87-scan-predecessor')
    const probe = vacuumProbe('87-scan-predecessor')
    try {
      probe.exec('DROP TABLE account_reconcile_hospital_month_bindings')
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).not.toThrow()
      const rebuilt = probe.prepare(`
        SELECT reconcile_generation_id AS generationId, binding_state AS state
          FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
      `).get(fixture.hospitalMonthId) as { generationId: string; state: string } | undefined
      expect(rebuilt).toEqual({
        generationId: fixture.nextBinding.reconcileGenerationId,
        state: 'bound',
      })
    } finally {
      probe.close()
    }
  })
})

describe('LOC-005 FUP P1 binding currentness, generation completion shape and NULL-safe immutable facts', () => {
  // 三路 non-author review REQUEST_CHANGES 的纠正版 RED（按主控勘误 comment-5121977091 A/B/C/D)。
  // production 暂停；本 describe 仅测试改动。
  // P1-A：INSERT binding→stale（is_current=0）代被接受 + 启动扫描无 currentness。
  // P1-B：pending 保持态携带 completion/close 字段、pending→complete 缺 evidence、
  //        is_current=0+complete、缺 evidence 的 malformed complete 可被 close、
  //        current-shape 启动扫描不拦、真 predecessor 缺两列时需 durable sentinel。
  // P1-C：immutable_fact 用 <>（NULL 三值旁路），NULL→value / value→NULL 均绕过。

  function seedPendingMonthP1(name: string) {
    const binding = seedSource({ name, lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    return { binding, hospitalMonthId: String(snapshot.hospitalMonthId) }
  }

  function vacuumProbeP1(label: string): DatabaseSync {
    const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    return openRegisteredTestDatabase(probePath)
  }

  function bindingGenerationRow(connection: DatabaseSync, generationId: string) {
    return connection.prepare(`
      SELECT status, is_current, completed_at, completed_by, closed_at, closed_by,
             completion_artifact_json, completion_artifact_hash
        FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(generationId) as Record<string, unknown> | undefined
  }

  // 精确断言 ReconcileLifecycleError + status=409 + 指定 code；不抛/抛别类都算失败（无兜底）。
  function expectLifecycle409(fn: () => unknown, code: string): void {
    let caught: unknown
    try {
      fn()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(lifecycle.ReconcileLifecycleError)
    const typed = caught as InstanceType<typeof lifecycle.ReconcileLifecycleError>
    expect(typed.code).toBe(code)
    expect(typed.status).toBe(409)
  }

  // B/C：只用 ALTER TABLE DROP COLUMN（摘引用 trigger 后），并断言原 CHECK/UNIQUE/FK/索引
  // 仍在。先摘所有引用该表的 trigger（DROP COLUMN 时它们引用旧 schema 报错）。
  function dropReferencingTriggers(connection: DatabaseSync, table: string) {
    const refs = connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%' || ? || '%'
    `).all(table) as Array<{ name: string }>
    for (const { name } of refs) connection.exec(`DROP TRIGGER IF EXISTS ${name}`)
  }

  // 断言 generations 表的关键约束/索引仍在（DROP COLUMN 不得误伤未引用该列者）。
  function expectGenerationsConstraintsIntact(connection: DatabaseSync) {
    const sql = connection.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'account_reconcile_generations'
    `).get() as { sql: string }
    expect(sql.sql).toMatch("UNIQUE(partner_id, settlement_month, statement_generation_id, reconcile_generation_id)")
    expect(sql.sql).toMatch('FOREIGN KEY(statement_generation_id)')
    expect(sql.sql).toMatch('FOREIGN KEY(hospital_month_id)')
    expect(sql.sql).toMatch('settlement_month GLOB')
    expect(sql.sql).toMatch('is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1))')
    expect(sql.sql).toMatch("CHECK(status IN ('pending', 'complete', 'closed'))")
    const idx = connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account_reconcile_generations'
    `).all() as Array<{ name: string }>
    const names = idx.map(r => r.name)
    expect(names).toContain('uq_account_reconcile_current_month')
    expect(names).toContain('idx_account_reconcile_statement_generation')
    // PRAGMA 双验证（DROP COLUMN / full-DDL rebuild 两路径都必须过）：精确两条 FK 引用结构
    //（statement_generation_id→batches.generation_id、hospital_month_id→months.id），
    // 且 foreign_key_check 零违例。
    const foreignKeys = connection.prepare(
      'PRAGMA foreign_key_list(account_reconcile_generations)',
    ).all() as Array<{ table: string; from: string; to: string }>
    expect(foreignKeys).toHaveLength(2)
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'statement_import_batches',
        from: 'statement_generation_id',
        to: 'generation_id',
      }),
      expect.objectContaining({
        table: 'reconcile_hospital_months',
        from: 'hospital_month_id',
        to: 'id',
      }),
    ]))
    expect(
      connection.prepare('PRAGMA foreign_key_check(account_reconcile_generations)').all(),
    ).toEqual([])
  }

  // 完整精确 DDL 重建 generations（statement_artifact_hash 改 nullable，保留全部约束/索引/行）。
  // 用于 value→NULL：列 pre-existing 但 nullable 且值非 NULL 的真实形状。
  function rebuildGenerationsNullableArtifactHashFullDdl(connection: DatabaseSync) {
    connection.exec('PRAGMA foreign_keys = OFF')
    dropReferencingTriggers(connection, 'account_reconcile_generations')
    connection.exec('BEGIN')
    connection.exec(`
      CREATE TABLE account_reconcile_generations__v (
        reconcile_generation_id TEXT PRIMARY KEY,
        partner_id TEXT NOT NULL,
        settlement_month TEXT NOT NULL CHECK(
          settlement_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
          AND CAST(substr(settlement_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
        ),
        statement_generation_id TEXT NOT NULL,
        hospital_month_id TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'complete', 'closed')),
        source_readiness_json TEXT NOT NULL,
        source_readiness_hash TEXT NOT NULL,
        statement_artifact_hash TEXT,
        snapshot_json TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        completion_artifact_json TEXT,
        completion_artifact_hash TEXT,
        completed_at DATETIME,
        completed_by TEXT,
        closed_at DATETIME,
        closed_by TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(partner_id, settlement_month, statement_generation_id, reconcile_generation_id),
        FOREIGN KEY(statement_generation_id) REFERENCES statement_import_batches(generation_id),
        FOREIGN KEY(hospital_month_id) REFERENCES reconcile_hospital_months(id)
      )
    `)
    connection.exec(`
      INSERT INTO account_reconcile_generations__v
        SELECT reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
               hospital_month_id, is_current, status, source_readiness_json, source_readiness_hash,
               statement_artifact_hash, snapshot_json, snapshot_hash,
               completion_artifact_json, completion_artifact_hash,
               completed_at, completed_by, closed_at, closed_by, created_at, updated_at
          FROM account_reconcile_generations
    `)
    connection.exec('DROP TABLE account_reconcile_generations')
    connection.exec('ALTER TABLE account_reconcile_generations__v RENAME TO account_reconcile_generations')
    connection.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_account_reconcile_current_month
        ON account_reconcile_generations(partner_id, settlement_month) WHERE is_current = 1
    `)
    connection.exec(`
      CREATE INDEX IF NOT EXISTS idx_account_reconcile_statement_generation
        ON account_reconcile_generations(partner_id, settlement_month, statement_generation_id)
    `)
    connection.exec('COMMIT')
    connection.exec('PRAGMA foreign_keys = ON')
  }

  const AUTHORITATIVE_IMMUTABLE_FACT_TEXT = `
    CREATE TRIGGER trg_account_reconcile_immutable_fact
    BEFORE UPDATE ON account_reconcile_generations
    WHEN OLD.reconcile_generation_id IS NOT NEW.reconcile_generation_id
      OR OLD.partner_id IS NOT NEW.partner_id
      OR OLD.settlement_month IS NOT NEW.settlement_month
      OR OLD.statement_generation_id IS NOT NEW.statement_generation_id
      OR OLD.hospital_month_id IS NOT NEW.hospital_month_id
      OR OLD.source_readiness_json IS NOT NEW.source_readiness_json
      OR OLD.source_readiness_hash IS NOT NEW.source_readiness_hash
      OR OLD.statement_artifact_hash IS NOT NEW.statement_artifact_hash
      OR OLD.snapshot_json IS NOT NEW.snapshot_json
      OR OLD.snapshot_hash IS NOT NEW.snapshot_hash
    BEGIN
      SELECT RAISE(ABORT, 'IMMUTABLE_RECONCILIATION_FACT');
    END`

  // ── P1-A binding stale 首绑 / 启动 currentness ────────────────────────────

  it('rejects first-bind INSERT pointing at a stale same-month generation (zero write)', () => {
    // 同 hospital_month 同时有 current 新代与 is_current=0 stale 旧代，首次 INSERT binding
    // 指向 stale——修复前 relation_insert 只查存在+等值，放行。
    const fixture = seedSupersededWithSurvivingDiff('p1a-insert-stale')
    const probe = vacuumProbeP1('p1a-insert-stale')
    try {
      probe.prepare(`
        DELETE FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
      `).run(fixture.hospitalMonthId)
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          INSERT INTO account_reconcile_hospital_month_bindings
            (hospital_month_id, reconcile_generation_id, binding_state)
          VALUES (?, ?, 'bound')
        `).run(fixture.hospitalMonthId, fixture.binding.reconcileGenerationId)
      }, /RECONCILE_BINDING_GENERATION_NOT_CURRENT/)
      const orphan = probe.prepare(`
        SELECT COUNT(*) AS n FROM account_reconcile_hospital_month_bindings WHERE hospital_month_id = ?
      `).get(fixture.hospitalMonthId) as { n: number }
      expect(Number(orphan.n)).toBe(0)
    } finally {
      probe.close()
    }
  })

  it('fails closed at first boot and restart when a current-shape binding points at a stale generation, then recovers', () => {
    // 启动 currentness 扫描：binding 指向 is_current=0 stale 代——缺 binding/悬空/月不等值
    // 三扫描均不命中（代存在、等值），须由独立 currentness 检查带出。
    // 真重启形状：seed 脏文件→close→first 连接 reopen 同一未修文件 throw+close→
    // second 全新连接再 reopen 同一未修文件仍 throw+close→最后才 repair（禁同连接连调冒充重启）。
    const fixture = seedSupersededWithSurvivingDiff('p1a-scan-stale')
    const probePath = join(testDirectory, `p1a-scan-stale-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const seed = openRegisteredTestDatabase(probePath)
    try {
      seed.exec('DROP TRIGGER IF EXISTS trg_reconcile_binding_generation_relation_update')
      seed.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ?
         WHERE hospital_month_id = ?
      `).run(fixture.binding.reconcileGenerationId, fixture.hospitalMonthId)
    } finally {
      seed.close()
    }
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first))
        .toThrow(/RECONCILE_BINDING_GENERATION_NOT_CURRENT:/)
    } finally {
      first.close()
    }
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second))
        .toThrow(/RECONCILE_BINDING_GENERATION_NOT_CURRENT:/)
    } finally {
      second.close()
    }
    const repair = openRegisteredTestDatabase(probePath)
    try {
      repair.exec('DROP TRIGGER IF EXISTS trg_reconcile_binding_generation_relation_update')
      repair.prepare(`
        UPDATE account_reconcile_hospital_month_bindings
           SET reconcile_generation_id = ?
         WHERE hospital_month_id = ?
      `).run(fixture.nextBinding.reconcileGenerationId, fixture.hospitalMonthId)
      expect(() => manager.upgradeAccountReconciliationSchema(repair)).not.toThrow()
    } finally {
      repair.close()
    }
  })

  it('keeps legal current first-bind green through the INSERT currentness guard', () => {
    // 不误伤对照：current 代（is_current=1）首绑放行。
    const fixture = seedPendingMonthP1('p1a-legal-current')
    const monthCId = `HM-P1A-LEGAL-${++sequence}`
    db.prepare('INSERT INTO reconcile_hospital_months (id, partner_id, service_month) VALUES (?, ?, ?)')
      .run(monthCId, fixture.binding.partnerId, '2099-07')
    const currentGenId = `GEN-P1A-CURRENT-${++sequence}`
    db.prepare(`
      INSERT INTO account_reconcile_generations (
        reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
        hospital_month_id, is_current, source_readiness_json, source_readiness_hash,
        statement_artifact_hash, snapshot_json, snapshot_hash
      ) VALUES (?, ?, ?, ?, ?, 1, '{}', 'rid', 'rid', '{}', 'rid')
    `).run(
      currentGenId,
      fixture.binding.partnerId,
      '2099-07',
      fixture.binding.statementGenerationId,
      monthCId,
    )
    db.prepare(`
      INSERT INTO account_reconcile_hospital_month_bindings
        (hospital_month_id, reconcile_generation_id, binding_state)
      VALUES (?, ?, 'bound')
    `).run(monthCId, currentGenId)
    const row = db.prepare(`
      SELECT reconcile_generation_id AS generationId FROM account_reconcile_hospital_month_bindings
       WHERE hospital_month_id = ?
    `).get(monthCId) as { generationId: string }
    expect(row.generationId).toBe(currentGenId)
  })

  // ── P1-B generation pending 状态机形状 ───────────────────────────────────

  it('rejects completion/close field writes on a pending generation that stays pending (zero write)', () => {
    const { binding } = seedPendingMonthP1('p1b-pending-fields')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_generations
           SET completed_at = CURRENT_TIMESTAMP, completed_by = 'attacker'
         WHERE reconcile_generation_id = ?
      `).run(binding.reconcileGenerationId)
    }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_generations
           SET closed_at = CURRENT_TIMESTAMP, closed_by = 'attacker'
         WHERE reconcile_generation_id = ?
      `).run(binding.reconcileGenerationId)
    }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
    expect(bindingGenerationRow(db, binding.reconcileGenerationId)).toMatchObject({
      status: 'pending', completed_at: null, completed_by: null, closed_at: null, closed_by: null,
    })
  })

  it('rejects pending→complete with missing completion shape (zero write)', () => {
    const { binding } = seedPendingMonthP1('p1b-complete-shape')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_generations SET status = 'complete'
         WHERE reconcile_generation_id = ?
      `).run(binding.reconcileGenerationId)
    }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
    expect(bindingGenerationRow(db, binding.reconcileGenerationId)).toMatchObject({ status: 'pending' })
  })

  it('rejects is_current flip to 0 together with complete on a pending generation (zero write)', () => {
    const { binding } = seedPendingMonthP1('p1b-complete-not-current')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', is_current = 0,
               completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
               completion_artifact_json = '{"supplements":[]}', completion_artifact_hash = 'h'
         WHERE reconcile_generation_id = ?
      `).run(binding.reconcileGenerationId)
    }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
    expect(bindingGenerationRow(db, binding.reconcileGenerationId)).toMatchObject({
      status: 'pending', is_current: 1,
    })
  })

  it('rejects closing a malformed complete generation lacking evidence, while legal lifecycle close stays green', () => {
    // A 修正：在独立 probe 上先摘 pending guard 造「缺 evidence 的 malformed complete」
    //（应用流不可能产出），complete_finality 基于 OLD completion shape 拒绝其 close；
    // legal lifecycle close（OLD evidence 完整）在独立对照例保绿。判别只看 OLD 行形状，
    // 不区分 direct SQL/应用流。必须用私有 probe 而非共享 db：production 启动扫描会对
    // malformed current-shape complete fail-closed，共享库残留脏行会污染后续全部用例。
    const binding = seedSource({ name: 'p1b-malformed-close', lisCount: 2 })
    lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const probe = vacuumProbeP1('p1b-malformed-close')
    try {
      probe.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_pending_state_guard')
      probe.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001'
         WHERE reconcile_generation_id = ?
      `).run(binding.reconcileGenerationId)
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = 'attacker'
           WHERE reconcile_generation_id = ?
        `).run(binding.reconcileGenerationId)
      }, /COMPLETE_RECONCILIATION_CLOSE_MALFORMED/)
      expect(bindingGenerationRow(probe, binding.reconcileGenerationId)).toMatchObject({
        status: 'complete', closed_at: null, closed_by: null,
        completion_artifact_json: null, completion_artifact_hash: null,
      })
    } finally {
      probe.close()
    }
  })

  it('keeps the legal complete→close lifecycle chain green through the tightened finality guards', () => {
    const binding = seedSource({ name: 'p1b-legal-close', lisCount: 2 })
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const hospitalMonthId = String(snapshot.hospitalMonthId)
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    lifecycle.closeAccountReconciliation(db, binding, 'USER-001')
    expect(bindingGenerationRow(db, binding.reconcileGenerationId)).toMatchObject({
      status: 'closed', is_current: 1,
    })
  })

  it('fails closed at first boot and a real restart on the SAME unrepaired malformed current-shape database, then repairs', () => {
    // A 修正：first upgrade throw → 关闭连接 → 重开同一未修脏库 → 再次 throw → 最后才 repair。
    // 先 DROP guard 造历史 malformed complete（列先存、evidence 缺失）。
    const fixture = seedPendingMonthP1('p1b-scan-malformed')
    const probePath = join(testDirectory, `p1b-scan-malformed-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const seed = openRegisteredTestDatabase(probePath)
    try {
      // 先由真实 service 写入 verdict（differences 全部复核是真实 complete 的前置），
      // 再摘 guard 造历史 malformed complete（列先存、evidence 缺失）。
      const diff = seed.prepare(
        'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
      ).get(fixture.hospitalMonthId) as { id: string }
      lifecycle.setAccountReconciliationVerdict(
        seed as any, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
      )
      seed.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_pending_state_guard')
      seed.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_complete_finality')
      seed.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001'
         WHERE reconcile_generation_id = ?
      `).run(fixture.binding.reconcileGenerationId)
    } finally {
      seed.close()
    }
    // 首启 fail-closed（同一未修脏库）
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first))
        .toThrow(/RECONCILE_GENERATION_COMPLETION_MALFORMED:/)
    } finally {
      first.close()
    }
    // 真实重启：重开同一未修脏库，仍 fail-closed（脏行未被修复）
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second))
        .toThrow(/RECONCILE_GENERATION_COMPLETION_MALFORMED:/)
    } finally {
      second.close()
    }
    // 最后才 repair：回退 pending 后由真实 lifecycle complete 产出真实自洽的
    // account-reconciliation-completion/v1 artifact + 匹配 sha256 hash（禁 dummy evidence）。
    const repair = openRegisteredTestDatabase(probePath)
    try {
      repair.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_pending_state_guard')
      repair.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_complete_finality')
      repair.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'pending', completed_at = NULL, completed_by = NULL
         WHERE reconcile_generation_id = ?
      `).run(fixture.binding.reconcileGenerationId)
      lifecycle.completeAccountReconciliation(repair as any, fixture.binding, 'USER-001')
      const repaired = repair.prepare(`
        SELECT completion_artifact_json AS json, completion_artifact_hash AS hash
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { json: string; hash: string }
      expect(repaired.json).toContain('account-reconciliation-completion/v1')
      expect(repaired.hash).toBe(
        `sha256:${createHash('sha256').update(repaired.json).digest('hex')}`,
      )
      expect(() => manager.upgradeAccountReconciliationSchema(repair)).not.toThrow()
    } finally {
      repair.close()
    }
  })

  it('writes a durable hash-consistent legacy-missing-artifact sentinel for a real predecessor complete row, staying green across a second boot while close/replay stay fail-closed', () => {
    // A durable：真 predecessor 缺 completion_artifact_json/hash 两列时，既存 complete 行属
    // 受支持旧形状。首启须写入持久、可审计、hash 自洽的 legacy-missing-artifact sentinel
    //（生产实现），断言首启绿、真实第二启（关闭重开）仍绿；service close/replay 对 sentinel
    // 行仍 fail-closed（409 精确码）。修复前无 sentinel 机制，本例必红。
    const fixture = seedPendingMonthP1('p1b-predecessor')
    const probePath = join(testDirectory, `p1b-predecessor-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    let replayDiffId: string
    const seed = openRegisteredTestDatabase(probePath)
    try {
      // 先由真实 service 写入一个 verdict，作为后续 exact replay 的输入；
      // 再人为制造 predecessor complete（真缺两列）。
      const diff = seed.prepare(
        'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
      ).get(fixture.hospitalMonthId) as { id: string }
      replayDiffId = diff.id
      lifecycle.setAccountReconciliationVerdict(
        seed as any, fixture.binding, replayDiffId, '核对无误', null, 'USER-001', 'admin',
      )
      seed.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_pending_state_guard')
      seed.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_complete_finality')
      seed.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001'
         WHERE reconcile_generation_id = ?
      `).run(fixture.binding.reconcileGenerationId)
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      seed.exec('ALTER TABLE account_reconcile_generations DROP COLUMN completion_artifact_json')
      seed.exec('ALTER TABLE account_reconcile_generations DROP COLUMN completion_artifact_hash')
      expectGenerationsConstraintsIntact(seed)
    } finally {
      seed.close()
    }
    // 首启：补列 + 写 sentinel（持久）→ 绿
    let sentinelHash = ''
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).not.toThrow()
      const sentinel = first.prepare(`
        SELECT completion_artifact_json AS json, completion_artifact_hash AS hash
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { json: unknown; hash: unknown }
      // sentinel 持久且 hash 自洽：非 NULL、含 legacy-missing-artifact 标记，
      // hash 精确等于 sha256:<createHash('sha256').update(json).digest('hex')>（禁格式 regex 兜底）。
      expect(typeof sentinel.json).toBe('string')
      expect(String(sentinel.json)).toContain('legacy-missing-artifact')
      const expectedDigest = createHash('sha256').update(String(sentinel.json)).digest('hex')
      expect(String(sentinel.hash)).toBe(`sha256:${expectedDigest}`)
      sentinelHash = String(sentinel.hash)
    } finally {
      first.close()
    }
    // 真实第二启：关闭重开同一库仍绿（sentinel 持久，不首启放行次启自锁）
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).not.toThrow()
      // #93-C：provenance 与 sentinel 同迁移事务写入——存在、hash 与 stored artifact
      // 一致、来源标记精确；三闸在场时任何 INSERT/UPDATE/DELETE 无条件 ABORT。
      const provenance = second.prepare(`
        SELECT artifact_hash AS artifactHash, provenance AS provenance
          FROM account_reconcile_completion_legacy_provenance
         WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as
        | { artifactHash: string; provenance: string }
        | undefined
      expect(provenance).toEqual({
        artifactHash: sentinelHash,
        provenance: 'predecessor-missing-completion-artifact-columns',
      })
      expectDatabaseMutationBlocked(second, () => {
        second.prepare(`
          INSERT INTO account_reconcile_completion_legacy_provenance
            (reconcile_generation_id, artifact_hash, provenance)
          VALUES ('RECON-FORGED-PROVENANCE', 'sha256:forged', 'predecessor-missing-completion-artifact-columns')
        `).run()
      }, /LEGACY_SENTINEL_PROVENANCE_IMMUTABLE/)
      expectDatabaseMutationBlocked(second, () => {
        second.prepare(`
          UPDATE account_reconcile_completion_legacy_provenance
             SET artifact_hash = 'sha256:drifted'
           WHERE reconcile_generation_id = ?
        `).run(fixture.binding.reconcileGenerationId)
      }, /LEGACY_SENTINEL_PROVENANCE_IMMUTABLE/)
      expectDatabaseMutationBlocked(second, () => {
        second.prepare(`
          DELETE FROM account_reconcile_completion_legacy_provenance
           WHERE reconcile_generation_id = ?
        `).run(fixture.binding.reconcileGenerationId)
      }, /LEGACY_SENTINEL_PROVENANCE_IMMUTABLE/)
    } finally {
      second.close()
    }
    // close/replay 对 sentinel 行仍 fail-closed（精确错误，无任意异常兜底）：
    // sentinel 非真实 evidence——close 重算 artifact 与 sentinel 不等 → 409 DECISION_SET_CHANGED；
    // 用 seed 阶段真实写入的 verdict 做 exact replay，sentinel artifact 的 decisions 集
    // 与该 verdict 不符 → 409 VERDICT_REPLAY_STATE_MISMATCH。
    const third = openRegisteredTestDatabase(probePath)
    try {
      manager.upgradeAccountReconciliationSchema(third)
      expectLifecycle409(
        () => lifecycle.closeAccountReconciliation(third as any, fixture.binding, 'USER-001'),
        'DECISION_SET_CHANGED',
      )
      expectLifecycle409(
        () => lifecycle.setAccountReconciliationVerdict(
          third as any, fixture.binding, replayDiffId, '核对无误', null, 'USER-001', 'admin',
        ),
        'VERDICT_REPLAY_STATE_MISMATCH',
      )
    } finally {
      third.close()
    }
  })

  // ── P1-C immutable_fact NULL 三值旁路 ────────────────────────────────────

  it('rejects NULL→value drift on statement_artifact_hash via NULL-safe compare (real predecessor)', () => {
    // B：真 predecessor 用纯 ALTER DROP COLUMN（摘引用 trigger 后），断言 CHECK/UNIQUE/FK/索引
    // 仍在；由 ensureDatabaseColumn 加回 nullable 列（既存行该列 NULL）→ NULL→value 拒。
    const fixture = seedPendingMonthP1('p1c-null-drift')
    const probe = vacuumProbeP1('p1c-null-drift')
    try {
      dropReferencingTriggers(probe, 'account_reconcile_generations')
      // P1 真有效性扫描下，probe 拷贝里其他用例积累的 complete/closed 行在列 drop 后会
      // 形成「artifact.statementArtifactHash ≠ 行 NULL」的真实 drift——本例测 immutable_fact
      // 行为而非 completion 扫描：先把这些行隔离为 pending 形状（清 completion/close 字段），
      // 使列迁移只作用于形状一致的行（主控裁定：不弱化 validator，隔离 fixture）。
      probe.exec(`
        UPDATE account_reconcile_generations
           SET status = 'pending', completed_at = NULL, completed_by = NULL,
               closed_at = NULL, closed_by = NULL,
               completion_artifact_json = NULL, completion_artifact_hash = NULL
         WHERE status IN ('complete', 'closed')
      `)
      // #93-A 终态一致性扫描读另一侧：只隔离 generation 会留下「hm 终态 + 所绑 gen
      // pending」的真实矛盾（生产无任何合法路径产出该形状，正是新扫描的命中对象）。
      // 同款意图扩展：hm 一并隔离回 pending 形状（不触碰 binding/current 标记）。
      // hm 侧 reset 本身被 complete_finality/closed_immutable 拦截——同代次侧先摘
      // 表上 trigger（探针隔离；upgrade 随后按权威集重装 reconcile 族）。
      dropReferencingTriggers(probe, 'reconcile_hospital_months')
      probe.exec(`
        UPDATE reconcile_hospital_months
           SET status = '待复核', completed_at = NULL, completed_by = NULL,
               closed_at = NULL, closed_by = NULL, confirmed_lab_revenue = NULL
         WHERE status IN ('复核完成', '已关账')
            OR completed_at IS NOT NULL OR closed_at IS NOT NULL
      `)
      probe.exec('ALTER TABLE account_reconcile_generations DROP COLUMN statement_artifact_hash')
      expectGenerationsConstraintsIntact(probe)
      manager.upgradeAccountReconciliationSchema(probe) // 加回 nullable 列 + 重装权威 trigger
      const col = probe.prepare(`
        SELECT statement_artifact_hash FROM account_reconcile_generations
         WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { statement_artifact_hash: unknown }
      expect(col.statement_artifact_hash).toBeNull()
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          UPDATE account_reconcile_generations SET statement_artifact_hash = 'sha256:attacker'
           WHERE reconcile_generation_id = ?
        `).run(fixture.binding.reconcileGenerationId)
      }, /IMMUTABLE_RECONCILIATION_FACT/)
      expect(probe.prepare(`
        SELECT statement_artifact_hash FROM account_reconcile_generations
         WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId)).toEqual({ statement_artifact_hash: null })
    } finally {
      probe.close()
    }
  })

  it('rejects value→NULL drift on statement_artifact_hash via NULL-safe compare (fresh non-NULL row)', () => {
    // C：完整精确 DDL 重建使 statement_artifact_hash nullable 且保留非 NULL 值，保留
    // CHECK/UNIQUE/FK并重建/断言索引；upgrade 装 trigger 后测 value→NULL（禁 NOT NULL 代打）。
    const fixture = seedPendingMonthP1('p1c-value-to-null')
    const probe = vacuumProbeP1('p1c-value-to-null')
    try {
      rebuildGenerationsNullableArtifactHashFullDdl(probe)
      expectGenerationsConstraintsIntact(probe)
      manager.upgradeAccountReconciliationSchema(probe) // 重装权威 trigger（含 immutable_fact）
      const before = probe.prepare(`
        SELECT statement_artifact_hash FROM account_reconcile_generations
         WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { statement_artifact_hash: unknown }
      expect(typeof before.statement_artifact_hash).toBe('string')
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          UPDATE account_reconcile_generations SET statement_artifact_hash = NULL
           WHERE reconcile_generation_id = ?
        `).run(fixture.binding.reconcileGenerationId)
      }, /IMMUTABLE_RECONCILIATION_FACT/)
      expect(probe.prepare(`
        SELECT statement_artifact_hash FROM account_reconcile_generations
         WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId)).toEqual(before)
    } finally {
      probe.close()
    }
  })

  it('pins the authoritative immutable_fact text to NULL-safe IS NOT for all fact columns', () => {
    const probe = vacuumProbeP1('p1c-authoritative-text')
    try {
      manager.upgradeAccountReconciliationSchema(probe)
      const sql = probe.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_account_reconcile_immutable_fact'`,
      ).get() as { sql: string }
      expect(sql.sql.replace(/\s+/g, ' ').trim())
        .toBe(AUTHORITATIVE_IMMUTABLE_FACT_TEXT.replace(/\s+/g, ' ').trim())
    } finally {
      probe.close()
    }
  })

  it('keeps a legal predecessor upgrade green after NULL-safe immutable_fact reinstall (NULL stays NULL)', () => {
    const fixture = seedPendingMonthP1('p1c-legal-predecessor')
    const probe = vacuumProbeP1('p1c-legal-predecessor')
    try {
      dropReferencingTriggers(probe, 'account_reconcile_generations')
      // 同 p1c-null-drift：先把其他用例积累的 complete/closed 行隔离为 pending 形状，
      // 再做事例列迁移（statement_artifact_hash DROP→ensure 回 nullable）——真有效性扫描
      // 对 drift 行 fail-closed 是正确行为，不得靠它误伤本例的「合法 predecessor」语义。
      probe.exec(`
        UPDATE account_reconcile_generations
           SET status = 'pending', completed_at = NULL, completed_by = NULL,
               closed_at = NULL, closed_by = NULL,
               completion_artifact_json = NULL, completion_artifact_hash = NULL
         WHERE status IN ('complete', 'closed')
      `)
      // #93-A：同 p1c-null-drift——hm 一并隔离回 pending 形状（否则新终态一致性扫描
      // 正确命中「hm 终态 + 所绑 gen pending」矛盾，与本例「合法 predecessor」语义无关）。
      dropReferencingTriggers(probe, 'reconcile_hospital_months')
      probe.exec(`
        UPDATE reconcile_hospital_months
           SET status = '待复核', completed_at = NULL, completed_by = NULL,
               closed_at = NULL, closed_by = NULL, confirmed_lab_revenue = NULL
         WHERE status IN ('复核完成', '已关账')
            OR completed_at IS NOT NULL OR closed_at IS NOT NULL
      `)
      probe.exec('ALTER TABLE account_reconcile_generations DROP COLUMN statement_artifact_hash')
      expectGenerationsConstraintsIntact(probe)
      manager.upgradeAccountReconciliationSchema(probe)
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).not.toThrow()
      probe.prepare(`
        UPDATE account_reconcile_generations
           SET source_readiness_json = source_readiness_json
         WHERE reconcile_generation_id = ?
      `).run(fixture.binding.reconcileGenerationId)
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).not.toThrow()
    } finally {
      probe.close()
    }
  })

  // ── P1 artifact 真有效性（主控 hostile 探针永久并入）────────────────────────────
  // 合同：有效性 = stored JSON 精确字节的 sha256 自洽 + 结构/行绑定（schemaVersion 精确、
  // binding 四键与 hospitalMonthId/sourceReadinessHash/statementArtifactHash 逐项等于
  // generation 行、confirmedLabRevenue finite、decisions/supplements 为数组且元素受检、
  // id 不重复、supplement.sourceDiffId ∈ decisions）。「{}+正确 hash」等自洽伪凭证必须拒。
  // legacy sentinel 是唯一例外且仅 startup 扫描放行（精确 well-formed）；pending→complete
  // 与 direct SQL close 永不接受 sentinel（trigger 段 allowLegacy=0）。
  // UDF 注册纪律：单一幂等入口由 upgrade 头部承担——本组所有 raw probe 一律先
  // upgrade（注册 + 重装权威 trigger）再做任何写入，绝不手动注册、不旁路。

  const prefixedSha256Of = (json: string) =>
    `sha256:${createHash('sha256').update(json).digest('hex')}`

  interface ArtifactForgeContext {
    binding: Binding
    hospitalMonthId: string
    sourceReadinessHash: unknown
    statementArtifactHash: unknown
    facts: CompletionFactSet
  }

  // 事实集（主控：完成凭证必须封存当前事实集）——测试侧独立构造，与 lifecycle
  // artifact builder 同源同序：decisions 按 case_no, line_type, id（14 键=artifact
  // v1 形状）；supplements 按 source_diff_id, id（8 键，service_month→settlementMonth）；
  // confirmedLabRevenue 权威=reconcile_hospital_months.confirmed_lab_revenue。
  interface CompletionFactSet {
    confirmedLabRevenue: unknown
    decisions: Array<Record<string, unknown>>
    supplements: Array<Record<string, unknown>>
  }

  function readCurrentFactsP1(
    connection: DatabaseSync,
    hospitalMonthId: string,
    generationId: string,
  ): CompletionFactSet {
    const month = connection.prepare(`
      SELECT confirmed_lab_revenue AS confirmedLabRevenue
        FROM reconcile_hospital_months WHERE id = ?
    `).get(hospitalMonthId) as { confirmedLabRevenue: unknown } | undefined
    const decisions = (connection.prepare(`
      SELECT id, partner_id, service_month, case_no, line_type, bill_count, lis_count,
             delta, amount_impact, verdict, verdict_reason, verdict_by, verdict_at, follow_up
        FROM reconcile_diffs
       WHERE hospital_month_id = ? AND reconcile_generation_id = ?
       ORDER BY case_no, line_type, id
    `).all(hospitalMonthId, generationId) as Array<Record<string, unknown>>)
      .map(row => ({
        id: row.id,
        partnerId: row.partner_id,
        serviceMonth: row.service_month,
        caseNo: row.case_no,
        lineType: row.line_type,
        billCount: row.bill_count,
        lisCount: row.lis_count,
        delta: row.delta,
        amountImpact: row.amount_impact,
        verdict: row.verdict,
        verdictReason: row.verdict_reason,
        verdictBy: row.verdict_by,
        verdictAt: row.verdict_at,
        followUp: row.follow_up,
      }))
    const supplements = (connection.prepare(`
      SELECT supplement.id, supplement.source_diff_id, supplement.partner_id,
             supplement.service_month, supplement.case_no, supplement.amount,
             supplement.case_count, supplement.submitted_by
        FROM supplement_orders supplement
        JOIN reconcile_diffs decision ON decision.id = supplement.source_diff_id
       WHERE decision.hospital_month_id = ?
         AND supplement.reconcile_generation_id = ?
         AND decision.reconcile_generation_id = ?
       ORDER BY supplement.source_diff_id, supplement.id
    `).all(hospitalMonthId, generationId, generationId) as Array<Record<string, unknown>>)
      .map(row => ({
        id: row.id,
        sourceDiffId: row.source_diff_id,
        partnerId: row.partner_id,
        settlementMonth: row.service_month,
        caseNo: row.case_no,
        amount: row.amount,
        caseCount: row.case_count,
        submittedBy: row.submitted_by,
      }))
    return { confirmedLabRevenue: month?.confirmedLabRevenue, decisions, supplements }
  }

  function artifactForgeContext(
    connection: DatabaseSync,
    fixture: { binding: Binding; hospitalMonthId: string; facts?: CompletionFactSet },
  ): ArtifactForgeContext {
    const row = connection.prepare(`
      SELECT source_readiness_hash AS sourceReadinessHash,
             statement_artifact_hash AS statementArtifactHash
        FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(fixture.binding.reconcileGenerationId) as {
      sourceReadinessHash: unknown
      statementArtifactHash: unknown
    }
    return {
      binding: fixture.binding,
      hospitalMonthId: fixture.hospitalMonthId,
      sourceReadinessHash: row.sourceReadinessHash,
      statementArtifactHash: row.statementArtifactHash,
      facts: fixture.facts ?? readCurrentFactsP1(
        connection, fixture.hospitalMonthId, fixture.binding.reconcileGenerationId,
      ),
    }
  }

  // 真 artifact 事实基准：在一次性 probe 上走真实 lifecycle complete，读回 stored
  // artifact 的事实三件套（confirmedLabRevenue/decisions/supplements）——伪造基准与
  // builder 输出逐字节同形，单字段变异即最小事实漂移（结构/绑定/hash 恒合法，
  // 保证 RED 只可能是「事实集未比对」而不是形状巧合）。
  function realArtifactFactsP1(
    fixture: { binding: Binding; hospitalMonthId: string },
    label: string,
  ): CompletionFactSet {
    const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const probe = openRegisteredTestDatabase(probePath)
    try {
      manager.upgradeAccountReconciliationSchema(probe)
      lifecycle.completeAccountReconciliation(probe as any, fixture.binding, 'USER-001')
      const stored = probe.prepare(`
        SELECT completion_artifact_json AS json
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { json: string }
      const parsed = JSON.parse(stored.json) as Record<string, unknown>
      return {
        confirmedLabRevenue: parsed.confirmedLabRevenue,
        decisions: parsed.decisions as Array<Record<string, unknown>>,
        supplements: parsed.supplements as Array<Record<string, unknown>>,
      }
    } finally {
      probe.close()
    }
  }

  // 结构合法（可定向变异）的 v1 伪凭证：默认逐项绑定真实行值，decisions/supplements 空数组。
  function forgedV1ArtifactJson(
    context: ArtifactForgeContext,
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      schemaVersion: 'account-reconciliation-completion/v1',
      binding: {
        partnerId: context.binding.partnerId,
        settlementMonth: context.binding.settlementMonth,
        statementGenerationId: context.binding.statementGenerationId,
        reconcileGenerationId: context.binding.reconcileGenerationId,
      },
      hospitalMonthId: context.hospitalMonthId,
      sourceReadinessHash: context.sourceReadinessHash,
      statementArtifactHash: context.statementArtifactHash,
      confirmedLabRevenue: 0,
      decisions: [],
      supplements: [],
      ...overrides,
    })
  }

  // 结构+行绑定+hash 全合法、但事实集可定向变异的 v1 伪凭证——「空证据」攻击面：
  // 凭证与事实集逐项比对前，结构完整、绑定正确、hash 精确的 decisions:[] 会被全通道接受。
  function factBoundArtifactJson(
    context: ArtifactForgeContext,
    facts: CompletionFactSet,
  ): string {
    return JSON.stringify({
      schemaVersion: 'account-reconciliation-completion/v1',
      binding: {
        partnerId: context.binding.partnerId,
        settlementMonth: context.binding.settlementMonth,
        statementGenerationId: context.binding.statementGenerationId,
        reconcileGenerationId: context.binding.reconcileGenerationId,
      },
      hospitalMonthId: context.hospitalMonthId,
      sourceReadinessHash: context.sourceReadinessHash,
      statementArtifactHash: context.statementArtifactHash,
      confirmedLabRevenue: facts.confirmedLabRevenue,
      decisions: facts.decisions,
      supplements: facts.supplements,
    })
  }

  // 事实集丰富 fixture：同院同月 2 条 diff——case A 漏收（bill 1 vs lis 2，认定
  // 「漏收，需补收」驱动一张补收单入 facts.supplements）、case B 计费差异
  // （bill 2 vs lis 0，认定「核对无误」）；generation 保持 pending，供「缺/改/多事实」
  // 单变量伪造提供非空 decisions 与 supplements 基准。批申报数在 INSERT 时即写实（2/2）——
  // posted 批次由 IMMUTABLE_IMPORT_FACT 冻结，事后 UPDATE 计数会被拒。
  function seedFactRichMonthP1(name: string) {
    const month = '2026-08'
    const suffix = `${name}-${++sequence}`
    const partnerId = `PT-LOC005-R2-${suffix}`
    const statementGenerationId = `STMT-LOC005-R2-${suffix}`
    const reconcileGenerationId = `RECON-LOC005-R2-${suffix}`
    const batchId = `BATCH-LOC005-R2-${suffix}`
    const caseNoA = `CASE-LOC005-R2-${suffix}-A`
    const caseNoB = `CASE-LOC005-R2-${suffix}-B`
    db.prepare('INSERT INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)')
      .run(partnerId, `CODE-${suffix}`, `Partner ${suffix}`)
    db.prepare(`
      INSERT INTO statement_import_batches
        (id, partner_id, source_hash, template_family, parser_revision, config_revision,
         settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
      VALUES (?, ?, ?, 'loc005-r2-test', 'r1', 'c1', ?, ?, 1, 2, 2, 'posted')
    `).run(batchId, partnerId, `HASH-${suffix}`, month, statementGenerationId)
    const insertRaw = db.prepare(`
      INSERT INTO statement_raw_rows
        (id, batch_id, generation_id, source_sheet, source_row, row_json)
      VALUES (?, ?, ?, 'sheet', ?, ?)
    `)
    insertRaw.run(`RAW-${suffix}-A`, batchId, statementGenerationId, 1, JSON.stringify({ caseNo: caseNoA, amount: 100 }))
    insertRaw.run(`RAW-${suffix}-B`, batchId, statementGenerationId, 2, JSON.stringify({ caseNo: caseNoB, amount: 200 }))
    const insertLine = db.prepare(`
      INSERT INTO statement_normalized_lines
        (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
         case_no, item_name, source_sheet, source_row, source_column, source_label,
         template_family, row_kind, line_grain, business_line, amount_role, amount,
         classification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet', ?, 'amount', ?,
              'loc005-r2-test', 'detail', 'case', 'IN', 'gross', ?, 'classified')
    `)
    insertLine.run(
      `LINE-${suffix}-A`, batchId, statementGenerationId, partnerId, month, month,
      caseNoA, '免疫组化染色*1', 1, '免疫组化染色*1', 100,
    )
    insertLine.run(
      `LINE-${suffix}-B`, batchId, statementGenerationId, partnerId, month, month,
      caseNoB, '免疫组化染色*2', 2, '免疫组化染色*2', 200,
    )
    const insertLis = db.prepare(`
      INSERT INTO lis_cases
        (id, case_no, partner_id, ihc_count, special_stain_count, operate_time)
      VALUES (?, ?, ?, ?, 0, ?)
    `)
    insertLis.run(`LIS-${suffix}-A`, caseNoA, partnerId, 2, `${month}-15`)
    insertLis.run(`LIS-${suffix}-B`, caseNoB, partnerId, 0, `${month}-16`)
    const insertRevenue = db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')
    `)
    insertRevenue.run(`REV-${suffix}-A`, caseNoA, partnerId, month, 100, 100, 100)
    insertRevenue.run(`REV-${suffix}-B`, caseNoB, partnerId, month, 200, 200, 200)
    const binding: Binding = { partnerId, settlementMonth: month, statementGenerationId, reconcileGenerationId }
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const hospitalMonthId = String(snapshot.hospitalMonthId)
    const diffs = db.prepare(`
      SELECT id, case_no FROM reconcile_diffs
       WHERE hospital_month_id = ? ORDER BY case_no
    `).all(hospitalMonthId) as Array<{ id: string; case_no: string }>
    expect(diffs).toHaveLength(2)
    for (const diff of diffs) {
      lifecycle.setAccountReconciliationVerdict(
        db,
        binding,
        diff.id,
        diff.case_no === caseNoA ? '漏收，需补收' : '核对无误',
        null,
        'USER-001',
        'admin',
      )
    }
    const sqlFacts = readCurrentFactsP1(db, hospitalMonthId, binding.reconcileGenerationId)
    expect(sqlFacts.decisions).toHaveLength(2)
    expect(sqlFacts.supplements).toHaveLength(1)
    // 事实基准 = 真实 builder 产物（独立 probe 上 complete 一次，共享库保持 pending 不受污染）
    const facts = realArtifactFactsP1({ binding, hospitalMonthId }, `${name}-facts`)
    expect(facts.decisions).toHaveLength(2)
    expect(facts.supplements).toHaveLength(1)
    return { binding, hospitalMonthId, facts }
  }

  // 造一行 current-shape complete（artifact 由 forge 给出）→ 首启 fail-closed
  // RECONCILE_GENERATION_COMPLETION_MALFORMED:<id> → 关连接真实重启同一未修库仍同码 →
  // 伪造行零持久修复（json/hash 原样仍在）。
  function expectArtifactBootForgeryRejected(
    label: string,
    forge: (context: ArtifactForgeContext) => { json: string; hash: string },
    seedFixture: (
      name: string,
    ) => { binding: Binding; hospitalMonthId: string; facts?: CompletionFactSet } = seedPendingMonthP1,
  ): void {
    const fixture = seedFixture(label)
    const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    let forgedJson = ''
    let forgedHash = ''
    const seed = openRegisteredTestDatabase(probePath)
    try {
      const forged = forge(artifactForgeContext(seed, fixture))
      forgedJson = forged.json
      forgedHash = forged.hash
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      seed.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(forged.json, forged.hash, fixture.binding.reconcileGenerationId)
    } finally {
      seed.close()
    }
    const expected = new RegExp(
      `RECONCILE_GENERATION_COMPLETION_MALFORMED:${fixture.binding.reconcileGenerationId}`,
    )
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).toThrow(expected)
    } finally {
      first.close()
    }
    // 真实重启：关闭重开同一未修库，仍 fail-closed 同码，且伪造行零持久修复
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).toThrow(expected)
      const persisted = second.prepare(`
        SELECT completion_artifact_json AS json, completion_artifact_hash AS hash
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { json: string; hash: string }
      expect(persisted).toEqual({ json: forgedJson, hash: forgedHash })
    } finally {
      second.close()
    }
  }

  it('rejects a well-hashed empty-object artifact at first boot and a real restart', () => {
    expectArtifactBootForgeryRejected('p1v-empty-object', () => ({
      json: '{}',
      hash: prefixedSha256Of('{}'),
    }))
  })

  it('rejects an unparseable artifact whose hash matches its exact stored bytes', () => {
    const broken = '{"schemaVersion":"account-reconciliation-completion/v1",'
    expectArtifactBootForgeryRejected('p1v-unparseable', () => ({
      json: broken,
      hash: prefixedSha256Of(broken),
    }))
  })

  it('rejects a structurally row-bound v1 artifact whose hash does not match', () => {
    expectArtifactBootForgeryRejected('p1v-hash-mismatch', context => ({
      json: forgedV1ArtifactJson(context),
      hash: `sha256:${'0'.repeat(64)}`,
    }))
  })

  it('rejects a well-hashed v1 artifact with a forged binding', () => {
    expectArtifactBootForgeryRejected('p1v-wrong-binding', context => {
      const json = forgedV1ArtifactJson(context, {
        binding: {
          partnerId: 'PT-FORGED',
          settlementMonth: context.binding.settlementMonth,
          statementGenerationId: context.binding.statementGenerationId,
          reconcileGenerationId: context.binding.reconcileGenerationId,
        },
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed artifact with a wrong schemaVersion', () => {
    expectArtifactBootForgeryRejected('p1v-wrong-schema', context => {
      const json = forgedV1ArtifactJson(context, {
        schemaVersion: 'account-reconciliation-completion/v2',
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed v1 artifact with a forged sourceReadinessHash', () => {
    expectArtifactBootForgeryRejected('p1v-wrong-source-hash', context => {
      const json = forgedV1ArtifactJson(context, {
        sourceReadinessHash: 'sha256:forged-source-readiness',
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed v1 artifact with a forged statementArtifactHash', () => {
    expectArtifactBootForgeryRejected('p1v-wrong-statement-hash', context => {
      const json = forgedV1ArtifactJson(context, {
        statementArtifactHash: 'sha256:forged-statement-artifact',
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed v1 artifact with a non-finite (null) confirmedLabRevenue', () => {
    expectArtifactBootForgeryRejected('p1v-null-revenue', context => {
      const json = forgedV1ArtifactJson(context, { confirmedLabRevenue: null })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed v1 artifact with non-array decisions', () => {
    expectArtifactBootForgeryRejected('p1v-nonarray-decisions', context => {
      const json = forgedV1ArtifactJson(context, { decisions: {} })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed v1 artifact whose decision identity drifts from the generation', () => {
    expectArtifactBootForgeryRejected('p1v-decision-identity', context => {
      const json = forgedV1ArtifactJson(context, {
        decisions: [{
          id: 'diff-forged',
          partnerId: 'PT-FORGED',
          serviceMonth: context.binding.settlementMonth,
          caseNo: 'CASE-X',
          lineType: '免疫组化',
          billCount: 1,
          lisCount: 2,
          delta: -1,
          amountImpact: -100,
          verdict: '核对无误',
          verdictReason: null,
          verdictBy: 'USER-001',
          verdictAt: '2026-08-01 00:00:00',
          followUp: null,
        }],
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed v1 artifact whose supplement points outside decisions', () => {
    expectArtifactBootForgeryRejected('p1v-supplement-dangling', context => {
      const json = forgedV1ArtifactJson(context, {
        supplements: [{
          id: 'so-forged',
          sourceDiffId: 'diff-not-in-decisions',
          partnerId: context.binding.partnerId,
          settlementMonth: context.binding.settlementMonth,
          caseNo: 'CASE-X',
          amount: 100,
          caseCount: 1,
          submittedBy: 'USER-001',
        }],
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed sentinel with a wrong reason even at startup (allowLegacy path)', () => {
    expectArtifactBootForgeryRejected('p1v-sentinel-reason', context => {
      const json = JSON.stringify({
        schemaVersion: 'account-reconciliation-completion/legacy-sentinel-v1',
        marker: 'legacy-missing-artifact',
        reconcileGenerationId: context.binding.reconcileGenerationId,
        reason: 'forged reason',
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects a well-hashed sentinel carrying an extra field even at startup', () => {
    expectArtifactBootForgeryRejected('p1v-sentinel-extra', context => {
      const json = JSON.stringify({
        schemaVersion: 'account-reconciliation-completion/legacy-sentinel-v1',
        marker: 'legacy-missing-artifact',
        reconcileGenerationId: context.binding.reconcileGenerationId,
        reason: 'predecessor schema had no completion artifact columns; original artifact is unrecoverable',
        extra: true,
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  // ── P1 事实集封存（主控：完成凭证必须封存当前事实集）────────────────────────────
  // 结构+行绑定+hash 全合法但事实集漂移的伪凭证，startup/pending→complete/direct close
  // 三通道一律拒绝：空证据（decisions:[]）、缺/篡改一条 decision、缺/多一条 supplement、
  // confirmedLabRevenue ≠ reconcile_hospital_months.confirmed_lab_revenue。
  // 真实 lifecycle artifact（p1v-real-artifact）是两通道正向对照，须保持绿。

  it('rejects a well-hashed fully-bound artifact whose decisions omit the current fact set (empty evidence)', () => {
    expectArtifactBootForgeryRejected('p1f-empty-decisions', context => {
      // 空证据：decisions/supplements 双空 + 真实 revenue——结构与行绑定完全自洽，
      // 只有事实集比对能拒（主控 hostile 探针原型形状）。
      const json = factBoundArtifactJson(context, {
        ...context.facts,
        decisions: [],
        supplements: [],
      })
      return { json, hash: prefixedSha256Of(json) }
    }, seedFactRichMonthP1)
  })

  it('rejects a well-hashed fully-bound artifact missing one current decision', () => {
    expectArtifactBootForgeryRejected('p1f-missing-decision', context => {
      // 缺 case B 一条 decision；保留带补收单的 case A 使 supplements 内部一致——
      // 结构/谱系自洽，只有「decisions ≠ 当前事实集」能拒。
      const json = factBoundArtifactJson(context, {
        ...context.facts,
        decisions: context.facts.decisions.slice(0, 1),
      })
      return { json, hash: prefixedSha256Of(json) }
    }, seedFactRichMonthP1)
  })

  it('rejects a well-hashed fully-bound artifact with one altered decision field', () => {
    expectArtifactBootForgeryRejected('p1f-altered-decision', context => {
      const decisions = context.facts.decisions.map((decision, index) =>
        index === 0 ? { ...decision, delta: Number(decision.delta) + 1 } : decision)
      const json = factBoundArtifactJson(context, { ...context.facts, decisions })
      return { json, hash: prefixedSha256Of(json) }
    }, seedFactRichMonthP1)
  })

  it('rejects a well-hashed fully-bound artifact whose supplements omit the current one', () => {
    expectArtifactBootForgeryRejected('p1f-missing-supplement', context => {
      const json = factBoundArtifactJson(context, { ...context.facts, supplements: [] })
      return { json, hash: prefixedSha256Of(json) }
    }, seedFactRichMonthP1)
  })

  it('rejects a well-hashed fully-bound artifact carrying an extra forged supplement', () => {
    expectArtifactBootForgeryRejected('p1f-extra-supplement', context => {
      const real = context.facts.supplements[0] as Record<string, unknown>
      // 结构合法（sourceDiffId ∈ decisions、id 不重复、partner/月一致）但事实集不存在的补收单
      const forged = { ...real, id: `${String(real.id)}-forged` }
      const json = factBoundArtifactJson(context, {
        ...context.facts,
        supplements: [...context.facts.supplements, forged],
      })
      return { json, hash: prefixedSha256Of(json) }
    }, seedFactRichMonthP1)
  })

  it('rejects a well-hashed fully-bound artifact whose confirmedLabRevenue drifts from the hospital month', () => {
    expectArtifactBootForgeryRejected('p1f-revenue-drift', context => {
      const json = factBoundArtifactJson(context, {
        ...context.facts,
        confirmedLabRevenue: Number(context.facts.confirmedLabRevenue) + 1,
      })
      return { json, hash: prefixedSha256Of(json) }
    }, seedFactRichMonthP1)
  })

  it('rejects a forged pending→complete write carrying fully-bound empty-fact evidence with zero write', () => {
    const fixture = seedFactRichMonthP1('p1f-forged-complete-empty')
    const probe = vacuumProbeP1('p1f-forged-complete-empty')
    try {
      manager.upgradeAccountReconciliationSchema(probe) // 注册 UDF（单一入口）
      const context = artifactForgeContext(probe, fixture)
      const json = factBoundArtifactJson(context, {
        ...context.facts,
        decisions: [],
        supplements: [],
      })
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
                 completion_artifact_json = ?, completion_artifact_hash = ?
           WHERE reconcile_generation_id = ?
        `).run(json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
      }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
      expect(bindingGenerationRow(probe, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'pending',
        completed_at: null,
        completed_by: null,
        completion_artifact_json: null,
        completion_artifact_hash: null,
      })
    } finally {
      probe.close()
    }
  })

  it('rejects a direct SQL close on a complete row carrying fully-bound empty-fact evidence', () => {
    expectDirectCloseRejectedWithCloseMalformed('p1f-close-empty', context => {
      const json = factBoundArtifactJson(context, {
        ...context.facts,
        decisions: [],
        supplements: [],
      })
      return { json, hash: prefixedSha256Of(json) }
    }, seedFactRichMonthP1)
  })

  it('rolls back the revenue prime when a fault is injected right after it (no pending+revenue intermediate state)', () => {
    // 主控合同：prime CAS（revenue 先于 generation 写入月行）之后任一点失败，
    // 事务必须整体回滚——generation 仍 pending、月行仍 待复核、confirmed_lab_revenue
    // 仍 NULL、completion artifact 与 complete audit 均零写，对外不存在
    // pending+revenue 中间态。
    const fixture = seedPendingMonthP1('p1f-revenue-prime-rollback')
    const diffs = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).all(fixture.hospitalMonthId) as Array<{ id: string }>
    for (const diff of diffs) {
      lifecycle.setAccountReconciliationVerdict(
        db, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
      )
    }
    const monthBefore = db.prepare(`
      SELECT status, completed_at, completed_by, confirmed_lab_revenue
        FROM reconcile_hospital_months WHERE id = ?
    `).get(fixture.hospitalMonthId) as Record<string, unknown>
    expect(monthBefore).toMatchObject({
      status: '待复核',
      completed_at: null,
      completed_by: null,
      confirmed_lab_revenue: null,
    })
    const auditBefore = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'complete_generation' AND target_id = ?
    `).get(fixture.binding.reconcileGenerationId) as { n: number }).n)
    let caught: unknown
    try {
      lifecycle.completeAccountReconciliation(
        db, fixture.binding, 'USER-001', 'USER-001', { at: 'afterRevenuePrime' },
      )
    } catch (error) {
      caught = error
    }
    expect(String(caught)).toContain('INJECTED_RECONCILIATION_FAULT:afterRevenuePrime')
    expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
      status: 'pending',
      completed_at: null,
      completed_by: null,
      completion_artifact_json: null,
      completion_artifact_hash: null,
    })
    expect(db.prepare(`
      SELECT status, completed_at, completed_by, confirmed_lab_revenue
        FROM reconcile_hospital_months WHERE id = ?
    `).get(fixture.hospitalMonthId)).toMatchObject({
      status: '待复核',
      completed_at: null,
      completed_by: null,
      confirmed_lab_revenue: null,
    })
    const auditAfter = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'complete_generation' AND target_id = ?
    `).get(fixture.binding.reconcileGenerationId) as { n: number }).n)
    expect(auditAfter).toBe(auditBefore)
  })

  it('pins confirmedLabRevenue round-trip precision beyond 15 significant digits (kills plain %.17g)', () => {
    // 主控实证：SQLite printf('%.17g', 1.2345678901234567) = '1.234567890123457'
    // （截断，Number 后不再等于原值）；printf('%!.17g', …) = '1.2345678901234567'
    // （双精度 round-trip 精确）。事实 SQL 的 revenue 传输必须让 stored REAL 与
    // artifact 数值严格 ===——17 位有效数字的月值首启与真实重启均不得被误拒，
    // 也不得以 epsilon 近似放行。
    const PRECISE = 1.2345678901234567
    const fixture = seedPendingMonthP1('p1f-revenue-roundtrip')
    const diffs = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).all(fixture.hospitalMonthId) as Array<{ id: string }>
    for (const diff of diffs) {
      lifecycle.setAccountReconciliationVerdict(
        db, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
      )
    }
    const probePath = join(testDirectory, `p1f-revenue-roundtrip-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const seed = openRegisteredTestDatabase(probePath)
    try {
      const context = artifactForgeContext(seed, fixture)
      // pending 窗口合法写：直接 SQL 预置 17 位有效数字月值，artifact 封存同一数值
      seed.prepare(
        'UPDATE reconcile_hospital_months SET confirmed_lab_revenue = ? WHERE id = ?',
      ).run(PRECISE, fixture.hospitalMonthId)
      const json = factBoundArtifactJson(context, {
        ...context.facts,
        confirmedLabRevenue: PRECISE,
      })
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      seed.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
    } finally {
      seed.close()
    }
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).not.toThrow()
    } finally {
      first.close()
    }
    // 真实重启：同一库再开仍绿（精确数值两通道一致，无修复动作）
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).not.toThrow()
    } finally {
      second.close()
    }
  })

  it('accepts the real service completion artifact (exact stored-bytes sha256) at first boot and a real restart (raw-probe upgrade→write registration proof)', () => {
    // 正向对照 + 注册覆盖回归：raw probe 不手动注册——upgrade 头部单一入口完成幂等注册；
    // 随后真实 lifecycle complete 触发 pending_state_guard 真有效性段并放行（UDF 在场），
    // artifact stored 字节 sha256 精确自洽，首启与真实重启都绿。
    const fixture = seedPendingMonthP1('p1v-real-artifact')
    const probePath = join(testDirectory, `p1v-real-artifact-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    // 本例是注册证明：两条连接都必须直接 new DatabaseSync（不经包装器预注册），
    // UDF 只能来自 upgrade 头部单一入口。
    const seed = new DatabaseSync(probePath)
    try {
      manager.upgradeAccountReconciliationSchema(seed) // 单一注册入口：raw 连接经 upgrade 获得 UDF
      const diffs = seed.prepare(
        'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
      ).all(fixture.hospitalMonthId) as Array<{ id: string }>
      for (const diff of diffs) {
        lifecycle.setAccountReconciliationVerdict(
          seed as any, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
        )
      }
      lifecycle.completeAccountReconciliation(seed as any, fixture.binding, 'USER-001')
      const stored = seed.prepare(`
        SELECT completion_artifact_json AS json, completion_artifact_hash AS hash
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { json: string; hash: string }
      expect(stored.json).toContain('account-reconciliation-completion/v1')
      expect(stored.hash).toBe(prefixedSha256Of(stored.json))
      expect(() => manager.upgradeAccountReconciliationSchema(seed)).not.toThrow()
    } finally {
      seed.close()
    }
    // 真实重启：同样直接 new DatabaseSync（不经包装器），靠 upgrade 头部注册
    const second = new DatabaseSync(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).not.toThrow()
    } finally {
      second.close()
    }
  })

  it('rejects a forged pending→complete write (well-hashed {} artifact) with zero write', () => {
    // pending_state_guard 真有效性段：伪造非空 artifact（'{}' + 正确 sha256）必须零写拒绝——
    // 「非空/格式像 sha256」不算有效，须过结构与行绑定校验。
    const fixture = seedPendingMonthP1('p1v-forged-complete')
    const probe = vacuumProbeP1('p1v-forged-complete')
    try {
      manager.upgradeAccountReconciliationSchema(probe) // 注册 UDF（单一入口）
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
                 completion_artifact_json = '{}', completion_artifact_hash = ?
           WHERE reconcile_generation_id = ?
        `).run(prefixedSha256Of('{}'), fixture.binding.reconcileGenerationId)
      }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
      expect(bindingGenerationRow(probe, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'pending',
        completed_at: null,
        completed_by: null,
        completion_artifact_json: null,
        completion_artifact_hash: null,
      })
    } finally {
      probe.close()
    }
  })

  // direct SQL close 通道：complete_finality 真有效性段对 OLD complete 的伪造/sentinel
  // artifact 一律 CLOSE_MALFORMED 零写（allowLegacy=0——sentinel 自洽也不得通行）。
  // forge 接收本 helper 内部 fixture 的行上下文——sentinel 的 reconcileGenerationId 与
  // 该 complete 行完全一致，hash 按相同精确字节计算（绝非「错绑定 sentinel」）。
  function expectDirectCloseRejectedWithCloseMalformed(
    label: string,
    forge: (context: ArtifactForgeContext) => { json: string; hash: string },
    seedFixture: (
      name: string,
    ) => { binding: Binding; hospitalMonthId: string; facts?: CompletionFactSet } = seedPendingMonthP1,
  ): void {
    const fixture = seedFixture(label)
    const probe = vacuumProbeP1(label)
    try {
      manager.upgradeAccountReconciliationSchema(probe) // 注册 UDF + 重装权威 trigger
      const forged = forge(artifactForgeContext(probe, fixture))
      dropReferencingTriggers(probe, 'account_reconcile_generations')
      probe.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(forged.json, forged.hash, fixture.binding.reconcileGenerationId)
      // 从共享库 sqlite_master 取 complete_finality 权威原文重装（零转录风险）
      const finalitySql = (db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_account_reconcile_complete_finality'`,
      ).get() as { sql: string }).sql
      probe.exec(finalitySql)
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = 'USER-001'
           WHERE reconcile_generation_id = ?
        `).run(fixture.binding.reconcileGenerationId)
      }, /COMPLETE_RECONCILIATION_CLOSE_MALFORMED/)
      expect(bindingGenerationRow(probe, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'complete',
        closed_at: null,
        closed_by: null,
      })
    } finally {
      probe.close()
    }
  }

  it('rejects a direct SQL close on a complete row carrying a forged well-hashed artifact', () => {
    expectDirectCloseRejectedWithCloseMalformed('p1v-close-forged', () => ({
      json: '{}',
      hash: prefixedSha256Of('{}'),
    }))
  })

  it('rejects a direct SQL close on a complete row carrying an exact self-consistent sentinel bound to that row', () => {
    expectDirectCloseRejectedWithCloseMalformed('p1v-close-sentinel', context => {
      const json = JSON.stringify({
        schemaVersion: 'account-reconciliation-completion/legacy-sentinel-v1',
        marker: 'legacy-missing-artifact',
        reconcileGenerationId: context.binding.reconcileGenerationId,
        reason: 'predecessor schema had no completion artifact columns; original artifact is unrecoverable',
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  // ── #93-C sentinel durable provenance（主控派单 C）─────────────────────────────
  // 漏洞：sentinel 的 schemaVersion/marker/reason 四个字面量与键集全公开，hash 可对自造
  // JSON 自算——trigger-drop 窗口把真 artifact 换成「精确 sentinel + 自洽 hash」，
  // allowLegacy 开机扫描无法区分「迁移事务真回填」与「当前形状伪造」，首启次启均放行。
  // 修复：sentinel 只能在 completion artifact 两列真实缺失的 predecessor 迁移事务中产生，
  // 同事务写 account_reconcile_completion_legacy_provenance（durable、不可改写/删除、
  // 与正常完成互不混用）；后续 startup 只认可带该来源的 sentinel。

  it('rejects a current-shape exact self-consistent sentinel without migration provenance at first boot and a real restart', () => {
    // 伪造上限：四键精确、reason 逐字、reconcileGenerationId 绑定本行、hash 对精确字节
    // 自洽——除「无迁移来源」外与真 sentinel 逐字节同形，只有 provenance 闸能拒。
    expectArtifactBootForgeryRejected('p1x-sentinel-no-provenance', context => {
      const json = JSON.stringify({
        schemaVersion: 'account-reconciliation-completion/legacy-sentinel-v1',
        marker: 'legacy-missing-artifact',
        reconcileGenerationId: context.binding.reconcileGenerationId,
        reason: 'predecessor schema had no completion artifact columns; original artifact is unrecoverable',
      })
      return { json, hash: prefixedSha256Of(json) }
    })
  })

  it('rejects migration provenance mixed with a normal completion artifact (never attachable to real evidence; naive write blocked, trigger-drop write caught at boot)', () => {
    // 「不可和正常完成混用」双层证据：①正常连接（三闸在场）直接 INSERT provenance
    // 无条件 ABORT；②攻击者上限（摘 no_insert 闸）把 provenance 挂到真 lifecycle
    // 完成行上、hash 与真 artifact 一致（最强一致形状）——开机扫描仍 fail-closed
    // （真实 artifact 绝不许挂 provenance），首启次启同码。
    const fixture = seedFactRichMonthP1('p1x-provenance-mixed-with-real')
    const probe = vacuumProbeP1('p1x-provenance-mixed-with-real')
    try {
      manager.upgradeAccountReconciliationSchema(probe)
      lifecycle.completeAccountReconciliation(probe as any, fixture.binding, 'USER-001')
      const completed = probe.prepare(`
        SELECT completion_artifact_hash AS hash
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { hash: string }
      expectDatabaseMutationBlocked(probe, () => {
        probe.prepare(`
          INSERT INTO account_reconcile_completion_legacy_provenance
            (reconcile_generation_id, artifact_hash, provenance)
          VALUES (?, ?, 'predecessor-missing-completion-artifact-columns')
        `).run(fixture.binding.reconcileGenerationId, completed.hash)
      }, /LEGACY_SENTINEL_PROVENANCE_IMMUTABLE/)
      probe.exec('DROP TRIGGER IF EXISTS trg_reconcile_legacy_provenance_no_insert')
      probe.prepare(`
        INSERT INTO account_reconcile_completion_legacy_provenance
          (reconcile_generation_id, artifact_hash, provenance)
        VALUES (?, ?, 'predecessor-missing-completion-artifact-columns')
      `).run(fixture.binding.reconcileGenerationId, completed.hash)
      const expected = new RegExp(
        `RECONCILE_GENERATION_COMPLETION_MALFORMED:${fixture.binding.reconcileGenerationId}`,
      )
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).toThrow(expected)
      expect(() => manager.upgradeAccountReconciliationSchema(probe)).toThrow(expected)
    } finally {
      probe.close()
    }
  })

  it('rejects a sentinel whose provenance hash drifts from the stored artifact hash at first boot and a real restart', () => {
    // provenance 与 sentinel 同迁移事务写入——artifact 自洽（exact sentinel + 正确 hash）
    // 但 provenance.artifact_hash 漂移 = 伪造/事后改写残留，开机扫描双向钉带出。
    const fixture = seedPendingMonthP1('p1x-provenance-hash-drift')
    const probePath = join(testDirectory, `p1x-provenance-hash-drift-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const seed = openRegisteredTestDatabase(probePath)
    try {
      const sentinelJson = JSON.stringify({
        schemaVersion: 'account-reconciliation-completion/legacy-sentinel-v1',
        marker: 'legacy-missing-artifact',
        reconcileGenerationId: fixture.binding.reconcileGenerationId,
        reason: 'predecessor schema had no completion artifact columns; original artifact is unrecoverable',
      })
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      // 攻击者上限：provenance no_insert 闸一并摘除（开机扫描是最后一道）。
      seed.exec('DROP TRIGGER IF EXISTS trg_reconcile_legacy_provenance_no_insert')
      seed.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(
        sentinelJson, prefixedSha256Of(sentinelJson), fixture.binding.reconcileGenerationId,
      )
      seed.prepare(`
        INSERT INTO account_reconcile_completion_legacy_provenance
          (reconcile_generation_id, artifact_hash, provenance)
        VALUES (?, ?, 'predecessor-missing-completion-artifact-columns')
      `).run(fixture.binding.reconcileGenerationId, prefixedSha256Of('drifted-artifact-bytes'))
    } finally {
      seed.close()
    }
    const expected = new RegExp(
      `RECONCILE_GENERATION_COMPLETION_MALFORMED:${fixture.binding.reconcileGenerationId}`,
    )
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).toThrow(expected)
    } finally {
      first.close()
    }
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).toThrow(expected)
    } finally {
      second.close()
    }
  })

  // ── P1 partial schema 判别 ─────────────────────────────────────────────────────
  // 受支持 predecessor 仅允许两列都原本不存在；只预存 json 或只预存 hash 都是
  // current/partial schema drift——两个方向首启+真实重启 fail-closed 稳定精确码，
  // 且零持久修复（ensure/回填一律不持久）。

  it('fails closed on partial schema (only completion_artifact_json pre-existing) at first boot and a real restart, with zero persistent repair', () => {
    const fixture = seedPendingMonthP1('p1s-partial-hash-missing')
    const probePath = join(testDirectory, `p1s-partial-hash-missing-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const seed = openRegisteredTestDatabase(probePath)
    try {
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      seed.exec('ALTER TABLE account_reconcile_generations DROP COLUMN completion_artifact_hash')
      expectGenerationsConstraintsIntact(seed)
    } finally {
      seed.close()
    }
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first))
        .toThrow('RECONCILE_COMPLETION_ARTIFACT_SCHEMA_PARTIAL:hash')
    } finally {
      first.close()
    }
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second))
        .toThrow('RECONCILE_COMPLETION_ARTIFACT_SCHEMA_PARTIAL:hash')
      // 零持久修复证据：hash 列仍缺席（ensure 未持久）、json 列与行原样（无 sentinel/无改写）
      const columns = (second.prepare('PRAGMA table_info(account_reconcile_generations)').all() as Array<{ name: string }>)
        .map(column => column.name)
      expect(columns).toContain('completion_artifact_json')
      expect(columns).not.toContain('completion_artifact_hash')
      const row = second.prepare(`
        SELECT status, completion_artifact_json AS json
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { status: string; json: unknown }
      expect(row).toEqual({ status: 'pending', json: null })
    } finally {
      second.close()
    }
  })

  it('fails closed on partial schema (only completion_artifact_hash pre-existing) at first boot and a real restart, with zero persistent repair', () => {
    const fixture = seedPendingMonthP1('p1s-partial-json-missing')
    const probePath = join(testDirectory, `p1s-partial-json-missing-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const seed = openRegisteredTestDatabase(probePath)
    try {
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      seed.exec('ALTER TABLE account_reconcile_generations DROP COLUMN completion_artifact_json')
      expectGenerationsConstraintsIntact(seed)
    } finally {
      seed.close()
    }
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first))
        .toThrow('RECONCILE_COMPLETION_ARTIFACT_SCHEMA_PARTIAL:json')
    } finally {
      first.close()
    }
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second))
        .toThrow('RECONCILE_COMPLETION_ARTIFACT_SCHEMA_PARTIAL:json')
      const columns = (second.prepare('PRAGMA table_info(account_reconcile_generations)').all() as Array<{ name: string }>)
        .map(column => column.name)
      expect(columns).not.toContain('completion_artifact_json')
      expect(columns).toContain('completion_artifact_hash')
      const row = second.prepare(`
        SELECT status, completion_artifact_hash AS hash
          FROM account_reconcile_generations WHERE reconcile_generation_id = ?
      `).get(fixture.binding.reconcileGenerationId) as { status: string; hash: unknown }
      expect(row).toEqual({ status: 'pending', hash: null })
    } finally {
      second.close()
    }
  })

  // ── #93-B artifact 业务语义（主控派单 B）────────────────────────────────────────
  // 漏洞：事实集比对（deepFactEqual）只钉「artifact == 数据库当前事实」——raw SQL 在 pending
  // 窗口先把 diff 认定列写成语义伪造形状，再原样镜像进 artifact，结构/绑定/hash/事实四关
  // 全过：verdict 不在权威 6 枚举 / followUp ≠ verdictFollowUp(verdict) / verdictBy·At 缺失 /
  // 「漏收，需补收」零张（或多张）补收单 / 其他 verdict 挂补收单。三通道必须同拒且零写：
  //   ① lifecycle completion 409（prime 一并回滚）；
  //   ② pending→complete trigger（UDF 共用同一语义实现）；
  //   ③ startup scan（列先存库 fail-closed，真 predecessor sentinel 短路不受影响）。
  // 语义唯一权威源 = utils/reconcile-account.ts 的 VERDICT_REASONS/verdictFollowUp/
  // drivesSupplement（非 owned，本文件只读引用其字面量钉版）。金额/数量/revenue 的
  // canonical 边界沿用既有 isFiniteNumber/isNonNegativeSafeInteger 与 lifecycle
  // canonicalAmount/canonicalCount，本族不放宽。
  interface SemanticForgeShape {
    label: string
    verdict: string
    followUp: string
    by: string | null
    at: string | null
    supplement: boolean
  }
  const SEMANTIC_FORGERY_SHAPES: SemanticForgeShape[] = [
    // 单变量①：verdict 越出权威枚举（其余字段全合法形状）。
    {
      label: 'verdict-outside-enum',
      verdict: '伪造结论', followUp: 'settled', by: 'USER-001', at: '2026-08-01 00:00:00',
      supplement: false,
    },
    // 单变量②：枚举内 verdict 但 followUp ≠ verdictFollowUp(verdict)。
    {
      label: 'followup-mapping-drift',
      verdict: '核对无误', followUp: 'supplement', by: 'USER-001', at: '2026-08-01 00:00:00',
      supplement: false,
    },
    // 单变量③：认定人/认定时间缺失（映射正确）。
    {
      label: 'verdict-actor-missing',
      verdict: '核对无误', followUp: 'settled', by: null, at: null,
      supplement: false,
    },
    // 单变量④：「漏收，需补收」映射正确但零张补收单（恰一张的基数违例）。
    {
      label: 'supplement-missing-for-recovery',
      verdict: '漏收，需补收', followUp: 'supplement', by: 'USER-001', at: '2026-08-01 00:00:00',
      supplement: false,
    },
    // 单变量⑤：非漏收 verdict（映射正确）却挂一张谱系合法的补收单（零张的基数违例）。
    {
      label: 'supplement-attached-to-settled',
      verdict: '核对无误', followUp: 'settled', by: 'USER-001', at: '2026-08-01 00:00:00',
      supplement: true,
    },
    // 单变量⑥（fresh-R2 P1-2）：认定人为纯空白串——isNonEmptyString 只挡 ''，'   ' 漏过；
    // 审计字段必须 trim 后非空（空串/纯空白同拒）。
    {
      label: 'verdict-actor-whitespace',
      verdict: '核对无误', followUp: 'settled', by: '   ', at: '2026-08-01 00:00:00',
      supplement: false,
    },
    // 单变量⑦（fresh-R2 P1-2）：认定时间非 canonical SQLite 时间戳——ISO-8601 T/Z 形状
    // Date.parse 会放行；仓库既有时间合同 = CURRENT_TIMESTAMP 'YYYY-MM-DD HH:MM:SS'
    // 严格形状（与 isStrictSettlementMonth 同风格锚定正则+范围）。
    {
      label: 'verdict-at-noncanonical',
      verdict: '核对无误', followUp: 'settled', by: 'USER-001', at: '2026-08-01T00:00:00.000Z',
      supplement: false,
    },
    // 单变量⑧（fresh-R2 P1-3 日历闸）：认定时间形状/段范围合法但 Gregorian 日历不存在
    // ——SQLite CURRENT_TIMESTAMP 永不产出 '2026-02-31'（主控独立复现：SQLite date 函数
    // 会把它归一化为 '2026-03-03'）。必须与仓库既有日历严格校验（lis-cases-v1.1.ts
    // parseStrictDate：日按月大小 + 闰年）同语义拒收。
    {
      label: 'verdict-at-calendar-invalid',
      verdict: '核对无误', followUp: 'settled', by: 'USER-001', at: '2026-02-31 00:00:00',
      supplement: false,
    },
    // 单变量⑨-⑫（fresh-R3 P1-B）：actor canonical 谓词——SQLite trim 只剥 U+0020，
    // tab/newline/NBSP-only 在 SQL 侧冒充非空；JS trim 不剥 NUL，纯控制串在 JS 侧也
    // 冒充非空。唯一权威 isCanonicalActor（JS）+ coreone_canonical_actor（UDF）同拒。
    // （⑨⑩⑪ 在 verdict JS 通道修复前已被 isNonBlankString 拦截=回归钉；⑫ 为真 RED。）
    {
      label: 'verdict-actor-tab-only',
      verdict: '核对无误', followUp: 'settled', by: '\t\t', at: '2026-08-01 00:00:00',
      supplement: false,
    },
    {
      label: 'verdict-actor-newline-only',
      verdict: '核对无误', followUp: 'settled', by: '\n', at: '2026-08-01 00:00:00',
      supplement: false,
    },
    {
      label: 'verdict-actor-nbsp-only',
      verdict: '核对无误', followUp: 'settled', by: String.fromCodePoint(0x00a0, 0x00a0), at: '2026-08-01 00:00:00',
      supplement: false,
    },
    {
      label: 'verdict-actor-nul-only',
      verdict: '核对无误', followUp: 'settled', by: '\0', at: '2026-08-01 00:00:00',
      supplement: false,
    },
  ]

  // 语义伪造 fixture：1 diff 的 pending 月，raw SQL 把认定列写成指定形状（pending 窗口
  // 合法可达——final_immutable 只管 complete/closed 代、identity 闸只管身份列，认定列
  // 直接 SQL 可写正是攻击面）；shape.supplement 时补一张谱系合法（同代同院同月同 case_no、
  // generation current+pending）的补收单，使违例只剩「基数」单变量。primeRevenue 用于
  // 镜像攻击（trigger/boot 通道）：月值预置后 artifact 镜像可过 revenue 闸，保证拒绝只能
  // 归因业务语义；lifecycle 通道不预置（prime 回滚本身是被断言的零写证据）。
  function seedSemanticForgeMonthP1(
    name: string,
    shape: SemanticForgeShape,
    options: { primeRevenue?: boolean } = {},
  ) {
    const fixture = seedPendingMonthP1(name)
    const diffs = db.prepare(`
      SELECT id, case_no FROM reconcile_diffs
       WHERE hospital_month_id = ? AND reconcile_generation_id = ?
    `).all(fixture.hospitalMonthId, fixture.binding.reconcileGenerationId) as Array<{
      id: string
      case_no: string
    }>
    expect(diffs).toHaveLength(1)
    const diff = diffs[0]
    db.prepare(`
      UPDATE reconcile_diffs
         SET verdict = ?, verdict_reason = NULL, verdict_by = ?, verdict_at = ?, follow_up = ?
       WHERE id = ?
    `).run(shape.verdict, shape.by, shape.at, shape.followUp, diff.id)
    if (shape.supplement) {
      db.prepare(`
        INSERT INTO supplement_orders
          (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
           case_no, amount, case_count, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?, 100, 1, 'USER-001')
      `).run(
        `SO-SEM-${name}`,
        fixture.binding.partnerId,
        fixture.binding.settlementMonth,
        diff.id,
        fixture.binding.reconcileGenerationId,
        diff.case_no,
      )
    }
    if (options.primeRevenue) {
      db.prepare('UPDATE reconcile_hospital_months SET confirmed_lab_revenue = ? WHERE id = ?')
        .run(100, fixture.hospitalMonthId)
    }
    return fixture
  }

  it('rejects semantically forged verdict facts at lifecycle completion (409 zero write; twelve single-variable shapes)', () => {
    for (const shape of SEMANTIC_FORGERY_SHAPES) {
      const fixture = seedSemanticForgeMonthP1(`p1b-lifecycle-${shape.label}`, shape)
      expectLifecycle409(
        () => lifecycle.completeAccountReconciliation(db, fixture.binding, 'USER-001'),
        'RECONCILIATION_VERDICT_SEMANTICS',
      )
      // 零写：generation 仍 pending（终态字段/artifact 全 NULL）；月行仍 待复核 +
      // confirmed_lab_revenue NULL——revenue prime 随事务整体回滚，不存在
      // pending+revenue 中间态（形状与 p1f-revenue-prime-rollback 同款）。
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'pending',
        completed_at: null,
        completed_by: null,
        completion_artifact_json: null,
        completion_artifact_hash: null,
      })
      expect(db.prepare(`
        SELECT status, confirmed_lab_revenue FROM reconcile_hospital_months WHERE id = ?
      `).get(fixture.hospitalMonthId)).toEqual({ status: '待复核', confirmed_lab_revenue: null })
    }
  })

  it('rejects a fact-mirrored but semantically invalid pending→complete write (zero write; twelve single-variable shapes)', () => {
    for (const shape of SEMANTIC_FORGERY_SHAPES) {
      const label = `p1b-trigger-${shape.label}`
      const fixture = seedSemanticForgeMonthP1(label, shape, { primeRevenue: true })
      const probe = vacuumProbeP1(label)
      try {
        manager.upgradeAccountReconciliationSchema(probe) // 注册 UDF + 重装权威 trigger
        const context = artifactForgeContext(probe, fixture)
        // 镜像攻击上限：artifact 逐项等于数据库当前事实（含伪造认定），结构/绑定/hash/
        // 事实/revenue 五关全绿——只有业务语义闸能拒。
        const json = factBoundArtifactJson(context, context.facts)
        expectDatabaseMutationBlocked(probe, () => {
          probe.prepare(`
            UPDATE account_reconcile_generations
               SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
                   completion_artifact_json = ?, completion_artifact_hash = ?
             WHERE reconcile_generation_id = ?
          `).run(json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
        }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
        expect(bindingGenerationRow(probe, fixture.binding.reconcileGenerationId)).toMatchObject({
          status: 'pending',
          completed_at: null,
          completed_by: null,
          completion_artifact_json: null,
          completion_artifact_hash: null,
        })
      } finally {
        probe.close()
      }
    }
  })

  it('fails boot on a fact-mirrored but semantically invalid complete generation (first boot and real restart; twelve single-variable shapes)', () => {
    for (const shape of SEMANTIC_FORGERY_SHAPES) {
      expectArtifactBootForgeryRejected(
        `p1b-boot-${shape.label}`,
        context => {
          const json = factBoundArtifactJson(context, context.facts)
          return { json, hash: prefixedSha256Of(json) }
        },
        label => seedSemanticForgeMonthP1(label, shape, { primeRevenue: true }),
      )
    }
  })

  it('calendar-day precision on verdict_at (lifecycle channel): rejects 2026-02-31 / 2025-02-29 / 2026-04-31 with zero write, accepts legal leap day 2024-02-29', () => {
    // fresh-R2 P1-3（2026-07-29 review finding）：canonical 时间合同从「形状 + 段范围」收紧到
    // 「Gregorian 真实日历日」（与 lis-cases-v1.1.ts parseStrictDate 同语义：日按月
    // 大小 + 闰年）。负控三日 CURRENT_TIMESTAMP 永不产出 → completion 必须 409 零写；
    // 正控合法闰日 2024-02-29 镜像进 artifact 后照常完成、首启扫描零误伤。
    // （trigger/boot 三通道的 2026-02-31 由 SEMANTIC_FORGERY_SHAPES ⑧ 自动覆盖。）
    const base = { verdict: '核对无误', followUp: 'settled', by: 'USER-001', supplement: false }
    for (const [tag, at] of [
      ['feb31', '2026-02-31 00:00:00'],
      ['feb29-nonleap', '2025-02-29 00:00:00'],
      ['apr31', '2026-04-31 00:00:00'],
    ] as const) {
      const fixture = seedSemanticForgeMonthP1(`p1c-cal-${tag}`, { label: `cal-${tag}`, ...base, at })
      expectLifecycle409(
        () => lifecycle.completeAccountReconciliation(db, fixture.binding, 'USER-001'),
        'RECONCILIATION_VERDICT_SEMANTICS',
      )
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'pending',
        completed_at: null,
        completed_by: null,
        completion_artifact_json: null,
        completion_artifact_hash: null,
      })
    }
    // 正控：2024 为闰年，02-29 真实存在——completion 成功且权威扫描不炸。
    const ok = seedSemanticForgeMonthP1('p1c-cal-leap-ok', {
      label: 'cal-leap-ok', ...base, at: '2024-02-29 00:00:00',
    })
    lifecycle.completeAccountReconciliation(db, ok.binding, 'USER-001')
    expect(bindingGenerationRow(db, ok.binding.reconcileGenerationId))
      .toMatchObject({ status: 'complete' })
    expect(() => manager.upgradeAccountReconciliationSchema(db)).not.toThrow()
  })

  it('accepts a lifecycle completion spanning all six verdicts with exact supplement cardinality (fresh and real restart)', () => {
    // 正向多 verdict 全链：同院同月 6 病例各一条 diff（bill 1 vs lis 2），依次认定
    // 权威 6 枚举——仅「漏收，需补收」驱动恰一张补收单，其余五 verdict 零张；
    // completion artifact 封存 6 决定 1 补收，首启与真实重启均绿（新语义闸对合法
    // 形状零误伤——fail-closed 新闸先对齐既有合法形状的反面，再谈拦截）。
    const month = '2026-08'
    const suffix = `p1b-six-verdicts-${++sequence}`
    const partnerId = `PT-LOC005-R2-${suffix}`
    const statementGenerationId = `STMT-LOC005-R2-${suffix}`
    const reconcileGenerationId = `RECON-LOC005-R2-${suffix}`
    const batchId = `BATCH-LOC005-R2-${suffix}`
    const caseNos = VERDICT_REASONS.map((_, index) => `CASE-LOC005-R2-${suffix}-V${index}`)
    db.prepare('INSERT INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)')
      .run(partnerId, `CODE-${suffix}`, `Partner ${suffix}`)
    db.prepare(`
      INSERT INTO statement_import_batches
        (id, partner_id, source_hash, template_family, parser_revision, config_revision,
         settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
      VALUES (?, ?, ?, 'loc005-r2-test', 'r1', 'c1', ?, ?, 1, 6, 6, 'posted')
    `).run(batchId, partnerId, `HASH-${suffix}`, month, statementGenerationId)
    const insertRaw = db.prepare(`
      INSERT INTO statement_raw_rows
        (id, batch_id, generation_id, source_sheet, source_row, row_json)
      VALUES (?, ?, ?, 'sheet', ?, ?)
    `)
    const insertLine = db.prepare(`
      INSERT INTO statement_normalized_lines
        (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
         case_no, item_name, source_sheet, source_row, source_column, source_label,
         template_family, row_kind, line_grain, business_line, amount_role, amount,
         classification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet', ?, 'amount', ?,
              'loc005-r2-test', 'detail', 'case', 'IN', 'gross', ?, 'classified')
    `)
    const insertLis = db.prepare(`
      INSERT INTO lis_cases
        (id, case_no, partner_id, ihc_count, special_stain_count, operate_time)
      VALUES (?, ?, ?, ?, 0, ?)
    `)
    const insertRevenue = db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')
    `)
    caseNos.forEach((caseNo, index) => {
      insertRaw.run(`RAW-${suffix}-V${index}`, batchId, statementGenerationId, index + 1,
        JSON.stringify({ caseNo, amount: 100 }))
      insertLine.run(`LINE-${suffix}-V${index}`, batchId, statementGenerationId, partnerId,
        month, month, caseNo, '免疫组化染色*1', index + 1, '免疫组化染色*1', 100)
      insertLis.run(`LIS-${suffix}-V${index}`, caseNo, partnerId, 2, `${month}-15`)
      insertRevenue.run(`REV-${suffix}-V${index}`, caseNo, partnerId, month, 100, 100, 100)
    })
    const binding: Binding = { partnerId, settlementMonth: month, statementGenerationId, reconcileGenerationId }
    const snapshot = lifecycle.computeAccountReconciliation(db, binding, 'USER-001') as any
    const hospitalMonthId = String(snapshot.hospitalMonthId)
    const diffs = db.prepare(`
      SELECT id FROM reconcile_diffs
       WHERE hospital_month_id = ? AND reconcile_generation_id = ?
       ORDER BY case_no, line_type, id
    `).all(hospitalMonthId, reconcileGenerationId) as Array<{ id: string }>
    expect(diffs).toHaveLength(VERDICT_REASONS.length)
    diffs.forEach((diff, index) => {
      lifecycle.setAccountReconciliationVerdict(
        db, binding, diff.id, VERDICT_REASONS[index], null, 'USER-001', 'admin',
      )
    })
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    const stored = db.prepare(`
      SELECT completion_artifact_json AS json, completion_artifact_hash AS hash
        FROM account_reconcile_generations WHERE reconcile_generation_id = ?
    `).get(reconcileGenerationId) as { json: string; hash: string }
    expect(stored.hash).toBe(prefixedSha256Of(stored.json))
    const artifact = JSON.parse(stored.json) as {
      decisions: Array<Record<string, unknown>>
      supplements: Array<Record<string, unknown>>
    }
    expect(artifact.decisions).toHaveLength(VERDICT_REASONS.length)
    expect(artifact.supplements).toHaveLength(1)
    const recoveryDiff = diffs[0]
    expect(String((artifact.supplements[0] as { sourceDiffId: unknown }).sourceDiffId))
      .toBe(recoveryDiff.id)
    // 首启 + 真实重启：权威扫描对合法全枚举完成零误伤。
    expect(() => manager.upgradeAccountReconciliationSchema(db)).not.toThrow()
    manager.closeDatabase()
    manager.initializeDatabase()
    db = manager.getDatabase()
  })

  // ── fresh-R2 P1-1 终态 hospital-month 严格形状（2026-07-29 review finding：startup scan 与
  //    overview 可信实收谓词共用同一完整形状，避免漂移）────────────────────────────
  // 漏洞：#93-A 扫描只钉「状态文本↔generation 状态 + 字段优先级粗配对」——有 binding
  // 的终态行字段残缺/矛盾全部放行：复核完成 completed_at=NULL、completed_by 纯空白、
  // 夹带 closed 字段；已关账缺 completed/closed 组或操作者空白；待复核夹带终态字段。
  // 开机不炸且 overview 照样计入确认实收。严格形状与所绑 current generation 严格互证：
  //   复核完成 = completed_at canonical + completed_by trim 非空 + closed_at/by 均 NULL
  //             + generation=complete；
  //   已关账   = completed/closed 两组 canonical 时间 + 两操作者 trim 非空
  //             + generation=closed；
  //   其它状态夹带任何终态字段 = malformed。
  // 合法写者（lifecycle/路由）形状不变；以下伪造只能经 trigger 被摘窗口落入 →
  // 首次 upgrade（首启）与真实重启（关闭重开同一文件）均 fail-closed，伪造行零持久修复。
  // （形状口径已升级：completed_by/closed_by 从「trim 非空」收紧为 actor canonical——
  // fresh-R3 P1-B 起 coreone_canonical_actor UDF、fresh blocker 起片段内原始 BLOB
  // instr(x'00') 闸，见 TRUSTED_TERMINAL_HOSPITAL_MONTH_SHAPE_SQL。）
  function expectTerminalShapeForgeryRejected(
    label: string,
    setup: 'complete' | 'closed' | 'pending',
    dropTrigger: string,
    forge: (probe: DatabaseSync, hospitalMonthId: string) => void,
  ): void {
    const fixture = seedPendingMonthP1(label)
    if (setup !== 'pending') {
      const diff = db.prepare(
        'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
      ).get(fixture.hospitalMonthId) as { id: string }
      lifecycle.setAccountReconciliationVerdict(
        db, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
      )
      lifecycle.completeAccountReconciliation(db, fixture.binding, 'USER-001')
      if (setup === 'closed') {
        lifecycle.closeAccountReconciliation(db, fixture.binding, 'USER-001')
      }
    }
    const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    let forgedRow: Record<string, unknown> | undefined
    const seed = openRegisteredTestDatabase(probePath)
    try {
      seed.exec(`DROP TRIGGER IF EXISTS ${dropTrigger}`)
      forge(seed, fixture.hospitalMonthId)
      forgedRow = seed.prepare(`
        SELECT status, completed_at, completed_by, closed_at, closed_by
          FROM reconcile_hospital_months WHERE id = ?
      `).get(fixture.hospitalMonthId) as Record<string, unknown>
    } finally {
      seed.close()
    }
    const expected = new RegExp(
      `RECONCILE_HOSPITAL_MONTH_TERMINAL_MISMATCH:${fixture.hospitalMonthId}`,
    )
    // 首次 upgrade（首启）即 fail-closed。
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).toThrow(expected)
    } finally {
      first.close()
    }
    // 真实重启：关闭重开同一未修库仍同码 fail-closed，且伪造行零持久修复。
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).toThrow(expected)
      const persisted = second.prepare(`
        SELECT status, completed_at, completed_by, closed_at, closed_by
          FROM reconcile_hospital_months WHERE id = ?
      `).get(fixture.hospitalMonthId)
      expect(persisted).toEqual(forgedRow)
    } finally {
      second.close()
    }
  }

  it('fails boot when a bound complete month loses completed_at (trigger-drop window; first boot and real restart)', () => {
    expectTerminalShapeForgeryRejected(
      'p1t-complete-at-cleared', 'complete', 'trg_reconcile_hospital_month_complete_finality',
      (probe, hmId) => {
        probe.prepare(
          'UPDATE reconcile_hospital_months SET completed_at = NULL WHERE id = ?',
        ).run(hmId)
      },
    )
  })

  it('fails boot when a bound complete month carries a whitespace completed_by (trigger-drop window; first boot and real restart)', () => {
    expectTerminalShapeForgeryRejected(
      'p1t-complete-by-blank', 'complete', 'trg_reconcile_hospital_month_complete_finality',
      (probe, hmId) => {
        probe.prepare(`UPDATE reconcile_hospital_months SET completed_by = '   ' WHERE id = ?`)
          .run(hmId)
      },
    )
  })

  it('fails boot when a bound complete month carries a NUL-junk completed_by (trigger-drop window; first boot and real restart)', () => {
    // fresh blocker（2026-07-29 root 复核）hm 侧钉：'USER-001\0junk' 经 node:sqlite
    // 截断在 UDF/JS 单侧冒充 'USER-001'——拒绝只能归因片段内 BLOB instr(x'00')
    // 原始字节闸（与 overview 负测⑤同一谓词的消费方对调：此处钉 startup 扫描侧）。
    expectTerminalShapeForgeryRejected(
      'p1t-complete-by-nul-junk', 'complete', 'trg_reconcile_hospital_month_complete_finality',
      (probe, hmId) => {
        probe.prepare('UPDATE reconcile_hospital_months SET completed_by = ? WHERE id = ?')
          .run('USER-001\0junk', hmId)
      },
    )
  })

  it('fails boot when a bound complete month carries closed fields (trigger-drop window; first boot and real restart)', () => {
    expectTerminalShapeForgeryRejected(
      'p1t-complete-closed-fields', 'complete', 'trg_reconcile_hospital_month_complete_finality',
      (probe, hmId) => {
        probe.prepare(`
          UPDATE reconcile_hospital_months
             SET closed_at = CURRENT_TIMESTAMP, closed_by = 'attacker' WHERE id = ?
        `).run(hmId)
      },
    )
  })

  it('fails boot when a bound closed month loses completed_at (trigger-drop window; first boot and real restart)', () => {
    expectTerminalShapeForgeryRejected(
      'p1t-closed-completed-cleared', 'closed', 'trg_reconcile_hospital_month_closed_immutable',
      (probe, hmId) => {
        probe.prepare(
          'UPDATE reconcile_hospital_months SET completed_at = NULL WHERE id = ?',
        ).run(hmId)
      },
    )
  })

  it('fails boot when a bound closed month carries a whitespace closed_by (trigger-drop window; first boot and real restart)', () => {
    expectTerminalShapeForgeryRejected(
      'p1t-closed-by-blank', 'closed', 'trg_reconcile_hospital_month_closed_immutable',
      (probe, hmId) => {
        probe.prepare(`UPDATE reconcile_hospital_months SET closed_by = ' ' WHERE id = ?`)
          .run(hmId)
      },
    )
  })

  it('fails boot when a bound pending month carries terminal fields (trigger-drop window; first boot and real restart)', () => {
    expectTerminalShapeForgeryRejected(
      'p1t-pending-terminal-fields', 'pending', 'trg_reconcile_hospital_month_pending_guard',
      (probe, hmId) => {
        probe.prepare(`
          UPDATE reconcile_hospital_months
             SET completed_at = CURRENT_TIMESTAMP, completed_by = 'attacker' WHERE id = ?
        `).run(hmId)
      },
    )
  })

  it('fails boot when a bound terminal month carries a calendar-impossible timestamp (2026-02-31 / 2025-02-29 / 2026-04-31 on completed_at and closed_at; first boot and real restart)', () => {
    // fresh-R2 P1-3：completed_at/closed_at 的 canonical 合同与 verdict_at 同收紧到真实
    // 日历日。三枚不可能日 × complete.completed_at（complete_finality 被摘窗口）与
    // closed.closed_at（closed_immutable 被摘窗口）——首启与真实重启均 fail-closed，
    // 伪造行零持久修复。
    for (const [tag, at] of [
      ['feb31', '2026-02-31 10:00:00'],
      ['feb29-nonleap', '2025-02-29 10:00:00'],
      ['apr31', '2026-04-31 10:00:00'],
    ] as const) {
      expectTerminalShapeForgeryRejected(
        `p1c-complete-at-${tag}`, 'complete', 'trg_reconcile_hospital_month_complete_finality',
        (probe, hmId) => {
          probe.prepare('UPDATE reconcile_hospital_months SET completed_at = ? WHERE id = ?')
            .run(at, hmId)
        },
      )
      expectTerminalShapeForgeryRejected(
        `p1c-closed-at-${tag}`, 'closed', 'trg_reconcile_hospital_month_closed_immutable',
        (probe, hmId) => {
          probe.prepare('UPDATE reconcile_hospital_months SET closed_at = ? WHERE id = ?')
            .run(at, hmId)
        },
      )
    }
  })

  it('boots clean when a bound closed month carries the legal leap day 2024-02-29 (trigger-drop window rewrite; first boot and real restart; no false positive)', () => {
    // 正控：2024-02-29 真实存在——completed_at/closed_at 改为该闰日后首启扫描与真实
    // 重启均不得误炸（日历闸对合法形状零误伤的直接证据；与 lis-cases 严格校验同款
    // 「严格≠误拒真实日期」钉版）。
    const fixture = seedPendingMonthP1(`p1c-leap-ok-${++sequence}`)
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(fixture.hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, fixture.binding, 'USER-001')
    lifecycle.closeAccountReconciliation(db, fixture.binding, 'USER-001')
    const probePath = join(testDirectory, `p1c-leap-ok-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    const seed = openRegisteredTestDatabase(probePath)
    try {
      seed.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_closed_immutable')
      seed.prepare(`
        UPDATE reconcile_hospital_months
           SET completed_at = '2024-02-29 09:30:00', closed_at = '2024-02-29 10:00:00'
         WHERE id = ?
      `).run(fixture.hospitalMonthId)
    } finally {
      seed.close()
    }
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).not.toThrow()
    } finally {
      first.close()
    }
    // 真实重启（关闭重开同一文件）同样零误炸。
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).not.toThrow()
    } finally {
      second.close()
    }
  })

  // ── fresh-R3 P1-A/P1-B（fixed-SHA 复核 2026-07-29）generation 终态证据
  //    canonical 合同 + actor 谓词单源 ──────────────────────────────────────────
  // P1-A（generation 终态证据漏检）：generation.completed_at/completed_by/closed_at/
  //   closed_by 此前只钉 NULL/粗 trim——BLOB/INTEGER/NUL-junk/日历不存在日
  //   （2026-02-31、2026-04-31、2025-02-29、2100-02-29 世纪非闰）全被放行；complete
  //   代夹带 closed 字段无人拦。TRUSTED_TERMINAL_HOSPITAL_MONTH_SHAPE_SQL（开机扫描
  //   + overview 可信实收谓词）、ensureReconcileGenerationCompletionShape、
  //   pending→complete/complete→closed trigger 四面必须与 hospital-month 同一
  //   canonical 合同。
  // P1-B（SQL trim 与 JS trim 漂移）：SQLite trim 只剥 U+0020，JS trim 剥全
  //   WhiteSpace 但不剥控制符——tab/newline/NBSP-only actor 在 SQL 侧、
  //   NUL/control-only 在两侧都冒充非空。唯一权威 isCanonicalActor（JS）+
  //   coreone_canonical_actor（deterministic UDF），startup/trigger/overview/JS
  //   单点消费；未注册连接命中引用 UDF 的 trigger 即 no such function 零写
  //   fail-closed（与 artifact UDF 同姿态）。
  type SqlScalar = string | number | Uint8Array | null
  const VALID_SEMANTIC_SHAPE: SemanticForgeShape = {
    label: 'valid', verdict: '核对无误', followUp: 'settled',
    by: 'USER-001', at: '2026-08-01 00:00:00', supplement: false,
  }
  const BAD_CANONICAL_TIMESTAMPS: ReadonlyArray<readonly [string, SqlScalar]> = [
    ['null', null], // 修复前已拦（回归钉）
    ['blob', new Uint8Array([0x32, 0x30, 0x32, 0x36])],
    ['integer', 20260231],
    ['nul-junk', '2026-08-01 00:00:00\0junk'],
    ['feb31', '2026-02-31 00:00:00'],
    ['apr31', '2026-04-31 00:00:00'],
    ['feb29-nonleap', '2025-02-29 00:00:00'],
    ['feb29-century-nonleap', '2100-02-29 00:00:00'],
  ]
  const BAD_CANONICAL_ACTORS: ReadonlyArray<readonly [string, string]> = [
    ['tab-only', '\t\t'],
    ['newline-only', '\n'],
    ['nbsp-only', String.fromCodePoint(0x00a0, 0x00a0)],
    ['nul-only', '\0'],
    // fresh blocker（2026-07-29 root 复核）：node:sqlite 把 TEXT 截到首个 NUL——
    // 'USER-001\0junk' 落库 14 字节、JS 扫描与 UDF 入参都只见 'USER-001' 被误判
    // 合法（真 RED，违反「拒绝一切 C0 控制字符」明示合同）；修复 = SQL 权威谓词加
    // 原始存储层 BLOB instr(x'00') 闸 + startup JS 扫描读取同一原始字节证据。
    ['nul-junk', 'USER-001\0junk'],
  ]
  const LEAP_DAY_TIMESTAMPS: ReadonlyArray<readonly [string, string]> = [
    ['leap-2000', '2000-02-29 00:00:00'], // 世纪闰（%400）
    ['leap-2024', '2024-02-29 00:00:00'],
  ]

  interface GenerationTerminalRow {
    status: string
    completed_at: SqlScalar
    completed_by: SqlScalar
    closed_at: SqlScalar
    closed_by: SqlScalar
    completion_artifact_json: string
    completion_artifact_hash: string
  }

  const generationTerminalSelect = `
    SELECT status, completed_at, completed_by, closed_at, closed_by,
           completion_artifact_json, completion_artifact_hash,
           length(CAST(completion_artifact_json AS BLOB)) AS completion_artifact_json_bytes,
           instr(CAST(completion_artifact_json AS BLOB), x'00') AS completion_artifact_json_nul,
           length(CAST(completion_artifact_hash AS BLOB)) AS completion_artifact_hash_bytes,
           instr(CAST(completion_artifact_hash AS BLOB), x'00') AS completion_artifact_hash_nul
      FROM account_reconcile_generations WHERE reconcile_generation_id = ?`

  // Pattern F（fragment 通道）：合法 lifecycle complete(+close) 使 hm 终态且绑定，
  // 摘 generation 触发器后伪造终态字段——终态月扫描（片段，与 overview 同一谓词）
  // 排在 generation 扫描之前，命中 RECONCILE_HOSPITAL_MONTH_TERMINAL_MISMATCH:<hmId>；
  // 真实重启同码，伪造行零持久修复。
  function expectGenerationFieldForgeryRejectedFragment(
    label: string,
    setup: 'complete' | 'closed',
    forge: (probe: DatabaseSync, generationId: string) => void,
  ): void {
    const fixture = seedPendingMonthP1(label)
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(fixture.hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
    )
    lifecycle.completeAccountReconciliation(db, fixture.binding, 'USER-001')
    if (setup === 'closed') {
      lifecycle.closeAccountReconciliation(db, fixture.binding, 'USER-001')
    }
    const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    let forgedRow: Record<string, unknown> | undefined
    const seed = openRegisteredTestDatabase(probePath)
    try {
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      forge(seed, fixture.binding.reconcileGenerationId)
      forgedRow = seed.prepare(generationTerminalSelect)
        .get(fixture.binding.reconcileGenerationId) as Record<string, unknown>
    } finally {
      seed.close()
    }
    const expected = new RegExp(
      `RECONCILE_HOSPITAL_MONTH_TERMINAL_MISMATCH:${fixture.hospitalMonthId}`,
    )
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).toThrow(expected)
    } finally {
      first.close()
    }
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).toThrow(expected)
      expect(second.prepare(generationTerminalSelect)
        .get(fixture.binding.reconcileGenerationId)).toEqual(forgedRow)
    } finally {
      second.close()
    }
  }

  // Pattern G（generation 扫描通道）：hm 保持 待复核（终态月扫描外层 WHERE 不命中），
  // valid 镜像 artifact + 单变量终态字段直接落库——只有
  // ensureReconcileGenerationCompletionShape 的 canonical 子句能命中
  // RECONCILE_GENERATION_COMPLETION_MALFORMED:<genId>；真实重启同码零修复。
  function expectGenerationFieldForgeryRejectedScan(
    label: string,
    setup: 'complete' | 'closed',
    forge: (row: GenerationTerminalRow) => void,
  ): void {
    const fixture = seedSemanticForgeMonthP1(label, VALID_SEMANTIC_SHAPE, { primeRevenue: true })
    const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
    db.prepare('VACUUM INTO ?').run(probePath)
    let forgedRow: Record<string, unknown> | undefined
    const seed = openRegisteredTestDatabase(probePath)
    try {
      dropReferencingTriggers(seed, 'account_reconcile_generations')
      const context = artifactForgeContext(seed, fixture)
      const json = factBoundArtifactJson(context, context.facts)
      const row: GenerationTerminalRow = {
        status: 'complete',
        completed_at: '2026-08-01 09:00:00',
        completed_by: 'USER-001',
        closed_at: null,
        closed_by: null,
        completion_artifact_json: json,
        completion_artifact_hash: prefixedSha256Of(json),
      }
      if (setup === 'closed') {
        row.status = 'closed'
        row.closed_at = '2026-08-01 10:00:00'
        row.closed_by = 'USER-001'
      }
      forge(row)
      seed.prepare(`
        UPDATE account_reconcile_generations
           SET status = ?, completed_at = ?, completed_by = ?, closed_at = ?, closed_by = ?,
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(
        row.status, row.completed_at, row.completed_by, row.closed_at, row.closed_by,
        row.completion_artifact_json, row.completion_artifact_hash,
        fixture.binding.reconcileGenerationId,
      )
      forgedRow = seed.prepare(generationTerminalSelect)
        .get(fixture.binding.reconcileGenerationId) as Record<string, unknown>
    } finally {
      seed.close()
    }
    const expected = new RegExp(
      `RECONCILE_GENERATION_COMPLETION_MALFORMED:${fixture.binding.reconcileGenerationId}`,
    )
    const first = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(first)).toThrow(expected)
    } finally {
      first.close()
    }
    const second = openRegisteredTestDatabase(probePath)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(second)).toThrow(expected)
      expect(second.prepare(generationTerminalSelect)
        .get(fixture.binding.reconcileGenerationId)).toEqual(forgedRow)
    } finally {
      second.close()
    }
  }

  it('direct pending→complete trigger applies the canonical contract to generation.completed_at/completed_by (zero write; 13 negatives + 2 leap-day positives + Unicode actor positive)', () => {
    // fresh-R3 P1-A/P1-B trigger 通道①：valid 镜像 artifact + 单变量终态字段。
    // 修复前仅 NULL completed_at 与空 actor 被拦（回归钉）；BLOB/INTEGER/NUL-junk/
    // 日历不存在日与 tab/newline/NBSP/NUL actor 全放行（真 RED）；
    // 'USER-001\0junk' 经 node:sqlite 截断冒充合法（fresh blocker 真 RED）。
    for (const [tag, badAt] of BAD_CANONICAL_TIMESTAMPS) {
      const fixture = seedSemanticForgeMonthP1(`p1g-tc-at-${tag}`, VALID_SEMANTIC_SHAPE, { primeRevenue: true })
      const context = artifactForgeContext(db, fixture)
      const json = factBoundArtifactJson(context, context.facts)
      expectDatabaseMutationBlocked(db, () => {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'complete', completed_at = ?, completed_by = 'USER-001',
                 completion_artifact_json = ?, completion_artifact_hash = ?
           WHERE reconcile_generation_id = ?
        `).run(badAt, json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
      }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'pending', completed_at: null, completed_by: null,
        completion_artifact_json: null, completion_artifact_hash: null,
      })
    }
    for (const [tag, badBy] of BAD_CANONICAL_ACTORS) {
      const fixture = seedSemanticForgeMonthP1(`p1g-tc-by-${tag}`, VALID_SEMANTIC_SHAPE, { primeRevenue: true })
      const context = artifactForgeContext(db, fixture)
      const json = factBoundArtifactJson(context, context.facts)
      expectDatabaseMutationBlocked(db, () => {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = ?,
                 completion_artifact_json = ?, completion_artifact_hash = ?
           WHERE reconcile_generation_id = ?
        `).run(badBy, json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
      }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'pending', completed_at: null, completed_by: null,
        completion_artifact_json: null, completion_artifact_hash: null,
      })
    }
    // 正控：2000-02-29（世纪闰）/2024-02-29 真实存在——raw complete 合法落库，
    // 末段开机扫描（generation 扫描 + 片段）对闰日零误伤。
    for (const [tag, goodAt] of LEAP_DAY_TIMESTAMPS) {
      const fixture = seedSemanticForgeMonthP1(`p1g-tc-at-${tag}`, VALID_SEMANTIC_SHAPE, { primeRevenue: true })
      const context = artifactForgeContext(db, fixture)
      const json = factBoundArtifactJson(context, context.facts)
      db.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = ?, completed_by = 'USER-001',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(goodAt, json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId))
        .toMatchObject({ status: 'complete', completed_at: goodAt, closed_at: null, closed_by: null })
    }
    // Unicode 正控：合法 CJK 操作者 id（'张医生' UTF-8 多字节序列不含 0x00）——
    // raw complete 合法落库；下方末段开机扫描（trigger 闸 + generation 扫描 + 片段
    // BLOB instr 闸）对合法 Unicode actor 必须零误伤。
    const unicodeFixture = seedSemanticForgeMonthP1('p1g-tc-by-unicode-cjk', VALID_SEMANTIC_SHAPE, { primeRevenue: true })
    const unicodeContext = artifactForgeContext(db, unicodeFixture)
    const unicodeJson = factBoundArtifactJson(unicodeContext, unicodeContext.facts)
    db.prepare(`
      UPDATE account_reconcile_generations
         SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = ?,
             completion_artifact_json = ?, completion_artifact_hash = ?
       WHERE reconcile_generation_id = ?
    `).run('张医生', unicodeJson, prefixedSha256Of(unicodeJson), unicodeFixture.binding.reconcileGenerationId)
    expect(bindingGenerationRow(db, unicodeFixture.binding.reconcileGenerationId))
      .toMatchObject({ status: 'complete', completed_by: '张医生' })
    expect(() => manager.upgradeAccountReconciliationSchema(db)).not.toThrow()
  })

  it('direct pending→complete rejects completion artifact bytes hidden after a NUL (JSON and hash; zero write)', () => {
    for (const target of ['json', 'hash'] as const) {
      const fixture = seedSemanticForgeMonthP1(
        `p1g-artifact-trigger-${target}`,
        VALID_SEMANTIC_SHAPE,
        { primeRevenue: true },
      )
      const context = artifactForgeContext(db, fixture)
      const validJson = factBoundArtifactJson(context, context.facts)
      const validHash = prefixedSha256Of(validJson)
      const forgedJson = target === 'json' ? `${validJson}\0UNHASHED-TAIL` : validJson
      const forgedHash = target === 'hash' ? `${validHash}\0UNVERIFIED-TAIL` : validHash
      expectDatabaseMutationBlocked(db, () => {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'complete', completed_at = CURRENT_TIMESTAMP,
                 completed_by = 'USER-001',
                 completion_artifact_json = ?, completion_artifact_hash = ?
           WHERE reconcile_generation_id = ?
        `).run(forgedJson, forgedHash, fixture.binding.reconcileGenerationId)
      }, /PENDING_RECONCILIATION_COMPLETION_MALFORMED/)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'pending',
        completed_at: null,
        completed_by: null,
        completion_artifact_json: null,
        completion_artifact_hash: null,
      })
    }
  })

  it('direct complete→closed rejects a pre-existing completion artifact with hidden NUL-tail bytes (JSON and hash; zero write)', () => {
    const triggerSqls = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'trg_account_reconcile_completion_immutable',
           'trg_account_reconcile_complete_finality'
         )
       ORDER BY name
    `).all() as Array<{ sql: string }>
    expect(triggerSqls).toHaveLength(2)
    for (const target of ['json', 'hash'] as const) {
      const fixture = seedSemanticForgeMonthP1(
        `p1g-artifact-close-${target}`,
        VALID_SEMANTIC_SHAPE,
        { primeRevenue: true },
      )
      const context = artifactForgeContext(db, fixture)
      const validJson = factBoundArtifactJson(context, context.facts)
      const validHash = prefixedSha256Of(validJson)
      db.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP,
               completed_by = 'USER-001',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(validJson, validHash, fixture.binding.reconcileGenerationId)
      db.exec(`
        DROP TRIGGER trg_account_reconcile_completion_immutable;
        DROP TRIGGER trg_account_reconcile_complete_finality;
      `)
      if (target === 'json') {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET completion_artifact_json = ?
           WHERE reconcile_generation_id = ?
        `).run(`${validJson}\0UNHASHED-TAIL`, fixture.binding.reconcileGenerationId)
      } else {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET completion_artifact_hash = ?
           WHERE reconcile_generation_id = ?
        `).run(`${validHash}\0UNVERIFIED-TAIL`, fixture.binding.reconcileGenerationId)
      }
      for (const { sql } of triggerSqls) db.exec(sql)
      expectDatabaseMutationBlocked(db, () => {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = 'USER-001'
           WHERE reconcile_generation_id = ?
        `).run(fixture.binding.reconcileGenerationId)
      }, /COMPLETE_RECONCILIATION_CLOSE_MALFORMED/)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'complete',
        closed_at: null,
        closed_by: null,
      })
      // 夹具清理：坏 artifact 只用于 close trigger 探针，恢复主测试库后再进入下一轮。
      db.exec(`
        DROP TRIGGER trg_account_reconcile_completion_immutable;
        DROP TRIGGER trg_account_reconcile_complete_finality;
      `)
      db.prepare(`
        UPDATE account_reconcile_generations
           SET completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(validJson, validHash, fixture.binding.reconcileGenerationId)
      for (const { sql } of triggerSqls) db.exec(sql)
    }
  })

  it('direct complete→closed trigger applies the canonical contract to generation.closed_at/closed_by (zero write; 13 negatives + 2 leap-day positives)', () => {
    // fresh-R3 P1-A/P1-B trigger 通道②：先合法 raw complete（valid 镜像 artifact +
    // CURRENT_TIMESTAMP），再单变量 close。修复前仅 NULL closed_at 被拦（回归钉）；
    // 'USER-001\0junk' closed_by 经 node:sqlite 截断冒充合法（fresh blocker 真 RED）。
    const seedClosable = (label: string) => {
      const fixture = seedSemanticForgeMonthP1(label, VALID_SEMANTIC_SHAPE, { primeRevenue: true })
      const context = artifactForgeContext(db, fixture)
      const json = factBoundArtifactJson(context, context.facts)
      db.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
      return fixture
    }
    for (const [tag, badAt] of BAD_CANONICAL_TIMESTAMPS) {
      const fixture = seedClosable(`p1g-tl-at-${tag}`)
      expectDatabaseMutationBlocked(db, () => {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'closed', closed_at = ?, closed_by = 'USER-001'
           WHERE reconcile_generation_id = ?
        `).run(badAt, fixture.binding.reconcileGenerationId)
      }, /COMPLETE_RECONCILIATION_FINAL/)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'complete', closed_at: null, closed_by: null,
      })
    }
    for (const [tag, badBy] of BAD_CANONICAL_ACTORS) {
      const fixture = seedClosable(`p1g-tl-by-${tag}`)
      expectDatabaseMutationBlocked(db, () => {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ?
           WHERE reconcile_generation_id = ?
        `).run(badBy, fixture.binding.reconcileGenerationId)
      }, /COMPLETE_RECONCILIATION_FINAL/)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId)).toMatchObject({
        status: 'complete', closed_at: null, closed_by: null,
      })
    }
    // 正控：闰日 close 合法落库；hm 同步合法 complete→close 保持终态 fragment 一致，
    // 末段开机扫描零误伤。
    for (const [tag, goodAt] of LEAP_DAY_TIMESTAMPS) {
      const fixture = seedClosable(`p1g-tl-at-${tag}`)
      db.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'closed', closed_at = ?, closed_by = 'USER-001'
         WHERE reconcile_generation_id = ?
      `).run(goodAt, fixture.binding.reconcileGenerationId)
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET status = '复核完成', completed_at = CURRENT_TIMESTAMP, completed_by = 'USER-001',
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(fixture.hospitalMonthId)
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET status = '已关账', closed_at = CURRENT_TIMESTAMP, closed_by = 'USER-001',
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(fixture.hospitalMonthId)
      expect(bindingGenerationRow(db, fixture.binding.reconcileGenerationId))
        .toMatchObject({ status: 'closed', closed_at: goodAt })
    }
    expect(() => manager.upgradeAccountReconciliationSchema(db)).not.toThrow()
  })

  it('fails startup and real restart when completion artifact JSON or hash stores hidden NUL-tail bytes', () => {
    expectGenerationFieldForgeryRejectedScan(
      'p1g-s-artifact-json-nul-tail',
      'complete',
      row => {
        row.completion_artifact_json = `${row.completion_artifact_json}\0UNHASHED-TAIL`
      },
    )
    expectGenerationFieldForgeryRejectedScan(
      'p1g-s-artifact-hash-nul-tail',
      'complete',
      row => {
        row.completion_artifact_hash = `${row.completion_artifact_hash}\0UNVERIFIED-TAIL`
      },
    )
  })

  it('hospital-month terminal triggers reject NUL-tail actors before they can create contradictory terminal state (zero write)', () => {
    const pending = seedPendingMonthP1('p1hm-trigger-complete-actor-nul-tail')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET status = '复核完成', completed_at = CURRENT_TIMESTAMP, completed_by = ?
         WHERE id = ?
      `).run('USER-001\0UNVERIFIED-TAIL', pending.hospitalMonthId)
    }, /PENDING_HOSPITAL_MONTH_COMPLETION_MALFORMED/)
    expect(db.prepare(`
      SELECT status, completed_at, completed_by
        FROM reconcile_hospital_months WHERE id = ?
    `).get(pending.hospitalMonthId)).toMatchObject({
      status: '待复核',
      completed_at: null,
      completed_by: null,
    })

    const completed = seedPendingMonthP1('p1hm-trigger-close-actor-nul-tail')
    const diff = db.prepare(
      'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
    ).get(completed.hospitalMonthId) as { id: string }
    lifecycle.setAccountReconciliationVerdict(
      db,
      completed.binding,
      diff.id,
      '核对无误',
      null,
      'USER-001',
      'admin',
    )
    lifecycle.completeAccountReconciliation(db, completed.binding, 'USER-001')
    expectDatabaseMutationBlocked(db, () => {
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET status = '已关账', closed_at = CURRENT_TIMESTAMP, closed_by = ?
         WHERE id = ?
      `).run('USER-001\0UNVERIFIED-TAIL', completed.hospitalMonthId)
    }, /COMPLETE_HOSPITAL_MONTH_FINAL/)
    expect(db.prepare(`
      SELECT status, closed_at, closed_by
        FROM reconcile_hospital_months WHERE id = ?
    `).get(completed.hospitalMonthId)).toMatchObject({
      status: '复核完成',
      closed_at: null,
      closed_by: null,
    })
  })

  it('fails boot when a bound complete generation carries a non-canonical completed_at (fragment channel; first boot and real restart; 8-value table)', () => {
    // fresh-R3 P1-A：终态月扫描（片段）此前不查 generation.completed_at——伪造只能
    // 经 trigger 被摘窗口落入。NULL 修复前由 generation 扫描兜底（码不同=RED 同现）；
    // 其余 7 值修复前全通道放行（真 RED）。
    for (const [tag, badAt] of BAD_CANONICAL_TIMESTAMPS) {
      expectGenerationFieldForgeryRejectedFragment(
        `p1g-f-complete-at-${tag}`, 'complete',
        (probe, generationId) => {
          probe.prepare(`
            UPDATE account_reconcile_generations SET completed_at = ?
             WHERE reconcile_generation_id = ?
          `).run(badAt, generationId)
        },
      )
    }
  })

  it('fails boot when a bound closed generation carries a non-canonical closed_at (fragment channel; first boot and real restart; 8-value table)', () => {
    for (const [tag, badAt] of BAD_CANONICAL_TIMESTAMPS) {
      expectGenerationFieldForgeryRejectedFragment(
        `p1g-f-closed-at-${tag}`, 'closed',
        (probe, generationId) => {
          probe.prepare(`
            UPDATE account_reconcile_generations SET closed_at = ?
             WHERE reconcile_generation_id = ?
          `).run(badAt, generationId)
        },
      )
    }
  })

  it('fails boot when a bound terminal generation carries a drifted actor or a complete generation carries closed fields (fragment channel; first boot and real restart)', () => {
    // fresh-R3 P1-B：tab/newline/NBSP/NUL-only actor 在 SQLite trim 下冒充非空——
    // 片段修复前照单全收（真 RED）。complete 代夹带 closed 字段此前无人拦（真 RED）。
    // 'USER-001\0junk' 经 node:sqlite 截断在片段 UDF 单侧冒充合法（fresh blocker 真
    // RED）——修复后由片段内 BLOB instr(x'00') 原始字节闸命中。
    for (const [tag, badBy] of BAD_CANONICAL_ACTORS) {
      expectGenerationFieldForgeryRejectedFragment(
        `p1g-f-complete-by-${tag}`, 'complete',
        (probe, generationId) => {
          probe.prepare(`
            UPDATE account_reconcile_generations SET completed_by = ?
             WHERE reconcile_generation_id = ?
          `).run(badBy, generationId)
        },
      )
      expectGenerationFieldForgeryRejectedFragment(
        `p1g-f-closed-by-${tag}`, 'closed',
        (probe, generationId) => {
          probe.prepare(`
            UPDATE account_reconcile_generations SET closed_by = ?
             WHERE reconcile_generation_id = ?
          `).run(badBy, generationId)
        },
      )
    }
    expectGenerationFieldForgeryRejectedFragment(
      'p1g-f-complete-closed-at', 'complete',
      (probe, generationId) => {
        probe.prepare(`
          UPDATE account_reconcile_generations SET closed_at = '2026-08-01 10:00:00'
           WHERE reconcile_generation_id = ?
        `).run(generationId)
      },
    )
    expectGenerationFieldForgeryRejectedFragment(
      'p1g-f-complete-closed-by', 'complete',
      (probe, generationId) => {
        probe.prepare(`
          UPDATE account_reconcile_generations SET closed_by = 'closer'
           WHERE reconcile_generation_id = ?
        `).run(generationId)
      },
    )
  })

  it('fails boot on a non-canonical generation.completed_at/closed_at while the hospital month stays pending (generation-scan channel; first boot and real restart)', () => {
    // fresh-R3 P1-A：hm 保持 待复核 → 终态月扫描外层 WHERE 不命中——直接钉
    // ensureReconcileGenerationCompletionShape 的 canonical 子句。代表值 5 枚
    // （全 8 值由 trigger 通道与 fragment 通道两份钉死）；NULL 修复前已拦（回归钉）。
    const REPRESENTATIVE = BAD_CANONICAL_TIMESTAMPS.filter(([tag]) =>
      ['null', 'blob', 'integer', 'nul-junk', 'feb31'].includes(tag))
    for (const [tag, badAt] of REPRESENTATIVE) {
      expectGenerationFieldForgeryRejectedScan(
        `p1g-s-complete-at-${tag}`, 'complete',
        row => { row.completed_at = badAt },
      )
      expectGenerationFieldForgeryRejectedScan(
        `p1g-s-closed-at-${tag}`, 'closed',
        row => { row.closed_at = badAt },
      )
    }
  })

  it('fails boot on a drifted generation actor or a complete generation carrying closed fields while the hospital month stays pending (generation-scan channel; first boot and real restart)', () => {
    // fresh-R3 P1-B：tab/newline/NBSP-only 修复前已被 JS trim 拦截（回归钉）；
    // NUL-only 两侧均放行（真 RED）。complete 代夹带 closed 字段（真 RED）。
    // 'USER-001\0junk' 修复前 JS 扫描读到截断前缀误判合法（fresh blocker 真 RED）——
    // 修复后由扫描的 instr(CAST AS BLOB), x'00') 原始字节证据列命中。
    for (const [tag, badBy] of BAD_CANONICAL_ACTORS) {
      expectGenerationFieldForgeryRejectedScan(
        `p1g-s-complete-by-${tag}`, 'complete',
        row => { row.completed_by = badBy },
      )
      expectGenerationFieldForgeryRejectedScan(
        `p1g-s-closed-by-${tag}`, 'closed',
        row => { row.closed_by = badBy },
      )
    }
    expectGenerationFieldForgeryRejectedScan(
      'p1g-s-complete-closed-at', 'complete',
      row => { row.closed_at = '2026-08-01 10:00:00' },
    )
    expectGenerationFieldForgeryRejectedScan(
      'p1g-s-complete-closed-by', 'complete',
      row => { row.closed_by = 'closer' },
    )
  })

  it('boots clean when bound terminal generations carry legal leap days 2000-02-29/2024-02-29 (fragment + generation scan; first boot and real restart; no false positive)', () => {
    // 正控：世纪闰 2000-02-29 与 2024-02-29 真实存在——trigger 被摘窗口把
    // completed_at/closed_at 改为闰日后，首启与真实重启均零误炸。
    const proveLeapClean = (
      label: string,
      setup: 'complete' | 'closed',
      rewrite: Record<string, string>,
    ) => {
      const fixture = seedPendingMonthP1(label)
      const diff = db.prepare(
        'SELECT id FROM reconcile_diffs WHERE hospital_month_id = ?',
      ).get(fixture.hospitalMonthId) as { id: string }
      lifecycle.setAccountReconciliationVerdict(
        db, fixture.binding, diff.id, '核对无误', null, 'USER-001', 'admin',
      )
      lifecycle.completeAccountReconciliation(db, fixture.binding, 'USER-001')
      if (setup === 'closed') {
        lifecycle.closeAccountReconciliation(db, fixture.binding, 'USER-001')
      }
      const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
      db.prepare('VACUUM INTO ?').run(probePath)
      const seed = openRegisteredTestDatabase(probePath)
      try {
        dropReferencingTriggers(seed, 'account_reconcile_generations')
        const columns = Object.keys(rewrite)
        seed.prepare(`
          UPDATE account_reconcile_generations
             SET ${columns.map(column => `${column} = ?`).join(', ')}
           WHERE reconcile_generation_id = ?
        `).run(...columns.map(column => rewrite[column]), fixture.binding.reconcileGenerationId)
      } finally {
        seed.close()
      }
      const first = openRegisteredTestDatabase(probePath)
      try {
        expect(() => manager.upgradeAccountReconciliationSchema(first)).not.toThrow()
      } finally {
        first.close()
      }
      const second = openRegisteredTestDatabase(probePath)
      try {
        expect(() => manager.upgradeAccountReconciliationSchema(second)).not.toThrow()
      } finally {
        second.close()
      }
    }
    proveLeapClean(`p1g-leap-complete-${++sequence}`, 'complete', {
      completed_at: '2000-02-29 09:30:00',
    })
    proveLeapClean(`p1g-leap-closed-${++sequence}`, 'closed', {
      completed_at: '2000-02-29 09:30:00',
      closed_at: '2024-02-29 10:00:00',
    })
  })

  it('boots clean when bound terminal rows carry a legal Unicode (CJK) actor (fragment + generation scan; first boot and real restart; no false positive)', () => {
    // 合法 Unicode actor 正控（fresh blocker BLOB instr 闸的零误伤钉）：'张医生' 的
    // UTF-8 字节序列不含 0x00——BLOB instr(x'00') 闸、coreone_canonical_actor UDF、
    // JS isCanonicalActor 三层都必须放行。raw 形状与 T2 闰日正控同款（trigger 在位
    // 即放行的合法字段形状）：complete/closed 两侧 generation 与 hm 四 actor 全 CJK，
    // probe 首启与真实重启零误炸。
    const proveUnicodeActorClean = (label: string, setup: 'complete' | 'closed') => {
      const fixture = seedSemanticForgeMonthP1(label, VALID_SEMANTIC_SHAPE, { primeRevenue: true })
      const context = artifactForgeContext(db, fixture)
      const json = factBoundArtifactJson(context, context.facts)
      db.prepare(`
        UPDATE account_reconcile_generations
           SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = '张医生',
               completion_artifact_json = ?, completion_artifact_hash = ?
         WHERE reconcile_generation_id = ?
      `).run(json, prefixedSha256Of(json), fixture.binding.reconcileGenerationId)
      db.prepare(`
        UPDATE reconcile_hospital_months
           SET status = '复核完成', completed_at = CURRENT_TIMESTAMP, completed_by = '张医生',
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(fixture.hospitalMonthId)
      if (setup === 'closed') {
        db.prepare(`
          UPDATE account_reconcile_generations
             SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = '张医生'
           WHERE reconcile_generation_id = ?
        `).run(fixture.binding.reconcileGenerationId)
        db.prepare(`
          UPDATE reconcile_hospital_months
             SET status = '已关账', closed_at = CURRENT_TIMESTAMP, closed_by = '张医生',
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
        `).run(fixture.hospitalMonthId)
      }
      const probePath = join(testDirectory, `${label}-${++sequence}.sqlite`)
      db.prepare('VACUUM INTO ?').run(probePath)
      const first = openRegisteredTestDatabase(probePath)
      try {
        expect(() => manager.upgradeAccountReconciliationSchema(first)).not.toThrow()
      } finally {
        first.close()
      }
      const second = openRegisteredTestDatabase(probePath)
      try {
        expect(() => manager.upgradeAccountReconciliationSchema(second)).not.toThrow()
      } finally {
        second.close()
      }
    }
    proveUnicodeActorClean('p1g-unicode-complete', 'complete')
    proveUnicodeActorClean('p1g-unicode-closed', 'closed')
  })
})
