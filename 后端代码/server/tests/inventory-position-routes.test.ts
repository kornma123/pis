process.env.DATABASE_PATH = ':memory:'
process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
  ? process.env.JWT_SECRET
  : 'pis-inventory-position-route-test-secret-20260805'

import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'

let app: any
let db: any
let token: string
let sequence = 0

function auth(call: any): any {
  return call.set('Authorization', `Bearer ${token}`)
}

function seed(batchManaged = true) {
  const suffix = `pos-route-${Date.now()}-${sequence++}`
  const ids = {
    category: `CAT-${suffix}`,
    supplier: `SUP-${suffix}`,
    material: `MAT-${suffix}`,
    locA: `LOC-A-${suffix}`,
    locB: `LOC-B-${suffix}`,
  }
  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, 1)')
    .run(ids.category, ids.category, 'position route')
  db.prepare('INSERT INTO suppliers (id, code, name, status) VALUES (?, ?, ?, 1)')
    .run(ids.supplier, ids.supplier, 'position supplier')
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, capacity, status)
    VALUES (?, ?, 'A', 'shelf', 'A', 999999, 1), (?, ?, 'B', 'shelf', 'B', 999999, 1)
  `).run(ids.locA, ids.locA, ids.locB, ids.locB)
  db.prepare(`
    INSERT INTO materials
      (id, code, name, unit, category_id, supplier_id, price, batch_managed, units_per_package, slots_per_package)
    VALUES (?, ?, 'position material', 'pcs', ?, ?, 10, ?, 10, 1)
  `).run(ids.material, ids.material, ids.category, ids.supplier, batchManaged ? 1 : 0)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES (?, ?, 0, 0)')
    .run(`INV-${suffix}`, ids.material)
  return ids
}

async function inbound(ids: ReturnType<typeof seed>, input: {
  locationId: string
  quantity: number
  batchNo?: string
  expiryDate?: string
}) {
  return auth(request(app).post('/api/v1/inbound')).send({
    type: 'direct',
    materialId: ids.material,
    batchNo: input.batchNo,
    quantity: input.quantity,
    price: 10,
    supplierId: ids.supplier,
    locationId: input.locationId,
    expiryDate: input.expiryDate,
    operator: 'position-test',
  })
}

function positions(materialId: string): any[] {
  return db.prepare(`
    SELECT batch_id, location_id, quantity
    FROM inventory_positions
    WHERE material_id = ?
    ORDER BY COALESCE(batch_id, ''), location_id
  `).all(materialId) as any[]
}

beforeAll(async () => {
  const appModule = await import('../src/app.js')
  const manager = await import('../src/database/DatabaseManager.js')
  app = appModule.default
  db = manager.getDatabase()
  const login = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })
  expect(login.status).toBe(200)
  token = login.body.data.token
})

describe('PIS-INV-G01 route-wide position cutover', () => {
  it('keeps one batch in two positions and makes outbound FEFO location-aware and non-overridable', async () => {
    const ids = seed()
    expect((await inbound(ids, { locationId: ids.locA, quantity: 4, batchNo: 'LOT-1', expiryDate: '2027-01-01' })).status).toBe(201)
    expect((await inbound(ids, { locationId: ids.locB, quantity: 6, batchNo: 'LOT-1', expiryDate: '2027-01-01' })).status).toBe(201)
    const batchId = (db.prepare('SELECT id FROM batches WHERE material_id = ?').get(ids.material) as any).id
    expect(positions(ids.material)).toEqual([
      { batch_id: batchId, location_id: ids.locA, quantity: 4 },
      { batch_id: batchId, location_id: ids.locB, quantity: 6 },
    ])

    const pinned = await auth(request(app).post('/api/v1/outbound')).send({
      type: 'direct', items: [{ materialId: ids.material, batchId, quantity: 1, usage: 'external' }],
    })
    expect(pinned.status).toBe(400)
    expect(pinned.body.error.code).toBe('FEFO_OVERRIDE_FORBIDDEN')

    const out = await auth(request(app).post('/api/v1/outbound')).send({
      type: 'direct', items: [{ materialId: ids.material, quantity: 5, usage: 'external' }],
    })
    expect(out.status).toBe(201)
    expect(positions(ids.material)).toEqual([
      { batch_id: batchId, location_id: ids.locB, quantity: 5 },
    ])
    expect(db.prepare(`
      SELECT location_id, quantity FROM inventory_transaction_allocations
      WHERE operation_kind = 'outbound' AND owner_id = ? ORDER BY id
    `).all(out.body.data.id)).toEqual([
      { location_id: ids.locA, quantity: 4 },
      { location_id: ids.locB, quantity: 1 },
    ])
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(ids.material) as any).stock).toBe(5)

    const update = await auth(request(app).put(`/api/v1/outbound/${out.body.data.id}`)).send({
      type: 'direct', items: [{ materialId: ids.material, quantity: 1 }],
    })
    expect(update.status).toBe(409)
    expect(update.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')
    const deletion = await auth(request(app).delete(`/api/v1/outbound/${out.body.data.id}`)).send({})
    expect(deletion.status).toBe(409)
    expect(deletion.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')
  })

  it('moves a true partial balance, persists both location facts, and closes the generic inbound bypass', async () => {
    const ids = seed()
    const receipt = await inbound(ids, { locationId: ids.locA, quantity: 10, batchNo: 'LOT-T', expiryDate: '2027-01-01' })
    expect(receipt.status).toBe(201)
    const transfer = await auth(request(app).post('/api/v1/transfers/inbound')).send({
      materialId: ids.material,
      quantity: 3,
      fromLocationId: ids.locA,
      toLocationId: ids.locB,
      operator: 'position-test',
    })
    expect(transfer.status).toBe(200)
    expect(positions(ids.material).map(row => [row.location_id, row.quantity])).toEqual([
      [ids.locA, 7],
      [ids.locB, 3],
    ])
    expect(db.prepare(`
      SELECT direction, location_id, quantity FROM inventory_transaction_allocations
      WHERE operation_kind = 'transfer' AND owner_id = ? ORDER BY direction DESC
    `).all(transfer.body.data.id)).toEqual([
      { direction: 'out', location_id: ids.locA, quantity: 3 },
      { direction: 'in', location_id: ids.locB, quantity: 3 },
    ])
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(ids.material) as any).stock).toBe(10)

    const viaInbound = await auth(request(app).put(`/api/v1/inbound/${transfer.body.data.id}`)).send({ quantity: 4 })
    expect(viaInbound.status).toBe(409)
    expect(viaInbound.body.error.code).toBe('ROUTE_OWNERSHIP_VIOLATION')
    const deletion = await auth(request(app).delete(`/api/v1/transfers/${transfer.body.data.id}`)).send({})
    expect(deletion.status).toBe(409)
    expect(deletion.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')
    expect(positions(ids.material).map(row => [row.location_id, row.quantity])).toEqual([
      [ids.locA, 7],
      [ids.locB, 3],
    ])
  })

  it('returns to the exact source allocation location and blocks source-less ambiguity', async () => {
    const ids = seed()
    expect((await inbound(ids, { locationId: ids.locA, quantity: 10, batchNo: 'LOT-R', expiryDate: '2027-01-01' })).status).toBe(201)
    const out = await auth(request(app).post('/api/v1/outbound')).send({
      type: 'direct', items: [{ materialId: ids.material, quantity: 3, usage: 'external' }],
    })
    expect(out.status).toBe(201)
    const source = db.prepare(`
      SELECT id FROM inventory_transaction_allocations
      WHERE operation_kind = 'outbound' AND owner_id = ? AND direction = 'out'
    `).get(out.body.data.id) as any
    const returned = await auth(request(app).post('/api/v1/returns')).send({
      materialId: ids.material,
      sourceAllocationId: source.id,
      quantity: 2,
      reason: 'excess',
    })
    expect(returned.status).toBe(201)
    expect((db.prepare(`
      SELECT location_id FROM inventory_transaction_allocations
      WHERE operation_kind = 'return' AND owner_id = ?
    `).get(returned.body.data.id) as any).location_id).toBe(ids.locA)
    expect(positions(ids.material)[0].quantity).toBe(9)

    const ambiguous = await auth(request(app).post('/api/v1/returns')).send({
      materialId: ids.material, quantity: 1, reason: 'unknown source',
    })
    expect(ambiguous.status).toBe(400)
    const deletion = await auth(request(app).delete(`/api/v1/returns/${returned.body.data.id}`)).send({})
    expect(deletion.status).toBe(409)
    expect(deletion.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')
  })

  it('forces scrap and supplier return through automatic FEFO and keeps cancellation in G2', async () => {
    const ids = seed()
    expect((await inbound(ids, { locationId: ids.locA, quantity: 5, batchNo: 'EARLY', expiryDate: '2026-12-01' })).status).toBe(201)
    expect((await inbound(ids, { locationId: ids.locB, quantity: 5, batchNo: 'LATE', expiryDate: '2027-12-01' })).status).toBe(201)
    const late = (db.prepare("SELECT id FROM batches WHERE material_id = ? AND batch_no = 'LATE'").get(ids.material) as any).id

    const pinnedScrap = await auth(request(app).post('/api/v1/scraps')).send({
      materialId: ids.material, batchId: late, quantity: 1, reason: 'expired',
    })
    expect(pinnedScrap.status).toBe(400)
    expect(pinnedScrap.body.error.code).toBe('FEFO_OVERRIDE_FORBIDDEN')
    const scrap = await auth(request(app).post('/api/v1/scraps')).send({
      materialId: ids.material, quantity: 2, reason: 'expired',
    })
    expect(scrap.status).toBe(201)
    expect((db.prepare(`
      SELECT location_id FROM inventory_transaction_allocations
      WHERE operation_kind = 'scrap' AND owner_id = ?
    `).get(scrap.body.data.id) as any).location_id).toBe(ids.locA)

    const pinnedSupplierReturn = await auth(request(app).post('/api/v1/supplier-returns')).send({
      materialId: ids.material, batchId: late, quantity: 1, reason: 'damage', refundAmount: 0,
    })
    expect(pinnedSupplierReturn.status).toBe(400)
    expect(pinnedSupplierReturn.body.error.code).toBe('FEFO_OVERRIDE_FORBIDDEN')
    const supplierReturn = await auth(request(app).post('/api/v1/supplier-returns')).send({
      materialId: ids.material, quantity: 1, reason: 'damage', refundAmount: 0,
    })
    expect(supplierReturn.status).toBe(201)
    const cancel = await auth(request(app).put(`/api/v1/supplier-returns/${supplierReturn.body.data.id}/status`))
      .send({ status: 'cancelled' })
    expect(cancel.status).toBe(409)
    expect(cancel.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')
  })

  it('keeps non-batch receipts, transfers, deductions, and facts null-batched', async () => {
    const ids = seed(false)
    const receipt = await inbound(ids, { locationId: ids.locA, quantity: 10 })
    expect(receipt.status).toBe(201)
    const transfer = await auth(request(app).post('/api/v1/transfers/inbound')).send({
      materialId: ids.material, quantity: 3, fromLocationId: ids.locA, toLocationId: ids.locB,
    })
    expect(transfer.status).toBe(200)
    const out = await auth(request(app).post('/api/v1/outbound')).send({
      type: 'direct', items: [{ materialId: ids.material, quantity: 2, usage: 'external' }],
    })
    expect(out.status).toBe(201)
    expect(positions(ids.material)).toEqual([
      { batch_id: null, location_id: ids.locA, quantity: 5 },
      { batch_id: null, location_id: ids.locB, quantity: 3 },
    ])
    expect((db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(ids.material) as any).count).toBe(0)
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_transaction_allocations
      WHERE material_id = ? AND batch_id IS NOT NULL
    `).get(ids.material) as any).count).toBe(0)
  })

  it('completes a legacy pending inbound through the position planner with a located allocation', async () => {
    const ids = seed()
    const inboundId = `PENDING-${Date.now()}-${sequence++}`
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_no, quantity, unit, price, amount,
         supplier_id, location_id, operator, status)
      VALUES (?, ?, 'direct', ?, 'PENDING-LOT', 6, 'pcs', 10, 60, ?, ?, 'position-test', 'pending')
    `).run(inboundId, inboundId, ids.material, ids.supplier, ids.locB)

    const completed = await auth(request(app).put(`/api/v1/inbound/${inboundId}`)).send({
      status: 'completed',
      materialId: ids.material,
      batchNo: 'PENDING-LOT',
      quantity: 6,
      price: 10,
      supplierId: ids.supplier,
      locationId: ids.locB,
      operator: 'position-test',
    })

    expect(completed.status).toBe(200)
    const batch = db.prepare('SELECT id, remaining FROM batches WHERE material_id = ?').get(ids.material) as any
    expect(batch.remaining).toBe(6)
    expect(positions(ids.material)).toEqual([
      { batch_id: batch.id, location_id: ids.locB, quantity: 6 },
    ])
    expect(db.prepare(`
      SELECT batch_id, location_id, quantity FROM inventory_transaction_allocations
      WHERE operation_kind = 'inbound' AND owner_id = ?
    `).get(inboundId)).toEqual({ batch_id: batch.id, location_id: ids.locB, quantity: 6 })
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(ids.material) as any).stock).toBe(6)
  })

  it('completes a non-batch pending inbound without manufacturing a batch', async () => {
    const ids = seed(false)
    const inboundId = `PENDING-NONBATCH-${Date.now()}-${sequence++}`
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, quantity, unit, price, amount,
         supplier_id, location_id, operator, status)
      VALUES (?, ?, 'direct', ?, 4, 'pcs', 10, 40, ?, ?, 'position-test', 'pending')
    `).run(inboundId, inboundId, ids.material, ids.supplier, ids.locA)

    const completed = await auth(request(app).put(`/api/v1/inbound/${inboundId}`)).send({
      status: 'completed',
      materialId: ids.material,
      quantity: 4,
      price: 10,
      supplierId: ids.supplier,
      locationId: ids.locA,
      operator: 'position-test',
    })

    expect(completed.status).toBe(200)
    expect(positions(ids.material)).toEqual([
      { batch_id: null, location_id: ids.locA, quantity: 4 },
    ])
    expect((db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(ids.material) as any).count).toBe(0)
    expect(db.prepare(`
      SELECT batch_id, location_id, quantity FROM inventory_transaction_allocations
      WHERE operation_kind = 'inbound' AND owner_id = ?
    `).get(inboundId)).toEqual({ batch_id: null, location_id: ids.locA, quantity: 4 })
  })

  it('keeps completed inbound cancellation and deletion inside the G2 boundary with zero quantity writes', async () => {
    const ids = seed()
    const receipt = await inbound(ids, {
      locationId: ids.locA, quantity: 3, batchNo: 'IMMUTABLE-IN', expiryDate: '2027-01-01',
    })
    expect(receipt.status).toBe(201)
    const before = positions(ids.material)

    const cancelled = await auth(request(app).post(`/api/v1/inbound/${receipt.body.data.id}/cancel`)).send({
      reason: 'requires compensation',
    })
    expect(cancelled.status).toBe(409)
    expect(cancelled.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')

    const deleted = await auth(request(app).delete(`/api/v1/inbound/${receipt.body.data.id}`)).send({})
    expect(deleted.status).toBe(409)
    expect(deleted.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')
    expect(positions(ids.material)).toEqual(before)
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(ids.material) as any).stock).toBe(3)
    expect((db.prepare('SELECT status, is_deleted FROM inbound_records WHERE id = ?').get(receipt.body.data.id) as any))
      .toEqual({ status: 'completed', is_deleted: 0 })
  })

  it('rejects duplicate generic transfer/scrap quantity routes', async () => {
    const ids = seed()
    const genericInbound = await inbound(ids, {
      locationId: ids.locA, quantity: 1, batchNo: 'ROUTE', expiryDate: '2027-01-01',
    })
    expect(genericInbound.status).toBe(201)
    const transferType = await auth(request(app).post('/api/v1/inbound')).send({
      type: 'transfer', materialId: ids.material, batchNo: 'X', quantity: 1,
      locationId: ids.locA, price: 0,
    })
    expect(transferType.status).toBe(400)
    const scrapType = await auth(request(app).post('/api/v1/outbound')).send({
      type: 'scrap', items: [{ materialId: ids.material, quantity: 1 }],
    })
    expect(scrapType.status).toBe(400)
  })
})
