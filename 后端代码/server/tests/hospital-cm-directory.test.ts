import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
  HOSPITAL_CM_DIRECTORY_LINEAGE_RECIPE_VERSION,
  HOSPITAL_CM_DIRECTORY_ROSTER_RECIPE_VERSION,
  HospitalCmDirectoryError,
  ensureHospitalCmDirectorySchema,
  getCurrentHospitalCmDirectory,
  getHospitalCmDirectoryRevision,
  listHospitalCmDirectoryRevisions,
  projectHospitalCmDirectoryForMonth,
  resolveHospitalCmDirectoryPartner,
  resolveHospitalCmDirectoryPartners,
  saveHospitalCmDirectoryRevision,
} from '../src/utils/hospital-cm-directory.js'

const ADMIN = { userId: 'USER-ADMIN-1', username: 'directory.admin' }
let idempotencySequence = 0

function nextIdempotencyKey(): string {
  idempotencySequence += 1
  return `hospital-directory-${String(idempotencySequence).padStart(4, '0')}`
}

function createDb(options: { audit?: boolean; foreignKeys?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys = ${options.foreignKeys === false ? 'OFF' : 'ON'}`)
  db.exec(`
    CREATE TABLE partners (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
  `)
  if (options.audit !== false) {
    db.exec(`
      CREATE TABLE abc_audit_logs (
        id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        detail TEXT,
        operator TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  }
  const insert = db.prepare('INSERT INTO partners (id, code, name, is_deleted) VALUES (?, ?, ?, ?)')
  insert.run('PARTNER-001', 'LEGACY-001', '测试医院甲', 0)
  insert.run('PARTNER-002', 'LEGACY-002', '测试医院乙', 0)
  insert.run('PARTNER-003', 'LEGACY-003', '测试医院丙', 0)
  insert.run('PARTNER-DELETED', 'LEGACY-DEL', '已删除测试医院', 1)
  ensureHospitalCmDirectorySchema(db)
  return db
}

function entry(
  stablePartnerId: string,
  overrides: Record<string, unknown> = {},
) {
  const suffix = stablePartnerId.replace(/[^A-Za-z0-9]/g, '')
  return {
    stablePartnerId,
    accountCode: `HCM-${suffix}`,
    canonicalDisplayName: `测试目录医院-${suffix}`,
    aliases: [`别名-${suffix}`],
    hospitalCmIncluded: true,
    effectiveFromMonth: '2026-07',
    effectiveToMonth: null,
    ...overrides,
  }
}

function revisionInput(overrides: Record<string, unknown> = {}) {
  return {
    entries: [entry('PARTNER-001'), entry('PARTNER-002')],
    knownCompleteFromMonth: '2026-07',
    actor: ADMIN,
    reasonCode: 'INITIAL_DIRECTORY_CONFIGURATION',
    idempotencyKey: nextIdempotencyKey(),
    ...overrides,
  }
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

function expectDirectoryCode(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(expect.objectContaining({ code }))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function expectedRosterSourceHash(serviceMonth: string, accounts: string[]): string {
  return stableHash({
    accounts,
    recipeVersion: 'hospital-cm.directory.membership-projection.v1',
    serviceMonth,
  })
}

function expectedRevisionLineageHash(input: {
  id: string
  eventNumber: number
  revision: number
  knownCompleteFromMonth: string
  entryCount: number
  aliasCount: number
  contentHash: string
  supersedesVersionId: string | null
  parentRevisionLineageHash: string | null
  reasonCode: string
  recordedByUserId: string
  recordedByUsername: string
  recordedAt: string
}): string {
  return stableHash({
    recipeVersion: 'hospital-cm.directory.revision-lineage.v1',
    contractVersion: 'hospital-cm.directory.v1',
    ...input,
  })
}

function insertForgedSingleEntryRevision(
  db: DatabaseSync,
  previous: ReturnType<typeof saveHospitalCmDirectoryRevision>,
  id: string,
): void {
  const retained = previous.entries.find(item => item.stablePartnerId === 'PARTNER-001')!
  const contentHash = stableHash({
    contractVersion: HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
    knownCompleteFromMonth: previous.knownCompleteFromMonth,
    rowHashes: [retained.rowHash],
  })
  const recordedAt = new Date().toISOString()
  const revisionLineageHash = expectedRevisionLineageHash({
    id,
    eventNumber: 2,
    revision: 2,
    knownCompleteFromMonth: previous.knownCompleteFromMonth,
    entryCount: 1,
    aliasCount: retained.aliases.length,
    contentHash,
    supersedesVersionId: previous.id,
    parentRevisionLineageHash: previous.revisionLineageHash,
    reasonCode: 'FORGED_MEMBER_OMISSION',
    recordedByUserId: 'FORGER',
    recordedByUsername: 'forger',
    recordedAt,
  })
  db.prepare(`
    INSERT INTO hospital_cm_directory_versions (
      event_number, id, revision, contract_version, known_complete_from_month,
      entry_count, alias_count, content_hash, revision_lineage_hash,
      supersedes_version_id, reason_code, recorded_by_user_id,
      recorded_by_username, recorded_at
    ) VALUES (2, ?, 2, ?, ?, 1, ?, ?, ?, ?, 'FORGED_MEMBER_OMISSION', 'FORGER', 'forger', ?)
  `).run(
    id,
    HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
    previous.knownCompleteFromMonth,
    retained.aliases.length,
    contentHash,
    revisionLineageHash,
    previous.id,
    recordedAt,
  )
  db.prepare(`
    INSERT INTO hospital_cm_directory_entries (
      directory_version_id, stable_partner_id, account_code, account_code_key,
      canonical_display_name, hospital_cm_included, effective_from_month,
      effective_to_month, row_hash
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id,
    retained.stablePartnerId,
    retained.accountCode,
    retained.accountCode.normalize('NFKC').trim().toLowerCase(),
    retained.canonicalDisplayName,
    retained.effectiveFromMonth,
    retained.effectiveToMonth,
    retained.rowHash,
  )
  const insertAlias = db.prepare(`
    INSERT INTO hospital_cm_directory_aliases (
      directory_version_id, stable_partner_id, alias, alias_key
    ) VALUES (?, ?, ?, ?)
  `)
  for (const alias of retained.aliases) {
    insertAlias.run(
      id,
      retained.stablePartnerId,
      alias,
      alias.normalize('NFKC').trim().toLowerCase(),
    )
  }
}

function insertForgedMovedStartRevision(
  db: DatabaseSync,
  previous: ReturnType<typeof saveHospitalCmDirectoryRevision>,
  id: string,
): void {
  const prior = previous.entries[0]!
  const moved = {
    stablePartnerId: prior.stablePartnerId,
    accountCode: prior.accountCode,
    canonicalDisplayName: prior.canonicalDisplayName,
    aliases: prior.aliases,
    hospitalCmIncluded: true,
    effectiveFromMonth: '2026-07',
    effectiveToMonth: prior.effectiveToMonth,
  }
  const rowHash = stableHash(moved)
  const contentHash = stableHash({
    contractVersion: HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
    knownCompleteFromMonth: previous.knownCompleteFromMonth,
    rowHashes: [rowHash],
  })
  const recordedAt = '2026-07-16T00:02:00.000Z'
  const revisionLineageHash = expectedRevisionLineageHash({
    id,
    eventNumber: 2,
    revision: 2,
    knownCompleteFromMonth: previous.knownCompleteFromMonth,
    entryCount: 1,
    aliasCount: prior.aliases.length,
    contentHash,
    supersedesVersionId: previous.id,
    parentRevisionLineageHash: previous.revisionLineageHash,
    reasonCode: 'FORGED_MOVE_START_FORWARD',
    recordedByUserId: 'FORGER',
    recordedByUsername: 'forger',
    recordedAt,
  })
  db.prepare(`
    INSERT INTO hospital_cm_directory_versions (
      event_number, id, revision, contract_version, known_complete_from_month,
      entry_count, alias_count, content_hash, revision_lineage_hash,
      supersedes_version_id, reason_code, recorded_by_user_id,
      recorded_by_username, recorded_at
    ) VALUES (2, ?, 2, ?, ?, 1, ?, ?, ?, ?, 'FORGED_MOVE_START_FORWARD',
      'FORGER', 'forger', ?)
  `).run(
    id,
    HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
    previous.knownCompleteFromMonth,
    prior.aliases.length,
    contentHash,
    revisionLineageHash,
    previous.id,
    recordedAt,
  )
  db.prepare(`
    INSERT INTO hospital_cm_directory_entries (
      directory_version_id, stable_partner_id, account_code, account_code_key,
      canonical_display_name, hospital_cm_included, effective_from_month,
      effective_to_month, row_hash
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id,
    moved.stablePartnerId,
    moved.accountCode,
    moved.accountCode.normalize('NFKC').trim().toLowerCase(),
    moved.canonicalDisplayName,
    moved.effectiveFromMonth,
    moved.effectiveToMonth,
    rowHash,
  )
  const insertAlias = db.prepare(`
    INSERT INTO hospital_cm_directory_aliases (
      directory_version_id, stable_partner_id, alias, alias_key
    ) VALUES (?, ?, ?, ?)
  `)
  for (const alias of moved.aliases) {
    insertAlias.run(id, moved.stablePartnerId, alias, alias.normalize('NFKC').trim().toLowerCase())
  }
}

describe('hospital-cm #182 · versioned hospital directory runtime', () => {
  let db: DatabaseSync

  beforeEach(() => {
    idempotencySequence = 0
    db = createDb()
  })

  it('pins the directory contract and lineage recipe versions independently from the implementation', () => {
    expect(HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION).toBe('hospital-cm.directory.v1')
    expect(HOSPITAL_CM_DIRECTORY_LINEAGE_RECIPE_VERSION)
      .toBe('hospital-cm.directory.revision-lineage.v1')
  })

  it('initializes an empty additive control plane without seeding or mutating partners', () => {
    ensureHospitalCmDirectorySchema(db)
    const tables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'hospital_cm_directory_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual([
      'hospital_cm_directory_aliases',
      'hospital_cm_directory_entries',
      'hospital_cm_directory_idempotency',
      'hospital_cm_directory_versions',
    ])
    for (const table of tables) expect(rowCount(db, table)).toBe(0)
    expect(getCurrentHospitalCmDirectory(db)).toBeNull()
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')).toBeNull()
    expect(resolveHospitalCmDirectoryPartners(db, [
      { stablePartnerId: 'PARTNER-001' },
      { mappingKey: 'HCM-PARTNER001' },
    ])).toEqual([null, null])
    expect(rowCount(db, 'partners')).toBe(4)
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM sqlite_master
             WHERE type = 'table'
               AND name = 'hospital_cm_account_roster_candidate_versions'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0)
    expect((db.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'hospital_cm_month_scope_snapshots',
        'hospital_cm_readiness_milestones'
      )
    `).get() as { n: number }).n).toBe(0)
  })

  it('rejects forged fields, missing identities, invalid intervals, and ambiguous strict mappings', () => {
    const invalidCases: Array<{ input: Record<string, unknown>; code: string }> = [
      { input: revisionInput({ entries: [] }), code: 'DIRECTORY_ENTRIES_REQUIRED' },
      {
        input: revisionInput({ entries: [entry('PARTNER-001', { effectiveFromMonth: null })] }),
        code: 'DIRECTORY_EFFECTIVE_FROM_REQUIRED',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-001', { effectiveFromMonth: '2026-13' })] }),
        code: 'DIRECTORY_MONTH_INVALID',
      },
      {
        input: revisionInput({ knownCompleteFromMonth: '2026-13' }),
        code: 'DIRECTORY_MONTH_INVALID',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-001', { effectiveToMonth: '2026-06' })] }),
        code: 'DIRECTORY_EFFECTIVE_RANGE_INVALID',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-MISSING')] }),
        code: 'DIRECTORY_PARTNER_MISSING',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-001'), entry('PARTNER-001')] }),
        code: 'DIRECTORY_PARTNER_DUPLICATE',
      },
      {
        input: revisionInput({
          entries: [
            entry('PARTNER-001', { accountCode: ' HCM-SAME ' }),
            entry('PARTNER-002', { accountCode: 'hcm-same' }),
          ],
        }),
        code: 'DIRECTORY_MAPPING_AMBIGUOUS',
      },
      {
        input: revisionInput({
          entries: [
            entry('PARTNER-001', { aliases: ['Shared Alias'] }),
            entry('PARTNER-002', { accountCode: ' shared alias ' }),
          ],
        }),
        code: 'DIRECTORY_MAPPING_AMBIGUOUS',
      },
      {
        input: revisionInput({
          entries: [
            entry('PARTNER-001', { aliases: ['Shared Alias'] }),
            entry('PARTNER-002', { aliases: ['Ｓｈａｒｅｄ　Ａｌｉａｓ'] }),
          ],
        }),
        code: 'DIRECTORY_MAPPING_AMBIGUOUS',
      },
      {
        input: revisionInput({ ready: true }),
        code: 'DIRECTORY_UNSUPPORTED_FIELD',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-001', { rosterSourceHash: 'a'.repeat(64) })] }),
        code: 'DIRECTORY_ENTRY_UNSUPPORTED_FIELD',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-001', { canonicalDisplayName: '=unsafe' })] }),
        code: 'DIRECTORY_DISPLAY_NAME_INVALID',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-001', { accountCode: '=unsafe' })] }),
        code: 'DIRECTORY_ACCOUNT_CODE_INVALID',
      },
      {
        input: revisionInput({ entries: [entry('PARTNER-001', { aliases: ['@unsafe'] })] }),
        code: 'DIRECTORY_ALIAS_INVALID',
      },
    ]

    for (const { input, code } of invalidCases) expectDirectoryCode(
      () => saveHospitalCmDirectoryRevision(db, input),
      code,
    )
    for (const table of [
      'hospital_cm_directory_versions',
      'hospital_cm_directory_entries',
      'hospital_cm_directory_aliases',
      'hospital_cm_directory_idempotency',
      'abc_audit_logs',
    ]) expect(rowCount(db, table)).toBe(0)
    expectDirectoryCode(() => projectHospitalCmDirectoryForMonth(db, '2026-13'), 'DIRECTORY_MONTH_INVALID')
  })

  it('keeps stable partner identifiers compatible with the existing C1 account boundary', () => {
    const maxLengthId = `P${'A'.repeat(79)}`
    db.prepare('INSERT INTO partners (id, code, name, is_deleted) VALUES (?, ?, ?, 0)')
      .run(maxLengthId, 'LEGACY-MAX-ID', 'Maximum stable id fixture')

    const created = saveHospitalCmDirectoryRevision(db, revisionInput({
      entries: [entry(maxLengthId, { accountCode: 'HCM-MAX-ID', aliases: ['MAX-ID'] })],
    }))
    expect(created.entries.map(item => item.stablePartnerId)).toEqual([maxLengthId])
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.accounts).toEqual([maxLengthId])
    expect(resolveHospitalCmDirectoryPartner(db, { stablePartnerId: maxLengthId })?.stablePartnerId)
      .toBe(maxLengthId)

    const tooLongId = `P${'A'.repeat(80)}`
    expectDirectoryCode(
      () => saveHospitalCmDirectoryRevision(db, revisionInput({ entries: [entry(tooLongId)] })),
      'DIRECTORY_PARTNER_ID_INVALID',
    )
    expectDirectoryCode(
      () => resolveHospitalCmDirectoryPartners(db, [{ stablePartnerId: tooLongId }]),
      'DIRECTORY_RESOLUTION_INPUT_INVALID',
    )
  })

  it('enforces the 1-to-80 stable partner id boundary in SQLite even for direct SQL with FKs off', () => {
    const isolated = createDb({ foreignKeys: false })
    const versionId = '00000000-0000-4000-8000-000000000080'
    const validId = 'V'.repeat(80)
    const tooLongId = 'X'.repeat(81)
    const insertPartner = isolated.prepare(
      'INSERT INTO partners (id, code, name, is_deleted) VALUES (?, ?, ?, 0)',
    )
    insertPartner.run(validId, 'RAW-VALID-80', 'Raw valid 80')
    insertPartner.run('', 'RAW-EMPTY', 'Raw empty id')
    insertPartner.run(tooLongId, 'RAW-TOO-LONG', 'Raw too long id')
    isolated.prepare(`
      INSERT INTO hospital_cm_directory_versions (
        id, revision, contract_version, known_complete_from_month,
        entry_count, alias_count, content_hash, revision_lineage_hash,
        supersedes_version_id, reason_code, recorded_by_user_id,
        recorded_by_username, recorded_at
      ) VALUES (?, 1, ?, '2026-07', 3, 0, ?, ?, NULL,
        'RAW_DB_BOUNDARY', 'RAW', 'raw', '2026-07-16T00:00:00.000Z')
    `).run(
      versionId,
      HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      'a'.repeat(64),
      'b'.repeat(64),
    )
    const insertEntry = isolated.prepare(`
      INSERT INTO hospital_cm_directory_entries (
        directory_version_id, stable_partner_id, account_code, account_code_key,
        canonical_display_name, hospital_cm_included, effective_from_month,
        effective_to_month, row_hash
      ) VALUES (?, ?, ?, ?, ?, 1, '2026-07', NULL, ?)
    `)
    insertEntry.run(versionId, validId, 'RAW-VALID-80', 'raw-valid-80', 'Raw valid 80', 'c'.repeat(64))

    for (const [invalidId, suffix] of [['', 'empty'], [tooLongId, 'too-long']] as const) {
      expect(() => insertEntry.run(
        versionId,
        invalidId,
        `RAW-${suffix}`,
        `raw-${suffix}`,
        `Raw ${suffix}`,
        'd'.repeat(64),
      )).toThrow(/CHECK constraint failed/)
    }
    expect(rowCount(isolated, 'hospital_cm_directory_entries')).toBe(1)
  })

  it('mirrors critical reference checks with triggers when SQLite FK enforcement is off', () => {
    const isolated = createDb({ foreignKeys: false })
    expect(isolated.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 })
    const insertEntry = isolated.prepare(`
      INSERT INTO hospital_cm_directory_entries (
        directory_version_id, stable_partner_id, account_code, account_code_key,
        canonical_display_name, hospital_cm_included, effective_from_month,
        effective_to_month, row_hash
      ) VALUES (?, ?, ?, ?, ?, 1, '2026-07', NULL, ?)
    `)
    expect(() => insertEntry.run(
      '00000000-0000-4000-8000-000000000090',
      'PARTNER-001',
      'RAW-MISSING-VERSION',
      'raw-missing-version',
      'Raw missing version',
      'e'.repeat(64),
    )).toThrow(/DIRECTORY_VERSION_MISSING/)

    const versionId = '00000000-0000-4000-8000-000000000091'
    isolated.prepare(`
      INSERT INTO hospital_cm_directory_versions (
        id, revision, contract_version, known_complete_from_month,
        entry_count, alias_count, content_hash, revision_lineage_hash,
        supersedes_version_id, reason_code, recorded_by_user_id,
        recorded_by_username, recorded_at
      ) VALUES (?, 1, ?, '2026-07', 1, 0, ?, ?, NULL,
        'RAW_REFERENCE_BOUNDARY', 'RAW', 'raw', '2026-07-16T00:00:00.000Z')
    `).run(
      versionId,
      HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      'f'.repeat(64),
      '0'.repeat(64),
    )
    expect(() => insertEntry.run(
      versionId,
      'PARTNER-MISSING',
      'RAW-MISSING-PARTNER',
      'raw-missing-partner',
      'Raw missing partner',
      '1'.repeat(64),
    )).toThrow(/DIRECTORY_PARTNER_MISSING/)
    expect(isolated.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 })
  })

  it('derives deterministic content hashes while every real save keeps its own audit revision', () => {
    const input = revisionInput({
      entries: [entry('PARTNER-002'), entry('PARTNER-001')],
    })
    const created = saveHospitalCmDirectoryRevision(db, input)
    expect(created).toMatchObject({
      revision: 1,
      contractVersion: HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      knownCompleteFromMonth: '2026-07',
      entryCount: 2,
      aliasCount: 2,
      supersedesVersionId: null,
      recordedByUserId: ADMIN.userId,
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(created.revisionLineageHash).toBe(expectedRevisionLineageHash({
      id: created.id,
      eventNumber: created.eventNumber,
      revision: created.revision,
      knownCompleteFromMonth: created.knownCompleteFromMonth,
      entryCount: created.entryCount,
      aliasCount: created.aliasCount,
      contentHash: created.contentHash,
      supersedesVersionId: null,
      parentRevisionLineageHash: null,
      reasonCode: created.reasonCode,
      recordedByUserId: created.recordedByUserId,
      recordedByUsername: created.recordedByUsername,
      recordedAt: created.recordedAt,
    }))
    expect(created.entries.map(item => item.stablePartnerId)).toEqual(['PARTNER-001', 'PARTNER-002'])
    expect(created.entries.every(item => /^[0-9a-f]{64}$/.test(item.rowHash))).toBe(true)

    const repeated = saveHospitalCmDirectoryRevision(db, revisionInput({
      entries: [
        entry('PARTNER-002', { aliases: ['别名-PARTNER002'] }),
        entry('PARTNER-001', { aliases: ['别名-PARTNER001'] }),
      ],
      reasonCode: 'REPEATED_IDENTICAL_CONTENT',
    }))
    expect(repeated).toMatchObject({
      revision: 2,
      contentHash: created.contentHash,
      supersedesVersionId: created.id,
      reasonCode: 'REPEATED_IDENTICAL_CONTENT',
    })
    expect(repeated.id).not.toBe(created.id)
    expect(repeated.revisionLineageHash).toBe(expectedRevisionLineageHash({
      id: repeated.id,
      eventNumber: repeated.eventNumber,
      revision: repeated.revision,
      knownCompleteFromMonth: repeated.knownCompleteFromMonth,
      entryCount: repeated.entryCount,
      aliasCount: repeated.aliasCount,
      contentHash: repeated.contentHash,
      supersedesVersionId: created.id,
      parentRevisionLineageHash: created.revisionLineageHash,
      reasonCode: repeated.reasonCode,
      recordedByUserId: repeated.recordedByUserId,
      recordedByUsername: repeated.recordedByUsername,
      recordedAt: repeated.recordedAt,
    }))
    expect(rowCount(db, 'hospital_cm_directory_versions')).toBe(2)
    expect(rowCount(db, 'hospital_cm_directory_idempotency')).toBe(2)
    expect(rowCount(db, 'abc_audit_logs')).toBe(2)

    const replayInput = revisionInput({ idempotencyKey: 'hospital-directory-replay-key' })
    const replayed = saveHospitalCmDirectoryRevision(db, replayInput)
    expect(saveHospitalCmDirectoryRevision(db, replayInput)).toEqual(replayed)
    expect(rowCount(db, 'hospital_cm_directory_versions')).toBe(3)
    expect(rowCount(db, 'hospital_cm_directory_idempotency')).toBe(3)

    const later = saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'LATER_REVISION_AFTER_REPLAY_RESULT',
    }))
    expect(saveHospitalCmDirectoryRevision(db, replayInput)).toEqual(replayed)
    expect(getCurrentHospitalCmDirectory(db)?.id).toBe(later.id)
    expect(rowCount(db, 'hospital_cm_directory_versions')).toBe(4)
    expect(rowCount(db, 'hospital_cm_directory_idempotency')).toBe(4)

    expectDirectoryCode(() => saveHospitalCmDirectoryRevision(db, {
      ...replayInput,
      actor: { userId: 'USER-OTHER', username: 'other.admin' },
    }), 'DIRECTORY_IDEMPOTENCY_CONFLICT')
    expectDirectoryCode(() => saveHospitalCmDirectoryRevision(db, {
      ...replayInput,
      entries: [entry('PARTNER-001')],
    }), 'DIRECTORY_IDEMPOTENCY_CONFLICT')
  })

  it('paginates immutable revisions with an exclusive stable event cursor', () => {
    for (let revision = 1; revision <= 4; revision += 1) {
      saveHospitalCmDirectoryRevision(db, revisionInput({
        reasonCode: `PAGINATION_REVISION_${revision}`,
      }))
    }

    const firstPage = listHospitalCmDirectoryRevisions(db, { limit: 2 })
    expect(firstPage.current?.revision).toBe(4)
    expect(firstPage.versions.map(version => version.revision)).toEqual([4, 3])
    expect(firstPage.pagination.nextCursor).toBe(firstPage.versions[1]?.eventNumber)

    const secondPage = listHospitalCmDirectoryRevisions(db, {
      limit: 2,
      beforeEvent: firstPage.pagination.nextCursor!,
    })
    expect(secondPage.current?.revision).toBe(4)
    expect(secondPage.versions.map(version => version.revision)).toEqual([2, 1])
    expect(secondPage.pagination.nextCursor).toBeNull()

    expectDirectoryCode(
      () => listHospitalCmDirectoryRevisions(db, { limit: 0 }),
      'DIRECTORY_PAGE_INVALID',
    )
    expectDirectoryCode(
      () => listHospitalCmDirectoryRevisions(db, { beforeEvent: 0 }),
      'DIRECTORY_PAGE_INVALID',
    )
  })

  it('records display and alias revisions without changing the monthly membership hash', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput())
    const before = projectHospitalCmDirectoryForMonth(db, '2026-07')

    const second = saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'DISPLAY_NAME_CORRECTION',
      entries: [
        entry('PARTNER-001', { canonicalDisplayName: '测试目录医院甲-新展示名' }),
        entry('PARTNER-002'),
      ],
    }))
    const afterDisplay = projectHospitalCmDirectoryForMonth(db, '2026-07')

    const third = saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'UNUSED_ALIAS_ADDED',
      entries: [
        entry('PARTNER-001', { canonicalDisplayName: '测试目录医院甲-新展示名', aliases: ['别名-PARTNER001', '额外别名甲'] }),
        entry('PARTNER-002'),
      ],
    }))
    const afterAlias = projectHospitalCmDirectoryForMonth(db, '2026-07')

    expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3])
    expect(new Set([first.contentHash, second.contentHash, third.contentHash]).size).toBe(3)
    expect(before?.accounts).toEqual(['PARTNER-001', 'PARTNER-002'])
    expect(afterDisplay?.accounts).toEqual(before?.accounts)
    expect(afterAlias?.accounts).toEqual(before?.accounts)
    expect(afterDisplay?.rosterSourceHash).toBe(before?.rosterSourceHash)
    expect(afterAlias?.rosterSourceHash).toBe(before?.rosterSourceHash)
    expect(afterAlias?.recipeVersion).toBe(HOSPITAL_CM_DIRECTORY_ROSTER_RECIPE_VERSION)
    expect(afterAlias).not.toHaveProperty('rosterScopeHash')
    expect(afterAlias).not.toHaveProperty('scopeHash')
  })

  it('uses the documented membership hash recipe and always projects the current revision', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput({
      entries: [entry('PARTNER-002'), entry('PARTNER-001')],
    }))
    expect(HOSPITAL_CM_DIRECTORY_ROSTER_RECIPE_VERSION)
      .toBe('hospital-cm.directory.membership-projection.v1')

    const julyBefore = projectHospitalCmDirectoryForMonth(db, '2026-07')
    const juneBefore = projectHospitalCmDirectoryForMonth(db, '2026-06')
    const augustBefore = projectHospitalCmDirectoryForMonth(db, '2026-08')
    expect(julyBefore?.accounts).toEqual(['PARTNER-001', 'PARTNER-002'])
    expect(julyBefore?.rosterSourceHash).toBe(expectedRosterSourceHash(
      '2026-07',
      ['PARTNER-001', 'PARTNER-002'],
    ))
    expect(juneBefore).toBeNull()
    expect(augustBefore?.rosterSourceHash).not.toBe(julyBefore?.rosterSourceHash)

    const second = saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'END_SECOND_MEMBERSHIP',
      entries: [
        entry('PARTNER-001'),
        entry('PARTNER-002', { effectiveToMonth: '2026-07' }),
      ],
    }))
    expect(getCurrentHospitalCmDirectory(db)).toMatchObject({
      id: second.id,
      revision: 2,
      supersedesVersionId: first.id,
    })
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.rosterSourceHash)
      .toBe(julyBefore?.rosterSourceHash)
    expect(projectHospitalCmDirectoryForMonth(db, '2026-08')).toMatchObject({
      accounts: ['PARTNER-001'],
      rosterSourceHash: expectedRosterSourceHash('2026-08', ['PARTNER-001']),
    })
    expect(projectHospitalCmDirectoryForMonth(db, '2026-06')).toBeNull()
  })

  it('resolves only exact stable ids or normalized approved code/aliases without fuzzy creation', () => {
    saveHospitalCmDirectoryRevision(db, revisionInput({
      entries: [
        entry('PARTNER-001', {
          accountCode: ' HCM-STRICT-001 ',
          aliases: ['Ｓｈａｒｅｄ　Ａｌｉａｓ'],
        }),
        entry('PARTNER-002', {
          accountCode: 'HCM-STRICT-002',
          aliases: ['Excluded Alias'],
          hospitalCmIncluded: false,
          effectiveFromMonth: null,
        }),
      ],
    }))
    const partnersBefore = rowCount(db, 'partners')
    expect(resolveHospitalCmDirectoryPartner(db, { stablePartnerId: 'PARTNER-001' })).toMatchObject({
      stablePartnerId: 'PARTNER-001',
      matchedBy: 'STABLE_PARTNER_ID',
    })
    expect(resolveHospitalCmDirectoryPartner(db, { mappingKey: 'hcm-strict-001' })).toMatchObject({
      stablePartnerId: 'PARTNER-001',
      matchedBy: 'ACCOUNT_CODE',
    })
    expect(resolveHospitalCmDirectoryPartner(db, { mappingKey: ' shared alias ' })).toMatchObject({
      stablePartnerId: 'PARTNER-001',
      matchedBy: 'ALIAS',
    })
    expect(resolveHospitalCmDirectoryPartner(db, { mappingKey: 'Excluded Alias' })).toMatchObject({
      stablePartnerId: 'PARTNER-002',
      matchedBy: 'ALIAS',
    })
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.accounts).not.toContain('PARTNER-002')
    expect(resolveHospitalCmDirectoryPartner(db, { mappingKey: 'Shared' })).toBeNull()
    expect(resolveHospitalCmDirectoryPartner(db, { stablePartnerId: 'PARTNER-004' })).toBeNull()
    expect(rowCount(db, 'partners')).toBe(partnersBefore)

    const first = getCurrentHospitalCmDirectory(db)!
    saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'ALIAS_REBIND_REVIEWED',
      entries: [
        entry('PARTNER-001', { accountCode: 'HCM-STRICT-001', aliases: [] }),
        entry('PARTNER-002', { accountCode: 'HCM-STRICT-002', aliases: ['Shared Alias'] }),
      ],
    }))
    expect(resolveHospitalCmDirectoryPartner(db, { mappingKey: 'Shared Alias' })?.stablePartnerId)
      .toBe('PARTNER-002')
    expect(getHospitalCmDirectoryRevision(db, first.id)?.entries
      .find(item => item.stablePartnerId === 'PARTNER-001')?.aliases).toEqual(['Shared Alias'])
  })

  it('projects only explicit inclusive membership intervals and never infers legacy partners from business presence', () => {
    db.prepare("INSERT INTO partners (id, code, name, is_deleted) VALUES ('PARTNER-004', 'LEGACY-004', '未配置医院', 0)").run()
    saveHospitalCmDirectoryRevision(db, revisionInput({
      knownCompleteFromMonth: '2026-06',
      entries: [
        entry('PARTNER-001', { effectiveFromMonth: '2026-07' }),
        entry('PARTNER-002', {
          hospitalCmIncluded: false,
          effectiveFromMonth: null,
          effectiveToMonth: null,
        }),
        entry('PARTNER-003', { effectiveFromMonth: '2026-06', effectiveToMonth: '2026-07' }),
      ],
    }))

    expect(projectHospitalCmDirectoryForMonth(db, '2026-05')).toBeNull()
    expect(projectHospitalCmDirectoryForMonth(db, '2026-06')?.accounts).toEqual(['PARTNER-003'])
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.accounts).toEqual(['PARTNER-001', 'PARTNER-003'])
    expect(projectHospitalCmDirectoryForMonth(db, '2026-08')?.accounts).toEqual(['PARTNER-001'])
    expect(projectHospitalCmDirectoryForMonth(db, '2026-08')?.accounts).not.toContain('PARTNER-004')
  })

  it('uses an explicit whole-directory completeness boundary instead of guessing from entry start months', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput({
      knownCompleteFromMonth: '2026-07',
      entries: [
        entry('PARTNER-001', { effectiveFromMonth: '2026-01' }),
        entry('PARTNER-002', { effectiveFromMonth: '2026-07' }),
      ],
    }))
    const julyBefore = projectHospitalCmDirectoryForMonth(db, '2026-07')
    expect(projectHospitalCmDirectoryForMonth(db, '2026-06')).toBeNull()
    expect(julyBefore?.accounts).toEqual(['PARTNER-001', 'PARTNER-002'])

    const withFutureJoin = saveHospitalCmDirectoryRevision(db, revisionInput({
      knownCompleteFromMonth: '2026-07',
      reasonCode: 'FUTURE_HOSPITAL_JOIN',
      entries: [
        entry('PARTNER-001', { effectiveFromMonth: '2026-01' }),
        entry('PARTNER-002', { effectiveFromMonth: '2026-07' }),
        entry('PARTNER-003', { effectiveFromMonth: '2026-08' }),
      ],
    }))
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')).toMatchObject({
      accounts: ['PARTNER-001', 'PARTNER-002'],
      rosterSourceHash: julyBefore?.rosterSourceHash,
    })
    expect(projectHospitalCmDirectoryForMonth(db, '2026-08')?.accounts)
      .toEqual(['PARTNER-001', 'PARTNER-002', 'PARTNER-003'])

    const correctedBoundary = saveHospitalCmDirectoryRevision(db, revisionInput({
      knownCompleteFromMonth: '2026-08',
      reasonCode: 'HISTORICAL_COMPLETENESS_CORRECTION',
      entries: withFutureJoin.entries.map(item => ({
        stablePartnerId: item.stablePartnerId,
        accountCode: item.accountCode,
        canonicalDisplayName: item.canonicalDisplayName,
        aliases: item.aliases,
        hospitalCmIncluded: item.hospitalCmIncluded,
        effectiveFromMonth: item.effectiveFromMonth,
        effectiveToMonth: item.effectiveToMonth,
      })),
    }))
    expect(correctedBoundary.contentHash).not.toBe(withFutureJoin.contentHash)
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')).toBeNull()
    expect(projectHospitalCmDirectoryForMonth(db, '2026-08')?.accounts)
      .toEqual(['PARTNER-001', 'PARTNER-002', 'PARTNER-003'])
    expect(first.knownCompleteFromMonth).toBe('2026-07')
  })

  it('does not let partner soft deletion rewrite audited membership or block an explicit exit', () => {
    saveHospitalCmDirectoryRevision(db, revisionInput({
      entries: [entry('PARTNER-001')],
    }))
    const before = projectHospitalCmDirectoryForMonth(db, '2026-07')
    db.prepare("UPDATE partners SET is_deleted = 1, code = 'LEGACY-001-RETIRED', name = '已停用主数据名称' WHERE id = 'PARTNER-001'").run()

    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')).toMatchObject({
      accounts: ['PARTNER-001'],
      rosterSourceHash: before?.rosterSourceHash,
    })
    saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'EXPLICIT_MEMBERSHIP_END',
      entries: [entry('PARTNER-001', { effectiveToMonth: '2026-07' })],
    }))
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.accounts).toEqual(['PARTNER-001'])
    expect(projectHospitalCmDirectoryForMonth(db, '2026-08')?.accounts).toEqual([])
  })

  it('requires an explicit inclusive exit month instead of removing an included identity', () => {
    saveHospitalCmDirectoryRevision(db, revisionInput())

    expectDirectoryCode(
      () => saveHospitalCmDirectoryRevision(db, revisionInput({
        reasonCode: 'UNSAFE_OMISSION',
        entries: [entry('PARTNER-001')],
      })),
      'DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID',
    )
    expectDirectoryCode(
      () => saveHospitalCmDirectoryRevision(db, revisionInput({
        reasonCode: 'UNSAFE_DISABLE',
        entries: [
          entry('PARTNER-001'),
          entry('PARTNER-002', {
            hospitalCmIncluded: false,
            effectiveFromMonth: null,
            effectiveToMonth: null,
          }),
        ],
      })),
      'DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID',
    )

    expect(getCurrentHospitalCmDirectory(db)?.revision).toBe(1)
    expect(rowCount(db, 'hospital_cm_directory_versions')).toBe(1)
    expect(rowCount(db, 'hospital_cm_directory_idempotency')).toBe(1)
    expect(rowCount(db, 'abc_audit_logs')).toBe(1)
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.accounts)
      .toEqual(['PARTNER-001', 'PARTNER-002'])

    saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'EXPLICIT_MEMBERSHIP_END',
      entries: [
        entry('PARTNER-001'),
        entry('PARTNER-002', { effectiveToMonth: '2026-07' }),
      ],
    }))
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.accounts)
      .toEqual(['PARTNER-001', 'PARTNER-002'])
    expect(projectHospitalCmDirectoryForMonth(db, '2026-08')?.accounts).toEqual(['PARTNER-001'])

    expectDirectoryCode(
      () => saveHospitalCmDirectoryRevision(db, revisionInput({
        reasonCode: 'UNSAFE_POST_EXIT_OMISSION',
        entries: [entry('PARTNER-001')],
      })),
      'DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID',
    )
    expect(getCurrentHospitalCmDirectory(db)?.revision).toBe(2)
    expect(rowCount(db, 'hospital_cm_directory_versions')).toBe(2)
    expect(rowCount(db, 'hospital_cm_directory_idempotency')).toBe(2)
    expect(rowCount(db, 'abc_audit_logs')).toBe(2)
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')?.accounts)
      .toEqual(['PARTNER-001', 'PARTNER-002'])
  })

  it('rejects and refuses to consume a correctly hashed direct-SQL revision that omits an included identity', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput())
    const forgedId = '00000000-0000-4000-8000-000000000002'
    db.exec('PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = OFF; BEGIN IMMEDIATE;')
    expect(() => insertForgedSingleEntryRevision(db, first, forgedId))
      .toThrow(/DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID/)
    db.exec('ROLLBACK')
    expect(getCurrentHospitalCmDirectory(db)?.id).toBe(first.id)

    db.exec('DROP TRIGGER IF EXISTS trg_hcm_directory_entries_preserve_included_members')
    insertForgedSingleEntryRevision(db, first, forgedId)
    expectDirectoryCode(() => getCurrentHospitalCmDirectory(db), 'DIRECTORY_CORRUPT')
    expectDirectoryCode(() => projectHospitalCmDirectoryForMonth(db, '2026-07'), 'DIRECTORY_CORRUPT')
  })

  it('never lets an ordinary revision move an included start month forward and erase history', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput({
      knownCompleteFromMonth: '2026-01',
      entries: [entry('PARTNER-001', { effectiveFromMonth: '2026-01' })],
    }))
    expect(projectHospitalCmDirectoryForMonth(db, '2026-01')?.accounts).toEqual(['PARTNER-001'])

    expectDirectoryCode(
      () => saveHospitalCmDirectoryRevision(db, revisionInput({
        knownCompleteFromMonth: '2026-01',
        entries: [entry('PARTNER-001', { effectiveFromMonth: '2026-07' })],
        reasonCode: 'MOVE_START_FORWARD',
      })),
      'DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID',
    )
    expect(getCurrentHospitalCmDirectory(db)?.id).toBe(first.id)
    expect(projectHospitalCmDirectoryForMonth(db, '2026-01')?.accounts).toEqual(['PARTNER-001'])

    const forgedId = '00000000-0000-4000-8000-000000000020'
    db.exec('BEGIN IMMEDIATE')
    expect(() => insertForgedMovedStartRevision(db, first, forgedId))
      .toThrow(/DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID/)
    db.exec('ROLLBACK')
    expect(getCurrentHospitalCmDirectory(db)?.id).toBe(first.id)

    db.exec('DROP TRIGGER trg_hcm_directory_entries_preserve_included_members')
    insertForgedMovedStartRevision(db, first, forgedId)
    expectDirectoryCode(() => getCurrentHospitalCmDirectory(db), 'DIRECTORY_CORRUPT')
    expectDirectoryCode(() => projectHospitalCmDirectoryForMonth(db, '2026-01'), 'DIRECTORY_CORRUPT')
    expectDirectoryCode(() => listHospitalCmDirectoryRevisions(db), 'DIRECTORY_CORRUPT')
  })

  it('allows an audited revision to move an included start month earlier', () => {
    saveHospitalCmDirectoryRevision(db, revisionInput({
      knownCompleteFromMonth: '2026-01',
      entries: [entry('PARTNER-001', { effectiveFromMonth: '2026-07' })],
    }))
    expect(projectHospitalCmDirectoryForMonth(db, '2026-01')?.accounts).toEqual([])

    const corrected = saveHospitalCmDirectoryRevision(db, revisionInput({
      knownCompleteFromMonth: '2026-01',
      entries: [entry('PARTNER-001', { effectiveFromMonth: '2026-01' })],
      reasonCode: 'CORRECT_START_EARLIER',
    }))
    expect(corrected.revision).toBe(2)
    expect(projectHospitalCmDirectoryForMonth(db, '2026-01')?.accounts).toEqual(['PARTNER-001'])
  })

  it('does not let a new header chain through an incomplete intermediate revision', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput())
    const retained = first.entries.find(item => item.stablePartnerId === 'PARTNER-001')!
    const incompleteId = '00000000-0000-4000-8000-000000000010'
    const nextId = '00000000-0000-4000-8000-000000000011'
    const retainedOnlyHash = stableHash({
      contractVersion: HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      knownCompleteFromMonth: first.knownCompleteFromMonth,
      rowHashes: [retained.rowHash],
    })
    const incompleteRecordedAt = '2026-07-16T00:00:00.000Z'
    const incompleteLineageHash = expectedRevisionLineageHash({
      id: incompleteId,
      eventNumber: 2,
      revision: 2,
      knownCompleteFromMonth: first.knownCompleteFromMonth,
      entryCount: 2,
      aliasCount: 1,
      contentHash: first.contentHash,
      supersedesVersionId: first.id,
      parentRevisionLineageHash: first.revisionLineageHash,
      reasonCode: 'INCOMPLETE_INTERMEDIATE',
      recordedByUserId: 'FORGER',
      recordedByUsername: 'forger',
      recordedAt: incompleteRecordedAt,
    })
    const nextRecordedAt = '2026-07-16T00:01:00.000Z'
    const nextLineageHash = expectedRevisionLineageHash({
      id: nextId,
      eventNumber: 3,
      revision: 3,
      knownCompleteFromMonth: first.knownCompleteFromMonth,
      entryCount: 1,
      aliasCount: 1,
      contentHash: retainedOnlyHash,
      supersedesVersionId: incompleteId,
      parentRevisionLineageHash: incompleteLineageHash,
      reasonCode: 'CHAIN_THROUGH_INCOMPLETE',
      recordedByUserId: 'FORGER',
      recordedByUsername: 'forger',
      recordedAt: nextRecordedAt,
    })
    db.exec('PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = OFF; BEGIN IMMEDIATE;')
    db.prepare(`
      INSERT INTO hospital_cm_directory_versions (
        event_number, id, revision, contract_version, known_complete_from_month,
        entry_count, alias_count, content_hash, revision_lineage_hash, supersedes_version_id,
        reason_code, recorded_by_user_id, recorded_by_username, recorded_at
      ) VALUES (2, ?, 2, ?, ?, 2, 1, ?, ?, ?, 'INCOMPLETE_INTERMEDIATE',
        'FORGER', 'forger', ?)
    `).run(
      incompleteId,
      HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      first.knownCompleteFromMonth,
      first.contentHash,
      incompleteLineageHash,
      first.id,
      incompleteRecordedAt,
    )
    db.prepare(`
      INSERT INTO hospital_cm_directory_entries (
        directory_version_id, stable_partner_id, account_code, account_code_key,
        canonical_display_name, hospital_cm_included, effective_from_month,
        effective_to_month, row_hash
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      incompleteId,
      retained.stablePartnerId,
      retained.accountCode,
      retained.accountCode.normalize('NFKC').trim().toLowerCase(),
      retained.canonicalDisplayName,
      retained.effectiveFromMonth,
      retained.effectiveToMonth,
      retained.rowHash,
    )
    db.prepare(`
      INSERT INTO hospital_cm_directory_aliases (
        directory_version_id, stable_partner_id, alias, alias_key
      ) VALUES (?, ?, ?, ?)
    `).run(
      incompleteId,
      retained.stablePartnerId,
      retained.aliases[0],
      retained.aliases[0]!.normalize('NFKC').trim().toLowerCase(),
    )

    expect(() => db.prepare(`
      INSERT INTO hospital_cm_directory_versions (
        event_number, id, revision, contract_version, known_complete_from_month,
        entry_count, alias_count, content_hash, revision_lineage_hash, supersedes_version_id,
        reason_code, recorded_by_user_id, recorded_by_username, recorded_at
      ) VALUES (3, ?, 3, ?, ?, 1, 1, ?, ?, ?, 'CHAIN_THROUGH_INCOMPLETE',
        'FORGER', 'forger', ?)
    `).run(
      nextId,
      HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      first.knownCompleteFromMonth,
      retainedOnlyHash,
      nextLineageHash,
      incompleteId,
      nextRecordedAt,
    )).toThrow(/DIRECTORY_PREVIOUS_VERSION_INCOMPLETE/)
    db.exec('ROLLBACK')
    expect(getCurrentHospitalCmDirectory(db)?.id).toBe(first.id)
  })

  it('keeps every revision append-only even when foreign keys and recursive triggers are disabled', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput())
    const second = saveHospitalCmDirectoryRevision(db, revisionInput({
      entries: [entry('PARTNER-001'), entry('PARTNER-002', { effectiveToMonth: '2026-07' })],
      reasonCode: 'END_SECOND_MEMBERSHIP',
    }))
    db.exec('PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = OFF;')

    const snapshot = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY event_number`).all()
    const before = Object.fromEntries([
      'hospital_cm_directory_versions',
      'hospital_cm_directory_entries',
      'hospital_cm_directory_aliases',
      'hospital_cm_directory_idempotency',
    ].map(table => [table, snapshot(table)]))

    for (const table of [
      'hospital_cm_directory_versions',
      'hospital_cm_directory_entries',
      'hospital_cm_directory_aliases',
      'hospital_cm_directory_idempotency',
    ]) {
      expect(() => db.prepare(`UPDATE ${table} SET event_number = event_number WHERE event_number = (SELECT MIN(event_number) FROM ${table})`).run())
        .toThrow(/DIRECTORY_.*_APPEND_ONLY/)
      expect(() => db.prepare(`DELETE FROM ${table} WHERE event_number = (SELECT MIN(event_number) FROM ${table})`).run())
        .toThrow(/DIRECTORY_.*_APPEND_ONLY/)
      expect(() => db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE event_number = (SELECT MIN(event_number) FROM ${table})`).run())
        .toThrow(/DIRECTORY_.*_APPEND_ONLY/)
    }

    const firstVersionEvent = (db.prepare(`
      SELECT event_number AS eventNumber FROM hospital_cm_directory_versions
      WHERE id = ?
    `).get(first.id) as { eventNumber: number }).eventNumber
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO hospital_cm_directory_versions (
        event_number, id, revision, contract_version, entry_count, alias_count,
        content_hash, supersedes_version_id, reason_code, recorded_by_user_id,
        recorded_by_username, recorded_at
      ) VALUES (?, '00000000-0000-4000-8000-000000000099', 3, ?, 1, 0, ?, ?,
        'FORGED_REPLACEMENT', 'FORGED', 'forged', '2026-07-16T00:00:00.000Z')
    `).run(
      firstVersionEvent,
      HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      'f'.repeat(64),
      second.id,
    )).toThrow(/DIRECTORY_.*_APPEND_ONLY/)
    expect(() => db.prepare(`
      INSERT INTO hospital_cm_directory_entries (
        directory_version_id, stable_partner_id, account_code, account_code_key,
        canonical_display_name, hospital_cm_included, effective_from_month,
        effective_to_month, row_hash
      ) VALUES (?, 'PARTNER-003', 'LATE', 'late', 'late', 1, '2026-07', NULL, ?)
    `).run(second.id, 'e'.repeat(64))).toThrow(/DIRECTORY_VERSION_SEALED/)
    expect(() => db.prepare(`
      INSERT INTO hospital_cm_directory_aliases (
        directory_version_id, stable_partner_id, alias, alias_key
      ) VALUES (?, 'PARTNER-001', 'late alias', 'late alias')
    `).run(second.id)).toThrow(/DIRECTORY_VERSION_SEALED/)
    expect(() => db.prepare(`
      INSERT INTO hospital_cm_directory_entries (
        directory_version_id, stable_partner_id, account_code, account_code_key,
        canonical_display_name, hospital_cm_included, effective_from_month,
        effective_to_month, row_hash
      ) VALUES ('00000000-0000-4000-8000-000000000098', 'PARTNER-003',
        'ORPHAN', 'orphan', 'orphan', 1, '2026-07', NULL, ?)
    `).run('d'.repeat(64))).toThrow(/DIRECTORY_VERSION_MISSING/)
    expect(() => db.prepare(`
      INSERT INTO hospital_cm_directory_versions (
        id, revision, contract_version, known_complete_from_month,
        entry_count, alias_count, content_hash,
        supersedes_version_id, reason_code, recorded_by_user_id,
        recorded_by_username, recorded_at
      ) VALUES ('00000000-0000-4000-8000-000000000097', 3, ?, '2026-07', 1, 0, ?,
        '00000000-0000-4000-8000-000000000096', 'FORGED_CHAIN', 'FORGED',
        'forged', '2026-07-16T00:00:00.000Z')
    `).run(HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION, 'c'.repeat(64)))
      .toThrow(/DIRECTORY_VERSION_SEQUENCE_INVALID/)

    const after = Object.fromEntries(Object.keys(before).map(table => [table, snapshot(table)]))
    expect(after).toEqual(before)

    expect(getHospitalCmDirectoryRevision(db, first.id)?.revision).toBe(1)
    expect(getHospitalCmDirectoryRevision(db, second.id)?.revision).toBe(2)
    expect(listHospitalCmDirectoryRevisions(db).versions.map(item => item.revision)).toEqual([2, 1])
  })

  it('rolls back the entire revision when an entry or audit write fails', () => {
    const rowFailureDb = createDb()
    rowFailureDb.exec(`
      CREATE TRIGGER test_directory_second_entry_failure
      BEFORE INSERT ON hospital_cm_directory_entries
      WHEN NEW.stable_partner_id = 'PARTNER-002'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_DIRECTORY_SECOND_ENTRY_FAILURE');
      END;
    `)
    expectDirectoryCode(
      () => saveHospitalCmDirectoryRevision(rowFailureDb, revisionInput()),
      'DIRECTORY_STORAGE_FAILED',
    )
    for (const table of [
      'hospital_cm_directory_versions',
      'hospital_cm_directory_entries',
      'hospital_cm_directory_aliases',
      'hospital_cm_directory_idempotency',
    ]) expect(rowCount(rowFailureDb, table)).toBe(0)

    const auditFailureDb = createDb({ audit: false })
    let auditFailure: unknown
    try {
      saveHospitalCmDirectoryRevision(auditFailureDb, revisionInput())
    } catch (error) {
      auditFailure = error
    }
    expect(auditFailure).toMatchObject({ code: 'DIRECTORY_STORAGE_FAILED' })
    expect(String((auditFailure as Error).message)).not.toMatch(/abc_audit_logs|INSERT|SQL/i)
    expect(rowCount(auditFailureDb, 'hospital_cm_directory_versions')).toBe(0)
    expect(rowCount(auditFailureDb, 'hospital_cm_directory_entries')).toBe(0)
    expect(rowCount(auditFailureDb, 'hospital_cm_directory_aliases')).toBe(0)
    expect(rowCount(auditFailureDb, 'hospital_cm_directory_idempotency')).toBe(0)
  })

  it('fails closed on corruption and records redacted before/after audit evidence', () => {
    const first = saveHospitalCmDirectoryRevision(db, revisionInput())
    const created = saveHospitalCmDirectoryRevision(db, revisionInput({
      reasonCode: 'DISPLAY_NAME_CORRECTION',
      entries: [
        entry('PARTNER-001', { canonicalDisplayName: '测试目录医院甲-新展示名' }),
        entry('PARTNER-002'),
      ],
    }))
    const audits = db.prepare(`
      SELECT target_id AS targetId, detail, operator, created_at AS createdAt
      FROM abc_audit_logs
      WHERE module = 'hospital_cm_directory'
      ORDER BY created_at, target_id
    `).all() as Array<{ targetId: string; detail: string; operator: string; createdAt: string }>
    const firstAudit = audits.find(audit => audit.targetId === first.id)!
    const currentAudit = audits.find(audit => audit.targetId === created.id)!
    expect(JSON.parse(firstAudit.detail)).toMatchObject({
      beforeContentHash: null,
      afterContentHash: first.contentHash,
      beforeKnownCompleteFromMonth: null,
      afterKnownCompleteFromMonth: '2026-07',
      supersedesVersionId: null,
      reasonCode: 'INITIAL_DIRECTORY_CONFIGURATION',
      membershipChangeCount: 2,
      affectedMembershipWindows: [{ fromMonth: '2026-07', toMonth: null }],
    })
    const detail = JSON.parse(currentAudit.detail) as Record<string, unknown>
    expect(Object.keys(detail).sort()).toEqual([
      'affectedMembershipWindows',
      'afterContentHash',
      'afterKnownCompleteFromMonth',
      'aliasCount',
      'beforeContentHash',
      'beforeKnownCompleteFromMonth',
      'contractVersion',
      'entryCount',
      'membershipChangeCount',
      'reasonCode',
      'revision',
      'supersedesVersionId',
    ])
    expect(detail).toMatchObject({
      beforeContentHash: first.contentHash,
      afterContentHash: created.contentHash,
      beforeKnownCompleteFromMonth: '2026-07',
      afterKnownCompleteFromMonth: '2026-07',
      supersedesVersionId: first.id,
      reasonCode: 'DISPLAY_NAME_CORRECTION',
      membershipChangeCount: 0,
      affectedMembershipWindows: [],
    })
    expect(currentAudit.operator).toBe(ADMIN.username)
    expect(Date.parse(currentAudit.createdAt)).not.toBeNaN()
    expect(currentAudit.detail).not.toContain('测试目录医院')
    expect(currentAudit.detail).not.toContain('别名-')
    expect(currentAudit.detail).not.toContain('HCM-PARTNER')

    db.exec('DROP TRIGGER trg_hcm_directory_entries_no_update')
    db.prepare(`
      UPDATE hospital_cm_directory_entries SET canonical_display_name = 'tampered'
      WHERE directory_version_id = ? AND stable_partner_id = 'PARTNER-001'
    `).run(created.id)
    expectDirectoryCode(() => getHospitalCmDirectoryRevision(db, created.id), 'DIRECTORY_CORRUPT')
    expectDirectoryCode(() => projectHospitalCmDirectoryForMonth(db, '2026-07'), 'DIRECTORY_CORRUPT')
  })

  it('fails closed when any ancestor content or immutable audit header is tampered', () => {
    const ancestorDb = createDb()
    const ancestor = saveHospitalCmDirectoryRevision(ancestorDb, revisionInput())
    saveHospitalCmDirectoryRevision(ancestorDb, revisionInput({
      reasonCode: 'SECOND_AUDITED_REVISION',
    }))
    ancestorDb.exec('DROP TRIGGER trg_hcm_directory_entries_no_update')
    ancestorDb.prepare(`
      UPDATE hospital_cm_directory_entries
      SET canonical_display_name = 'tampered ancestor'
      WHERE directory_version_id = ? AND stable_partner_id = 'PARTNER-001'
    `).run(ancestor.id)

    expectDirectoryCode(() => getCurrentHospitalCmDirectory(ancestorDb), 'DIRECTORY_CORRUPT')
    expectDirectoryCode(
      () => projectHospitalCmDirectoryForMonth(ancestorDb, '2026-07'),
      'DIRECTORY_CORRUPT',
    )
    expectDirectoryCode(() => listHospitalCmDirectoryRevisions(ancestorDb), 'DIRECTORY_CORRUPT')

    const headerDb = createDb()
    saveHospitalCmDirectoryRevision(headerDb, revisionInput())
    saveHospitalCmDirectoryRevision(headerDb, revisionInput({
      reasonCode: 'SECOND_AUDITED_REVISION',
    }))
    headerDb.exec('DROP TRIGGER trg_hcm_directory_versions_no_update')
    headerDb.prepare(`
      UPDATE hospital_cm_directory_versions
      SET reason_code = 'FORGED_REASON',
          recorded_by_user_id = 'FORGED-ACTOR',
          recorded_by_username = 'forged.actor',
          recorded_at = '2026-07-16T00:00:00.000Z'
      WHERE revision = 2
    `).run()

    expectDirectoryCode(() => getCurrentHospitalCmDirectory(headerDb), 'DIRECTORY_CORRUPT')
    expectDirectoryCode(
      () => projectHospitalCmDirectoryForMonth(headerDb, '2026-07'),
      'DIRECTORY_CORRUPT',
    )
    expectDirectoryCode(() => listHospitalCmDirectoryRevisions(headerDb), 'DIRECTORY_CORRUPT')
  })

  it('reads and projects a large directory with constant query count rather than one query per partner', () => {
    const largeDb = createDb()
    const insert = largeDb.prepare('INSERT INTO partners (id, code, name, is_deleted) VALUES (?, ?, ?, 0)')
    const entries = Array.from({ length: 300 }, (_, index) => {
      const id = `PARTNER-LARGE-${String(index).padStart(4, '0')}`
      insert.run(id, `LEGACY-LARGE-${index}`, `规模测试医院-${index}`)
      return entry(id, { aliases: [] })
    })
    saveHospitalCmDirectoryRevision(largeDb, revisionInput({ entries }))

    let prepares = 0
    const countedDb = {
      exec: (sql: string) => largeDb.exec(sql),
      prepare: (sql: string) => {
        prepares += 1
        return largeDb.prepare(sql)
      },
    }
    const projected = projectHospitalCmDirectoryForMonth(countedDb, '2026-07')
    expect(projected?.accounts).toHaveLength(300)
    expect(prepares).toBeLessThanOrEqual(4)
  })

  it('loads one immutable resolver snapshot and maps a large batch without per-row SQL or scans', () => {
    const largeDb = createDb()
    const insert = largeDb.prepare('INSERT INTO partners (id, code, name, is_deleted) VALUES (?, ?, ?, 0)')
    const entries = Array.from({ length: 300 }, (_, index) => {
      const suffix = String(index).padStart(4, '0')
      const id = `PARTNER-BATCH-${suffix}`
      insert.run(id, `LEGACY-BATCH-${suffix}`, `批量映射医院-${suffix}`)
      return entry(id, {
        accountCode: `BATCH-CODE-${suffix}`,
        aliases: [`BATCH-ALIAS-${suffix}`],
      })
    })
    saveHospitalCmDirectoryRevision(largeDb, revisionInput({ entries }))

    const countQueries = () => {
      let prepares = 0
      return {
        db: {
          exec: (sql: string) => largeDb.exec(sql),
          prepare: (sql: string) => {
            prepares += 1
            return largeDb.prepare(sql)
          },
        },
        prepares: () => prepares,
      }
    }
    const rawInputs = entries.flatMap(item => [
      { stablePartnerId: item.stablePartnerId },
      { mappingKey: item.accountCode.toLowerCase() },
      { mappingKey: item.aliases[0]!.toLowerCase() },
    ])

    const batchCounter = countQueries()
    const resolved = resolveHospitalCmDirectoryPartners(batchCounter.db, rawInputs)
    expect(resolved).toHaveLength(900)
    expect(resolved.every(item => item !== null)).toBe(true)
    expect(batchCounter.prepares()).toBeLessThanOrEqual(4)

    const noQueryCounter = countQueries()
    expect(resolveHospitalCmDirectoryPartners(noQueryCounter.db, [])).toEqual([])
    expect(noQueryCounter.prepares()).toBe(0)
    expectDirectoryCode(
      () => resolveHospitalCmDirectoryPartners(noQueryCounter.db, [{ stablePartnerId: null }]),
      'DIRECTORY_RESOLUTION_INPUT_INVALID',
    )
    expect(noQueryCounter.prepares()).toBe(0)
  })

  it('DatabaseManager initializes only an empty directory and does not publish B0/C1 facts', async () => {
    const manager = await import('../src/database/DatabaseManager.js')
    try {
      manager.initializeDatabase()
      const runtimeDb = manager.getDatabase()
      const tables = (runtimeDb.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'hospital_cm_directory_%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map(row => row.name)
      expect(tables).toEqual([
        'hospital_cm_directory_aliases',
        'hospital_cm_directory_entries',
        'hospital_cm_directory_idempotency',
        'hospital_cm_directory_versions',
      ])
      for (const table of tables) expect(rowCount(runtimeDb, table)).toBe(0)
      expect(rowCount(runtimeDb, 'hospital_cm_account_roster_candidate_versions')).toBe(0)
      expect(rowCount(runtimeDb, 'hospital_cm_month_scope_snapshots')).toBe(0)
      expect((runtimeDb.prepare(`
        SELECT COUNT(*) AS n FROM abc_audit_logs WHERE module = 'hospital_cm_directory'
      `).get() as { n: number }).n).toBe(0)
    } finally {
      manager.closeDatabase()
    }
  })

  it('exposes a stable domain error type for validation callers', () => {
    expect(() => saveHospitalCmDirectoryRevision(db, revisionInput({ entries: [] }))).toThrow(HospitalCmDirectoryError)
  })
})
