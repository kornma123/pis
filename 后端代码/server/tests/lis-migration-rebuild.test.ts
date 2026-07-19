/**
 * LIS migration admission contracts.
 *
 * These tests deliberately bypass p0-harness.getDb(): that helper initializes and stamps the
 * database before a legacy fixture can be installed. Each scenario instead gets a fresh module
 * graph and its own in-memory DatabaseManager connection.
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

type DatabaseManagerModule = typeof import('../src/database/DatabaseManager.js')

const originalEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  databasePath: process.env.DATABASE_PATH,
}

const CANONICAL_LIS_COLUMNS = [
  'id',
  'case_no',
  'project_id',
  'project_name',
  'operator',
  'operate_time',
  'status',
  'import_batch',
  'created_at',
  'partner_id',
  'specimen_type',
  'specimen_type_source',
  'he_slide_count',
  'block_count',
  'ihc_count',
  'special_stain_count',
  'eber_count',
  'pdl1_count',
  'business_line',
  'business_line_source',
  'service_step_scope',
  'service_step_scope_source',
] as const

let activeDatabaseModule: DatabaseManagerModule | undefined

async function loadFreshMemoryDatabase(): Promise<{
  database: DatabaseSync
  databaseModule: DatabaseManagerModule
}> {
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_PATH = ':memory:'
  vi.resetModules()

  const databaseModule = await import('../src/database/DatabaseManager.js')
  activeDatabaseModule = databaseModule
  return { database: databaseModule.getDatabase(), databaseModule }
}

function installLegacyLisFixture(
  database: DatabaseSync,
  options: { extraFingerprintColumn?: boolean } = {},
): void {
  const fingerprintMutation = options.extraFingerprintColumn
    ? ', unexpected_fingerprint_column TEXT'
    : ''

  database.exec(`
    CREATE TABLE lis_cases (
      id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL UNIQUE,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'normal',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ${fingerprintMutation}
    );

    INSERT INTO lis_cases (id, case_no, project_id, status, created_at)
    VALUES ('OLD1', 'OLD-CASE-1', 'PROJECT-OLD-1', 'signed', '2026-06-01T00:00:00.000Z');
    INSERT INTO lis_cases (id, case_no, project_id, created_at)
    VALUES ('OLD2', 'OLD-CASE-2', 'PROJECT-OLD-2', '2026-06-02T00:00:00.000Z');
  `)
}

function readUserVersion(database: DatabaseSync): { user_version: number } {
  return database.prepare('PRAGMA user_version').get() as { user_version: number }
}

function readSchemaVersion(database: DatabaseSync): { schema_version: number } {
  return database.prepare('PRAGMA schema_version').get() as { schema_version: number }
}

function historyTableExists(database: DatabaseSync): boolean {
  return Boolean(database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration_history'",
  ).get())
}

function readHistory(database: DatabaseSync): unknown[] {
  return database.prepare(`
    SELECT step_id, source_version, target_version, checksum, applied_at
    FROM schema_migration_history
    ORDER BY step_id
  `).all()
}

function readUniqueKeys(database: DatabaseSync, table: string): string[][] {
  return (database.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
    name: string
    unique: number
    origin?: string
  }>)
    .filter(index => index.unique === 1 && index.origin !== 'pk')
    .map(index => (database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
      seqno: number
      name: string
    }>)
      .sort((left, right) => left.seqno - right.seqno)
      .map(column => column.name))
    .sort((left, right) => left.join(',').localeCompare(right.join(',')))
}

function readSchemaSql(database: DatabaseSync): unknown[] {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all()
}

function readLisSchemaSql(database: DatabaseSync): unknown[] {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE tbl_name = 'lis_cases' OR name = 'lis_cases'
    ORDER BY type, name
  `).all()
}

function readTemporaryMigrationTables(database: DatabaseSync): unknown[] {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE name LIKE '%__migration_v1' OR name LIKE '%__new'
    ORDER BY name
  `).all()
}

function readLegacyRows(database: DatabaseSync): unknown[] {
  return database.prepare(`
    SELECT id, case_no, project_id, status, created_at
    FROM lis_cases
    ORDER BY id
  `).all()
}

function restoreEnvironment(): void {
  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalEnvironment.nodeEnv
  if (originalEnvironment.databasePath === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = originalEnvironment.databasePath
}

afterEach(() => {
  activeDatabaseModule?.closeDatabase()
  activeDatabaseModule = undefined
  restoreEnvironment()
  vi.resetModules()
})

describe('LIS migration admission contracts', () => {
  it('A: admits the exact legacy v0 shape before stamping, preserves rows, and is idempotent at v1', async () => {
    const { database, databaseModule } = await loadFreshMemoryDatabase()
    installLegacyLisFixture(database)

    expect(readUserVersion(database)).toEqual({ user_version: 0 })
    expect(historyTableExists(database)).toBe(false)
    expect(database.prepare('PRAGMA table_info(lis_cases)').all()).toEqual([
      { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'case_no', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'project_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 3, name: 'status', type: 'TEXT', notnull: 1, dflt_value: "'normal'", pk: 0 },
      {
        cid: 4,
        name: 'created_at',
        type: 'DATETIME',
        notnull: 1,
        dflt_value: 'CURRENT_TIMESTAMP',
        pk: 0,
      },
    ])
    expect(readUniqueKeys(database, 'lis_cases')).toEqual([['case_no']])
    expect(readLegacyRows(database)).toEqual([
      {
        id: 'OLD1',
        case_no: 'OLD-CASE-1',
        project_id: 'PROJECT-OLD-1',
        status: 'signed',
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'OLD2',
        case_no: 'OLD-CASE-2',
        project_id: 'PROJECT-OLD-2',
        status: 'normal',
        created_at: '2026-06-02T00:00:00.000Z',
      },
    ])

    databaseModule.initializeDatabase()

    const canonicalStep = (await import('../src/database/migrations/manifest.js'))
      .CANONICAL_MIGRATION_MANIFEST.legacySteps.find(step => (
        step.id === 'legacy-lis-cases-partner-unique-v1'
      ))
    expect(canonicalStep).toBeDefined()
    expect(database.prepare('PRAGMA table_info(lis_cases)').all().map(column => String(column.name)))
      .toEqual(CANONICAL_LIS_COLUMNS)
    expect(readUniqueKeys(database, 'lis_cases')).toEqual([['partner_id', 'case_no']])
    expect(database.prepare(`
      SELECT id, case_no, project_id, project_name, status, partner_id
      FROM lis_cases
      ORDER BY id
    `).all()).toEqual([
      {
        id: 'OLD1',
        case_no: 'OLD-CASE-1',
        project_id: 'PROJECT-OLD-1',
        project_name: null,
        status: 'signed',
        partner_id: null,
      },
      {
        id: 'OLD2',
        case_no: 'OLD-CASE-2',
        project_id: 'PROJECT-OLD-2',
        project_name: null,
        status: 'normal',
        partner_id: null,
      },
    ])
    expect(readHistory(database)).toEqual([{
      step_id: canonicalStep?.id,
      source_version: canonicalStep?.sourceVersion,
      target_version: canonicalStep?.targetVersion,
      checksum: canonicalStep?.checksum,
      applied_at: expect.any(String),
    }])
    expect(readUserVersion(database)).toEqual({ user_version: 1 })
    expect(readTemporaryMigrationTables(database)).toEqual([])

    const beforeSecondStartup = {
      schema: readSchemaSql(database),
      history: readHistory(database),
      userVersion: readUserVersion(database),
      schemaVersion: readSchemaVersion(database),
    }
    databaseModule.initializeDatabase()
    const afterSecondStartup = {
      schema: readSchemaSql(database),
      history: readHistory(database),
      userVersion: readUserVersion(database),
      schemaVersion: readSchemaVersion(database),
    }
    expect(afterSecondStartup.schema).toEqual(beforeSecondStartup.schema)
    expect(afterSecondStartup.history).toEqual(beforeSecondStartup.history)
    expect(afterSecondStartup.userVersion).toEqual(beforeSecondStartup.userVersion)
    expect(afterSecondStartup.schemaVersion).toEqual(beforeSecondStartup.schemaVersion)

    database.prepare(`
      INSERT INTO lis_cases (id, case_no, partner_id)
      VALUES ('NEW-A', 'OLD-CASE-1', 'P-A')
    `).run()
    expect(() => database.prepare(`
      INSERT INTO lis_cases (id, case_no, partner_id)
      VALUES ('NEW-A2', 'OLD-CASE-1', 'P-A')
    `).run()).toThrow()
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM lis_cases WHERE case_no = 'OLD-CASE-1' AND partner_id = 'P-A'",
    ).get()).toEqual({ count: 1 })
  })

  it('B: rejects stamped target drift without healing or partial writes', async () => {
    const { database, databaseModule } = await loadFreshMemoryDatabase()
    databaseModule.initializeDatabase()

    const stampedHistory = readHistory(database)
    const stampedUserVersion = readUserVersion(database)
    expect(stampedUserVersion).toEqual({ user_version: 1 })

    database.exec('DROP TABLE lis_cases')
    installLegacyLisFixture(database)
    expect(readHistory(database)).toEqual(stampedHistory)
    expect(readUserVersion(database)).toEqual(stampedUserVersion)

    const before = {
      schemaSql: readLisSchemaSql(database),
      rows: readLegacyRows(database),
      history: readHistory(database),
      userVersion: readUserVersion(database),
      schemaVersion: readSchemaVersion(database),
    }
    expect(() => databaseModule.initializeDatabase()).toThrow(
      /^MIGRATION_POSTCONDITION_FAILED: lis_cases missing project_name$/,
    )
    const after = {
      schemaSql: readLisSchemaSql(database),
      rows: readLegacyRows(database),
      history: readHistory(database),
      userVersion: readUserVersion(database),
      schemaVersion: readSchemaVersion(database),
    }

    expect(after.schemaSql).toEqual(before.schemaSql)
    expect(after.rows).toEqual(before.rows)
    expect(after.history).toEqual(before.history)
    expect(after.userVersion).toEqual(before.userVersion)
    expect(after.schemaVersion).toEqual(before.schemaVersion)
  })

  it('negative control: rejects a one-column fingerprint mutation at v0 with zero writes', async () => {
    const { database, databaseModule } = await loadFreshMemoryDatabase()
    installLegacyLisFixture(database, { extraFingerprintColumn: true })

    const before = {
      schemaSql: readSchemaSql(database),
      rows: database.prepare('SELECT * FROM lis_cases ORDER BY id').all(),
      historyExists: historyTableExists(database),
      userVersion: readUserVersion(database),
      schemaVersion: readSchemaVersion(database),
      temporaryTables: readTemporaryMigrationTables(database),
    }
    expect(before.historyExists).toBe(false)
    expect(before.userVersion).toEqual({ user_version: 0 })

    expect(() => databaseModule.initializeDatabase()).toThrow(
      /^UNKNOWN_SCHEMA_STATE: version=0 fingerprint=[a-f0-9]{64}$/,
    )
    const after = {
      schemaSql: readSchemaSql(database),
      rows: database.prepare('SELECT * FROM lis_cases ORDER BY id').all(),
      historyExists: historyTableExists(database),
      userVersion: readUserVersion(database),
      schemaVersion: readSchemaVersion(database),
      temporaryTables: readTemporaryMigrationTables(database),
    }

    expect(after.schemaSql).toEqual(before.schemaSql)
    expect(after.rows).toEqual(before.rows)
    expect(after.historyExists).toBe(false)
    expect(after.userVersion).toEqual({ user_version: 0 })
    expect(after.schemaVersion).toEqual(before.schemaVersion)
    expect(after.temporaryTables).toEqual([])
  })
})
