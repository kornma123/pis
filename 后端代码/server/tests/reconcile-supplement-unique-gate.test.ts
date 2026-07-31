/**
 * Issue #89 / LOC-005 follow-up: supplement_orders(reconcile_generation_id, source_diff_id)
 * DB 唯一索引硬闸 + 存量重复 legacy 行开机 fail-closed + 幂等升级/重启。
 *
 * 背景（Issue #89）：supplement_orders.source_diff_id 上无唯一约束，同代内同 source_diff
 * 可经纯 DML 签出多张补收单，形成同笔漏收的双计收款面（汇总/收款按 status 聚合双计）。
 * 冻结方向：唯一索引作为 DB 单一权威，只钉「同时存活」；verdict 的 scoped DELETE 后重签
 * 必须保留；不静默删除/合并重复行；不改补收金额/扣率/代次/终态语义；不改 UI。
 *
 * 本文件用真实 SQLite 文件库（两个连接可共享），RED 断言 = 第二张同 pair 补收单必须被
 * UNIQUE 拒绝（base 上会真实失败，证明缺口存在）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'coreone-supp-unique-gate-'))
const DB_FILE = join(TMP_DIR, 'gate.db')
const ORIGINAL_DATABASE_PATH = process.env.DATABASE_PATH
process.env.DATABASE_PATH = DB_FILE

const P = 'PT-SUP-UNIQ-1'
const M = '2026-06'
const S = 'SG-SUP-UNIQ-1'
const R = 'RG-SUP-UNIQ-1'
const HM = 'HM-SUP-UNIQ-1'
const DIFF = 'DIFF-SUP-UNIQ-1'

const INSERT_SUPPLEMENT_SQL = `
  INSERT INTO supplement_orders
    (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
     case_no, amount, case_count, status, operator, review_status, submitted_by)
  VALUES (?, ?, ?, ?, ?, ?, 300, 1, '待补收', 'op', 'pending_review', 'op')
`
const SCOPED_DELETE_SQL = `
  DELETE FROM supplement_orders
   WHERE source_diff_id = ? AND reconcile_generation_id = ? AND status = '待补收'
`

let dm: any
let db: any
let lifecycle: any
let closeDatabase: () => void
let initializeDatabase: () => void

function insertSupplement(
  conn: any,
  id: string,
  diffId: string = DIFF,
  generationId: string = R,
  caseNo = 'C1',
): void {
  conn.prepare(INSERT_SUPPLEMENT_SQL).run(id, P, M, diffId, generationId, caseNo)
}

function insertLegacyNullSupplement(conn: any, id: string): void {
  conn.prepare(`
    INSERT INTO supplement_orders
      (id, partner_id, service_month, case_no, amount, case_count, status, operator)
    VALUES (?, ?, ?, 'C-LEGACY', 300, 1, '待补收', 'op')
  `).run(id, P, M)
}

function countByDiff(diffId: string): number {
  return Number((db.prepare(`
    SELECT COUNT(*) AS n FROM supplement_orders
     WHERE source_diff_id = ? AND reconcile_generation_id = ?
  `).get(diffId, R) as { n: number }).n)
}

function seedReconcileFixture(conn: any): void {
  conn.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, '唯一闸测试院', 1)`)
    .run(P, P)
  conn.prepare(`
    INSERT OR IGNORE INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
    VALUES (?, ?, 'HASH-SUP-UNIQ-1', 'test', 'r1', 'c1', ?, ?, 1, 1, 1, 'posted')
  `).run('B-SUP-UNIQ-1', P, M, S)
  conn.prepare(`
    INSERT OR IGNORE INTO reconcile_hospital_months
      (id, partner_id, partner_name, service_month, status)
    VALUES (?, ?, '唯一闸测试院', ?, '待复核')
  `).run(HM, P, M)
  conn.prepare(`
    INSERT OR IGNORE INTO account_reconcile_generations
      (reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
       hospital_month_id, is_current, status, source_readiness_json, source_readiness_hash,
       statement_artifact_hash, snapshot_json, snapshot_hash)
    VALUES (?, ?, ?, ?, ?, 1, 'pending', '{}', 'h', 'h', '{}', 'h')
  `).run(R, P, M, S, HM)
  conn.prepare(`
    INSERT OR IGNORE INTO account_reconcile_hospital_month_bindings
      (hospital_month_id, reconcile_generation_id, binding_state)
    VALUES (?, ?, 'bound')
  `).run(HM, R)
  conn.prepare(`
    INSERT OR IGNORE INTO reconcile_diffs
      (id, hospital_month_id, partner_id, service_month, case_no, line_type,
       bill_count, lis_count, delta, amount_impact, system_hint, low_confidence,
       reconcile_generation_id)
    VALUES (?, ?, ?, ?, 'C1', 'IHC', 0, 0, 0, 300, '疑似漏收，需补收', 0, ?)
  `).run(DIFF, HM, P, M, R)
}

function seedSecondDiff(conn: any, diffId: string, caseNo: string): void {
  conn.prepare(`
    INSERT OR IGNORE INTO reconcile_diffs
      (id, hospital_month_id, partner_id, service_month, case_no, line_type,
       bill_count, lis_count, delta, amount_impact, system_hint, low_confidence,
       reconcile_generation_id)
    VALUES (?, ?, ?, ?, ?, 'IHC', 0, 0, 0, 200, '疑似漏收，需补收', 0, ?)
  `).run(diffId, HM, P, M, caseNo, R)
}

function uniqueIndexRow(conn: any): { name: string; unique: number } | undefined {
  return conn.prepare(`
    SELECT name, "unique" FROM pragma_index_list('supplement_orders')
     WHERE name = 'uq_supplement_orders_generation_diff'
  `).get() as { name: string; unique: number } | undefined
}

beforeAll(async () => {
  dm = await import('../src/database/DatabaseManager.js')
  lifecycle = await import('../src/services/account-reconciliation-lifecycle.js')
  closeDatabase = dm.closeDatabase
  initializeDatabase = dm.initializeDatabase
  initializeDatabase()
  db = dm.getDatabase()
  seedReconcileFixture(db)
}, 120_000)

afterAll(() => {
  try { closeDatabase() } catch { /* already closed */ }
  rmSync(TMP_DIR, { recursive: true, force: true })
  if (ORIGINAL_DATABASE_PATH === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH
}, 120_000)

describe('Issue #89 · 补收单同代同 diff DB 唯一硬闸', () => {
  it('fresh DB 升级幂等：唯一索引存在、列序正确、重复启动不报错', () => {
    const index = uniqueIndexRow(db)
    expect(index).toBeDefined()
    expect(index?.unique).toBe(1)
    const columns = (db.prepare(`
      SELECT name FROM pragma_index_info('uq_supplement_orders_generation_diff')
    `).all() as Array<{ name: string }>).map(row => row.name)
    expect(columns).toEqual(['reconcile_generation_id', 'source_diff_id'])

    // 真实重启（关闭连接 → 重新初始化同一文件库）幂等
    closeDatabase()
    initializeDatabase()
    db = dm.getDatabase()
    expect(uniqueIndexRow(db)?.unique).toBe(1)
  })

  it('同代同 source_diff 的第二张补收单被 UNIQUE 硬闸拒绝（RED 核心断言）', () => {
    insertSupplement(db, 'SUP-UNIQ-A')
    expect(() => insertSupplement(db, 'SUP-UNIQ-B'))
      .toThrow(/UNIQUE constraint failed: supplement_orders\.reconcile_generation_id, supplement_orders\.source_diff_id/)
    expect(countByDiff(DIFF)).toBe(1)
    expect((db.prepare('SELECT id FROM supplement_orders WHERE id = ?').get('SUP-UNIQ-A') as any)?.id)
      .toBe('SUP-UNIQ-A')
  })

  it('同代不同 source_diff 可各自签发（唯一性只钉 pair，不误伤同代多 diff）', () => {
    seedSecondDiff(db, 'DIFF-SUP-UNIQ-2', 'C2')
    insertSupplement(db, 'SUP-UNIQ-DIFF2', 'DIFF-SUP-UNIQ-2', R, 'C2')
    expect(countByDiff(DIFF)).toBe(1)
    expect(countByDiff('DIFF-SUP-UNIQ-2')).toBe(1)
  })

  it('合法 scoped DELETE 后重签可再插入（改判重签语义保留）', () => {
    // test 2 已留下一张唯一存活单（SUP-UNIQ-A）——改判流 = 先 scoped DELETE 旧单，再 INSERT 重签
    db.prepare(SCOPED_DELETE_SQL).run(DIFF, R)
    insertSupplement(db, 'SUP-UNIQ-RESIGN-1')
    expect(countByDiff(DIFF)).toBe(1)
    expect((db.prepare('SELECT id FROM supplement_orders WHERE source_diff_id = ?').get(DIFF) as any)?.id)
      .toBe('SUP-UNIQ-RESIGN-1')
  })

  it('NULL/legacy 行不受唯一索引影响（NULL-distinct，多行合法共存）', () => {
    insertLegacyNullSupplement(db, 'SUP-LEGACY-NULL-1')
    insertLegacyNullSupplement(db, 'SUP-LEGACY-NULL-2')
    const n = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM supplement_orders
       WHERE source_diff_id IS NULL AND reconcile_generation_id IS NULL
    `).get() as { n: number }).n)
    expect(n).toBeGreaterThanOrEqual(2)
  })

  it('应用 verdict 路径改判重签（漏收→免费→漏收）每步保持单张补收单', () => {
    const binding = { partnerId: P, settlementMonth: M, statementGenerationId: S, reconcileGenerationId: R }
    const first = lifecycle.setAccountReconciliationVerdict(
      db, binding, DIFF, '漏收，需补收', null, 'USER-001', 'op',
    )
    expect(first.duplicate).toBe(false)
    expect(countByDiff(DIFF)).toBe(1)

    lifecycle.setAccountReconciliationVerdict(
      db, binding, DIFF, '超期，免费做的', null, 'USER-001', 'op',
    )
    expect(countByDiff(DIFF)).toBe(0)

    const again = lifecycle.setAccountReconciliationVerdict(
      db, binding, DIFF, '漏收，需补收', null, 'USER-001', 'op',
    )
    expect(again.duplicate).toBe(false)
    expect(countByDiff(DIFF)).toBe(1)
  })

  it('开机发现存量重复 legacy 行 → 具名 fail-closed、零改动、重复启动同一错误', () => {
    // 模拟升级前库：唯一索引尚不存在（被摘除），同代同 diff 已存两张补收单
    // base 上唯一索引本来就不存在 → IF EXISTS 保持同一场景形状（重复行可被真实插入）
    db.exec('DROP INDEX IF EXISTS uq_supplement_orders_generation_diff')
    seedSecondDiff(db, 'DIFF-SUP-UNIQ-DUP', 'CD-1')
    insertSupplement(db, 'SUP-UNIQ-DUP-1', 'DIFF-SUP-UNIQ-DUP', R, 'CD-1')
    insertSupplement(db, 'SUP-UNIQ-DUP-2', 'DIFF-SUP-UNIQ-DUP', R, 'CD-1')

    closeDatabase()
    let firstError: unknown = null
    try {
      initializeDatabase()
    } catch (error) {
      firstError = error
    }
    expect(String((firstError as Error)?.message ?? firstError))
      .toContain('SUPPLEMENT_ORDERS_DUPLICATE_GENERATION_DIFF:SUP-UNIQ-DUP-1')
    expect(String((firstError as Error)?.message ?? firstError))
      .toContain(':RG-SUP-UNIQ-1:DIFF-SUP-UNIQ-DUP')

    // 零部分升级：两行原样保留、索引未建、外键检查为空（事务整体回滚）
    const probe = new DatabaseSync(DB_FILE)
    try {
      expect((probe.prepare('SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?')
        .get('DIFF-SUP-UNIQ-DUP') as { n: number }).n).toBe(2)
      expect(uniqueIndexRow(probe)).toBeUndefined()
      expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      probe.close()
    }

    // 重复启动：同一条具名错误，状态不变
    closeDatabase()
    let secondError: unknown = null
    try {
      initializeDatabase()
    } catch (error) {
      secondError = error
    }
    expect(String((secondError as Error)?.message ?? secondError))
      .toContain('SUPPLEMENT_ORDERS_DUPLICATE_GENERATION_DIFF:SUP-UNIQ-DUP-1')
    const probe2 = new DatabaseSync(DB_FILE)
    try {
      expect((probe2.prepare('SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?')
        .get('DIFF-SUP-UNIQ-DUP') as { n: number }).n).toBe(2)
      expect(uniqueIndexRow(probe2)).toBeUndefined()
    } finally {
      probe2.close()
    }
  })

  it('受治理人工删除重复行后重启：升级完成、索引恢复、单行保留（不自动合并）', () => {
    const probe = new DatabaseSync(DB_FILE)
    probe.prepare("DELETE FROM supplement_orders WHERE id = 'SUP-UNIQ-DUP-2'").run()
    probe.close()

    closeDatabase()
    initializeDatabase()
    db = dm.getDatabase()
    expect(uniqueIndexRow(db)?.unique).toBe(1)
    expect(countByDiff('DIFF-SUP-UNIQ-DUP')).toBe(1)
    expect((db.prepare('SELECT id FROM supplement_orders WHERE source_diff_id = ?')
      .get('DIFF-SUP-UNIQ-DUP') as any)?.id).toBe('SUP-UNIQ-DUP-1')
  })
})
