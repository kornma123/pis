/**
 * P1-12 库位写权限 + P1-06 库位利用率派生（同文件 locations-v1.1.ts，一起改）
 *
 * P1-12 Bug: requireLocationWrite = requireRole('admin')，但读权限 + app.ts:81 给
 *   admin+warehouse_manager → wm 能进库位模块却建不了库位（403）。
 *   修复：写守卫放开给 requireRole('admin','warehouse_manager')。
 *   红测试：wm token POST 库位 → 201（修复前 403）。
 *
 * P1-06 Bug: GET 返回 r.used，但全库无任何写 used 的逻辑 → used 恒为装饰性的 0。
 *   master 数据模型实情：库位级库存由 inventory.location_id 关联（无 inventory_locations 表）。
 *   修复：used 改由 SELECT COALESCE(SUM(stock),0) FROM inventory WHERE location_id=? 派生。
 *   红测试：建库位 + 该库位下有库存 → GET used>0（修复前恒 0）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let adminToken: string
let wmToken: string

async function loginAs(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const locationRoutes = (await import('../src/routes/locations-v1.1.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      // 镜像 app.ts:81 的读权限矩阵（admin + warehouse_manager）
      path: '/api/v1/locations',
      router: locationRoutes,
      middleware: [authenticateToken, requireRole('admin', 'warehouse_manager')],
    },
  ])

  // 仓管用户
  const pw = bcrypt.hashSync('pw123456', 10)
  db.prepare(`INSERT INTO users (id, username, password, real_name, role, status, is_deleted)
    VALUES ('U-WM-LOC', 'wmloc', ?, '仓管', 'warehouse_manager', 1, 0)`).run(pw)

  adminToken = await loginAdmin(app)
  wmToken = await loginAs('wmloc', 'pw123456')
})

describe('P1-12 库位写权限：仓管可建库位', () => {
  it('warehouse_manager POST 库位 → 201（修复前 403）', async () => {
    const request = (await import('supertest')).default
    const res = await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${wmToken}`)
      .send({ name: '仓管建的库位', zone: 'A区', type: 'shelf' })
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBeTruthy()
  })

  it('warehouse_manager PUT 库位 → 200（修复前 403）', async () => {
    const request = (await import('supertest')).default
    const created = await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${wmToken}`)
      .send({ name: '待改库位', zone: 'A区' })
    const id = created.body.data.id
    const res = await request(app)
      .put(`/api/v1/locations/${id}`)
      .set('Authorization', `Bearer ${wmToken}`)
      .send({ name: '改名后' })
    expect(res.status).toBe(200)
  })
})

describe('P1-06 库位利用率派生：used 来自该库位下库存合计', () => {
  it('建库位 + 入该库位库存 → GET used>0（修复前恒 0）', async () => {
    const request = (await import('supertest')).default
    // 建库位（admin）
    const created = await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '有库存库位', zone: 'B区', capacity: 100 })
    const locId = created.body.data.id

    // 该库位下放置库存（inventory.location_id 关联）
    db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, status, is_deleted)
      VALUES ('MAT-LOC06', 'C-LOC06', '库位试剂', '瓶', 'CAT', 1, 0)`).run()
    db.prepare(`INSERT INTO inventory (id, material_id, stock, location_id)
      VALUES ('INV-LOC06', 'MAT-LOC06', 37, ?)`).run(locId)

    const list = await request(app)
      .get('/api/v1/locations?pageSize=100')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(list.status).toBe(200)
    const loc = list.body.data.list.find((l: any) => l.id === locId)
    expect(loc).toBeTruthy()
    // 修复前 used 恒为 0；修复后应等于库位下库存合计 37
    expect(loc.used).toBe(37)
  })

  it('无库存库位 used = 0', async () => {
    const request = (await import('supertest')).default
    const created = await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '空库位', zone: 'C区' })
    const locId = created.body.data.id
    const list = await request(app)
      .get('/api/v1/locations?pageSize=100')
      .set('Authorization', `Bearer ${adminToken}`)
    const loc = list.body.data.list.find((l: any) => l.id === locId)
    expect(loc.used).toBe(0)
  })
})
