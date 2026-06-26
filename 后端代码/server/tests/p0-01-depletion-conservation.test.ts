/**
 * P0-01 库存守恒（耗尽确认不得制造幽灵库存）
 *
 * 语义判断（见报告）：
 * - batch_usage_tracking 是“已领出在用”的领用台账（出库时已扣减 inventory + batches 并建档）。
 * - /tracking/:id/deplete 确认“在用瓶子用尽/结案”，属消耗台账闭环，**不是仓库库存操作**。
 *   仓库库存在出库时已结算，确认耗尽不应再回写已结算的仓库 batches/inventory。
 *
 * master Bug：deplete 用 remain_qty 绝对覆盖 batches.remaining（按 batch_no 模糊），
 *   且不联动 inventory、无事务 → 仓库守恒不变量 inventory.stock == SUM(batches.remaining) 被破坏，
 *   产生账实不符/幽灵库存。
 *
 * 红测试（修复前失败）：构造出库后的一致状态（不变量持平），调用 deplete，
 *   断言仓库守恒不变量不变、batches.remaining 不被污染。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let token: string

// 物料/批次/库存：模拟“出库后”一致状态
const MAT = 'MAT-DPL'
const BATCH_NO = 'B-DPL-001'

function sumBatchesRemaining(materialId: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(remaining),0) AS s FROM batches WHERE material_id = ?').get(materialId) as any
  return Number(r.s)
}
function invStock(materialId: string): number {
  const r = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
  return Number(r?.stock ?? 0)
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const depletionRoutes = (await import('../src/routes/depletion-v1.1.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/depletion',
      router: depletionRoutes,
      middleware: [authenticateToken, requireRole('admin', 'pathologist', 'finance')],
    },
  ])
  token = await loginAdmin(app)

  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, status, is_deleted)
    VALUES (?, 'C-DPL', '抗体DPL', 'ml', 'CAT', 1, 0)`).run(MAT)

  // 仓库一致状态：出库后仍有 1 个未开封批次 remaining=40，inventory.stock=40（不变量持平）
  db.prepare(`INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
    VALUES ('BAT-DPL', ?, ?, 100, 40, 'IN-DPL', 1)`).run(MAT, BATCH_NO)
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('INV-DPL', ?, 40)`).run(MAT)

  // 已领出在用的一瓶（出库 10ml 中尚余 6ml）。该瓶已不在仓库账内。
  db.prepare(`INSERT INTO batch_usage_tracking
    (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, status)
    VALUES ('TRK-DPL', ?, '抗体DPL', ?, '10ml', 10, 6, 'ml', '2026-06-01', 'in-use')`).run(MAT, BATCH_NO)
})

describe('P0-01 确认耗尽不破坏仓库守恒、不产生幽灵库存', () => {
  it('deplete 后 inventory.stock == SUM(batches.remaining)，且仓库 batches.remaining 不被污染', async () => {
    const request = (await import('supertest')).default

    const beforeInv = invStock(MAT)
    const beforeBatches = sumBatchesRemaining(MAT)
    expect(beforeInv).toBe(beforeBatches) // 前置不变量持平

    const res = await request(app)
      .post('/api/v1/depletion/tracking/TRK-DPL/deplete')
      .set('Authorization', `Bearer ${token}`)
      .send({ remain_qty: 6, deplete_type: 'normal', deplete_reason: '用尽', operator: 'admin' })
    expect(res.status).toBe(200)

    // 跟踪记录已置 depleted
    const trk = db.prepare("SELECT status FROM batch_usage_tracking WHERE id = 'TRK-DPL'").get() as any
    expect(trk.status).toBe('depleted')
    // 落了一条耗尽记录
    const dpl = db.prepare('SELECT COUNT(*) c FROM batch_depletion WHERE tracking_id = ?').get('TRK-DPL') as any
    expect(dpl.c).toBe(1)

    // 核心：仓库守恒不变量必须保持
    const afterInv = invStock(MAT)
    const afterBatches = sumBatchesRemaining(MAT)
    // 修复前：deplete 把 batches.remaining 绝对覆盖成 remain_qty(6)，inventory 不动(40)
    //   → afterInv(40) != afterBatches(6)，不变量被破坏（幽灵库存）。
    expect(afterInv).toBe(afterBatches)
    // 仓库批次余量不应被在用瓶子的剩余量污染
    expect(afterBatches).toBe(beforeBatches)
    expect(afterInv).toBe(beforeInv)
  })

  it('重复 deplete 应被拒绝（幂等保护）', async () => {
    const request = (await import('supertest')).default
    const res = await request(app)
      .post('/api/v1/depletion/tracking/TRK-DPL/deplete')
      .set('Authorization', `Bearer ${token}`)
      .send({ remain_qty: 6, operator: 'admin' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('ALREADY_DEPLETED')
  })
})
