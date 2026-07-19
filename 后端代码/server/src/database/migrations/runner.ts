import type { DatabaseSync } from 'node:sqlite'
import {
  CANONICAL_MIGRATION_MANIFEST,
  MIGRATION_HISTORY_TABLE,
  checksumCanonicalValue,
  type MigrationIdentity,
  type MigrationManifest,
  type SchemaFingerprintDescriptor,
} from './manifest.js'

export type MigrationRunResult =
  | { readonly kind: 'current'; readonly version: number }
  | { readonly kind: 'bootstrapped'; readonly version: number; readonly stepId: string }
  | { readonly kind: 'migrated'; readonly version: number; readonly stepId: string }

interface HistoryRow {
  step_id: string
  source_version: number
  target_version: number
  checksum: string
}

function validateManifest(manifest: MigrationManifest): void {
  if (!Number.isSafeInteger(manifest.targetVersion) || manifest.targetVersion <= 0) {
    throw new Error('MIGRATION_MANIFEST_INVALID: target version must be a positive integer')
  }

  const identities = [manifest.bootstrap, ...manifest.legacySteps]
  const ids = new Set<string>()
  for (const identity of identities) {
    if (ids.has(identity.id)) {
      throw new Error(`MIGRATION_MANIFEST_INVALID: duplicate step ${identity.id}`)
    }
    ids.add(identity.id)
    if (
      identity.sourceVersion < 0
      || identity.targetVersion <= identity.sourceVersion
      || identity.targetVersion !== manifest.targetVersion
      || !/^[a-f0-9]{64}$/.test(identity.checksum)
    ) {
      throw new Error(`MIGRATION_MANIFEST_INVALID: non-monotonic or incomplete step ${identity.id}`)
    }
  }
}

export function enforceForeignKeys(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON')
  const row = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined
  if (row?.foreign_keys !== 1) {
    throw new Error('FOREIGN_KEYS_REQUIRED: SQLite refused PRAGMA foreign_keys = ON')
  }
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const version = Number(row?.user_version)
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('SCHEMA_VERSION_INVALID')
  }
  return version
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

function userTableNames(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> ?
    ORDER BY name
  `).all(MIGRATION_HISTORY_TABLE) as Array<{ name: string }>).map(row => row.name)
}

function schemaFingerprintDescriptor(database: DatabaseSync): SchemaFingerprintDescriptor {
  const tables = userTableNames(database).map(name => {
    const columns = (database.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
      cid: number
      name: string
      type: string
      notnull: number
      dflt_value: unknown
      pk: number
    }>).sort((left, right) => left.cid - right.cid).map(column => ({
      name: column.name,
      type: column.type.trim().toUpperCase(),
      notnull: column.notnull,
      defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      primaryKeyPosition: column.pk,
    }))

    const uniqueIndexes = (database.prepare(`PRAGMA index_list("${name}")`).all() as Array<{
      name: string
      unique: number
      origin?: string
    }>).filter(index => index.unique === 1 && index.origin !== 'pk').map(index => (
      database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
        seqno: number
        name: string
      }>
    ).sort((left, right) => left.seqno - right.seqno).map(column => column.name))
      .sort((left, right) => left.join(',').localeCompare(right.join(',')))

    return { name, columns, uniqueIndexes }
  })

  return { tables }
}

export function fingerprintDatabaseSchema(database: DatabaseSync): string {
  return checksumCanonicalValue(schemaFingerprintDescriptor(database))
}

function createHistoryTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE ${MIGRATION_HISTORY_TABLE} (
      step_id TEXT PRIMARY KEY,
      source_version INTEGER NOT NULL,
      target_version INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(target_version > source_version)
    )
  `)
}

function insertHistory(database: DatabaseSync, identity: MigrationIdentity): void {
  database.prepare(`
    INSERT INTO ${MIGRATION_HISTORY_TABLE} (
      step_id, source_version, target_version, checksum
    ) VALUES (?, ?, ?, ?)
  `).run(identity.id, identity.sourceVersion, identity.targetVersion, identity.checksum)
}

function expectedHistoryIdentities(manifest: MigrationManifest): readonly MigrationIdentity[] {
  return [manifest.bootstrap, ...manifest.legacySteps]
}

function assertExactHistory(database: DatabaseSync, manifest: MigrationManifest): void {
  if (!tableExists(database, MIGRATION_HISTORY_TABLE)) {
    throw new Error('PARTIAL_MIGRATION_STATE: target version has no migration history')
  }

  let rows: HistoryRow[]
  try {
    rows = database.prepare(`
      SELECT step_id, source_version, target_version, checksum
      FROM ${MIGRATION_HISTORY_TABLE}
      ORDER BY step_id
    `).all() as unknown as HistoryRow[]
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`MIGRATION_HISTORY_MISMATCH: ${detail}`)
  }

  if (rows.length !== 1) {
    throw new Error(`MIGRATION_HISTORY_MISMATCH: expected 1 row, received ${rows.length}`)
  }

  const row = rows[0]
  const exactMatch = expectedHistoryIdentities(manifest).some(identity => (
    row.step_id === identity.id
    && row.source_version === identity.sourceVersion
    && row.target_version === identity.targetVersion
    && row.checksum === identity.checksum
  ))
  if (!exactMatch) {
    throw new Error(`MIGRATION_HISTORY_MISMATCH: non-canonical history for ${row.step_id}`)
  }
}

function assertCurrentState(database: DatabaseSync, manifest: MigrationManifest): void {
  const version = readSchemaVersion(database)
  if (version !== manifest.targetVersion) {
    throw new Error(
      `PARTIAL_MIGRATION_STATE: expected user_version ${manifest.targetVersion}, received ${version}`,
    )
  }
  assertExactHistory(database, manifest)
  manifest.assertTarget(database)
}

function rollbackPreservingOriginalError(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // The migration error remains the authoritative failure.
  }
}

function executeTransition(
  database: DatabaseSync,
  manifest: MigrationManifest,
  identity: MigrationIdentity,
  transition: () => void,
): void {
  let transactionStarted = false
  try {
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    createHistoryTable(database)
    transition()
    manifest.assertTarget(database)
    insertHistory(database, identity)
    database.exec(`PRAGMA user_version = ${identity.targetVersion}`)
    assertCurrentState(database, manifest)
    database.exec('COMMIT')
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) rollbackPreservingOriginalError(database)
    throw error
  }
}

export function runDatabaseMigrations(
  database: DatabaseSync,
  initializeUnversionedDatabase: () => void,
  manifest: MigrationManifest = CANONICAL_MIGRATION_MANIFEST,
): MigrationRunResult {
  validateManifest(manifest)
  enforceForeignKeys(database)

  const version = readSchemaVersion(database)
  if (version > manifest.targetVersion) {
    throw new Error(
      `SCHEMA_VERSION_AHEAD: database=${version} manifest=${manifest.targetVersion}`,
    )
  }

  if (version === manifest.targetVersion) {
    assertCurrentState(database, manifest)
    return { kind: 'current', version }
  }

  if (version !== 0) {
    throw new Error(
      `SCHEMA_VERSION_DOWNGRADE_UNSUPPORTED: database=${version} manifest=${manifest.targetVersion}`,
    )
  }

  if (tableExists(database, MIGRATION_HISTORY_TABLE)) {
    throw new Error('PARTIAL_MIGRATION_STATE: history exists while user_version is zero')
  }

  const tables = userTableNames(database)
  if (tables.length === 0) {
    executeTransition(database, manifest, manifest.bootstrap, initializeUnversionedDatabase)
    return {
      kind: 'bootstrapped',
      version: manifest.targetVersion,
      stepId: manifest.bootstrap.id,
    }
  }

  const sourceFingerprint = fingerprintDatabaseSchema(database)
  const step = manifest.legacySteps.find(candidate => (
    candidate.sourceVersion === version && candidate.sourceFingerprint === sourceFingerprint
  ))
  if (!step) {
    throw new Error(`UNKNOWN_SCHEMA_STATE: version=${version} fingerprint=${sourceFingerprint}`)
  }

  executeTransition(database, manifest, step, () => {
    step.apply(database)
    initializeUnversionedDatabase()
  })
  return { kind: 'migrated', version: manifest.targetVersion, stepId: step.id }
}
