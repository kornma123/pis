import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Test } from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let token = ''
let sequence = 0

type InboundFixture = {
  categoryId: string
  supplierId: string
  locationId: string
  materialId: string
  purchaseOrderId: string
  suffix: string
}

function nextSuffix(label: string): string {
  sequence += 1
  return `${label}-${Date.now()}-${sequence}`
}

function seedInboundFixture(label: string): InboundFixture {
  const suffix = nextSuffix(label)
  const categoryId = `cat-${suffix}`
  const supplierId = `sup-${suffix}`
  const locationId = `loc-${suffix}`
  const materialId = `mat-${suffix}`
  const purchaseOrderId = `po-${suffix}`

  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, 1)')
    .run(categoryId, `CAT-${suffix}`, '数值护栏分类')
  db.prepare('INSERT INTO suppliers (id, code, name, status) VALUES (?, ?, ?, 1)')
    .run(supplierId, `SUP-${suffix}`, '数值护栏供应商')
  db.prepare("INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, 'shelf', 'A', 1)")
    .run(locationId, `LOC-${suffix}`, '数值护栏库位')
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, supplier_id, price, location_id, status)
    VALUES (?, ?, ?, '瓶', ?, ?, 10, ?, 1)
  `).run(materialId, `MAT-${suffix}`, '数值护栏物料', categoryId, supplierId, locationId)
  db.prepare(`
    INSERT INTO purchase_orders
      (id, order_no, material_id, material_name, supplier_id, ordered_qty, received_qty, unit, unit_price, total_amount, status)
    VALUES (?, ?, ?, '数值护栏物料', ?, 100, 0, '瓶', 10, 1000, 'pending')
  `).run(purchaseOrderId, `PO-${suffix}`, materialId, supplierId)

  return { categoryId, supplierId, locationId, materialId, purchaseOrderId, suffix }
}

function inboundSnapshot(fixture: InboundFixture) {
  return {
    inboundRecords: db.prepare(`
      SELECT id, quantity, batch_no, status, purchase_order_id
      FROM inbound_records WHERE material_id = ? ORDER BY id
    `).all(fixture.materialId),
    batches: db.prepare(`
      SELECT id, quantity, remaining, batch_no, status
      FROM batches WHERE material_id = ? ORDER BY id
    `).all(fixture.materialId),
    inventory: db.prepare(`
      SELECT id, stock, locked_stock, location_id, last_inbound_id
      FROM inventory WHERE material_id = ? ORDER BY id
    `).all(fixture.materialId),
    purchaseOrder: db.prepare(`
      SELECT received_qty, status FROM purchase_orders WHERE id = ?
    `).get(fixture.purchaseOrderId),
    stockLogs: db.prepare(`
      SELECT id, type, quantity, before_stock, after_stock, related_id, related_type
      FROM stock_logs WHERE material_id = ? ORDER BY id
    `).all(fixture.materialId),
  }
}

function materialSnapshot(materialId: string) {
  return {
    material: db.prepare(`
      SELECT id, code, name, price FROM materials WHERE id = ?
    `).get(materialId),
    inventory: db.prepare(`
      SELECT id, material_id, stock, locked_stock FROM inventory WHERE material_id = ? ORDER BY id
    `).all(materialId),
  }
}

function materialCodeSnapshot(code: string) {
  return db.prepare(`
    SELECT m.id, m.code, m.name, m.price, i.id AS inventory_id, i.stock, i.locked_stock
    FROM materials m
    LEFT JOIN inventory i ON i.material_id = m.id
    WHERE m.code = ?
    ORDER BY m.id, i.id
  `).all(code)
}

function auth(req: Test): Test {
  return req.set('Authorization', `Bearer ${token}`)
}

beforeAll(async () => {
  db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  app = await buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/inbound',
      router: (await import('../src/routes/inbound-v1.1.js')).default,
      middleware: [authenticateToken, requirePermission('inbound', 'R')],
    },
    {
      path: '/api/v1/materials',
      router: (await import('../src/routes/materials.js')).default,
      middleware: [authenticateToken, requirePermission('materials', 'R')],
    },
  ])
  token = await loginAdmin(app)
})

const invalidQuantities: unknown[] = [-5, 0, 'Infinity', 'abc', 'NaN']

describe('DATA-1 inbound quantity guard', () => {
  it.each(invalidQuantities)('POST rejects quantity=%s and leaves all related tables unchanged', async (quantity) => {
    const fixture = seedInboundFixture('post-invalid')
    const before = inboundSnapshot(fixture)

    const response = await auth(request(app).post('/api/v1/inbound')).send({
      type: 'purchase',
      materialId: fixture.materialId,
      batchNo: `B-${fixture.suffix}`,
      quantity,
      price: 10,
      supplierId: fixture.supplierId,
      locationId: fixture.locationId,
      purchaseOrderId: fixture.purchaseOrderId,
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_PARAMETER')
    expect(inboundSnapshot(fixture)).toEqual(before)
  })

  it.each(invalidQuantities)('PUT rejects quantity=%s and leaves all related tables unchanged', async (quantity) => {
    const fixture = seedInboundFixture('put-invalid')
    const created = await auth(request(app).post('/api/v1/inbound')).send({
      type: 'direct',
      materialId: fixture.materialId,
      batchNo: `B-${fixture.suffix}`,
      quantity: 5,
      price: 10,
      supplierId: fixture.supplierId,
      locationId: fixture.locationId,
    })
    expect(created.status).toBe(201)

    db.prepare(`
      UPDATE inbound_records SET purchase_order_id = ?, purchase_order_no = ? WHERE id = ?
    `).run(fixture.purchaseOrderId, `PO-${fixture.suffix}`, created.body.data.id)
    const before = inboundSnapshot(fixture)

    const response = await auth(request(app).put(`/api/v1/inbound/${created.body.data.id}`)).send({ quantity })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_PARAMETER')
    expect(inboundSnapshot(fixture)).toEqual(before)
  })

  it('accepts a positive quantity on create and update without breaking stock accounting', async () => {
    const fixture = seedInboundFixture('positive')
    const created = await auth(request(app).post('/api/v1/inbound')).send({
      type: 'direct',
      materialId: fixture.materialId,
      batchNo: `B-${fixture.suffix}`,
      quantity: 5,
      price: 10,
      supplierId: fixture.supplierId,
      locationId: fixture.locationId,
    })
    expect(created.status).toBe(201)
    expect(created.body.data.quantity).toBe(5)

    const updated = await auth(request(app).put(`/api/v1/inbound/${created.body.data.id}`)).send({ quantity: 8 })
    expect(updated.status).toBe(200)

    const snapshot = inboundSnapshot(fixture)
    expect(snapshot.inboundRecords).toHaveLength(1)
    expect(snapshot.inboundRecords[0]).toMatchObject({ quantity: 8, status: 'completed' })
    expect(snapshot.batches).toHaveLength(1)
    expect(snapshot.batches[0]).toMatchObject({ quantity: 8, remaining: 8, status: 1 })
    expect(snapshot.inventory).toHaveLength(1)
    expect(snapshot.inventory[0]).toMatchObject({ stock: 8 })
    expect(snapshot.stockLogs).toHaveLength(2)
    expect(snapshot.stockLogs.map((row: any) => row.quantity)).toEqual(expect.arrayContaining([5, 3]))
  })
})

const invalidPrices: unknown[] = [-1, 'Infinity', 'abc', 'NaN']

describe('DATA-1 material price guard', () => {
  it.each(invalidPrices)('POST rejects price=%s without creating material or inventory rows', async (price) => {
    const fixture = seedInboundFixture('material-post-invalid')
    const code = `NEW-${fixture.suffix}`
    const before = materialCodeSnapshot(code)

    const response = await auth(request(app).post('/api/v1/materials')).send({
      code,
      name: '非法价格物料',
      unit: '瓶',
      categoryId: fixture.categoryId,
      price,
    })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_PARAMETER')
    expect(materialCodeSnapshot(code)).toEqual(before)
  })

  it.each(invalidPrices)('PUT rejects price=%s without changing the material row', async (price) => {
    const fixture = seedInboundFixture('material-put-invalid')
    const before = materialSnapshot(fixture.materialId)

    const response = await auth(request(app).put(`/api/v1/materials/${fixture.materialId}`)).send({ price })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_PARAMETER')
    expect(materialSnapshot(fixture.materialId)).toEqual(before)
  })

  it('accepts zero on create and a positive finite price on update', async () => {
    const fixture = seedInboundFixture('material-positive')
    const code = `NEW-${fixture.suffix}`
    const created = await auth(request(app).post('/api/v1/materials')).send({
      code,
      name: '合法价格物料',
      unit: '瓶',
      categoryId: fixture.categoryId,
      price: 0,
    })
    expect(created.status).toBe(201)

    const updated = await auth(request(app).put(`/api/v1/materials/${created.body.data.id}`)).send({ price: 12.5 })
    expect(updated.status).toBe(200)
    expect(db.prepare('SELECT price FROM materials WHERE id = ?').get(created.body.data.id))
      .toEqual({ price: 12.5 })
  })
})
