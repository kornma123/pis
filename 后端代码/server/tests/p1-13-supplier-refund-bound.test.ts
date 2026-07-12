/**
 * P1-13 供应商退款上界勾稽
 *
 * Bug: supplier-returns-v1.1.ts POST 把 refundAmount 原样落库，不与来源成本勾稽
 *   → 可填任意金额（甚至远超进价×数量）造成财务失真。
 *
 * 修复：refundAmount 必须 ≤ 来源成本上界 = 来源单价(inbound_price)×quantity，超界 422 拒绝。
 *   来源单价优先取关联入库单 price，其次该物料批次 inbound_price，最后 material.price。
 *
 * 红测试：
 *   - 超界退款（refundAmount 远大于 进价×数量）→ 422 拒绝（修复前 200 落库）
 *   - 合理退款（≤ 进价×数量）→ 200 通过
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

beforeAll(async () => {
  db = await getDb()
  const supplierReturnRoutes = (await import('../src/routes/supplier-returns-v1.1.js')).default

  // supplier-returns 路由本身无认证中间件（与 app.ts 一致挂在已认证后）。
  // P1-14 给写端点加了 requireWriteAccess（依赖 req.user.role），故此处注入一个写角色用户，
  // 模拟 authenticateToken 已设置 req.user（生产链路一致）。
  const injectWriteUser = (req: any, _res: any, next: any) => {
    req.user = { userId: 'TEST-ADMIN', username: 'admin', role: 'admin', roles: ['admin'] }
    next()
  }
  app = await buildTestApp([
    { path: '/api/v1/supplier-returns', router: supplierReturnRoutes, middleware: [injectWriteUser] },
  ])

  // 物料：进价（批次 inbound_price）= 10/瓶
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES ('MAT-SR13', 'C-SR13', '退货试剂', '瓶', 'CAT', 10, 1, 0)`).run()
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('INV-SR13', 'MAT-SR13', 100)`).run()
  db.prepare(`INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, status)
    VALUES ('B-SR13', 'MAT-SR13', 'BN-SR13', 50, 50, 'IN-SR13', 10, 1)`).run()
})

describe('P1-13 退款上界勾稽', () => {
  it('超界退款（refundAmount 远大于 进价×数量）→ 422 拒绝', async () => {
    const request = (await import('supertest')).default
    // 进价 10 × 数量 5 = 上界 50；填 9999 应被拒
    const res = await request(app).post('/api/v1/supplier-returns').send({
      materialId: 'MAT-SR13', quantity: 5, reason: '质量问题', refundAmount: 9999,
    })
    expect(res.status).toBe(422)
    expect(res.body.success).toBe(false)
  })

  it('合理退款（≤ 进价×数量）→ 200 通过', async () => {
    const request = (await import('supertest')).default
    // 进价 10 × 数量 5 = 上界 50；填 40 应通过
    const res = await request(app).post('/api/v1/supplier-returns').send({
      materialId: 'MAT-SR13', quantity: 5, reason: '质量问题', refundAmount: 40,
    })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBeTruthy()
  })

  it('恰好等于上界的退款 → 200 通过（边界）', async () => {
    const request = (await import('supertest')).default
    // 进价 10 × 数量 3 = 上界 30；填 30 应通过
    const res = await request(app).post('/api/v1/supplier-returns').send({
      materialId: 'MAT-SR13', quantity: 3, reason: '质量问题', refundAmount: 30,
    })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })
})
