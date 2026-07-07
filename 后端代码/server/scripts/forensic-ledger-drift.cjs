#!/usr/bin/env node
/**
 * 向后取证（只读）—— 库存双账本漂移 · 非-P0 审计项 A。
 *
 * 用途：补守卫（resolveOutboundUnitCost）只保未来；历史已以 unit_cost=0 出库的记录已把过去月份成本算低，
 * 而 P0 体检第一天就读这些月的趋势。此脚本一次性盘点两类历史证据，交人工逐单处置（成本重述 / 趋势打「成本失真」标）：
 *   ① 当前正向存量漂移（stock > Σ status=1 batches.remaining）= 未来出库会缺批次、走兜底/0 的物料。
 *   ② 历史 unit_cost=0 出库明细按月分布 = 已污染的成本趋势窗（P0 体检会在其上画趋势）。
 *
 * ⚠️ 诚实天花板：这是**取证不是修数**（只读、不改任何行）。生产环境须对**真实库**复跑本脚本再决策。
 *
 * 运行：node 后端代码/server/scripts/forensic-ledger-drift.cjs [dbPath]
 *   dbPath 默认 后端代码/server/data/coreone.db
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'coreone.db')
const db = new DatabaseSync(dbPath, { readOnly: true })

function section(title) { console.log(`\n=== ${title} ===`) }

section(`库存双账本漂移取证（只读） · DB=${dbPath}`)

// ① 当前正向存量漂移：stock 大于启用批次剩余量之和 → 出库缺批次风险方向
section('① 当前正向存量漂移（stock > Σ status=1 batches.remaining）—— 出库会缺批次的物料')
const drift = db.prepare(`
  SELECT i.material_id, m.code, m.name, i.stock,
         COALESCE(SUM(CASE WHEN b.status = 1 THEN b.remaining ELSE 0 END), 0) AS batch_remaining,
         i.stock - COALESCE(SUM(CASE WHEN b.status = 1 THEN b.remaining ELSE 0 END), 0) AS drift
  FROM inventory i
  JOIN materials m ON m.id = i.material_id AND m.is_deleted = 0
  LEFT JOIN batches b ON b.material_id = i.material_id
  GROUP BY i.material_id, m.code, m.name, i.stock
  HAVING drift > 0.0001
  ORDER BY drift DESC
`).all()
console.log(`正向漂移物料数：${drift.length}`)
console.log(`净正向漂移量合计：${drift.reduce((s, r) => s + Number(r.drift || 0), 0).toFixed(4)}`)
drift.slice(0, 20).forEach((r) => console.log(`  ${r.code || r.material_id}｜${r.name || ''}｜stock=${r.stock}｜Σremaining=${r.batch_remaining}｜drift=+${Number(r.drift).toFixed(4)}`))
if (drift.length > 20) console.log(`  …（其余 ${drift.length - 20} 条略）`)

// ② 历史 unit_cost=0 出库明细按月分布（已污染的成本趋势窗）
section('② 历史 unit_cost=0 出库明细按月分布（已算低成本、污染 P0 趋势窗）')
const zeroByMonth = db.prepare(`
  SELECT substr(r.created_at, 1, 7) AS month, COUNT(*) AS zero_rows, SUM(oi.quantity) AS qty
  FROM outbound_items oi
  JOIN outbound_records r ON r.id = oi.outbound_id
  WHERE oi.unit_cost = 0 AND oi.quantity > 0
  GROUP BY month
  ORDER BY month
`).all()
const totalZero = zeroByMonth.reduce((s, r) => s + Number(r.zero_rows || 0), 0)
console.log(`unit_cost=0 出库明细总行数：${totalZero}`)
zeroByMonth.forEach((r) => console.log(`  ${r.month || '(无日期)'}：${r.zero_rows} 行，qty ${Number(r.qty || 0).toFixed(2)}`))

section('结论与处置')
console.log('• ① 命中物料 → 补守卫上线前先清漂移（补批次/补价），或 PM 归类「杂散库存」走均价口径。')
console.log('• ② 命中月份 → 二选一：成本重述，或在 P0 体检趋势线上打「成本失真」标（否则 A 门装了、体检仍在失真历史上画趋势）。')
console.log('• ⚠️ 只读取证：以上是「按当前库存/历史明细」的近似，未改任何数据；生产须对真实库复跑。')

db.close()
