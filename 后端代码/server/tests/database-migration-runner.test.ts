import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CANONICAL_MIGRATION_MANIFEST } from '../src/database/migrations/manifest.js'
import { enforceForeignKeys, runDatabaseMigrations } from '../src/database/migrations/runner.js'

const LEGACY_CASE_REVENUE_SQL = `
  CREATE TABLE case_revenue (
    id TEXT PRIMARY KEY,
    case_no TEXT NOT NULL,
    partner_id TEXT NOT NULL,
    partner_name TEXT NOT NULL,
    doc_no TEXT,
    gross_amount REAL NOT NULL DEFAULT 0,
    net_amount REAL NOT NULL DEFAULT 0,
    discount_rate REAL NOT NULL DEFAULT 1,
    service_month TEXT NOT NULL,
    line_count INTEGER NOT NULL DEFAULT 0,
    import_batch TEXT,
    config_version TEXT,
    lab_revenue REAL NOT NULL DEFAULT 0,
    out_revenue REAL NOT NULL DEFAULT 0,
    diagnosis_revenue REAL NOT NULL DEFAULT 0,
    revenue_source TEXT,
    unallocated_amount REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(case_no, service_month)
  );

  INSERT INTO case_revenue (
    id, case_no, partner_id, partner_name, doc_no,
    gross_amount, net_amount, discount_rate, service_month, line_count,
    import_batch, config_version, lab_revenue, out_revenue,
    diagnosis_revenue, revenue_source, unallocated_amount,
    created_at, updated_at
  ) VALUES (
    'revenue-legacy-1', 'CASE-LEGACY-1', 'partner-legacy-1', 'Legacy Partner', 'DOC-1',
    1000, 900, 0.9, '2026-06', 3,
    'batch-legacy-1', 'config-v0', 400, 300,
    175.5, 'legacy-import', 24.5,
    '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z'
  );
`

const LEGACY_LIS_CASES_SQL = `
  CREATE TABLE lis_cases (
    id TEXT PRIMARY KEY,
    case_no TEXT NOT NULL UNIQUE,
    project_id TEXT,
    status TEXT NOT NULL DEFAULT 'normal',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO lis_cases (id, case_no, project_id, status, created_at)
  VALUES ('OLD1', 'OLD-CASE-1', 'PROJECT-OLD-1', 'signed', '2026-06-01T00:00:00.000Z');
  INSERT INTO lis_cases (id, case_no, project_id, created_at)
  VALUES ('OLD2', 'OLD-CASE-2', 'PROJECT-OLD-2', '2026-06-02T00:00:00.000Z');
`

const originalEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  databasePath: process.env.DATABASE_PATH,
  allowFixtureUsers: process.env.COREONE_ALLOW_DEFAULT_FIXTURE_USERS,
}

let temporaryDirectory: string | undefined

function createTemporaryDatabase(name: string, sql: string): string {
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), `coreone-migration-${name}-`))
  const databasePath = path.join(temporaryDirectory, `${name}.sqlite`)
  const database = new DatabaseSync(databasePath)
  database.exec(sql)
  database.close()
  return databasePath
}

async function loadDatabaseManager(databasePath: string) {
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_PATH = databasePath
  process.env.COREONE_ALLOW_DEFAULT_FIXTURE_USERS = 'true'
  vi.resetModules()
  return import('../src/database/DatabaseManager.js')
}

afterEach(async () => {
  try {
    const databaseModule = await import('../src/database/DatabaseManager.js')
    databaseModule.closeDatabase()
  } catch {
    // The RED harness can fail before DatabaseManager finishes loading.
  }

  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalEnvironment.nodeEnv
  if (originalEnvironment.databasePath === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = originalEnvironment.databasePath
  if (originalEnvironment.allowFixtureUsers === undefined) {
    delete process.env.COREONE_ALLOW_DEFAULT_FIXTURE_USERS
  } else {
    process.env.COREONE_ALLOW_DEFAULT_FIXTURE_USERS = originalEnvironment.allowFixtureUsers
  }

  vi.resetModules()
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe('database migration admission runner', () => {
  it('preserves legacy case_revenue diagnosis and unallocated values during the unique-key rebuild', async () => {
    const databasePath = createTemporaryDatabase('legacy', LEGACY_CASE_REVENUE_SQL)
    const databaseModule = await loadDatabaseManager(databasePath)
    databaseModule.initializeDatabase()

    const migratedDatabase = databaseModule.getDatabase()
    const columns = migratedDatabase.prepare('PRAGMA table_info(case_revenue)').all()
      .map((column) => String(column.name))
    const migratedRow = migratedDatabase.prepare(
      "SELECT * FROM case_revenue WHERE id = 'revenue-legacy-1'",
    ).get() as Record<string, unknown>

    expect({
      columns,
      diagnosisRevenue: migratedRow.diagnosis_revenue,
      unallocatedAmount: migratedRow.unallocated_amount,
    }).toEqual({
      columns: expect.arrayContaining(['diagnosis_revenue', 'unallocated_amount']),
      diagnosisRevenue: 175.5,
      unallocatedAmount: 24.5,
    })

    const canonicalStep = CANONICAL_MIGRATION_MANIFEST.legacySteps[0]
    expect(migratedDatabase.prepare(`
      SELECT step_id, source_version, target_version, checksum
      FROM schema_migration_history
    `).get()).toEqual({
      step_id: canonicalStep.id,
      source_version: canonicalStep.sourceVersion,
      target_version: canonicalStep.targetVersion,
      checksum: canonicalStep.checksum,
    })
    expect(migratedDatabase.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })

    migratedDatabase.prepare(`
      INSERT INTO case_revenue (
        id, case_no, partner_id, service_month, net_amount,
        diagnosis_revenue, unallocated_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(partner_id, case_no, service_month) DO UPDATE SET
        net_amount = excluded.net_amount,
        diagnosis_revenue = excluded.diagnosis_revenue,
        unallocated_amount = excluded.unallocated_amount
    `).run('statement-followup-1', 'CASE-FOLLOWUP-1', 'partner-legacy-1', '2026-07', 80, 70, 10)
    expect(migratedDatabase.prepare(
      "SELECT diagnosis_revenue, unallocated_amount FROM case_revenue WHERE id = 'statement-followup-1'",
    ).get()).toEqual({ diagnosis_revenue: 70, unallocated_amount: 10 })
  })

  it('admits only the fixed legacy LIS v0 fingerprint and preserves its rows while installing the canonical key', async () => {
    const databasePath = createTemporaryDatabase('legacy-lis', LEGACY_LIS_CASES_SQL)
    const databaseModule = await loadDatabaseManager(databasePath)
    databaseModule.initializeDatabase()

    const database = databaseModule.getDatabase()
    const columns = database.prepare('PRAGMA table_info(lis_cases)').all()
      .map(column => String(column.name))
    const tableSql = String((database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lis_cases'",
    ).get() as { sql: string }).sql)
    const rows = database.prepare(`
      SELECT id, case_no, project_id, status, partner_id
      FROM lis_cases
      WHERE id IN ('OLD1', 'OLD2')
      ORDER BY id
    `).all()
    const uniqueIndexes = (database.prepare('PRAGMA index_list(lis_cases)').all() as Array<{
      name: string
      unique: number
    }>).filter(index => index.unique === 1).map(index => (
      database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
        seqno: number
        name: string
      }>
    ).sort((left, right) => left.seqno - right.seqno).map(column => column.name))

    expect(columns).toEqual(expect.arrayContaining([
      'partner_id',
      'he_slide_count',
      'specimen_type',
      'import_batch',
    ]))
    expect(tableSql).not.toMatch(/case_no\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
    expect(rows).toEqual([
      {
        id: 'OLD1',
        case_no: 'OLD-CASE-1',
        project_id: 'PROJECT-OLD-1',
        status: 'signed',
        partner_id: null,
      },
      {
        id: 'OLD2',
        case_no: 'OLD-CASE-2',
        project_id: 'PROJECT-OLD-2',
        status: 'normal',
        partner_id: null,
      },
    ])
    expect(uniqueIndexes).toContainEqual(['partner_id', 'case_no'])
    expect(uniqueIndexes).not.toContainEqual(['case_no'])

    database.prepare(`
      INSERT INTO lis_cases (id, case_no, partner_id)
      VALUES ('NEW-A', 'OLD-CASE-1', 'P-A')
    `).run()
    expect(() => database.prepare(`
      INSERT INTO lis_cases (id, case_no, partner_id)
      VALUES ('NEW-A2', 'OLD-CASE-1', 'P-A')
    `).run()).toThrow()

    const canonicalStep = CANONICAL_MIGRATION_MANIFEST.legacySteps.find(step => (
      step.id === 'legacy-lis-cases-partner-unique-v1'
    ))
    expect(canonicalStep).toBeDefined()
    expect(database.prepare(`
      SELECT step_id, source_version, target_version, checksum
      FROM schema_migration_history
    `).get()).toEqual({
      step_id: canonicalStep?.id,
      source_version: canonicalStep?.sourceVersion,
      target_version: canonicalStep?.targetVersion,
      checksum: canonicalStep?.checksum,
    })
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
  })

  it('keeps a target database structurally and historically unchanged on a second startup', async () => {
    const databasePath = createTemporaryDatabase('idempotent', '')
    const databaseModule = await loadDatabaseManager(databasePath)
    databaseModule.initializeDatabase()
    const database = databaseModule.getDatabase()

    const snapshot = () => ({
      schemaVersion: database.prepare('PRAGMA schema_version').get(),
      userVersion: database.prepare('PRAGMA user_version').get(),
      history: database.prepare(`
        SELECT step_id, source_version, target_version, checksum, applied_at
        FROM schema_migration_history ORDER BY step_id
      `).all(),
      schema: database.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all(),
    })

    const before = snapshot()
    databaseModule.initializeDatabase()
    const after = snapshot()

    expect(after).toEqual(before)
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('fails closed without writes when a stamped v1 database has a downgraded LIS shape', async () => {
    const databasePath = createTemporaryDatabase('tampered-lis', '')
    const databaseModule = await loadDatabaseManager(databasePath)
    databaseModule.initializeDatabase()
    const database = databaseModule.getDatabase()

    database.exec('DROP TABLE lis_cases')
    database.exec(LEGACY_LIS_CASES_SQL)

    const snapshot = () => ({
      schemaVersion: database.prepare('PRAGMA schema_version').get(),
      userVersion: database.prepare('PRAGMA user_version').get(),
      history: database.prepare(`
        SELECT step_id, source_version, target_version, checksum, applied_at
        FROM schema_migration_history
        ORDER BY step_id
      `).all(),
      lisSchema: database.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE tbl_name = 'lis_cases' OR name = 'lis_cases'
        ORDER BY type, name
      `).all(),
      lisColumns: database.prepare('PRAGMA table_info(lis_cases)').all(),
      lisRows: database.prepare('SELECT * FROM lis_cases ORDER BY id').all(),
    })

    const before = snapshot()
    expect(() => databaseModule.initializeDatabase()).toThrow(
      /MIGRATION_POSTCONDITION_FAILED: lis_cases/,
    )
    expect(snapshot()).toEqual(before)
  })

  it('fails hard when target history checksum no longer matches the manifest', async () => {
    const databasePath = createTemporaryDatabase('checksum', '')
    const databaseModule = await loadDatabaseManager(databasePath)
    databaseModule.initializeDatabase()
    databaseModule.getDatabase().prepare(
      "UPDATE schema_migration_history SET checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
    ).run()

    expect(() => databaseModule.initializeDatabase()).toThrow(/MIGRATION_HISTORY_MISMATCH/)
  })

  it('forces foreign keys on and rejects a connection where SQLite cannot enable them', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;')
    expect(() => enforceForeignKeys(database)).toThrow(/FOREIGN_KEYS_REQUIRED/)
    database.exec('ROLLBACK')

    enforceForeignKeys(database)
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    database.close()
  })

  it('opens every admitted transition with BEGIN IMMEDIATE', () => {
    const databasePath = createTemporaryDatabase('begin-immediate', LEGACY_CASE_REVENUE_SQL)
    const database = new DatabaseSync(databasePath)
    const executedStatements: string[] = []
    const tracedDatabase = new Proxy(database, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (property === 'exec') {
          return (sql: string) => {
            executedStatements.push(sql.trim())
            return target.exec(sql)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as DatabaseSync

    const transactionTraceManifest = {
      ...CANONICAL_MIGRATION_MANIFEST,
      assertTarget: () => undefined,
    }

    try {
      runDatabaseMigrations(tracedDatabase, () => undefined, transactionTraceManifest)
      expect(executedStatements.find(statement => /^BEGIN\b/.test(statement))).toBe('BEGIN IMMEDIATE')
    } finally {
      database.close()
    }
  })

  it('rejects an unknown unversioned schema before initialization writes', async () => {
    const databasePath = createTemporaryDatabase('unknown', `
      CREATE TABLE unexpected_domain_state (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `)
    const databaseModule = await loadDatabaseManager(databasePath)

    expect(() => databaseModule.initializeDatabase()).toThrow(/UNKNOWN_SCHEMA_STATE/)
  })

  it('rejects a partially stamped migration state', async () => {
    const databasePath = createTemporaryDatabase('partial', `
      CREATE TABLE schema_migration_history (
        step_id TEXT PRIMARY KEY,
        source_version INTEGER NOT NULL,
        target_version INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migration_history (
        step_id, source_version, target_version, checksum, applied_at
      ) VALUES ('partial-v0-v1', 0, 1, 'not-canonical', '2026-07-19T00:00:00.000Z');
      PRAGMA user_version = 0;
    `)
    const databaseModule = await loadDatabaseManager(databasePath)

    expect(() => databaseModule.initializeDatabase()).toThrow(/PARTIAL_MIGRATION_STATE/)
  })

  it('rejects a schema version ahead of the canonical manifest', async () => {
    const databasePath = createTemporaryDatabase('ahead', 'PRAGMA user_version = 99;')
    const databaseModule = await loadDatabaseManager(databasePath)

    expect(() => databaseModule.initializeDatabase()).toThrow(/SCHEMA_VERSION_AHEAD/)
  })

  it('rolls back and rethrows the original failure instead of leaving a partial migration', async () => {
    const databasePath = createTemporaryDatabase('fault', LEGACY_CASE_REVENUE_SQL)
    const database = new DatabaseSync(databasePath)
    const canonicalStep = CANONICAL_MIGRATION_MANIFEST.legacySteps[0]
    const injectedFailure = new Error('INJECTED_MIGRATION_FAILURE')
    const faultManifest = {
      ...CANONICAL_MIGRATION_MANIFEST,
      legacySteps: [{
        ...canonicalStep,
        apply(databaseUnderTest: DatabaseSync) {
          canonicalStep.apply(databaseUnderTest)
          throw injectedFailure
        },
      }],
    }

    let observedFailure: unknown
    try {
      runDatabaseMigrations(database, () => undefined, faultManifest)
    } catch (error) {
      observedFailure = error
    }

    const schemaVersion = database.prepare('PRAGMA user_version').get()
    const historyTable = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration_history'",
    ).get()
    const migrationTable = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'case_revenue__migration_v1'",
    ).get()
    const preservedRow = database.prepare(
      "SELECT diagnosis_revenue, unallocated_amount FROM case_revenue WHERE id = 'revenue-legacy-1'",
    ).get()
    database.close()

    expect(observedFailure).toBe(injectedFailure)
    expect({ schemaVersion, historyTable, migrationTable, preservedRow }).toEqual({
      schemaVersion: { user_version: 0 },
      historyTable: undefined,
      migrationTable: undefined,
      preservedRow: { diagnosis_revenue: 175.5, unallocated_amount: 24.5 },
    })
  })
})
