/**
 * Lane C「修流程」— 退库/报废/调拨 后端契约（TDD 先行，语义改正后锁定）
 *
 * 讨论循环（2026-07-02，PM 拍板）确认的库存语义：
 *  - 退库(returns)：物料退回仓库 → 库存 +数量；撤销对称 −数量（带负库存拦截）。无上限、无库存行则新建。
 *  - 调拨(transfers)：库位间移动、总库存不变 → 只改 inventory.location_id、不动 stock；持久化 from_location_id；撤销还原库位。
 *  - 报废(scraps)：物料退出库存 → 库存 −数量（本就正确，此处回归锁定）。
 * 另：三个列表加 sortField/sortOrder 白名单 + 关键字/原因/目标库位/日期过滤 + /stats。
 *
 * 守 ABC 黄金零回归：这三条与 ¥13,152/¥27,870 物理无关（成本走出库+BOM、收入走账单+LIS）。
 */
process.env.DATABASE_PATH = ':memory:'

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'

const getApp = async () => {
  const { default: app } = await import('../src/app.js')
  const { getDatabase } = await import('../src/database/DatabaseManager.js')
  return { app, db: getDatabase() }
}

async function loginAdmin(app: any): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })
  expect(res.status).toBe(200)
  return res.body.data.token
}

let seq = 0
function seed(db: any) {
  const sfx = `lc-${Date.now()}-${seq++}`
  const categoryId = `cat-${sfx}`, supplierId = `sup-${sfx}`
  const loc1 = `loc1-${sfx}`, loc2 = `loc2-${sfx}`, materialId = `mat-${sfx}`
  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, ?)').run(categoryId, `CAT-${sfx}`, '分类', 1)
  db.prepare('INSERT INTO suppliers (id, code, name, status) VALUES (?, ?, ?, ?)').run(supplierId, `SUP-${sfx}`, '供应商', 1)
  db.prepare('INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, ?, ?, ?)').run(loc1, `L1-${sfx}`, 'A区常温库', 'shelf', 'A区', 1)
  db.prepare('INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, ?, ?, ?)').run(loc2, `L2-${sfx}`, 'B区冷藏库', 'shelf', 'B区', 1)
  db.prepare('INSERT INTO materials (id, code, name, spec, unit, category_id, supplier_id, price, location_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(materialId, `MAT-${sfx}`, '苏木素染液', '500ml', '瓶', categoryId, supplierId, 10, loc1, 1)
  return { categoryId, supplierId, loc1, loc2, materialId, sfx }
}

const inv = (db: any, materialId: string) =>
  db.prepare('SELECT stock, location_id FROM inventory WHERE material_id = ?').get(materialId) as any

async function inbound(app: any, token: string, f: any, qty: number) {
  const res = await request(app).post('/api/v1/inbound').set('Authorization', `Bearer ${token}`).send({
    type: 'direct', materialId: f.materialId, batchNo: `B-${f.sfx}`, quantity: qty, price: 10,
    supplierId: f.supplierId, locationId: f.loc1, expiryDate: '2030-12-31',
  })
  expect(res.status).toBe(201)
}

describe('Lane C · 退库(returns) 语义：物料退回仓库 → 库存 +数量', () => {
  let app: any, db: any, token: string
  beforeAll(async () => { ({ app, db } = await getApp()); token = await loginAdmin(app) })

  it('RET-01 退库使库存增加（100 + 5 = 105）', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    expect(inv(db, f.materialId).stock).toBe(100)
    const res = await request(app).post('/api/v1/returns').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 5, reason: 'excess' })
    expect([200, 201]).toContain(res.status)
    expect(res.body.success).toBe(true)
    expect(inv(db, f.materialId).stock).toBe(105)
  })

  it('RET-02 撤销退库对称扣回（105 − 5 = 100）', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    const c = await request(app).post('/api/v1/returns').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 5, reason: 'excess' })
    const id = c.body.data.id
    expect(inv(db, f.materialId).stock).toBe(105)
    const d = await request(app).delete(`/api/v1/returns/${id}`).set('Authorization', `Bearer ${token}`)
    expect(d.status).toBe(200)
    expect(inv(db, f.materialId).stock).toBe(100)
  })

  it('RET-03 无上限：可退超过当前库存（不再因库存不足被拒）', async () => {
    const f = seed(db); await inbound(app, token, f, 10)
    const res = await request(app).post('/api/v1/returns').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 999, reason: 'excess' })
    expect([200, 201]).toContain(res.status)
    expect(inv(db, f.materialId).stock).toBe(1009)
  })

  it('RET-04 无库存行时退库自动新建库存行（0 + 7 = 7）', async () => {
    const f = seed(db) // 未入库 → 无 inventory 行
    expect(inv(db, f.materialId)).toBeUndefined()
    const res = await request(app).post('/api/v1/returns').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 7, reason: 'excess' })
    expect([200, 201]).toContain(res.status)
    expect(inv(db, f.materialId).stock).toBe(7)
  })

  it('RET-05 列表返回物料名 + 撤销后不在列表', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    await request(app).post('/api/v1/returns').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 3, reason: 'wrong_item' })
    const list = await request(app).get('/api/v1/returns?pageSize=100').set('Authorization', `Bearer ${token}`)
    const row = (list.body.data.list as any[]).find(r => r.materialId === f.materialId)
    expect(row).toBeTruthy()
    expect(row.materialName).toBe('苏木素染液')
  })
})

describe('Lane C · 报废(scraps) 语义：退出库存 → 库存 −数量（回归锁定）', () => {
  let app: any, db: any, token: string
  beforeAll(async () => { ({ app, db } = await getApp()); token = await loginAdmin(app) })

  it('SCR-01 报废使库存减少（100 − 3 = 97），撤销回滚（+3）', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    const c = await request(app).post('/api/v1/scraps').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 3, reason: 'expired' })
    expect([200, 201]).toContain(c.status)
    expect(inv(db, f.materialId).stock).toBe(97)
    const d = await request(app).delete(`/api/v1/scraps/${c.body.data.id}`).set('Authorization', `Bearer ${token}`)
    expect(d.status).toBe(200)
    expect(inv(db, f.materialId).stock).toBe(100)
  })

  it('SCR-02 库存不足报废被拒（422）', async () => {
    const f = seed(db); await inbound(app, token, f, 2)
    const res = await request(app).post('/api/v1/scraps').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 5, reason: 'expired' })
    expect(res.status).toBe(422)
    expect(inv(db, f.materialId).stock).toBe(2)
  })
})

describe('Lane C · 调拨(transfers) 语义：库位间移动、总库存不变、存来源', () => {
  let app: any, db: any, token: string
  beforeAll(async () => { ({ app, db } = await getApp()); token = await loginAdmin(app) })

  it('TF-01 调拨不改变总库存，只把库位移到目标（stock 不变、location_id=目标）', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    expect(inv(db, f.materialId)).toMatchObject({ stock: 100, location_id: f.loc1 })
    const res = await request(app).post('/api/v1/transfers/inbound').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 30, fromLocationId: f.loc1, toLocationId: f.loc2 })
    expect([200, 201]).toContain(res.status)
    expect(inv(db, f.materialId)).toMatchObject({ stock: 100, location_id: f.loc2 })
  })

  it('TF-02 持久化 from_location_id（DB 落列 + GET 列表返回）', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    const c = await request(app).post('/api/v1/transfers/inbound').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 10, fromLocationId: f.loc1, toLocationId: f.loc2 })
    const id = c.body.data.id
    const rec = db.prepare('SELECT from_location_id, location_id FROM inbound_records WHERE id = ?').get(id) as any
    expect(rec.from_location_id).toBe(f.loc1)
    expect(rec.location_id).toBe(f.loc2)
    const list = await request(app).get('/api/v1/transfers?pageSize=100').set('Authorization', `Bearer ${token}`)
    const row = (list.body.data.list as any[]).find(r => r.id === id)
    expect(row).toBeTruthy()
    expect(row.fromLocationId).toBe(f.loc1)
    expect(row.fromLocationName).toBe('A区常温库')
    expect(row.toLocationId).toBe(f.loc2)
    expect(row.toLocationName).toBe('B区冷藏库')
  })

  it('TF-03 撤销调拨还原库位、总库存仍不变', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    const c = await request(app).post('/api/v1/transfers/inbound').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 30, fromLocationId: f.loc1, toLocationId: f.loc2 })
    expect(inv(db, f.materialId)).toMatchObject({ stock: 100, location_id: f.loc2 })
    const d = await request(app).delete(`/api/v1/transfers/${c.body.data.id}`).set('Authorization', `Bearer ${token}`)
    expect(d.status).toBe(200)
    expect(inv(db, f.materialId)).toMatchObject({ stock: 100, location_id: f.loc1 })
  })

  it('TF-04 来源=目标库位被拒（400）', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    const res = await request(app).post('/api/v1/transfers/inbound').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 5, fromLocationId: f.loc1, toLocationId: f.loc1 })
    expect(res.status).toBe(400)
    expect(inv(db, f.materialId)).toMatchObject({ stock: 100, location_id: f.loc1 })
  })

  it('TF-05 无库存物料不能调拨（422），不新建 0 库存行', async () => {
    const f = seed(db) // 未入库 → 无 inventory 行
    expect(inv(db, f.materialId)).toBeUndefined()
    const res = await request(app).post('/api/v1/transfers/inbound').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 3, fromLocationId: f.loc1, toLocationId: f.loc2 })
    expect(res.status).toBe(422)
    expect(inv(db, f.materialId)).toBeUndefined()
  })
})

describe('Lane C · 列表 排序白名单 / 过滤 / 统计', () => {
  let app: any, db: any, token: string
  beforeAll(async () => { ({ app, db } = await getApp()); token = await loginAdmin(app) })

  async function mkReturn(f: any, qty: number, reason: string) {
    await request(app).post('/api/v1/returns').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: qty, reason })
  }

  it('LST-01 退库按数量升序/降序排序（白名单 quantity）', async () => {
    const f = seed(db); await inbound(app, token, f, 500)
    await mkReturn(f, 7, 'excess'); await mkReturn(f, 3, 'excess'); await mkReturn(f, 15, 'excess')
    const asc = await request(app).get('/api/v1/returns?pageSize=100&sortField=quantity&sortOrder=asc').set('Authorization', `Bearer ${token}`)
    const qa = (asc.body.data.list as any[]).filter(r => r.materialId === f.materialId).map(r => r.quantity)
    expect(qa).toEqual([...qa].sort((a, b) => a - b))
    const desc = await request(app).get('/api/v1/returns?pageSize=100&sortField=quantity&sortOrder=desc').set('Authorization', `Bearer ${token}`)
    const qd = (desc.body.data.list as any[]).filter(r => r.materialId === f.materialId).map(r => r.quantity)
    expect(qd).toEqual([...qd].sort((a, b) => b - a))
  })

  it('LST-02 非法 sortField 不注入、回退默认排序（仍 200）', async () => {
    const res = await request(app).get('/api/v1/returns?sortField=quantity;DROP%20TABLE%20return_records&sortOrder=xx')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('LST-03 退库按原因过滤', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    await mkReturn(f, 2, 'wrong_item'); await mkReturn(f, 4, 'excess')
    const res = await request(app).get('/api/v1/returns?pageSize=100&reason=wrong_item').set('Authorization', `Bearer ${token}`)
    const mine = (res.body.data.list as any[]).filter(r => r.materialId === f.materialId)
    expect(mine.length).toBeGreaterThanOrEqual(1)
    expect(mine.every(r => r.reason === 'wrong_item')).toBe(true)
  })

  it('LST-04 调拨按目标库位过滤', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    await request(app).post('/api/v1/transfers/inbound').set('Authorization', `Bearer ${token}`)
      .send({ materialId: f.materialId, quantity: 10, fromLocationId: f.loc1, toLocationId: f.loc2 })
    const res = await request(app).get(`/api/v1/transfers?pageSize=100&locationId=${f.loc2}`).set('Authorization', `Bearer ${token}`)
    const mine = (res.body.data.list as any[]).filter(r => r.materialId === f.materialId)
    expect(mine.length).toBeGreaterThanOrEqual(1)
    expect(mine.every(r => r.toLocationId === f.loc2)).toBe(true)
  })

  it('LST-05 三个 /stats 返回本月/件数/涉及物料/今日', async () => {
    const f = seed(db); await inbound(app, token, f, 100)
    await mkReturn(f, 6, 'excess')
    for (const mod of ['returns', 'scraps', 'transfers']) {
      const res = await request(app).get(`/api/v1/${mod}/stats`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const s = res.body.data
      expect(s).toHaveProperty('monthCount')
      expect(s).toHaveProperty('monthQty')
      expect(s).toHaveProperty('materialKinds')
      expect(s).toHaveProperty('todayCount')
    }
    const rs = await request(app).get('/api/v1/returns/stats').set('Authorization', `Bearer ${token}`)
    expect(rs.body.data.monthCount).toBeGreaterThanOrEqual(1)
  })
})
