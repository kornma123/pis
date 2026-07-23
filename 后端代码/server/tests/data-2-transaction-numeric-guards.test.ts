import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb } from './p0-harness.js'
import {
  parseFiniteNonNegativeNumber,
  parseFiniteNumber,
  parseFinitePositiveNumber,
} from '../src/utils/numeric-input.js'

let app: any
let db: any
let seq = 0

const injectWriteUser = (req: any, _res: any, next: any) => {
  req.user = { userId: 'DATA-2', username: 'system', role: 'admin', roles: ['admin'] }
  next()
}

function seedMaterial(stock = 10, batches?: Array<{ id: string; quantity: number; remaining: number; expiry?: string | null }>) {
  const suffix = `${Date.now()}-${++seq}`
  const materialId = `MAT-D2-${suffix}`
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, ?, 'DATA-2 material', 'pcs', 'CAT-D2', 10, 1, 0)
  `).run(materialId, materialId)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES (?, ?, ?, 0)')
    .run(`INV-${suffix}`, materialId, stock)
  const rows = batches || [{ id: `B-${suffix}`, quantity: stock, remaining: stock, expiry: '2030-01-01' }]
  for (const row of rows) {
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, expiry_date, inbound_id, inbound_price, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 10, ?)
    `).run(
      row.id,
      materialId,
      row.id,
      row.quantity,
      row.remaining,
      row.expiry ?? null,
      `IN-${row.id}`,
      row.remaining > 0 ? 1 : 0,
    )
  }
  return { materialId, batchId: rows[0]?.id ?? null }
}

function snapshot(materialId: string) {
  return {
    inventory: db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId),
    batches: db.prepare('SELECT id, quantity, remaining, status FROM batches WHERE material_id = ? ORDER BY id').all(materialId),
    inbound: db.prepare('SELECT COUNT(*) c FROM inbound_records WHERE material_id = ?').get(materialId),
    outbound: db.prepare('SELECT COUNT(*) c FROM outbound_items WHERE material_id = ?').get(materialId),
    returns: db.prepare('SELECT COUNT(*) c FROM return_records WHERE material_id = ?').get(materialId),
    scraps: db.prepare('SELECT COUNT(*) c FROM scrap_records WHERE material_id = ?').get(materialId),
    supplierReturns: db.prepare('SELECT COUNT(*) c FROM supplier_returns WHERE material_id = ?').get(materialId),
    allocations: db.prepare('SELECT operation_kind, owner_id, batch_id, direction, quantity, is_reversed FROM inventory_transaction_allocations WHERE material_id = ? ORDER BY operation_kind, owner_id, batch_id').all(materialId),
    logs: db.prepare('SELECT type, quantity, before_stock, after_stock, related_type FROM stock_logs WHERE material_id = ? ORDER BY created_at, id').all(materialId),
  }
}

beforeAll(async () => {
  db = await getDb()
  const inbound = (await import('../src/routes/inbound-v1.1.js')).default
  const outbound = (await import('../src/routes/outbound-v1.1.js')).default
  const returns = (await import('../src/routes/returns-v1.1.js')).default
  const scraps = (await import('../src/routes/scraps-v1.1.js')).default
  const supplierReturns = (await import('../src/routes/supplier-returns-v1.1.js')).default
  const stocktaking = (await import('../src/routes/stocktaking-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/inbound', router: inbound, middleware: [injectWriteUser] },
    { path: '/api/v1/outbound', router: outbound, middleware: [injectWriteUser] },
    { path: '/api/v1/returns', router: returns, middleware: [injectWriteUser] },
    { path: '/api/v1/scraps', router: scraps, middleware: [injectWriteUser] },
    { path: '/api/v1/supplier-returns', router: supplierReturns, middleware: [injectWriteUser] },
    { path: '/api/v1/stocktaking', router: stocktaking, middleware: [injectWriteUser] },
  ])
})

beforeEach(() => {
  db.exec(`
    DELETE FROM inventory_transaction_allocations;
    DELETE FROM idempotency_keys;
    DELETE FROM stock_logs;
    DELETE FROM stocktaking_records;
    DELETE FROM supplier_returns;
    DELETE FROM scrap_records;
    DELETE FROM return_records;
    DELETE FROM outbound_items;
    DELETE FROM outbound_records;
    DELETE FROM inbound_records;
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM material_categories;
  `)
  db.prepare("INSERT INTO material_categories (id, code, name, level) VALUES ('CAT-D2', 'CAT-D2', 'DATA-2', 1)").run()
})

describe('DATA-2 strict numeric input semantics', () => {
  it.each([true, [1], { value: 1 }, null, '   '])('rejects broad coercion for %j', (value) => {
    expect(parseFiniteNumber(value)).toBeNull()
  })

  it('keeps legal zero distinct from a positive quantity', () => {
    expect(parseFiniteNonNegativeNumber('0')).toBe(0)
    expect(parseFinitePositiveNumber('0')).toBeNull()
    expect(parseFinitePositiveNumber('2.5')).toBe(2.5)
  })
})

describe('DATA-2 LOC-001 transaction guards', () => {
  it('rejects an unsafe inbound quantity before business, allocation, log, or idempotency writes', async () => {
    const { materialId } = seedMaterial(0, [])
    const before = snapshot(materialId)
    const response = await request(app).post('/api/v1/inbound')
      .set('Idempotency-Key', 'D2-INBOUND-UNSAFE')
      .send({
        type: 'direct',
        materialId,
        batchNo: 'D2-UNSAFE',
        quantity: '1e400',
        price: 1,
        locationId: 'LOC-D2',
      })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(snapshot(materialId)).toEqual(before)
    expect(db.prepare("SELECT COUNT(*) c FROM idempotency_keys WHERE idempotency_key = 'D2-INBOUND-UNSAFE'").get()).toEqual({ c: 0 })
  })

  it('commits inbound batch/cache/allocation once and replays the same idempotency result', async () => {
    const { materialId } = seedMaterial(0, [])
    const body = {
      type: 'direct',
      materialId,
      batchNo: 'D2-INBOUND',
      quantity: '2.5',
      price: '10',
      locationId: 'LOC-D2',
    }
    const first = await request(app).post('/api/v1/inbound').set('Idempotency-Key', 'D2-INBOUND').send(body)
    const replay = await request(app).post('/api/v1/inbound').set('Idempotency-Key', 'D2-INBOUND').send(body)
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.body).toEqual(first.body)
    expect(snapshot(materialId)).toMatchObject({
      inventory: { stock: 2.5 },
      inbound: { c: 1 },
      allocations: [{
        operation_kind: 'inbound',
        owner_id: first.body.data.id,
        direction: 'in',
        quantity: 2.5,
        is_reversed: 0,
      }],
    })
  })

  it('fails closed on cache drift before an outbound can persist a partial write', async () => {
    const { materialId } = seedMaterial(10)
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare('UPDATE inventory SET stock = 9 WHERE material_id = ?').run(materialId)
    db.exec('PRAGMA ignore_check_constraints = OFF')
    const before = snapshot(materialId)
    const response = await request(app).post('/api/v1/outbound').send({
      type: 'direct',
      items: [{ materialId, quantity: 1 }],
    })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('INVENTORY_LEDGER_CORRUPT')
    expect(snapshot(materialId)).toEqual(before)
  })

  it('never falls back from an insufficient explicitly selected batch', async () => {
    const batches = [
      { id: 'D2-PIN', quantity: 1, remaining: 1, expiry: '2030-01-01' },
      { id: 'D2-OTHER', quantity: 9, remaining: 9, expiry: '2031-01-01' },
    ]
    const { materialId } = seedMaterial(10, batches)
    const before = snapshot(materialId)
    const response = await request(app).post('/api/v1/outbound').send({
      type: 'direct',
      items: [{ materialId, batchId: 'D2-PIN', quantity: 2 }],
    })
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('BATCH_STOCK_INSUFFICIENT')
    expect(snapshot(materialId)).toEqual(before)
  })

  it('persists a source-bound return and rejects cumulative over-return without a partial write', async () => {
    const { materialId } = seedMaterial(10)
    const outbound = await request(app).post('/api/v1/outbound').send({
      type: 'direct',
      items: [{ materialId, quantity: 4, usage: 'external' }],
    })
    expect(outbound.status).toBe(201)
    const source = db.prepare(`
      SELECT id FROM inventory_transaction_allocations
      WHERE operation_kind = 'outbound' AND owner_id = ?
    `).get(outbound.body.data.id) as any
    const returned = await request(app).post('/api/v1/returns').send({
      materialId,
      sourceAllocationId: source.id,
      quantity: 3,
      reason: 'excess',
    })
    expect(returned.status).toBe(201)
    const beforeRejected = snapshot(materialId)
    const rejected = await request(app).post('/api/v1/returns').send({
      materialId,
      sourceAllocationId: source.id,
      quantity: 2,
      reason: 'excess',
    })
    expect(rejected.status).toBe(422)
    expect(rejected.body.error.code).toBe('RETURN_SOURCE_EXHAUSTED')
    expect(snapshot(materialId)).toEqual(beforeRejected)
  })

  it('uses FEFO for scrap and restores exactly those persisted allocations', async () => {
    const batches = [
      { id: 'D2-LATE', quantity: 5, remaining: 5, expiry: '2031-01-01' },
      { id: 'D2-FIRST', quantity: 2, remaining: 2, expiry: '2030-01-01' },
    ]
    const { materialId } = seedMaterial(7, batches)
    const created = await request(app).post('/api/v1/scraps').send({
      materialId,
      quantity: 4,
      reason: 'expired',
    })
    expect(created.status).toBe(201)
    expect(db.prepare(`
      SELECT batch_id, quantity FROM inventory_transaction_allocations
      WHERE operation_kind = 'scrap' AND owner_id = ?
      ORDER BY batch_id
    `).all(created.body.data.id)).toEqual([
      { batch_id: 'D2-FIRST', quantity: 2 },
      { batch_id: 'D2-LATE', quantity: 2 },
    ])
    const removed = await request(app).delete(`/api/v1/scraps/${created.body.data.id}`)
    expect(removed.status).toBe(200)
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock).toBe(7)
    expect(db.prepare('SELECT id, remaining FROM batches WHERE material_id = ? ORDER BY id').all(materialId)).toEqual([
      { id: 'D2-FIRST', remaining: 2 },
      { id: 'D2-LATE', remaining: 5 },
    ])
  })

  it('replays a cancellation idempotency result without a second restore or log', async () => {
    const { materialId } = seedMaterial(5)
    const created = await request(app).post('/api/v1/scraps').send({
      materialId,
      quantity: 2,
      reason: 'expired',
    })
    const first = await request(app).delete(`/api/v1/scraps/${created.body.data.id}`)
      .set('Idempotency-Key', 'D2-SCRAP-DELETE')
      .send({})
    const afterFirst = snapshot(materialId)
    const replay = await request(app).delete(`/api/v1/scraps/${created.body.data.id}`)
      .set('Idempotency-Key', 'D2-SCRAP-DELETE')
      .send({})
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(snapshot(materialId)).toEqual(afterFirst)
  })

  it('rolls back business, cache, batch, allocation, log, and idempotency writes after a late failure', async () => {
    const { materialId } = seedMaterial(5)
    const before = snapshot(materialId)
    db.exec(`
      CREATE TRIGGER d2_fail_scrap_log
      BEFORE INSERT ON stock_logs
      WHEN NEW.related_type = 'scrap'
      BEGIN
        SELECT RAISE(ABORT, 'injected late stock log failure');
      END
    `)
    try {
      const response = await request(app).post('/api/v1/scraps')
        .set('Idempotency-Key', 'D2-SCRAP-ROLLBACK')
        .send({ materialId, quantity: 2, reason: 'expired' })
      expect(response.status).toBe(500)
      expect(snapshot(materialId)).toEqual(before)
      expect(db.prepare("SELECT COUNT(*) c FROM idempotency_keys WHERE idempotency_key = 'D2-SCRAP-ROLLBACK'").get()).toEqual({ c: 0 })
    } finally {
      db.exec('DROP TRIGGER IF EXISTS d2_fail_scrap_log')
    }
  })

  it('keeps legal zero stocktaking distinct while refusing a material-only nonzero adjustment', async () => {
    const { materialId } = seedMaterial(10)
    const zero = await request(app).post('/api/v1/stocktaking').send({ materialId, actualStock: '10' })
    expect(zero.status).toBe(200)
    expect(zero.body.data.status).toBe('completed')
    const draft = await request(app).post('/api/v1/stocktaking').send({ materialId, actualStock: 9 })
    expect(draft.status).toBe(200)
    const applied = await request(app).post(`/api/v1/stocktaking/${draft.body.data.id}/adjust`).send({ reason: 'physical' })
    expect(applied.status).toBe(422)
    expect(applied.body.error.code).toBe('BATCH_DETAIL_REQUIRED')
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock).toBe(10)
  })

  it('persists supplier-return FEFO facts and restores them on delete', async () => {
    const { materialId } = seedMaterial(10)
    const created = await request(app).post('/api/v1/supplier-returns').send({
      materialId,
      quantity: '2',
      reason: 'quality_issue',
      refundAmount: '0',
    })
    expect(created.status).toBe(201)
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock).toBe(8)
    const removed = await request(app).delete(`/api/v1/supplier-returns/${created.body.data.id}`)
    expect(removed.status).toBe(200)
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock).toBe(10)
  })
})
