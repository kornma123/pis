#!/usr/bin/env node
/**
 * 向后取证（只读）—— 账实核对补收单 floor-to-1 疑似伪造 · 非-P0 审计项 D。
 *
 * 用途：项D 的人闸+SoD 只保未来；历史在「认定即直发补收单、无第二审核人」的旧口径下，可能已因 floor-to-1
 * （账单聚合行数量藏项名 → billCount 系统性低估 → 误判『疑似漏收，需补收』）签发甚至收款了本不该有的追加收费单
 * ——这是**唯一可能已伤真人（客户/合作医院）**的项。此脚本一次性盘点疑似单，交人工逐单处置（已收款走 reopen/giveup 冲正）。
 *
 * ⚠️ 判据用 bill_count < lis_count（账单件数低于台账），**不能只抓 bill_count=1**——floor-to-1 是按行发生的：
 *    一张账单 3 条聚合行各按 1 计 → bill_count=3、台账 40，照样伪造少计，会被 =1 放过。宁可多抓交人工筛。
 *
 * ⚠️ 诚实天花板：只读、不改任何行；ratio 高=更可疑但非定论（真漏收也会 bill<lis）；生产须对真实库复跑。
 *
 * 运行：node 后端代码/server/scripts/forensic-supplement-floor.cjs [dbPath]
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'coreone.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
const section = (t) => console.log(`\n=== ${t} ===`)

section(`补收单 floor-to-1 疑似伪造取证（只读） · DB=${dbPath}`)

// 疑似单：源差异 bill_count < lis_count（账单少于台账），按 ratio 降序（越大越像聚合行被 floor 成 1）
let rows = []
try {
  rows = db.prepare(`
    SELECT so.id, so.partner_id, so.service_month, so.case_no, so.amount, so.status,
           so.collected_revenue, so.collected_month, so.review_status,
           d.bill_count, d.lis_count,
           (d.lis_count * 1.0 / NULLIF(d.bill_count, 0)) AS ratio
    FROM supplement_orders so
    JOIN reconcile_diffs d ON d.id = so.source_diff_id
    WHERE d.bill_count < d.lis_count
    ORDER BY ratio DESC, so.amount DESC
  `).all()
} catch (e) {
  console.log(`(查询失败：${e.message} —— 可能该库尚无 reconcile_diffs/supplement_orders 数据)`)
}

section('① 疑似单总览')
const collected = rows.filter((r) => r.status === '已补收')
const pending = rows.filter((r) => r.status === '待补收')
console.log(`疑似补收单总数（bill_count < lis_count）：${rows.length}`)
console.log(`  其中【已补收·可能已收真金→需人工冲正】：${collected.length}，折实收合计 ${collected.reduce((s, r) => s + (Number(r.collected_revenue) || 0), 0).toFixed(2)}`)
console.log(`  其中【待补收·人闸上线后须重新签发才可收】：${pending.length}`)
const legacyApprovedNull = rows.filter((r) => r.review_status !== 'approved')
console.log(`  其中【旧直发/未过人闸（review_status≠approved）】：${legacyApprovedNull.length}`)

section('② 已补收疑似单明细（最需人工优先冲正·按 ratio 降序）')
collected.slice(0, 30).forEach((r) =>
  console.log(`  ${r.partner_id}｜${r.service_month}｜case ${r.case_no}｜¥${r.amount}｜折实收¥${r.collected_revenue}｜bill=${r.bill_count} lis=${r.lis_count} ratio=${Number(r.ratio || 0).toFixed(2)}｜review=${r.review_status}`))
if (collected.length > 30) console.log(`  …（其余 ${collected.length - 30} 条略）`)

section('结论与处置')
console.log('• 已补收疑似单 = 唯一可能已伤真人：出「受影响客户/金额/是否已收款」清单交人工逐单处置，不自动批量冲；已收款走 reopen/giveup 冲正。')
console.log('• 待补收疑似单：人闸上线后天然须独立签发（approve）才可收款——签发人应核对台账真实片数再放行。')
console.log('• 根因（floor-to-1 解析器）修复见项D 后续「解析器识别聚合行」PR；本脚本只取证不修数，生产须复跑。')

db.close()
