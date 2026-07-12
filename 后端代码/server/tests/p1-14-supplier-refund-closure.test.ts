/**
 * P1-14 供应商退款财务闭环（有界版）
 *
 * 背景：master `supplier-returns-v1.1.ts:205+` 仅 PUT /:id/status 流转；
 *   refundAmount 创建后不可改；refunded 无财务过账；finance 角色无该模块权限。
 *
 * 本次有界目标：
 *   1. finance 角色【只读】访问供应商退货（可 GET，不可 POST/PUT/DELETE → 403）。
 *   2. 新增 PUT /:id/refund-amount：退款额可修正（受 P1-13 来源成本上界约束；
 *      已 refunded 状态锁定不可改）。修正写 operation_logs 审计留痕。
 *   3. refunded 应付贷项过账：master 无应付/财务台账表 → deferred（见 modelNote）。
 *
 * 红测试（修复前失败）：
 *   - finance GET 列表/详情 → 200（修复前 403：无权限）
 *   - finance POST/PUT status/PUT refund-amount/DELETE → 403（修复前 403 因无权限，
 *     但语义上需保证“finance 永远不能写”作为回归守卫）
 *   - admin PUT /:id/refund-amount 合理额 → 200 且 DB 落库新值（修复前 404：端点不存在）
 *   - admin PUT /:id/refund-amount 超界 → 422（复用 P1-13 上界）
 *   - admin PUT /:id/refund-amount 对 refunded 记录 → 409 锁定
 *   - refund-amount 修正写 operation_logs 一条审计
 */
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any

const ALLOWED = ['admin', 'warehouse_manager', 'procurement', 'finance']

function seedUser(id: string, username: string, role: string) {
  const pw = bcrypt.hashSync('pw123456', 10)
  db.prepare(`INSERT INTO users (id, username, password, real_name, role, status, is_deleted)
    VALUES (?, ?, ?, ?, ?, 1, 0)`).run(id, username, pw, username, role)
}

async function loginAs(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}

/** 直接建一条退货记录（绕过 POST，避免依赖写权限），返回 id */
function seedReturn(id: string, status: string, refund: number): string {
  db.prepare(`INSERT INTO supplier_returns
    (id, return_no, material_id, quantity, reason, refund_amount, status, operator, is_deleted)
    VALUES (?, ?, 'MAT-SR14', 5, '质量问题', ?, ?, 'system', 0)`)
    .run(id, 'SR-' + id, refund, status)
  return id
}

beforeAll(async () => {
  db = await getDb()

  const authRoutes = (await import('../src/routes/auth.js')).default
  const supplierReturnRoutes = (await import('../src/routes/supplier-returns-v1.1.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/supplier-returns',
      router: supplierReturnRoutes,
      middleware: [authenticateToken, requireRole(...ALLOWED)],
    },
  ])

  // 物料：进价（批次 inbound_price）= 10/瓶 → 数量5上界=50
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES ('MAT-SR14', 'C-SR14', '退货试剂14', '瓶', 'CAT', 10, 1, 0)`).run()
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('INV-SR14', 'MAT-SR14', 100)`).run()
  db.prepare(`INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, status)
    VALUES ('B-SR14', 'MAT-SR14', 'BN-SR14', 50, 50, 'IN-SR14', 10, 1)`).run()

  seedUser('U-SR14-FIN', 'sr14fin', 'finance')
  seedUser('U-SR14-WM', 'sr14wm', 'warehouse_manager')
})

describe('P1-14 finance 只读访问供应商退货', () => {
  it('finance GET 列表 → 200', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('sr14fin', 'pw123456')
    const res = await request(app).get('/api/v1/supplier-returns?page=1').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('finance GET 详情 → 200', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('sr14fin', 'pw123456')
    seedReturn('SR14-DETAIL', 'pending', 30)
    const res = await request(app).get('/api/v1/supplier-returns/SR14-DETAIL').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe('SR14-DETAIL')
  })

  it('finance POST 创建 → 403（只读，不可写）', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('sr14fin', 'pw123456')
    const res = await request(app).post('/api/v1/supplier-returns')
      .set('Authorization', `Bearer ${token}`)
      .send({ materialId: 'MAT-SR14', quantity: 1, reason: '质量问题' })
    expect(res.status).toBe(403)
  })

  it('finance PUT status → 403（只读）', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('sr14fin', 'pw123456')
    seedReturn('SR14-STAT', 'pending', 0)
    const res = await request(app).put('/api/v1/supplier-returns/SR14-STAT/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'shipped' })
    expect(res.status).toBe(403)
  })

  it('finance PUT refund-amount → 403（只读）', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('sr14fin', 'pw123456')
    seedReturn('SR14-FINREFUND', 'pending', 10)
    const res = await request(app).put('/api/v1/supplier-returns/SR14-FINREFUND/refund-amount')
      .set('Authorization', `Bearer ${token}`)
      .send({ refundAmount: 20 })
    expect(res.status).toBe(403)
  })

  it('finance DELETE → 403（只读）', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('sr14fin', 'pw123456')
    seedReturn('SR14-DEL', 'pending', 0)
    const res = await request(app).delete('/api/v1/supplier-returns/SR14-DEL')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})

describe('P1-14 退款额可修正（PUT /:id/refund-amount）', () => {
  it('admin 修正合理退款额 → 200 且 DB 落库新值', async () => {
    const request = (await import('supertest')).default
    const token = await loginAdmin(app)
    seedReturn('SR14-FIX', 'received', 10)
    // 上界 = 10 × 5 = 50；改成 40 合法
    const res = await request(app).put('/api/v1/supplier-returns/SR14-FIX/refund-amount')
      .set('Authorization', `Bearer ${token}`)
      .send({ refundAmount: 40 })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const row = db.prepare('SELECT refund_amount FROM supplier_returns WHERE id = ?').get('SR14-FIX') as any
    expect(Number(row.refund_amount)).toBe(40)
  })

  it('admin 修正退款额超界 → 422（复用 P1-13 上界）', async () => {
    const request = (await import('supertest')).default
    const token = await loginAdmin(app)
    seedReturn('SR14-OVER', 'received', 10)
    // 上界 50；填 9999 应被拒
    const res = await request(app).put('/api/v1/supplier-returns/SR14-OVER/refund-amount')
      .set('Authorization', `Bearer ${token}`)
      .send({ refundAmount: 9999 })
    expect(res.status).toBe(422)
    expect(res.body.success).toBe(false)
    // 未落库
    const row = db.prepare('SELECT refund_amount FROM supplier_returns WHERE id = ?').get('SR14-OVER') as any
    expect(Number(row.refund_amount)).toBe(10)
  })

  it('admin 修正已 refunded 记录 → 409 锁定不可改', async () => {
    const request = (await import('supertest')).default
    const token = await loginAdmin(app)
    seedReturn('SR14-LOCK', 'refunded', 30)
    const res = await request(app).put('/api/v1/supplier-returns/SR14-LOCK/refund-amount')
      .set('Authorization', `Bearer ${token}`)
      .send({ refundAmount: 40 })
    expect(res.status).toBe(409)
    expect(res.body.success).toBe(false)
    const row = db.prepare('SELECT refund_amount FROM supplier_returns WHERE id = ?').get('SR14-LOCK') as any
    expect(Number(row.refund_amount)).toBe(30)
  })

  it('退款额修正写一条 operation_logs 审计留痕', async () => {
    const request = (await import('supertest')).default
    const token = await loginAdmin(app)
    seedReturn('SR14-AUDIT', 'received', 10)
    const before = (db.prepare("SELECT COUNT(*) c FROM operation_logs WHERE operation = 'supplier_return_refund_amount'").get() as any).c
    const res = await request(app).put('/api/v1/supplier-returns/SR14-AUDIT/refund-amount')
      .set('Authorization', `Bearer ${token}`)
      .send({ refundAmount: 25 })
    expect(res.status).toBe(200)
    const after = (db.prepare("SELECT COUNT(*) c FROM operation_logs WHERE operation = 'supplier_return_refund_amount'").get() as any).c
    expect(after).toBe(before + 1)
  })

  it('不存在的记录 → 404', async () => {
    const request = (await import('supertest')).default
    const token = await loginAdmin(app)
    const res = await request(app).put('/api/v1/supplier-returns/NOPE/refund-amount')
      .set('Authorization', `Bearer ${token}`)
      .send({ refundAmount: 10 })
    expect(res.status).toBe(404)
  })

  it('refundAmount 非法（负数）→ 400', async () => {
    const request = (await import('supertest')).default
    const token = await loginAdmin(app)
    seedReturn('SR14-NEG', 'pending', 0)
    const res = await request(app).put('/api/v1/supplier-returns/SR14-NEG/refund-amount')
      .set('Authorization', `Bearer ${token}`)
      .send({ refundAmount: -5 })
    expect(res.status).toBe(400)
  })
})
