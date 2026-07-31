'use strict'

// Issue #89 并发双签探针：真实独立进程 + 真实第二 DatabaseSync 连接。
// 数据经 SUP_RACE_WORKER_DATA 传入；mode=insert 直接 INSERT 同 (generation, diff) pair；
// mode=resign 执行 verdict 同款 scoped DELETE 后重签（同事务 DELETE→INSERT）。
// 每事务额外写一行 supplement_race_probe 探针，失败路径 ROLLBACK → 证明零 partial。
const { DatabaseSync } = require('node:sqlite')

const data = JSON.parse(process.env.SUP_RACE_WORKER_DATA || 'null')
if (!data) {
  process.exit(2)
}

function done(message) {
  try {
    process.send(message, () => process.exit(0))
  } catch {
    process.exit(0)
  }
}

let db
try {
  db = new DatabaseSync(data.dbPath)
  db.exec('PRAGMA busy_timeout = 20000')
  db.exec('BEGIN IMMEDIATE')
  if (data.mode === 'resign') {
    db.prepare(`
      DELETE FROM supplement_orders
       WHERE source_diff_id = ? AND reconcile_generation_id = ? AND status = '待补收'
    `).run(data.diffId, data.generationId)
  }
  db.prepare(`
    INSERT INTO supplement_orders
      (id, partner_id, service_month, source_diff_id, reconcile_generation_id,
       case_no, amount, case_count, status, operator, review_status, submitted_by)
    VALUES (?, ?, ?, ?, ?, ?, 300, 1, '待补收', 'worker', 'pending_review', 'worker')
  `).run(
    data.rowId,
    data.partnerId,
    data.month,
    data.diffId,
    data.generationId,
    data.caseNo,
  )
  db.prepare('INSERT INTO supplement_race_probe (id) VALUES (?)').run(data.workerId)
  db.exec('COMMIT')
  done({ ok: true, workerId: data.workerId })
} catch (error) {
  try {
    db?.exec('ROLLBACK')
  } catch {
    // 原始错误优先
  }
  done({
    ok: false,
    workerId: data.workerId,
    error: String((error && (error.message || error)) || error),
  })
} finally {
  try {
    db?.close()
  } catch {
    // already closed
  }
}
