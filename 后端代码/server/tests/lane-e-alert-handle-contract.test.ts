/**
 * Lane E 预警做真 —— /handle 契约与落库回归
 *
 * 背景（修复前 bug）：
 *  - 前端调 POST /:id/process 与 /:id/ignore，后端只有 /:id/handle → 处理/忽略链路全 404。
 *  - handle 表单的 处理意见(opinion)/处理结果(result) 从未透传 → remark 永远为空。
 *  - handle 不写 handled_by → 谁处理的无留痕。
 *
 * 统一契约（本测试锁定）：
 *  - 唯一写入端点 = POST /:id/handle，body = { action, remark }。
 *  - action ∈ {'processed','ignored'}；非法值 400；缺省视为 'processed'。
 *  - 成功后 status=action、remark 落库、handled_by=当前用户名、handled_at 写入。
 *  - 已处理(status!=='pending')再操作 → 400；不存在 → 404。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let token: string

async function seedPendingAlert(id: string, type = 'low-stock') {
  db.prepare(
    "INSERT INTO alerts (id, type, level, material_id, material_name, current_stock, threshold, message, status) VALUES (?, ?, 'warning', 'MAT-X', '试剂X', 3, 10, '低库存', 'pending')"
  ).run(id, type)
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const alertRoutes = (await import('../src/routes/alerts-v1.1.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/alerts',
      router: alertRoutes,
      middleware: [
        authenticateToken,
        requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance'),
      ],
    },
  ])
  token = await loginAdmin(app)
})

describe('Lane E /handle 契约', () => {
  it('action=processed 带 remark → status=processed、remark 落库、handled_by 记名', async () => {
    const request = (await import('supertest')).default
    await seedPendingAlert('AL-P1')
    const res = await request(app)
      .post('/api/v1/alerts/AL-P1/handle')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'processed', remark: '已采购补货：已下单50瓶' })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get('AL-P1') as any
    expect(row.status).toBe('processed')
    expect(row.remark).toBe('已采购补货：已下单50瓶')
    expect(row.handled_by).toBe('admin')
    expect(row.handled_at).toBeTruthy()
  })

  it('action=ignored → status=ignored（忽略走同一端点）', async () => {
    const request = (await import('supertest')).default
    await seedPendingAlert('AL-I1')
    const res = await request(app)
      .post('/api/v1/alerts/AL-I1/handle')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'ignored', remark: '快速忽略' })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT status FROM alerts WHERE id = ?').get('AL-I1') as any
    expect(row.status).toBe('ignored')
  })

  it('非法 action → 400，且不改动状态', async () => {
    const request = (await import('supertest')).default
    await seedPendingAlert('AL-BAD')
    const res = await request(app)
      .post('/api/v1/alerts/AL-BAD/handle')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'deleted', remark: 'x' })
    expect(res.status).toBe(400)
    const row = db.prepare('SELECT status FROM alerts WHERE id = ?').get('AL-BAD') as any
    expect(row.status).toBe('pending')
  })

  it('缺省 action → 视为 processed', async () => {
    const request = (await import('supertest')).default
    await seedPendingAlert('AL-DEF')
    const res = await request(app)
      .post('/api/v1/alerts/AL-DEF/handle')
      .set('Authorization', `Bearer ${token}`)
      .send({ remark: '仅备注' })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT status FROM alerts WHERE id = ?').get('AL-DEF') as any
    expect(row.status).toBe('processed')
  })

  it('重复处理已处理预警 → 400', async () => {
    const request = (await import('supertest')).default
    await seedPendingAlert('AL-DUP')
    await request(app).post('/api/v1/alerts/AL-DUP/handle').set('Authorization', `Bearer ${token}`).send({ action: 'processed' })
    const res = await request(app)
      .post('/api/v1/alerts/AL-DUP/handle')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'processed' })
    expect(res.status).toBe(400)
  })

  it('不存在的预警 → 404', async () => {
    const request = (await import('supertest')).default
    const res = await request(app)
      .post('/api/v1/alerts/NOPE/handle')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'processed' })
    expect(res.status).toBe(404)
  })
})
