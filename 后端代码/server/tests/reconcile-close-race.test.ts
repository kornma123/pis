/**
 * 关账窗口竞态复现（两连接时序）—— runReconcile 定版保护。
 *
 * 病灶（#183 C1 / PR#187 对抗复核面板实证）：runReconcile 在**事务外**读 existing 行并判
 * PERIOD_CLOSED，之后才 BEGIN IMMEDIATE。多连接/多进程窗口内另一连接先关账
 * （account-reconcile-v1.1.ts /close 是自提交 UPDATE），compute 的 UPDATE（CASE 保持
 * status='已关账'）照跑：已关账行的 match_rate/diff_count 被覆写、reconcile_diffs 被清空重建、
 * 「待补收」单被删——定版被改写且无任何信号。
 *
 * 期望姿势（对齐 hospital-cm readiness probe run）：重活在事务外，BEGIN IMMEDIATE 拿到写锁后
 * **再复核一次**状态；窗口内已关账 → 抛 PERIOD_CLOSED、整体回滚，定版一字不动。
 *
 * 测试为什么这样写：node:sqlite 是同步 API，真线程并发无法稳定复现纳秒级窗口。这里的第二连接
 * （rival）是**真实的第二个 DatabaseSync 连接**（自提交写，与 /close 路由同一条 SQL）；只有
 * "何时执行" 用 BEGIN IMMEDIATE 钩子定格在预检之后、拿锁之前——固定的是调度，不是造假的写入。
 * 因此需要文件库（:memory: 无法开第二连接）：本文件在 db-isolation.setup.ts 之后、动态 import
 * DatabaseManager 之前覆写 DATABASE_PATH 指向临时文件（与 p0-harness 覆写 :memory: 同姿势）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'coreone-reconcile-race-'))
const DB_FILE = join(TMP_DIR, 'race.db')
process.env.DATABASE_PATH = DB_FILE
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-race'

const P1 = 'PT-RACE-1'
const P2 = 'PT-RACE-2'
const P3 = 'PT-RACE-3'
const MONTH = '2026-06'
const CLOSE_SQL = `UPDATE reconcile_hospital_months SET status = '已关账', closed_at = CURRENT_TIMESTAMP, closed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?` // 与 account-reconcile-v1.1.ts /close 同一条

let victim: any // 被测连接（DatabaseManager 单例，runReconcile 用它）
let rival: DatabaseSync // 第二个真实连接（模拟另一进程/请求的关账写）
let resetDatabase: () => void
let runReconcile: (db: any, partnerId: string, serviceMonth: string, operator: string | null) => any

/**
 * 包一层 db：首个 BEGIN IMMEDIATE 之前触发 onBeforeLock（= 预检之后、拿锁之前的竞态窗口）。
 * 同时记录事务控制语句计数（txn），供断言「判定与写入共处一个事务」的形状——防止未来把
 * 锁内复核拆成独立小事务（校验事务 COMMIT 后再开写事务 = 窗口原样回归）之类的错修法静默过绿。
 */
function raceWindow(db: any, onBeforeLock?: () => void) {
  let fired = false
  const txn = { begin: 0, commit: 0, rollback: 0 }
  const wrapped = {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') {
        if (!fired) {
          fired = true
          onBeforeLock?.()
        }
        txn.begin += 1
      } else if (sql === 'COMMIT') txn.commit += 1
      else if (sql === 'ROLLBACK') txn.rollback += 1
      return db.exec(sql)
    },
  }
  return { db: wrapped, txn, reachedLock: () => fired }
}

function seedPartnerMonth(db: any, partnerId: string, cases: Array<{ caseNo: string; bill: number; lis: number }>) {
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)`).run(partnerId, partnerId, `竞态测试院-${partnerId}`)
  const bill = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, '免疫组化染色', ?, 100, ?)`)
  const lis = db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, 0, '2026-06-10')`)
  for (const c of cases) {
    if (c.bill > 0) bill.run(`bill-${partnerId}-${c.caseNo}`, c.caseNo, partnerId, c.bill, MONTH)
    if (c.lis > 0) lis.run(`lis-${partnerId}-${c.caseNo}`, c.caseNo, partnerId, c.lis)
  }
}

const hmRow = (db: any, partnerId: string) =>
  db.prepare('SELECT * FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?').get(partnerId, MONTH) as any
const diffIds = (db: any, hmId: string) =>
  (db.prepare('SELECT id FROM reconcile_diffs WHERE hospital_month_id = ? ORDER BY id').all(hmId) as any[]).map((r) => r.id)

beforeAll(async () => {
  const dm = await import('../src/database/DatabaseManager.js')
  dm.initializeDatabase()
  victim = dm.getDatabase()
  resetDatabase = dm.resetDatabase
  runReconcile = (await import('../src/utils/reconcile-compute.js')).runReconcile
  rival = new DatabaseSync(DB_FILE)
})

afterAll(() => {
  try { rival?.close() } catch { /* already closed */ }
  try { resetDatabase?.() } catch { /* already closed */ }
  rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('runReconcile 关账窗口竞态（预检通过 → 另一连接关账 → 拿锁）', () => {
  let hmId = ''

  it('窗口内被另一连接关账 → 必须 PERIOD_CLOSED 拒绝，定版（行/差异/待补收单）一字不动', () => {
    // CA 账单=LIS（无差异）；CB 3 vs 5（1 条差异）→ 正常 compute 建行
    seedPartnerMonth(victim, P1, [
      { caseNo: 'CA', bill: 5, lis: 5 },
      { caseNo: 'CB', bill: 3, lis: 5 },
    ])
    const first = runReconcile(victim, P1, MONTH, 'op-setup')
    hmId = first.hospitalMonthId
    expect(first.diffCount).toBe(1)

    // 推进到「复核完成」（关账前置态，与 /complete 同字段），并挂一张待补收单
    victim.prepare(`UPDATE reconcile_hospital_months SET status = '复核完成', completed_at = CURRENT_TIMESTAMP, completed_by = 'op-setup', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(hmId)
    const diffId = diffIds(victim, hmId)[0]
    victim.prepare(`INSERT INTO supplement_orders (id, partner_id, service_month, source_diff_id, case_no, amount, case_count, operator) VALUES ('SUP-RACE-1', ?, ?, ?, 'CB', 200, 2, 'op-setup')`).run(P1, MONTH, diffId)

    // 改变输入（新增 CC 1 vs 4 差异）：若定版被覆写，diff_count/差异集必然变化 → 覆写可被无歧义检出
    seedPartnerMonth(victim, P1, [{ caseNo: 'CC', bill: 1, lis: 4 }])

    const before = hmRow(victim, P1)
    const beforeDiffIds = diffIds(victim, hmId)
    expect(beforeDiffIds).toHaveLength(1)

    // 竞态：预检（此刻 status='复核完成'，放行）→ rival 关账（真第二连接，自提交）→ BEGIN IMMEDIATE
    const raced = raceWindow(victim, () => {
      rival.prepare(CLOSE_SQL).run('rival-closer', hmId)
    })
    let err: any = null
    try {
      runReconcile(raced.db, P1, MONTH, 'op-racer')
    } catch (e) {
      err = e
    }
    expect(err, '窗口内已关账必须拒绝重算（而不是静默覆写定版）').not.toBeNull()
    expect(err?.code).toBe('PERIOD_CLOSED')
    // 事务形状：判定与写入必须同处一个事务——恰一次 BEGIN、拒绝走 ROLLBACK、绝无 COMMIT。
    expect(raced.txn).toEqual({ begin: 1, commit: 0, rollback: 1 })

    // 定版一字不动：计算字段=关账前快照，关账留痕=rival 写入，差异集与待补收单原样
    const after = hmRow(victim, P1)
    expect(after.status).toBe('已关账')
    expect(after.closed_by).toBe('rival-closer')
    expect(after.match_rate).toBe(before.match_rate)
    expect(after.diff_count).toBe(before.diff_count)
    expect(after.pending_count).toBe(before.pending_count)
    expect(after.unmatched_count).toBe(before.unmatched_count)
    expect(after.computed_at).toBe(before.computed_at)
    expect(diffIds(victim, hmId)).toEqual(beforeDiffIds)
    const sup = victim.prepare(`SELECT status FROM supplement_orders WHERE id = 'SUP-RACE-1'`).get() as any
    expect(sup?.status).toBe('待补收')
  })

  it('窗口内行被另一连接创建并关账（预检时行还不存在）→ 同样 PERIOD_CLOSED，而非 UNIQUE 冲突/覆写', () => {
    seedPartnerMonth(victim, P2, [{ caseNo: 'CX', bill: 2, lis: 3 }])
    // 预检读不到行 → 旧代码走 INSERT 路径；窗口内 rival 已建同院月「已关账」行
    const raced = raceWindow(victim, () => {
      rival
        .prepare(`INSERT INTO reconcile_hospital_months (id, partner_id, partner_name, service_month, status, match_rate, diff_count, closed_by) VALUES ('HM-RIVAL-2', ?, '竞态测试院-PT-RACE-2', ?, '已关账', 0.987, 7, 'rival-closer')`)
        .run(P2, MONTH)
    })
    let err: any = null
    try {
      runReconcile(raced.db, P2, MONTH, 'op-racer')
    } catch (e) {
      err = e
    }
    expect(err, '拿锁后必须以锁内读到的行为权威（含窗口内新建的已关账行）').not.toBeNull()
    expect(err?.code).toBe('PERIOD_CLOSED')

    const after = hmRow(victim, P2)
    expect(after.id).toBe('HM-RIVAL-2')
    expect(after.status).toBe('已关账')
    expect(after.match_rate).toBe(0.987)
    expect(after.diff_count).toBe(7)
    expect(diffIds(victim, 'HM-RIVAL-2')).toEqual([])
  })

  it('窗口内行被另一连接创建但「未关账」→ 必须收编该行走 UPDATE（锁内派生），而非 INSERT 撞 UNIQUE', () => {
    // 钉住修复的另一半：hmId 与 UPDATE/INSERT 分支必须由**锁内**复读派生。若退回事务外快照派生
    // （锁内只判关账），本例=两个连接并发首算：旧快照 undefined → INSERT → 撞 UNIQUE(partner_id,
    // service_month) 报 ERR_SQLITE_ERROR；若 hmId 用事务外幻影 uuid，diffs 会挂错行、行计数不被覆写。
    seedPartnerMonth(victim, P3, [
      { caseNo: 'CY', bill: 5, lis: 5 },
      { caseNo: 'CZ', bill: 2, lis: 6 },
    ])
    const raced = raceWindow(victim, () => {
      rival
        .prepare(`INSERT INTO reconcile_hospital_months (id, partner_id, partner_name, service_month, status, match_rate, diff_count) VALUES ('HM-RIVAL-3', ?, '竞态测试院-PT-RACE-3', ?, '待复核', 0.123, 99)`)
        .run(P3, MONTH)
    })
    const out = runReconcile(raced.db, P3, MONTH, 'op-adopt') // 必须成功，不许抛
    expect(out.hospitalMonthId).toBe('HM-RIVAL-3')
    expect(out.diffCount).toBe(1) // CZ 2 vs 6
    const rows = victim.prepare('SELECT * FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?').all(P3, MONTH) as any[]
    expect(rows).toHaveLength(1) // 收编而非另建行
    expect(rows[0].id).toBe('HM-RIVAL-3')
    expect(rows[0].diff_count).toBe(1) // rival 的 99 被本次重算真实覆写 → UPDATE 真的落在这一行上
    expect(rows[0].status).toBe('待复核')
    expect(diffIds(victim, 'HM-RIVAL-3')).toHaveLength(1) // diffs 挂在被收编的行下，不是幻影 hmId
    expect(raced.txn).toEqual({ begin: 1, commit: 1, rollback: 0 })
  })

  it('回归钉：无竞态时，已关账行被事务外预检拒绝——在进 BEGIN IMMEDIATE 之前', () => {
    // P1 在上面已被 rival 关账 → 普通调用（无窗口写入）也必须 PERIOD_CLOSED。
    // reachedLock 断言钉住「快速失败发生在拿锁前」：预检被删/写歪时这里会先进 BEGIN 再被锁内复核拒。
    const plain = raceWindow(victim)
    let err: any = null
    try {
      runReconcile(plain.db, P1, MONTH, 'op-again')
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('PERIOD_CLOSED')
    expect(plain.reachedLock(), '已关账必须被事务外预检拦下，不该走到 BEGIN IMMEDIATE').toBe(false)
    expect(plain.txn).toEqual({ begin: 0, commit: 0, rollback: 0 })
  })
})
