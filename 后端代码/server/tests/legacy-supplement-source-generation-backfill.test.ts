/**
 * Issue #83（LOC-005-FUP）— master 形状旧库（带漏收补收单、无对账代）的受治理 backfill
 *
 * 冻结方向（benchmark task card DS-C1-ISSUE83，方案 B）：
 * - 一次性离线 backfill 工具 + runbook；显式 database / actor / reason；默认 dry-run，
 *   --apply 才写；正常 boot 对目标 legacy shape 继续 fail-closed；
 * - 工具只处理 Issue 精确定义形状；额外 drift / 事实不足 / lineage 不可证 → 零写停止；
 * - 保留 who / when / reason / original facts；检查与写入同一事务边界，任何 fault 全量 rollback。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  applyBackfill,
  assertFileIdentity,
  AUDIT_TABLE,
  BackfillError,
  findTargetRows,
  planBackfill,
} from '../scripts/legacy-supplement-source-generation-backfill.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TOOL_PATH = join(__dirname, '..', 'scripts', 'legacy-supplement-source-generation-backfill.mjs')
const testDirectory = mkdtempSync(join(tmpdir(), 'coreone-issue83-backfill-'))

const MAIN_DB = join(testDirectory, 'legacy-main.sqlite')
const DRY_DB = join(testDirectory, 'legacy-dry.sqlite')
const PARTIAL_DB = join(testDirectory, 'partial-schema.sqlite')
const DANGLING_DB = join(testDirectory, 'dangling-lineage.sqlite')
const CONFLICT_DB = join(testDirectory, 'audit-conflict.sqlite')
const DRIFT_DB = join(testDirectory, 'audit-drift.sqlite')
const LOCK_DB = join(testDirectory, 'concurrent-lock.sqlite')
const FAULT_DB = join(testDirectory, 'fault-rollback.sqlite')
const REPLACED_DB = join(testDirectory, 'replaced-target.sqlite')
const MISSING_DB = join(testDirectory, 'does-not-exist.sqlite')

process.env.NODE_ENV = 'test'
process.env.DATABASE_PATH = MAIN_DB
process.env.COREONE_ALLOW_DATABASE_CREATE = '1'
process.env.JWT_SECRET = 'issue83-backfill-test-secret-at-least-32-characters'

let manager: typeof import('../src/database/DatabaseManager.js')

const ACTOR = 'issue83-benchmark-operator'
const REASON = 'Issue83 frozen direction: governed one-off backfill (方案 B)'

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function openRaw(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath)
}

function createLegacySchema(conn: DatabaseSync): void {
  conn.exec('PRAGMA foreign_keys = ON')
  conn.exec(`
    CREATE TABLE reconcile_hospital_months (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      partner_name TEXT,
      service_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待复核',
      name_aligned INTEGER NOT NULL DEFAULT 0,
      match_rate DECIMAL(10, 6) DEFAULT 0,
      match_status TEXT,
      statement_ready INTEGER NOT NULL DEFAULT 0,
      lis_ready INTEGER NOT NULL DEFAULT 0,
      diff_count INTEGER NOT NULL DEFAULT 0,
      pending_count INTEGER NOT NULL DEFAULT 0,
      unmatched_count INTEGER NOT NULL DEFAULT 0,
      confirmed_lab_revenue DECIMAL(18, 4),
      computed_at DATETIME,
      completed_at DATETIME,
      completed_by TEXT,
      closed_at DATETIME,
      closed_by TEXT,
      reopened_at DATETIME,
      reopen_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(partner_id, service_month)
    )
  `)
  conn.exec(`
    CREATE TABLE reconcile_diffs (
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
    )
  `)
  conn.exec(`
    CREATE TABLE account_reconcile_generations (
      reconcile_generation_id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      settlement_month TEXT NOT NULL,
      statement_generation_id TEXT NOT NULL,
      hospital_month_id TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      source_readiness_json TEXT,
      source_readiness_hash TEXT,
      snapshot_json TEXT,
      snapshot_hash TEXT,
      completed_at DATETIME,
      completed_by TEXT,
      closed_at DATETIME,
      closed_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  conn.exec(`
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
    )
  `)
}

function insertHospitalMonth(
  conn: DatabaseSync,
  id: string,
  partnerId: string,
  month: string,
  status = '待复核',
): void {
  conn.prepare(`
    INSERT INTO reconcile_hospital_months (id, partner_id, service_month, status)
    VALUES (?, ?, ?, ?)
  `).run(id, partnerId, month, status)
}

function insertDiff(
  conn: DatabaseSync,
  id: string,
  hospitalMonthId: string,
  partnerId: string,
  month: string,
  caseNo: string,
): void {
  conn.prepare(`
    INSERT INTO reconcile_diffs
      (id, hospital_month_id, partner_id, service_month, case_no, line_type,
       bill_count, lis_count, delta, amount_impact, low_confidence)
    VALUES (?, ?, ?, ?, ?, 'bill_less', 1, 2, -1, 100, 0)
  `).run(id, hospitalMonthId, partnerId, month, caseNo)
}

function insertSupplement(
  conn: DatabaseSync,
  id: string,
  partnerId: string,
  month: string,
  sourceDiffId: string | null,
  amount = 88.5,
): void {
  conn.prepare(`
    INSERT INTO supplement_orders
      (id, partner_id, service_month, source_diff_id, case_no, amount, case_count,
       status, submitted_by, review_status)
    VALUES (?, ?, ?, ?, 'CASE-LEGACY', ?, 1, '待补收', 'legacy-operator', 'pending_review')
  `).run(id, partnerId, month, sourceDiffId, amount)
}

function insertGeneration(
  conn: DatabaseSync,
  id: string,
  partnerId: string,
  month: string,
  hospitalMonthId: string,
): void {
  const hash = 'sha256:' + 'a'.repeat(64)
  conn.prepare(`
    INSERT INTO account_reconcile_generations
      (reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
       hospital_month_id, is_current, status, source_readiness_json, source_readiness_hash,
       snapshot_json, snapshot_hash)
    VALUES (?, ?, ?, ?, ?, 1, 'pending', '{}', ?, '{}', ?)
  `).run(id, partnerId, month, `STMT-${id}`, hospitalMonthId, hash, hash)
}

const AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplement_id TEXT NOT NULL UNIQUE,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    original_source_diff_id TEXT NOT NULL,
    original_partner_id TEXT NOT NULL,
    original_service_month TEXT NOT NULL,
    original_amount DECIMAL(18, 4) NOT NULL,
    original_case_count INTEGER NOT NULL,
    original_status TEXT NOT NULL,
    handled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tool_version TEXT NOT NULL
  )
`

/**
 * 固定 predecessor fixture：master 形状旧库（supplement_orders 带 source_diff_id、
 * 无 reconcile_generation_id；reconcile_diffs 无代次列；account_reconcile_generations
 * 无 completion artifact 列；无 bindings/provenance 表）。
 * 默认含 SO-LEGACY-A（漏收补收单，所属院·月无 current 代）与 SO-LEGACY-B
 * （有 current 代，boot 可自动升级的非目标行）。
 */
function buildLegacyFixture(dbPath: string, options: {
  withMixTarget?: boolean
  danglingExtra?: boolean
  partialSchema?: boolean
  auditConflict?: boolean
  auditSchemaDrift?: boolean
} = {}): void {
  const withMix = options.withMixTarget ?? true
  if (existsSync(dbPath)) {
    unlinkSync(dbPath)
  }
  const conn = new DatabaseSync(dbPath)
  try {
    conn.exec('PRAGMA foreign_keys = ON')
    createLegacySchema(conn)
    insertHospitalMonth(conn, 'HM-LEGACY-A', 'PT-LEGACY', '2026-05')
    insertDiff(conn, 'DIFF-LEGACY-A', 'HM-LEGACY-A', 'PT-LEGACY', '2026-05', 'CASE-A')
    insertSupplement(conn, 'SO-LEGACY-A', 'PT-LEGACY', '2026-05', 'DIFF-LEGACY-A', 88.5)
    if (withMix) {
      insertHospitalMonth(conn, 'HM-LEGACY-B', 'PT-LEGACY', '2026-06')
      insertDiff(conn, 'DIFF-LEGACY-B', 'HM-LEGACY-B', 'PT-LEGACY', '2026-06', 'CASE-B')
      insertGeneration(conn, 'GEN-LEGACY-B', 'PT-LEGACY', '2026-06', 'HM-LEGACY-B')
      insertSupplement(conn, 'SO-LEGACY-B', 'PT-LEGACY', '2026-06', 'DIFF-LEGACY-B', 12.25)
    }
    if (options.danglingExtra) {
      conn.exec('PRAGMA foreign_keys = OFF')
      insertSupplement(conn, 'SO-DANGLING', 'PT-LEGACY', '2026-05', 'DIFF-MISSING', 7)
      conn.exec('PRAGMA foreign_keys = ON')
    }
    if (options.partialSchema) {
      conn.exec('PRAGMA foreign_keys = OFF')
      conn.exec('DROP TABLE supplement_orders')
      conn.exec(`
        CREATE TABLE supplement_orders (
          id TEXT PRIMARY KEY,
          partner_id TEXT NOT NULL,
          service_month TEXT NOT NULL,
          source_diff_id TEXT,
          reconcile_generation_id TEXT,
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
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      conn.prepare(`
        INSERT INTO supplement_orders
          (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
           case_no, amount, case_count, status, submitted_by, review_status)
        VALUES ('SO-LEGACY-A', 'PT-LEGACY', '2026-05', 'DIFF-LEGACY-A', NULL,
                'CASE-A', 88.5, 1, '待补收', 'legacy-operator', 'pending_review')
      `).run()
      conn.exec('PRAGMA foreign_keys = ON')
    }
    if (options.auditConflict || options.auditSchemaDrift) {
      if (options.auditSchemaDrift) {
        conn.exec(`
          CREATE TABLE ${AUDIT_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplement_id TEXT NOT NULL UNIQUE,
            actor TEXT NOT NULL
          )
        `)
      } else {
        conn.exec(AUDIT_DDL)
        conn.prepare(`
          INSERT INTO ${AUDIT_TABLE}
            (supplement_id, actor, reason, original_source_diff_id, original_partner_id,
             original_service_month, original_amount, original_case_count, original_status,
             tool_version)
          VALUES ('SO-LEGACY-A', 'previous-runner', 'previous attempt', 'DIFF-LEGACY-A',
                  'PT-LEGACY', '2026-05', 88.5, 1, '待补收', '1.0.0')
        `).run()
      }
    }
  } finally {
    conn.close()
  }
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-sqlite', TOOL_PATH, ...args],
    { encoding: 'utf8', timeout: 30000 },
  )
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

function expectBackfillError(stderr: string, code: string): void {
  expect(stderr).toContain(`BACKFILL_ERROR ${code}`)
}

beforeAll(async () => {
  manager = await import('../src/database/DatabaseManager.js')
})

afterAll(() => {
  manager.closeDatabase()
  const realDirectory = resolve(testDirectory)
  const realTempRoot = resolve(tmpdir())
  if (!realDirectory.startsWith(`${realTempRoot}\\`) && !realDirectory.startsWith(`${realTempRoot}/`)) {
    throw new Error(`unsafe test cleanup path: ${realDirectory}`)
  }
  rmSync(testDirectory, { recursive: true, force: true })
})

describe('Issue #83 fixed predecessor fixture — boot fail-closed probe', () => {
  it('first and second boot both fail closed with SUPPLEMENT_SOURCE_GENERATION_BACKFILL_REQUIRED', () => {
    buildLegacyFixture(MAIN_DB)
    expect(() => manager.initializeDatabase()).toThrow(
      /SUPPLEMENT_SOURCE_GENERATION_BACKFILL_REQUIRED:SO-LEGACY-A/,
    )
    manager.closeDatabase()
    expect(() => manager.initializeDatabase()).toThrow(
      /SUPPLEMENT_SOURCE_GENERATION_BACKFILL_REQUIRED:SO-LEGACY-A/,
    )
    manager.closeDatabase()
  })

  it('partial-schema variant still fails closed at boot', () => {
    buildLegacyFixture(PARTIAL_DB, { partialSchema: true, withMixTarget: false })
    const conn = new DatabaseSync(PARTIAL_DB)
    try {
      expect(() => manager.upgradeAccountReconciliationSchema(conn)).toThrow(
        /SUPPLEMENT_SOURCE_GENERATION_BACKFILL_REQUIRED/,
      )
    } finally {
      conn.close()
    }
  })
})

describe('Issue #83 governed backfill tool contract', () => {
  it('dry-run is read-only: lists exactly the target rows and leaves the DB byte-identical', () => {
    buildLegacyFixture(DRY_DB)
    const before = sha256File(DRY_DB)
    const result = runCli([
      '--database', DRY_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--json',
    ])
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.ok).toBe(true)
    expect(out.dryRun).toBe(true)
    expect(out.applied).toBe(0)
    expect(out.targetRows).toEqual([
      {
        id: 'SO-LEGACY-A',
        sourceDiffId: 'DIFF-LEGACY-A',
        hospitalMonthId: 'HM-LEGACY-A',
      },
    ])
    expect(sha256File(DRY_DB)).toBe(before)
    const conn = openRaw(DRY_DB)
    try {
      const row = conn.prepare(
        'SELECT source_diff_id FROM supplement_orders WHERE id = ?',
      ).get('SO-LEGACY-A') as { source_diff_id: string | null }
      expect(row.source_diff_id).toBe('DIFF-LEGACY-A')
      expect(conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(AUDIT_TABLE)).toBeUndefined()
    } finally {
      conn.close()
    }
  })

  it('missing required flags are rejected without touching the database', () => {
    buildLegacyFixture(DRY_DB)
    const before = sha256File(DRY_DB)
    const result = runCli(['--database', DRY_DB, '--actor', ACTOR])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--reason')
    expect(sha256File(DRY_DB)).toBe(before)
  })

  it('apply writes only the exact Issue-shape rows plus audit facts, in one transaction', () => {
    const result = runCli([
      '--database', MAIN_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.ok).toBe(true)
    expect(out.dryRun).toBe(false)
    expect(out.applied).toBe(1)
    expect(out.auditRowsWritten).toBe(1)

    const conn = openRaw(MAIN_DB)
    try {
      const handled = conn.prepare(
        `SELECT source_diff_id, amount, case_count, status, review_status
           FROM supplement_orders WHERE id = ?`,
      ).get('SO-LEGACY-A') as {
        source_diff_id: string | null
        amount: number
        case_count: number
        status: string
        review_status: string
      }
      expect(handled).toMatchObject({
        source_diff_id: null,
        amount: 88.5,
        case_count: 1,
        status: '待补收',
        review_status: 'pending_review',
      })
      const untouched = conn.prepare(
        'SELECT source_diff_id FROM supplement_orders WHERE id = ?',
      ).get('SO-LEGACY-B') as { source_diff_id: string | null }
      expect(untouched.source_diff_id).toBe('DIFF-LEGACY-B')

      const audit = conn.prepare(`
        SELECT actor, reason, original_source_diff_id, original_partner_id,
               original_service_month, original_amount, original_case_count,
               original_status, handled_at, tool_version
          FROM ${AUDIT_TABLE} WHERE supplement_id = ?
      `).get('SO-LEGACY-A') as {
        actor: string
        reason: string
        original_source_diff_id: string
        original_partner_id: string
        original_service_month: string
        original_amount: number
        original_case_count: number
        original_status: string
        handled_at: string
        tool_version: string
      }
      expect(audit).toMatchObject({
        actor: ACTOR,
        reason: REASON,
        original_source_diff_id: 'DIFF-LEGACY-A',
        original_partner_id: 'PT-LEGACY',
        original_service_month: '2026-05',
        original_amount: 88.5,
        original_case_count: 1,
        original_status: '待补收',
      })
      expect(audit.handled_at).toBeTruthy()
      expect(audit.tool_version).toBeTruthy()
      expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      conn.close()
    }
  })

  it('rerun immediately after apply is an idempotent no-op (stable success)', () => {
    const result = runCli([
      '--database', MAIN_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.applied).toBe(0)
    expect(out.auditRowsWritten).toBe(0)
    const conn = openRaw(MAIN_DB)
    try {
      expect(conn.prepare(
        `SELECT COUNT(*) AS n FROM ${AUDIT_TABLE} WHERE supplement_id = 'SO-LEGACY-A'`,
      ).get() as { n: number }).toMatchObject({ n: 1 })
    } finally {
      conn.close()
    }
  })

  it('after apply, first full boot and restart both succeed; non-target row keeps lineage', () => {
    expect(() => manager.initializeDatabase()).not.toThrow()
    manager.closeDatabase()
    expect(() => manager.initializeDatabase()).not.toThrow()
    manager.closeDatabase()

    const conn = openRaw(MAIN_DB)
    try {
      const row = conn.prepare(
        `SELECT source_diff_id, reconcile_generation_id FROM supplement_orders WHERE id = ?`,
      ).get('SO-LEGACY-B') as {
        source_diff_id: string | null
        reconcile_generation_id: string | null
      }
      expect(row).toMatchObject({
        source_diff_id: 'DIFF-LEGACY-B',
        reconcile_generation_id: 'GEN-LEGACY-B',
      })
      const handled = conn.prepare(
        `SELECT source_diff_id, reconcile_generation_id FROM supplement_orders WHERE id = ?`,
      ).get('SO-LEGACY-A') as {
        source_diff_id: string | null
        reconcile_generation_id: string | null
      }
      expect(handled).toMatchObject({ source_diff_id: null, reconcile_generation_id: null })
    } finally {
      conn.close()
    }
  })

  it('rerun after boot is a stable rejection (DB is no longer the legacy shape)', () => {
    const result = runCli([
      '--database', MAIN_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(result.status).toBe(1)
    expectBackfillError(result.stderr, 'DB_PARTIAL_SCHEMA')
  })
})

describe('Issue #83 adversarial — zero-write stops and rollback', () => {
  it('extra dirty row with unprovable lineage stops with zero writes', () => {
    buildLegacyFixture(DANGLING_DB, { danglingExtra: true })
    const before = sha256File(DANGLING_DB)
    const result = runCli([
      '--database', DANGLING_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(result.status).toBe(1)
    expectBackfillError(result.stderr, 'LINEAGE_UNPROVABLE')
    expect(sha256File(DANGLING_DB)).toBe(before)
  })

  it('partial schema is refused before any write and boot still fails closed', () => {
    buildLegacyFixture(PARTIAL_DB, { partialSchema: true, withMixTarget: false })
    const before = sha256File(PARTIAL_DB)
    const result = runCli([
      '--database', PARTIAL_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(result.status).toBe(1)
    expectBackfillError(result.stderr, 'DB_PARTIAL_SCHEMA')
    expect(sha256File(PARTIAL_DB)).toBe(before)
  })

  it('pre-existing audit fact for a target row rejects with zero writes (no double handling)', () => {
    buildLegacyFixture(CONFLICT_DB, { auditConflict: true, withMixTarget: false })
    const before = sha256File(CONFLICT_DB)
    const result = runCli([
      '--database', CONFLICT_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(result.status).toBe(1)
    expectBackfillError(result.stderr, 'ALREADY_HANDLED_TAMPERED')
    expect(sha256File(CONFLICT_DB)).toBe(before)
    const conn = openRaw(CONFLICT_DB)
    try {
      const row = conn.prepare(
        'SELECT source_diff_id FROM supplement_orders WHERE id = ?',
      ).get('SO-LEGACY-A') as { source_diff_id: string | null }
      expect(row.source_diff_id).toBe('DIFF-LEGACY-A')
    } finally {
      conn.close()
    }
  })

  it('audit table schema drift stops with zero writes', () => {
    buildLegacyFixture(DRIFT_DB, { auditSchemaDrift: true, withMixTarget: false })
    const before = sha256File(DRIFT_DB)
    const result = runCli([
      '--database', DRIFT_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(result.status).toBe(1)
    expectBackfillError(result.stderr, 'AUDIT_SCHEMA_DRIFT')
    expect(sha256File(DRIFT_DB)).toBe(before)
  })

  it('concurrent write lock fails cleanly with zero writes, then succeeds after release', () => {
    buildLegacyFixture(LOCK_DB)
    const lockConn = new DatabaseSync(LOCK_DB)
    try {
      lockConn.exec('BEGIN IMMEDIATE')
      const result = runCli([
        '--database', LOCK_DB,
        '--actor', ACTOR,
        '--reason', REASON,
        '--apply',
        '--json',
      ])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/locked|BUSY/i)
      const conn = openRaw(LOCK_DB)
      try {
        const row = conn.prepare(
          'SELECT source_diff_id FROM supplement_orders WHERE id = ?',
        ).get('SO-LEGACY-A') as { source_diff_id: string | null }
        expect(row.source_diff_id).toBe('DIFF-LEGACY-A')
      } finally {
        conn.close()
      }
    } finally {
      lockConn.exec('ROLLBACK')
      lockConn.close()
    }
    const retry = runCli([
      '--database', LOCK_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(retry.status).toBe(0)
    expect(JSON.parse(retry.stdout).applied).toBe(1)
  })

  it('audit-write fault rolls back row update, audit insert and table creation', () => {
    buildLegacyFixture(FAULT_DB, { withMixTarget: false })
    for (const faultAt of ['afterAuditWrite', 'beforeCommit']) {
      const conn = new DatabaseSync(FAULT_DB)
      try {
        expect(() => applyBackfill(conn, {
          actor: ACTOR,
          reason: REASON,
          faultAt,
        })).toThrow(`INJECTED_BACKFILL_FAULT:${faultAt}`)
        const row = conn.prepare(
          'SELECT source_diff_id FROM supplement_orders WHERE id = ?',
        ).get('SO-LEGACY-A') as { source_diff_id: string | null }
        expect(row.source_diff_id).toBe('DIFF-LEGACY-A')
        expect(conn.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(AUDIT_TABLE)).toBeUndefined()
        expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        conn.close()
      }
    }
  })

  it('db path replaced or invalid is refused without creating artifacts', () => {
    const missing = runCli([
      '--database', MISSING_DB,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(missing.status).toBe(1)
    expectBackfillError(missing.stderr, 'DB_FILE_MISSING')
    expect(existsSync(MISSING_DB)).toBe(false)

    const directoryResult = runCli([
      '--database', testDirectory,
      '--actor', ACTOR,
      '--reason', REASON,
      '--apply',
      '--json',
    ])
    expect(directoryResult.status).toBe(1)
    expectBackfillError(directoryResult.stderr, 'DB_PATH_NOT_FILE')

    buildLegacyFixture(REPLACED_DB, { withMixTarget: false })
    const expected = statSync(REPLACED_DB, { bigint: true })
    const renamed = join(testDirectory, 'replaced-target-renamed.sqlite')
    renameSync(REPLACED_DB, renamed)
    expect(() => assertFileIdentity(REPLACED_DB, expected)).toThrow(BackfillError)
    expect(() => assertFileIdentity(REPLACED_DB, expected)).toThrow(/DB_FILE_REPLACED/)
  })
})

describe('Issue #83 tool shape contract (module-level)', () => {
  it('planBackfill and findTargetRows expose the exact Issue shape', () => {
    buildLegacyFixture(DRY_DB)
    const conn = openRaw(DRY_DB)
    try {
      const targets = findTargetRows(conn)
      expect(targets).toEqual([
        {
          id: 'SO-LEGACY-A',
          sourceDiffId: 'DIFF-LEGACY-A',
          hospitalMonthId: 'HM-LEGACY-A',
        },
      ])
      const plan = planBackfill(conn)
      expect(plan.targets).toEqual(targets)
      expect(plan.shape).toBe('legacy-issue83')
      expect(plan.auditTableState).toBe('absent')
    } finally {
      conn.close()
    }
  })
})
