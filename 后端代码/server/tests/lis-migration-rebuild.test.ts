/**
 * PRD-0 T1.1 — lis_cases 旧库整表重建迁移直测（最高风险路径：数据保留 + 去列级 UNIQUE）。
 *
 * 真实 coreone.db 是 pre-ABC 旧快照：lis_cases 含 `case_no TEXT NOT NULL UNIQUE`。本测试在隔离库里
 * 复刻旧式表 + 数据，再触发 initializeDatabase 的重建迁移，断言：UNIQUE 去除、数据/默认值无损保留、
 * 增列补齐、复合唯一索引生效（跨院同号可并存、同院同号被拒）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'

let db: any, mod: any

beforeAll(async () => {
  db = await getDb()
  mod = await import('../src/database/DatabaseManager.js')
})

describe('T1.1 旧库整表重建迁移', () => {
  it('旧式 lis_cases(case_no UNIQUE)+数据 → 重建后去 UNIQUE、保数据、复合键生效', () => {
    // 复刻 pre-ABC 旧表（带列级 UNIQUE），灌入 2 行（含非默认 status）
    db.exec('DROP TABLE IF EXISTS lis_cases')
    db.exec(`CREATE TABLE lis_cases (
      id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL UNIQUE,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'normal',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    db.prepare(`INSERT INTO lis_cases (id, case_no, status) VALUES ('OLD1','OLD-CASE-1','signed')`).run()
    db.prepare(`INSERT INTO lis_cases (id, case_no) VALUES ('OLD2','OLD-CASE-2')`).run()

    // 触发迁移：ensureColumn 补 partner_id/数量列 → 重建去 UNIQUE → 复合唯一索引
    mod.initializeDatabase()

    // 1) 旧列级 UNIQUE 已去除
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lis_cases'").get() as any).sql
    expect(sql).not.toMatch(/case_no\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)

    // 2) 数据 + 默认值无损保留
    const rows = db.prepare(`SELECT id, case_no, status FROM lis_cases WHERE id IN ('OLD1','OLD2') ORDER BY id`).all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 'OLD1', case_no: 'OLD-CASE-1', status: 'signed' })
    expect(rows[1].status).toBe('normal') // 默认值列保留

    // 3) 增列补齐（重建动态保留全部 ensureColumn 列）
    const cols = (db.prepare(`PRAGMA table_info(lis_cases)`).all() as any[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['partner_id', 'he_slide_count', 'specimen_type']))

    // 4) 复合唯一索引生效：跨院同号可并存（OLD-CASE-1 已存在 partner_id=NULL，加 P-A 不冲突）
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id) VALUES ('NEW-A','OLD-CASE-1','P-A')`).run()
    expect((db.prepare(`SELECT COUNT(*) t FROM lis_cases WHERE case_no='OLD-CASE-1'`).get() as any).t).toBe(2)
    // 同院同号被拒
    expect(() => db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id) VALUES ('NEW-A2','OLD-CASE-1','P-A')`).run()).toThrow()
  })

  it('迁移幂等：再次 initializeDatabase 不重建、不报错、表定义不变', () => {
    const before = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lis_cases'").get() as any).sql
    expect(() => mod.initializeDatabase()).not.toThrow()
    const after = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lis_cases'").get() as any).sql
    expect(after).toBe(before)
  })
})
