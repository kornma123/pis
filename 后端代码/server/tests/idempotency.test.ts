process.env.DATABASE_PATH = ':memory:'

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'

// 延迟导入 app，确保 DATABASE_PATH 已设置
const getApp = async () => {
  const { default: app } = await import('../src/app.js')
  const { getDatabase } = await import('../src/database/DatabaseManager.js')
  return { app, db: getDatabase() }
}

async function loginAdmin(app: any): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: 'admin123' })
  expect(res.status).toBe(200)
  expect(res.body.success).toBe(true)
  return res.body.data.token
}

function seedBaseFixture(db: any, suffix: string) {
  const categoryId = `cat-idem-${suffix}`
  const supplierId = `sup-idem-${suffix}`
  const locationId = `loc-idem-${suffix}`
  const materialId = `mat-idem-${suffix}`

  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, ?)')
    .run(categoryId, `CAT-IDEM-${suffix}`, '幂等分类', 1)
  db.prepare('INSERT INTO suppliers (id, code, name, status) VALUES (?, ?, ?, ?)')
    .run(supplierId, `SUP-IDEM-${suffix}`, '幂等供应商', 1)
  db.prepare('INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(locationId, `LOC-IDEM-${suffix}`, '幂等库位', 'shelf', 'A区', 1)
  db.prepare(`
    INSERT INTO materials (id, code, name, spec, unit, category_id, supplier_id, price, location_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(materialId, `MAT-IDEM-${suffix}`, '幂等物料', '1ml', '瓶', categoryId, supplierId, 10, locationId, 1)

  return { categoryId, supplierId, locationId, materialId }
}

describe('入库/出库提交幂等键（防重复入账）', () => {
  let app: any
  let db: any
  let token: string

  beforeAll(async () => {
    ;({ app, db } = await getApp())
    token = await loginAdmin(app)
  })

  it('IDEM-INBOUND-DIRECT: 同一幂等键两次普通入库，库存/批次/金额只变一次', async () => {
    const suffix = `in-direct-${Date.now()}`
    const fixture = seedBaseFixture(db, suffix)
    const batchNo = `B-IDEM-${suffix}`
    const key = `idem-in-direct-${suffix}`
    const payload = {
      type: 'direct',
      materialId: fixture.materialId,
      batchNo,
      quantity: 10,
      price: 21,
      supplierId: fixture.supplierId,
      locationId: fixture.locationId,
      expiryDate: '2030-12-31',
    }

    const first = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)

    // 重复请求应返回首次结果（相同单号/ID），而非再写一条
    expect(second.status).toBe(201)
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(second.body.data.inboundNo).toBe(first.body.data.inboundNo)

    const inboundCount = (db.prepare('SELECT COUNT(*) as c FROM inbound_records WHERE material_id = ? AND batch_no = ?')
      .get(fixture.materialId, batchNo) as any).c
    const inventory = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(fixture.materialId) as any
    const batch = db.prepare('SELECT quantity, remaining FROM batches WHERE material_id = ? AND batch_no = ?')
      .get(fixture.materialId, batchNo) as any
    const amountSum = (db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM inbound_records WHERE material_id = ? AND batch_no = ?')
      .get(fixture.materialId, batchNo) as any).s

    expect(inboundCount).toBe(1)
    expect(inventory.stock).toBe(10)
    expect(batch).toMatchObject({ quantity: 10, remaining: 10 })
    expect(amountSum).toBe(210)
  })

  it('IDEM-OUTBOUND-PROJECT: 同一幂等键两次普通出库，库存只扣一次', async () => {
    const suffix = `out-proj-${Date.now()}`
    const fixture = seedBaseFixture(db, suffix)
    const batchNo = `B-IDEM-${suffix}`

    // 先入库形成库存
    const inbound = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'direct',
        materialId: fixture.materialId,
        batchNo,
        quantity: 50,
        price: 10,
        supplierId: fixture.supplierId,
        locationId: fixture.locationId,
        expiryDate: '2030-12-31',
      })
    expect(inbound.status).toBe(201)

    // 项目
    const projectRes = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `P-IDEM-${suffix}`, name: '幂等项目', type: 'ihc', status: 'active' })
    expect(projectRes.status).toBe(201)
    const projectId = projectRes.body.data.id

    const key = `idem-out-proj-${suffix}`
    const payload = {
      type: 'project',
      projectId,
      items: [{ materialId: fixture.materialId, quantity: 10, usage: 'self' }],
    }

    const first = await request(app)
      .post('/api/v1/outbound')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/api/v1/outbound')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)
    expect(second.status).toBe(201)
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(second.body.data.outboundNo).toBe(first.body.data.outboundNo)

    const outboundCount = (db.prepare('SELECT COUNT(*) as c FROM outbound_records WHERE id = ?')
      .get(first.body.data.id) as any).c
    const outboundRecordsForProject = (db.prepare('SELECT COUNT(*) as c FROM outbound_records WHERE project_id = ?')
      .get(projectId) as any).c
    const inventory = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(fixture.materialId) as any
    const batch = db.prepare('SELECT remaining FROM batches WHERE material_id = ? AND batch_no = ?')
      .get(fixture.materialId, batchNo) as any

    expect(outboundCount).toBe(1)
    expect(outboundRecordsForProject).toBe(1)
    expect(inventory.stock).toBe(40) // 50 - 10，只扣一次
    expect(batch.remaining).toBe(40)
  })

  it('IDEM-CONFLICT: 同一幂等键但请求体不同，应拒绝（409）且不二次写入', async () => {
    const suffix = `conflict-${Date.now()}`
    const fixture = seedBaseFixture(db, suffix)
    const key = `idem-conflict-${suffix}`

    const first = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({
        type: 'direct',
        materialId: fixture.materialId,
        batchNo: `B-IDEM-${suffix}`,
        quantity: 10,
        price: 10,
        supplierId: fixture.supplierId,
        locationId: fixture.locationId,
        expiryDate: '2030-12-31',
      })
    expect(first.status).toBe(201)

    const conflict = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({
        type: 'direct',
        materialId: fixture.materialId,
        batchNo: `B-IDEM-${suffix}`,
        quantity: 999, // 不同内容
        price: 10,
        supplierId: fixture.supplierId,
        locationId: fixture.locationId,
        expiryDate: '2030-12-31',
      })

    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')

    const inboundCount = (db.prepare('SELECT COUNT(*) as c FROM inbound_records WHERE material_id = ?')
      .get(fixture.materialId) as any).c
    const inventory = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(fixture.materialId) as any
    expect(inboundCount).toBe(1)
    expect(inventory.stock).toBe(10)
  })

  it('IDEM-NO-KEY: 不带幂等键时维持原行为（不去重，向后兼容）', async () => {
    const suffix = `nokey-${Date.now()}`
    const fixture = seedBaseFixture(db, suffix)
    const payload = {
      type: 'direct',
      materialId: fixture.materialId,
      batchNo: `B-IDEM-${suffix}`,
      quantity: 5,
      price: 10,
      supplierId: fixture.supplierId,
      locationId: fixture.locationId,
      expiryDate: '2030-12-31',
    }

    const first = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
    const second = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body.data.id).not.toBe(first.body.data.id)

    const inboundCount = (db.prepare('SELECT COUNT(*) as c FROM inbound_records WHERE material_id = ? AND batch_no = ?')
      .get(fixture.materialId, `B-IDEM-${suffix}`) as any).c
    expect(inboundCount).toBe(2)
  })
})
