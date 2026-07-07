#!/usr/bin/env node
/**
 * 向后取证（只读）—— 对账单导入传错月「平行行」· 非-P0 审计项 B。
 *
 * 用途：期间键（②）只保未来；历史在「serviceMonth 只格式校验、不与台账绑定」的旧口径下，可能已把某月对账单
 * 按错月 commit → 静默新建一整套平行 case_revenue 行（同院同号跨月并存、双计风险、污染 P0 趋势线）。
 * 此脚本盘点 case_revenue.service_month 与该 case 在台账(lis_cases) operate_time 月不符的行，交人工逐条判：
 * 真跨月登记（某客户 2 月表含 3 月登记=正常）vs 误录（须删/改月）。
 *
 * ⚠️ 诚实天花板：只读、不改；仅覆盖能与 lis_cases 关联上的 case；生产须对真实库复跑。
 *
 * 运行：node 后端代码/server/scripts/forensic-import-parallel-rows.cjs [dbPath]
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'coreone.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
const section = (t) => console.log(`\n=== ${t} ===`)

section(`对账单导入平行行取证（只读） · DB=${dbPath}`)

let rows = []
try {
  rows = db.prepare(`
    SELECT cr.partner_id, cr.case_no, cr.service_month,
           substr(replace(lg.operate_time, '/', '-'), 1, 7) AS ledger_month,
           cr.lab_revenue, cr.net_amount
    FROM case_revenue cr
    JOIN lis_cases lg ON lg.partner_id = cr.partner_id AND lg.case_no = cr.case_no
    WHERE cr.revenue_source = 'statement'
      AND lg.operate_time IS NOT NULL AND lg.operate_time <> ''
      AND cr.service_month <> substr(replace(lg.operate_time, '/', '-'), 1, 7)
    ORDER BY cr.partner_id, cr.case_no
  `).all()
} catch (e) {
  console.log(`(查询失败：${e.message} —— 可能该库尚无 case_revenue/lis_cases 数据)`)
}

section('① 疑似传错月/平行行明细（service_month ≠ 台账 operate_time 月）')
console.log(`疑似行数：${rows.length}`)
rows.slice(0, 40).forEach((r) =>
  console.log(`  ${r.partner_id}｜case ${r.case_no}｜落库月 ${r.service_month} ≠ 台账月 ${r.ledger_month}｜lab¥${r.lab_revenue} net¥${r.net_amount}`))
if (rows.length > 40) console.log(`  …（其余 ${rows.length - 40} 条略）`)

section('② 按院·月汇总（哪些院月最可能整批传错）')
const byKey = new Map()
for (const r of rows) {
  const k = `${r.partner_id}｜${r.service_month}→${r.ledger_month}`
  byKey.set(k, (byKey.get(k) || 0) + 1)
}
;[...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, c]) => console.log(`  ${k}：${c} 行`))

section('结论与处置')
console.log('• 逐条人看：真跨月登记（某客户表含邻月登记=正常）vs 误录（须删/改月）。同院同号跨月并存 = 双计高危，优先查。')
console.log('• 期间键闸（本 PR）上线后：传错月 commit 会触发 NEEDS_CONFIRM，须 confirm 显式旁路（旁路应留操作人+理由，归项⑦）。')
console.log('• ⚠️ 只读取证：未改任何数据；仅覆盖能关联 lis_cases 的 case；生产须复跑。')

db.close()
