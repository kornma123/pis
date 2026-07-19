import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const CURRENT_SCHEMA_VERSION = 1
export const MIGRATION_HISTORY_TABLE = 'schema_migration_history'

export interface MigrationIdentity {
  readonly id: string
  readonly sourceVersion: number
  readonly targetVersion: number
  readonly checksum: string
}

export interface LegacyMigrationStep extends MigrationIdentity {
  readonly sourceFingerprint: string
  readonly apply: (database: DatabaseSync) => void
}

export interface MigrationManifest {
  readonly targetVersion: number
  readonly bootstrap: MigrationIdentity
  readonly legacySteps: readonly LegacyMigrationStep[]
  readonly assertTarget: (database: DatabaseSync) => void
}

export interface SchemaColumnFingerprint {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly defaultValue: string | null
  readonly primaryKeyPosition: number
}

export interface SchemaTableFingerprint {
  readonly name: string
  readonly columns: readonly SchemaColumnFingerprint[]
  readonly uniqueIndexes: readonly (readonly string[])[]
}

export interface SchemaFingerprintDescriptor {
  readonly tables: readonly SchemaTableFingerprint[]
}

export function checksumCanonicalValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const LEGACY_CASE_REVENUE_V0_DESCRIPTOR: SchemaFingerprintDescriptor = {
  tables: [
    {
      name: 'case_revenue',
      columns: [
        { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, primaryKeyPosition: 1 },
        { name: 'case_no', type: 'TEXT', notnull: 1, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'partner_id', type: 'TEXT', notnull: 1, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'partner_name', type: 'TEXT', notnull: 1, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'doc_no', type: 'TEXT', notnull: 0, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'gross_amount', type: 'REAL', notnull: 1, defaultValue: '0', primaryKeyPosition: 0 },
        { name: 'net_amount', type: 'REAL', notnull: 1, defaultValue: '0', primaryKeyPosition: 0 },
        { name: 'discount_rate', type: 'REAL', notnull: 1, defaultValue: '1', primaryKeyPosition: 0 },
        { name: 'service_month', type: 'TEXT', notnull: 1, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'line_count', type: 'INTEGER', notnull: 1, defaultValue: '0', primaryKeyPosition: 0 },
        { name: 'import_batch', type: 'TEXT', notnull: 0, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'config_version', type: 'TEXT', notnull: 0, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'lab_revenue', type: 'REAL', notnull: 1, defaultValue: '0', primaryKeyPosition: 0 },
        { name: 'out_revenue', type: 'REAL', notnull: 1, defaultValue: '0', primaryKeyPosition: 0 },
        { name: 'diagnosis_revenue', type: 'REAL', notnull: 1, defaultValue: '0', primaryKeyPosition: 0 },
        { name: 'revenue_source', type: 'TEXT', notnull: 0, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'unallocated_amount', type: 'REAL', notnull: 1, defaultValue: '0', primaryKeyPosition: 0 },
        { name: 'created_at', type: 'TEXT', notnull: 1, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'updated_at', type: 'TEXT', notnull: 1, defaultValue: null, primaryKeyPosition: 0 },
      ],
      uniqueIndexes: [['case_no', 'service_month']],
    },
  ],
}

const LEGACY_LIS_CASES_V0_DESCRIPTOR: SchemaFingerprintDescriptor = {
  tables: [
    {
      name: 'lis_cases',
      columns: [
        { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, primaryKeyPosition: 1 },
        { name: 'case_no', type: 'TEXT', notnull: 1, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'project_id', type: 'TEXT', notnull: 0, defaultValue: null, primaryKeyPosition: 0 },
        { name: 'status', type: 'TEXT', notnull: 1, defaultValue: "'normal'", primaryKeyPosition: 0 },
        {
          name: 'created_at',
          type: 'DATETIME',
          notnull: 1,
          defaultValue: 'CURRENT_TIMESTAMP',
          primaryKeyPosition: 0,
        },
      ],
      uniqueIndexes: [['case_no']],
    },
  ],
}

const CASE_REVENUE_TARGET_SQL = `
  CREATE TABLE case_revenue__migration_v1 (
    id TEXT PRIMARY KEY,
    case_no TEXT NOT NULL,
    partner_id TEXT,
    partner_name TEXT,
    doc_no TEXT,
    gross_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
    net_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
    discount_rate DECIMAL(10, 6) NOT NULL DEFAULT 0,
    service_month TEXT,
    line_count INTEGER NOT NULL DEFAULT 0,
    import_batch TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    config_version INTEGER,
    lab_revenue DECIMAL(18, 4),
    out_revenue DECIMAL(18, 4) NOT NULL DEFAULT 0,
    diagnosis_revenue DECIMAL(18, 4) NOT NULL DEFAULT 0,
    revenue_source TEXT,
    unallocated_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
    UNIQUE(partner_id, case_no, service_month)
  )
`

const CASE_REVENUE_COPY_COLUMNS = [
  'id',
  'case_no',
  'partner_id',
  'partner_name',
  'doc_no',
  'gross_amount',
  'net_amount',
  'discount_rate',
  'service_month',
  'line_count',
  'import_batch',
  'created_at',
  'updated_at',
  'config_version',
  'lab_revenue',
  'out_revenue',
  'diagnosis_revenue',
  'revenue_source',
  'unallocated_amount',
] as const

const CASE_REVENUE_COPY_LIST = CASE_REVENUE_COPY_COLUMNS.join(', ')

const LIS_CASES_TARGET_SQL = `
  CREATE TABLE lis_cases__migration_v1 (
    id TEXT PRIMARY KEY,
    case_no TEXT NOT NULL,
    project_id TEXT,
    project_name TEXT,
    operator TEXT,
    operate_time TEXT,
    status TEXT NOT NULL DEFAULT 'normal',
    import_batch TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    partner_id TEXT,
    specimen_type TEXT,
    specimen_type_source TEXT NOT NULL DEFAULT 'auto',
    he_slide_count INTEGER NOT NULL DEFAULT 0,
    block_count INTEGER NOT NULL DEFAULT 0,
    ihc_count INTEGER NOT NULL DEFAULT 0,
    special_stain_count INTEGER NOT NULL DEFAULT 0,
    eber_count INTEGER NOT NULL DEFAULT 0,
    pdl1_count INTEGER NOT NULL DEFAULT 0,
    business_line TEXT,
    business_line_source TEXT NOT NULL DEFAULT 'auto',
    service_step_scope TEXT,
    service_step_scope_source TEXT NOT NULL DEFAULT 'auto'
  )
`

const LIS_CASES_SOURCE_COLUMNS = [
  'id',
  'case_no',
  'project_id',
  'status',
  'created_at',
] as const

const LIS_CASES_TARGET_COLUMNS = [
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

const LIS_CASES_SOURCE_LIST = LIS_CASES_SOURCE_COLUMNS.join(', ')

function uniqueIndexColumns(database: DatabaseSync, table: string): string[][] {
  const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
    name: string
    unique: number
    origin?: string
  }>

  return indexes
    .filter(index => index.unique === 1 && index.origin !== 'pk')
    .map(index => (database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
      seqno: number
      name: string
    }>).sort((left, right) => left.seqno - right.seqno).map(column => column.name))
}

function assertCaseRevenueTarget(database: DatabaseSync): void {
  const table = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'case_revenue'",
  ).get() as { present?: number } | undefined
  if (!table?.present) {
    throw new Error('MIGRATION_POSTCONDITION_FAILED: missing case_revenue')
  }

  const columns = database.prepare('PRAGMA table_info(case_revenue)').all() as Array<{
    name: string
    notnull: number
    dflt_value: string | null
  }>
  const byName = new Map(columns.map(column => [column.name, column]))
  for (const name of CASE_REVENUE_COPY_COLUMNS) {
    if (!byName.has(name)) {
      throw new Error(`MIGRATION_POSTCONDITION_FAILED: case_revenue missing ${name}`)
    }
  }
  for (const name of ['diagnosis_revenue', 'unallocated_amount']) {
    const column = byName.get(name)
    if (column?.notnull !== 1 || column.dflt_value !== '0') {
      throw new Error(`MIGRATION_POSTCONDITION_FAILED: case_revenue ${name} constraint drift`)
    }
  }

  const uniqueIndexes = uniqueIndexColumns(database, 'case_revenue')
  const hasCanonicalUnique = uniqueIndexes.some(columnsInIndex => (
    columnsInIndex.join(',') === 'partner_id,case_no,service_month'
  ))
  const hasLegacyUnique = uniqueIndexes.some(columnsInIndex => (
    columnsInIndex.join(',') === 'case_no,service_month'
  ))
  if (!hasCanonicalUnique || hasLegacyUnique) {
    throw new Error('MIGRATION_POSTCONDITION_FAILED: case_revenue unique key drift')
  }
}

function assertLisCasesTarget(database: DatabaseSync): void {
  const table = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'lis_cases'",
  ).get() as { present?: number } | undefined
  if (!table?.present) {
    throw new Error('MIGRATION_POSTCONDITION_FAILED: lis_cases missing table')
  }

  const columns = database.prepare('PRAGMA table_info(lis_cases)').all() as Array<{
    name: string
    notnull: number
    dflt_value: string | null
  }>
  const byName = new Map(columns.map(column => [column.name, column]))
  for (const name of LIS_CASES_TARGET_COLUMNS) {
    if (!byName.has(name)) {
      throw new Error(`MIGRATION_POSTCONDITION_FAILED: lis_cases missing ${name}`)
    }
  }

  const requiredDefaults = new Map<string, string>([
    ['status', "'normal'"],
    ['specimen_type_source', "'auto'"],
    ['he_slide_count', '0'],
    ['block_count', '0'],
    ['ihc_count', '0'],
    ['special_stain_count', '0'],
    ['eber_count', '0'],
    ['pdl1_count', '0'],
    ['business_line_source', "'auto'"],
    ['service_step_scope_source', "'auto'"],
  ])
  for (const [name, defaultValue] of requiredDefaults) {
    const column = byName.get(name)
    if (column?.notnull !== 1 || column.dflt_value !== defaultValue) {
      throw new Error(`MIGRATION_POSTCONDITION_FAILED: lis_cases ${name} constraint drift`)
    }
  }
  if (byName.get('case_no')?.notnull !== 1) {
    throw new Error('MIGRATION_POSTCONDITION_FAILED: lis_cases case_no constraint drift')
  }

  const uniqueIndexes = uniqueIndexColumns(database, 'lis_cases')
  const hasCanonicalUnique = uniqueIndexes.some(columnsInIndex => (
    columnsInIndex.join(',') === 'partner_id,case_no'
  ))
  const hasLegacyUnique = uniqueIndexes.some(columnsInIndex => (
    columnsInIndex.join(',') === 'case_no'
  ))
  if (!hasCanonicalUnique || hasLegacyUnique) {
    throw new Error('MIGRATION_POSTCONDITION_FAILED: lis_cases unique key drift')
  }
}

function assertCanonicalTarget(database: DatabaseSync): void {
  assertCaseRevenueTarget(database)
  assertLisCasesTarget(database)
}

function migrateLegacyCaseRevenue(database: DatabaseSync): void {
  database.exec(CASE_REVENUE_TARGET_SQL)
  database.exec(`
    INSERT INTO case_revenue__migration_v1 (${CASE_REVENUE_COPY_LIST})
    SELECT ${CASE_REVENUE_COPY_LIST} FROM case_revenue
  `)

  const mismatch = database.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT * FROM (
        SELECT ${CASE_REVENUE_COPY_LIST} FROM case_revenue
        EXCEPT
        SELECT ${CASE_REVENUE_COPY_LIST} FROM case_revenue__migration_v1
      )
      UNION ALL
      SELECT * FROM (
        SELECT ${CASE_REVENUE_COPY_LIST} FROM case_revenue__migration_v1
        EXCEPT
        SELECT ${CASE_REVENUE_COPY_LIST} FROM case_revenue
      )
    ) LIMIT 1
  `).get() as { mismatch?: number } | undefined
  if (mismatch?.mismatch) {
    throw new Error('MIGRATION_DATA_MISMATCH: case_revenue copy verification failed')
  }

  database.exec('DROP TABLE case_revenue')
  database.exec('ALTER TABLE case_revenue__migration_v1 RENAME TO case_revenue')
  database.exec(
    'CREATE INDEX idx_case_revenue_partner_month ON case_revenue(partner_id, service_month)',
  )
}

function migrateLegacyLisCases(database: DatabaseSync): void {
  database.exec(LIS_CASES_TARGET_SQL)
  database.exec(`
    INSERT INTO lis_cases__migration_v1 (${LIS_CASES_SOURCE_LIST})
    SELECT ${LIS_CASES_SOURCE_LIST} FROM lis_cases
  `)

  const mismatch = database.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT * FROM (
        SELECT ${LIS_CASES_SOURCE_LIST} FROM lis_cases
        EXCEPT
        SELECT ${LIS_CASES_SOURCE_LIST} FROM lis_cases__migration_v1
      )
      UNION ALL
      SELECT * FROM (
        SELECT ${LIS_CASES_SOURCE_LIST} FROM lis_cases__migration_v1
        EXCEPT
        SELECT ${LIS_CASES_SOURCE_LIST} FROM lis_cases
      )
    ) LIMIT 1
  `).get() as { mismatch?: number } | undefined
  if (mismatch?.mismatch) {
    throw new Error('MIGRATION_DATA_MISMATCH: lis_cases copy verification failed')
  }

  database.exec('DROP TABLE lis_cases')
  database.exec('ALTER TABLE lis_cases__migration_v1 RENAME TO lis_cases')
  database.exec(
    'CREATE UNIQUE INDEX uq_lis_cases_partner_case ON lis_cases(partner_id, case_no)',
  )
  database.exec('CREATE INDEX idx_lis_cases_case_no ON lis_cases(case_no)')
}

const legacyCaseRevenueIdentity = {
  id: 'legacy-case-revenue-partner-unique-v1',
  sourceVersion: 0,
  targetVersion: CURRENT_SCHEMA_VERSION,
  sourceFingerprint: checksumCanonicalValue(LEGACY_CASE_REVENUE_V0_DESCRIPTOR),
}

const legacyCaseRevenueStep: LegacyMigrationStep = {
  ...legacyCaseRevenueIdentity,
  checksum: checksumCanonicalValue({
    ...legacyCaseRevenueIdentity,
    targetSql: CASE_REVENUE_TARGET_SQL.replace(/\s+/g, ' ').trim(),
    copyColumns: CASE_REVENUE_COPY_COLUMNS,
    postconditions: 'canonical-columns+two-money-constraints+partner-case-month-unique+bidirectional-copy+canonical-lis-shape',
  }),
  apply: migrateLegacyCaseRevenue,
}

const legacyLisCasesIdentity = {
  id: 'legacy-lis-cases-partner-unique-v1',
  sourceVersion: 0,
  targetVersion: CURRENT_SCHEMA_VERSION,
  sourceFingerprint: checksumCanonicalValue(LEGACY_LIS_CASES_V0_DESCRIPTOR),
}

const legacyLisCasesStep: LegacyMigrationStep = {
  ...legacyLisCasesIdentity,
  checksum: checksumCanonicalValue({
    ...legacyLisCasesIdentity,
    targetSql: LIS_CASES_TARGET_SQL.replace(/\s+/g, ' ').trim(),
    copyColumns: LIS_CASES_SOURCE_COLUMNS,
    postconditions: 'canonical-lis-shape+partner-case-unique+no-partner-inference+bidirectional-copy+canonical-case-revenue',
  }),
  apply: migrateLegacyLisCases,
}

const bootstrapIdentity = {
  id: 'empty-database-bootstrap-v1',
  sourceVersion: 0,
  targetVersion: CURRENT_SCHEMA_VERSION,
}

export const CANONICAL_MIGRATION_MANIFEST: MigrationManifest = Object.freeze({
  targetVersion: CURRENT_SCHEMA_VERSION,
  bootstrap: Object.freeze({
    ...bootstrapIdentity,
    checksum: checksumCanonicalValue({
      ...bootstrapIdentity,
      postconditions: 'canonical-case-revenue-v1+canonical-lis-cases-v1',
    }),
  }),
  legacySteps: Object.freeze([
    Object.freeze(legacyCaseRevenueStep),
    Object.freeze(legacyLisCasesStep),
  ]),
  assertTarget: assertCanonicalTarget,
})
