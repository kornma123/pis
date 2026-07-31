/**
 * Issue #89 / LOC-005 follow-up: 并发双签真值证明。
 *
 * node:sqlite 是同步 API，单进程两连接无法真并发；本文件用**两个真实子进程**（各持独立
 * DatabaseSync 连接，同文件 SQLite + BEGIN IMMEDIATE 写锁 + busy_timeout）同时尝试对同一
 * (reconcile_generation_id, source_diff_id) 签发补收单：唯一索引保证最多一张成功，失败方
 * 稳定 UNIQUE 错误且事务零 partial（探针行证明）。另覆盖「并发 insert 与合法重签交错」：
 * 终态恒一单。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'coreone-supp-unique-conc-'))
const DB_FILE = join(TMP_DIR, 'concurrency.db')
const ORIGINAL_DATABASE_PATH = process.env.DATABASE_PATH
process.env.DATABASE_PATH = DB_FILE

const P = 'PT-SUP-CONC-1'
const M = '2026-06'
const S = 'SG-SUP-CONC-1'
const R = 'RG-SUP-CONC-1'
const HM = 'HM-SUP-CONC-1'
const WORKER_FILE = fileURLToPath(new URL('./fixtures/supplement-race-worker.cjs', import.meta.url))

let dm: any
let db: any
let closeDatabase: () => void

function spawnWorker(workerData: Record<string, unknown>): Promise<{
  ok: boolean
  workerId: string
  error?: string
}> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: { ok: boolean; workerId: string; error?: string }) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const child = fork(WORKER_FILE, [], {
      env: { ...process.env, SUP_RACE_WORKER_DATA: JSON.stringify(workerData) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, workerId: String(workerData.workerId), error: 'worker timeout' })
    }, 60_000)
    child.on('message', (message: { ok: boolean; workerId: string; error?: string }) => {
      clearTimeout(timer)
      finish(message)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, workerId: String(workerData.workerId), error: String(error) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ ok: false, workerId: String(workerData.workerId), error: `worker exit ${code}` })
      }
    })
  })
}

function seedDiff(diffId: string, caseNo: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO reconcile_diffs
      (id, hospital_month_id, partner_id, service_month, case_no, line_type,
       bill_count, lis_count, delta, amount_impact, system_hint, low_confidence,
       reconcile_generation_id)
    VALUES (?, ?, ?, ?, ?, 'IHC', 0, 0, 0, 300, '疑似漏收，需补收', 0, ?)
  `).run(diffId, HM, P, M, caseNo, R)
}

function countSupplements(diffId: string): number {
  return Number((db.prepare(`
    SELECT COUNT(*) AS n FROM supplement_orders
     WHERE source_diff_id = ? AND reconcile_generation_id = ?
  `).get(diffId, R) as { n: number }).n)
}

function countProbes(workerIds: string[]): number {
  const placeholders = workerIds.map(() => '?').join(', ')
  return Number((db.prepare(`
    SELECT COUNT(*) AS n FROM supplement_race_probe WHERE id IN (${placeholders})
  `).all(...workerIds)[0] as { n: number }).n)
}

beforeAll(async () => {
  dm = await import('../src/database/DatabaseManager.js')
  closeDatabase = dm.closeDatabase
  dm.initializeDatabase()
  db = dm.getDatabase()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, '并发测试院', 1)`)
    .run(P, P)
  db.prepare(`
    INSERT OR IGNORE INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
    VALUES (?, ?, 'HASH-SUP-CONC-1', 'test', 'r1', 'c1', ?, ?, 1, 1, 1, 'posted')
  `).run('B-SUP-CONC-1', P, M, S)
  db.prepare(`
    INSERT OR IGNORE INTO reconcile_hospital_months
      (id, partner_id, partner_name, service_month, status)
    VALUES (?, ?, '并发测试院', ?, '待复核')
  `).run(HM, P, M)
  db.prepare(`
    INSERT OR IGNORE INTO account_reconcile_generations
      (reconcile_generation_id, partner_id, settlement_month, statement_generation_id,
       hospital_month_id, is_current, status, source_readiness_json, source_readiness_hash,
       statement_artifact_hash, snapshot_json, snapshot_hash)
    VALUES (?, ?, ?, ?, ?, 1, 'pending', '{}', 'h', 'h', '{}', 'h')
  `).run(R, P, M, S, HM)
  db.prepare(`
    INSERT OR IGNORE INTO account_reconcile_hospital_month_bindings
      (hospital_month_id, reconcile_generation_id, binding_state)
    VALUES (?, ?, 'bound')
  `).run(HM, R)
  db.exec('CREATE TABLE IF NOT EXISTS supplement_race_probe (id TEXT PRIMARY KEY)')
}, 120_000)

afterAll(() => {
  try { closeDatabase() } catch { /* already closed */ }
  rmSync(TMP_DIR, { recursive: true, force: true })
  if (ORIGINAL_DATABASE_PATH === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH
}, 120_000)

describe('Issue #89 · 并发双签（真实双进程 + 双连接）', () => {
  it('两进程同时 INSERT 同代同 diff → 恰一成功，失败方稳定 UNIQUE，零 partial（3 轮）', async () => {
    for (let i = 0; i < 3; i += 1) {
      const diffId = `DIFF-CONC-${i}`
      const caseNo = `CC-${i}`
      seedDiff(diffId, caseNo)
      const base = {
        dbPath: DB_FILE,
        partnerId: P,
        month: M,
        diffId,
        generationId: R,
        caseNo,
        mode: 'insert',
      }
      const [a, b] = await Promise.all([
        spawnWorker({ ...base, rowId: `SUP-CONC-A-${i}`, workerId: `A-${i}` }),
        spawnWorker({ ...base, rowId: `SUP-CONC-B-${i}`, workerId: `B-${i}` }),
      ])
      const succeeded = [a, b].filter(result => result.ok)
      expect(succeeded, `round ${i}: 恰一张成功`).toHaveLength(1)
      const loser = succeeded[0] === a ? b : a
      expect(loser.error, `round ${i}: 失败方必须稳定 UNIQUE 约束错误`).toContain('UNIQUE constraint failed')
      expect(loser.error).toContain('supplement_orders.reconcile_generation_id')
      expect(loser.error).toContain('supplement_orders.source_diff_id')
      expect(countSupplements(diffId), `round ${i}: 终态一单`).toBe(1)
      expect(countProbes([`A-${i}`, `B-${i}`]), `round ${i}: 失败方零 partial`).toBe(1)
    }
  })

  it('并发直接 insert 与合法重签（scoped DELETE→INSERT）交错 → 终态恒一单（3 轮）', async () => {
    for (let i = 0; i < 3; i += 1) {
      const diffId = `DIFF-RESIGN-${i}`
      const caseNo = `CR-${i}`
      seedDiff(diffId, caseNo)
      const base = {
        dbPath: DB_FILE,
        partnerId: P,
        month: M,
        diffId,
        generationId: R,
        caseNo,
      }
      const [inserter, resigner] = await Promise.all([
        spawnWorker({ ...base, mode: 'insert', rowId: `SUP-INS-${i}`, workerId: `I-${i}` }),
        spawnWorker({ ...base, mode: 'resign', rowId: `SUP-RESIGN-${i}`, workerId: `R-${i}` }),
      ])
      expect(resigner.ok, `round ${i}: 合法重签必须成功`).toBe(true)
      // 终态恒一：要么直接 insert 先落库后被重签 DELETE 取代，要么 insert 撞 UNIQUE 失败。
      expect(countSupplements(diffId), `round ${i}: 绝不允许两张存活`).toBe(1)
      // 零 partial：重签必留探针；insert 提交与否各留 1 行，绝不可能 0。
      expect(countProbes([`I-${i}`, `R-${i}`])).toBeGreaterThanOrEqual(1)
      expect(countProbes([`I-${i}`, `R-${i}`])).toBeLessThanOrEqual(2)
      if (!inserter.ok) {
        expect(inserter.error).toContain('UNIQUE constraint failed')
      }
    }
  })

  it('第二真实连接已持单时，同 pair 插入被 UNIQUE 拒绝且既有行零改动', () => {
    seedDiff('DIFF-RIVAL-1', 'CRV-1')
    db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
         case_no, amount, case_count, status, operator, review_status, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, 300, 1, '待补收', 'op', 'pending_review', 'op')
    `).run('SUP-RIVAL-1', P, M, 'DIFF-RIVAL-1', R, 'CRV-1')

    const rival = new DatabaseSync(DB_FILE)
    rival.exec('PRAGMA busy_timeout = 5000')
    expect(() => rival.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
         case_no, amount, case_count, status, operator, review_status, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, 300, 1, '待补收', 'op', 'pending_review', 'op')
    `).run('SUP-RIVAL-2', P, M, 'DIFF-RIVAL-1', R, 'CRV-1'))
      .toThrow(/UNIQUE constraint failed/)
    rival.close()

    expect(countSupplements('DIFF-RIVAL-1')).toBe(1)
    expect((db.prepare("SELECT id FROM supplement_orders WHERE id = 'SUP-RIVAL-1'").get() as any)?.id)
      .toBe('SUP-RIVAL-1')
  })

  it('合法重签事务可取代第二连接已提交的既有单，终态一单', () => {
    seedDiff('DIFF-RIVAL-RESIGN-1', 'CRVR-1')
    const rival = new DatabaseSync(DB_FILE)
    rival.exec('PRAGMA busy_timeout = 5000')
    rival.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
         case_no, amount, case_count, status, operator, review_status, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, 300, 1, '待补收', 'op', 'pending_review', 'op')
    `).run('SUP-RIVAL-RESIGN-OLD', P, M, 'DIFF-RIVAL-RESIGN-1', R, 'CRVR-1')
    rival.close()

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`
      DELETE FROM supplement_orders
       WHERE source_diff_id = ? AND reconcile_generation_id = ? AND status = '待补收'
    `).run('DIFF-RIVAL-RESIGN-1', R)
    db.prepare(`
      INSERT INTO supplement_orders
        (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
         case_no, amount, case_count, status, operator, review_status, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, 300, 1, '待补收', 'op', 'pending_review', 'op')
    `).run('SUP-RIVAL-RESIGN-NEW', P, M, 'DIFF-RIVAL-RESIGN-1', R, 'CRVR-1')
    db.exec('COMMIT')

    expect(countSupplements('DIFF-RIVAL-RESIGN-1')).toBe(1)
    expect((db.prepare('SELECT id FROM supplement_orders WHERE source_diff_id = ?')
      .get('DIFF-RIVAL-RESIGN-1') as any)?.id).toBe('SUP-RIVAL-RESIGN-NEW')
  })
})
