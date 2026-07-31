/**
 * Issue #89 / LOC-005 follow-up: clean predecessor（无 reconcile_generation_id 列的旧形状
 * supplement_orders）开机升级 → 重建表保留 legacy 行、装回 generation 绑定形状、
 * 幂等创建 (reconcile_generation_id, source_diff_id) 唯一索引；NULL legacy 行不受影响。
 *
 * 本文件在 DatabaseManager 动态 import 之前用真实 SQLite 预建旧形状表，验证「真 predecessor
 * 首启」路径（与 fresh DB 路径分开证明）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'coreone-supp-unique-pred-'))
const DB_FILE = join(TMP_DIR, 'predecessor.db')
const ORIGINAL_DATABASE_PATH = process.env.DATABASE_PATH
process.env.DATABASE_PATH = DB_FILE

// 旧形状：无 reconcile_generation_id 列、无 source_diff/generation 外键、无 pair CHECK。
// 其余列与重建 SELECT 需要的列保持一致（ensureColumn 幂等补列路径也覆盖更早的旧库）。
const raw = new DatabaseSync(DB_FILE)
raw.exec(`
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
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
raw.prepare(`
  INSERT INTO supplement_orders
    (id, partner_id, service_month, case_no, amount, case_count, status, operator)
  VALUES ('SUP-LEGACY-PRED-1', 'PT-PRED-1', '2026-05', 'C-LEGACY', 300, 1, '待补收', 'op')
`).run()
raw.close()

let dm: any
let db: any
let closeDatabase: () => void
let initializeDatabase: () => void

function uniqueIndexRow(conn: any): { name: string; unique: number } | undefined {
  return conn.prepare(`
    SELECT name, "unique" FROM pragma_index_list('supplement_orders')
     WHERE name = 'uq_supplement_orders_generation_diff'
  `).get() as { name: string; unique: number } | undefined
}

beforeAll(async () => {
  dm = await import('../src/database/DatabaseManager.js')
  closeDatabase = dm.closeDatabase
  initializeDatabase = dm.initializeDatabase
  initializeDatabase()
  db = dm.getDatabase()
}, 120_000)

afterAll(() => {
  try { closeDatabase() } catch { /* already closed */ }
  rmSync(TMP_DIR, { recursive: true, force: true })
  if (ORIGINAL_DATABASE_PATH === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH
}, 120_000)

describe('Issue #89 · clean predecessor 开机升级', () => {
  it('首启成功：legacy 行原样保留（source_diff/generation 为 NULL 的合法遗留形状）', () => {
    const row = db.prepare("SELECT * FROM supplement_orders WHERE id = 'SUP-LEGACY-PRED-1'").get() as any
    expect(row).toBeDefined()
    expect(row.partner_id).toBe('PT-PRED-1')
    expect(row.service_month).toBe('2026-05')
    expect(row.amount).toBe(300)
    expect(row.source_diff_id).toBeNull()
    expect(row.reconcile_generation_id).toBeNull()
  })

  it('重建后为新形状：generation 列、双外键、pair CHECK 齐备', () => {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(supplement_orders)').all() as Array<{ name: string }>)
        .map(column => column.name),
    )
    expect(columns.has('reconcile_generation_id')).toBe(true)
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(supplement_orders)').all() as Array<{
      from: string
      table: string
    }>
    expect(foreignKeys.some(fk => fk.from === 'source_diff_id' && fk.table === 'reconcile_diffs')).toBe(true)
    expect(foreignKeys.some(fk => fk.from === 'reconcile_generation_id' && fk.table === 'account_reconcile_generations'))
      .toBe(true)
    const tableSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'supplement_orders'",
    ).get() as { sql: string }).sql
    expect(/chk_supplement_generation_pair/i.test(tableSql)).toBe(true)
  })

  it('唯一索引已幂等创建且列序正确', () => {
    const index = uniqueIndexRow(db)
    expect(index).toBeDefined()
    expect(index?.unique).toBe(1)
    const columns = (db.prepare(`
      SELECT name FROM pragma_index_info('uq_supplement_orders_generation_diff')
    `).all() as Array<{ name: string }>).map(row => row.name)
    expect(columns).toEqual(['reconcile_generation_id', 'source_diff_id'])
  })

  it('重复启动幂等：关连接重开不报错、索引仍在', () => {
    closeDatabase()
    initializeDatabase()
    db = dm.getDatabase()
    expect(uniqueIndexRow(db)?.unique).toBe(1)
  })

  it('升级后 NULL legacy 行仍可多行共存（NULL-distinct 语义保留）', () => {
    db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, case_no, amount, case_count, status, operator)
      VALUES ('SUP-LEGACY-PRED-2', 'PT-PRED-1', '2026-05', 'C-LEGACY', 300, 1, '待补收', 'op')
    `).run()
    const n = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM supplement_orders
       WHERE partner_id = 'PT-PRED-1' AND source_diff_id IS NULL AND reconcile_generation_id IS NULL
    `).get() as { n: number }).n)
    expect(n).toBe(2)
  })

  it('pair 语义保留：source-only（无 generation）裸 INSERT 仍被拒', () => {
    expect(() => db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id)
      VALUES ('SUP-PRED-BAD-PAIR', 'PT-PRED-1', '2026-05', 'DIFF-X', NULL)
    `).run()).toThrow()
  })
})
