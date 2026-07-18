/**
 * #140 / #139 库存事实链：全批次事实 + inventory.stock 派生守恒缓存。
 *
 * BDD:
 * - 未指定批次：6 + 4 出库 7，按 FEFO 拆为 6 + 1，整单 201。
 * - 指定余量 6 的批次出库 7：即使别批有货也 422，且零副作用。
 * - 六类库存写路径完成后 inventory.stock = SUM(batches.remaining)。
 * - 同一 Idempotency-Key 重放不二次入账/扣减。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
let sequence = 0

const writeUser = (req: any, _res: any, next: any) => {
  req.user = { userId: 'TEST-ADMIN', username: 'admin', role: 'admin', roles: ['admin'] }
  next()
}

function nextId(label: string): string {
  sequence += 1
  return `INV-TX-${label}-${sequence}`
}

function seedMaterial(label: string, batches: Array<{ quantity: number; expiry: string | null; price?: number }> = []) {
  const materialId = nextId(`MAT-${label}`)
  const locationId = nextId(`LOC-${label}`)
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, status)
    VALUES (?, ?, ?, 'shelf', 'TEST', 1)
  `).run(locationId, locationId, locationId)
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, price, location_id, status, is_deleted)
    VALUES (?, ?, ?, '瓶', 'CAT', 10, ?, 1, 0)
  `).run(materialId, materialId, materialId, locationId)

  const seededBatches = batches.map((fixture, index) => {
    const id = nextId(`BATCH-${label}-${index}`)
    const batchNo = nextId(`NO-${label}-${index}`)
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, expiry_date, inbound_id, inbound_price, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, materialId, batchNo, fixture.quantity, fixture.quantity, fixture.expiry, nextId('SOURCE'), fixture.price ?? 10)
    return { id, batchNo, ...fixture }
  })
  const stock = batches.reduce((sum, batch) => sum + batch.quantity, 0)
  db.prepare('INSERT INTO inventory (id, material_id, stock, location_id) VALUES (?, ?, ?, ?)')
    .run(nextId('INVENTORY'), materialId, stock, locationId)
  return { materialId, locationId, batches: seededBatches }
}

function stockOf(materialId: string): number {
  return Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock ?? 0)
}

function remainingOf(materialId: string): number {
  return Number((db.prepare('SELECT COALESCE(SUM(remaining), 0) AS total FROM batches WHERE material_id = ?')
    .get(materialId) as any).total)
}

function expectConserved(materialId: string, expected?: number): void {
  const inventory = stockOf(materialId)
  const batches = remainingOf(materialId)
  expect(inventory).toBe(batches)
  const batchRows = db.prepare('SELECT remaining, status FROM batches WHERE material_id = ?').all(materialId) as any[]
  for (const row of batchRows) {
    const remaining = Number(row.remaining)
    expect(remaining).toBeGreaterThanOrEqual(0)
    expect(Number(row.status)).toBe(remaining === 0 ? 0 : 1)
  }
  const activeTotal = Number((db.prepare(`
    SELECT COALESCE(SUM(remaining), 0) AS total
    FROM batches WHERE material_id = ? AND status = 1
  `).get(materialId) as any).total)
  expect(inventory).toBe(activeTotal)
  if (expected !== undefined) expect(inventory).toBe(expected)
}

function post(path: string, key: string, body: Record<string, unknown>) {
  return request(app).post(path).set('Idempotency-Key', key).send(body)
}

async function injectBeforeWriteLock<T>(mutation: () => void, action: () => PromiseLike<T>): Promise<T> {
  const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => unknown
  let injected = false
  const execSpy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
    if (!injected && /^BEGIN\s+IMMEDIATE$/i.test(sql)) {
      injected = true
      mutation()
    }
    return originalExec(sql)
  })
  try {
    return await action()
  } finally {
    execSpy.mockRestore()
  }
}

beforeAll(async () => {
  db = await getDb()
  const [inbound, outbound, returns, scraps, stocktaking, supplierReturns] = await Promise.all([
    import('../src/routes/inbound-v1.1.js'),
    import('../src/routes/outbound-v1.1.js'),
    import('../src/routes/returns-v1.1.js'),
    import('../src/routes/scraps-v1.1.js'),
    import('../src/routes/stocktaking-v1.1.js'),
    import('../src/routes/supplier-returns-v1.1.js'),
  ])
  app = await buildTestApp([
    { path: '/api/v1/inbound', router: inbound.default, middleware: [writeUser] },
    { path: '/api/v1/outbound', router: outbound.default, middleware: [writeUser] },
    { path: '/api/v1/returns', router: returns.default, middleware: [writeUser] },
    { path: '/api/v1/scraps', router: scraps.default, middleware: [writeUser] },
    { path: '/api/v1/stocktaking', router: stocktaking.default, middleware: [writeUser] },
    { path: '/api/v1/supplier-returns', router: supplierReturns.default, middleware: [writeUser] },
  ])
})

describe('库存全批次事实与事务幂等', () => {
  it('未指定批次时 6+4 出库 7，按 FEFO 拆成 6+1 并保持守恒', async () => {
    const fixture = seedMaterial('FEFO', [
      { quantity: 6, expiry: '2027-01-01', price: 2 },
      { quantity: 4, expiry: '2027-02-01', price: 3 },
    ])
    const key = nextId('IDEM-OUTBOUND-FEFO')
    const payload = { type: 'direct', items: [{ materialId: fixture.materialId, quantity: 7 }] }

    const first = await post('/api/v1/outbound', key, payload)
    expect(first.status).toBe(201)
    const replay = await post('/api/v1/outbound', key, payload)
    expect(replay.status).toBe(201)
    expect(replay.body.data.id).toBe(first.body.data.id)

    const items = db.prepare(`
      SELECT batch_id, quantity, unit_cost, total_cost
      FROM outbound_items WHERE outbound_id = ? ORDER BY rowid
    `).all(first.body.data.id) as any[]
    expect(items.map((item) => [item.batch_id, Number(item.quantity)])).toEqual([
      [fixture.batches[0].id, 6],
      [fixture.batches[1].id, 1],
    ])
    expect(items.map((item) => [Number(item.unit_cost), Number(item.total_cost)])).toEqual([[2, 12], [3, 3]])
    expect(Number((db.prepare('SELECT total_cost FROM outbound_records WHERE id = ?').get(first.body.data.id) as any).total_cost)).toBe(15)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[0].id) as any).remaining)).toBe(0)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[1].id) as any).remaining)).toBe(3)
    expectConserved(fixture.materialId, 3)

    const deleted = await request(app).delete(`/api/v1/outbound/${first.body.data.id}`)
    expect(deleted.status).toBe(200)
    expect(fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining)))
      .toEqual([6, 4])
    expectConserved(fixture.materialId, 10)
  })

  it('指定余量 6 的批次出库 7 返回 422，绝不静默换到另一批且零副作用', async () => {
    const fixture = seedMaterial('PINNED', [
      { quantity: 10, expiry: '2027-01-01' },
      { quantity: 6, expiry: '2027-02-01' },
    ])
    const before = {
      stock: stockOf(fixture.materialId),
      remaining: fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining)),
      records: Number((db.prepare('SELECT COUNT(*) AS count FROM outbound_records').get() as any).count),
      items: Number((db.prepare('SELECT COUNT(*) AS count FROM outbound_items').get() as any).count),
      logs: Number((db.prepare('SELECT COUNT(*) AS count FROM stock_logs').get() as any).count),
      idempotency: Number((db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get() as any).count),
      tracking: Number((db.prepare('SELECT COUNT(*) AS count FROM batch_usage_tracking').get() as any).count),
    }

    const response = await post('/api/v1/outbound', nextId('IDEM-PINNED'), {
      type: 'direct',
      items: [{ materialId: fixture.materialId, batchId: fixture.batches[1].id, quantity: 7 }],
    })
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('STOCK_INSUFFICIENT')
    const responseByNo = await post('/api/v1/outbound', nextId('IDEM-PINNED-BY-NO'), {
      type: 'direct',
      items: [{ materialId: fixture.materialId, batchNo: fixture.batches[1].batchNo, quantity: 7 }],
    })
    expect(responseByNo.status).toBe(422)
    expect(responseByNo.body.error.code).toBe('STOCK_INSUFFICIENT')
    expect(stockOf(fixture.materialId)).toBe(before.stock)
    expect(fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining))).toEqual(before.remaining)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM outbound_records').get() as any).count)).toBe(before.records)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM outbound_items').get() as any).count)).toBe(before.items)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM stock_logs').get() as any).count)).toBe(before.logs)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get() as any).count)).toBe(before.idempotency)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM batch_usage_tracking').get() as any).count)).toBe(before.tracking)
    expectConserved(fixture.materialId, 16)
  })

  it('无批号入库仍落一个事实批次，幂等重放只增加一次', async () => {
    const fixture = seedMaterial('INBOUND')
    const key = nextId('IDEM-INBOUND')
    const payload = { type: 'direct', materialId: fixture.materialId, quantity: 5, locationId: fixture.locationId }
    const first = await post('/api/v1/inbound', key, payload)
    const replay = await post('/api/v1/inbound', key, payload)
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM inbound_records WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(1)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(1)
    expectConserved(fixture.materialId, 5)
  })

  it('退库增加批次事实，幂等重放不二次增加', async () => {
    const fixture = seedMaterial('RETURN', [{ quantity: 10, expiry: '2027-01-01' }])
    const key = nextId('IDEM-RETURN')
    const payload = { materialId: fixture.materialId, quantity: 2, reason: 'unused' }
    const first = await post('/api/v1/returns', key, payload)
    const replay = await post('/api/v1/returns', key, payload)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM return_records WHERE material_id = ? AND is_deleted = 0').get(fixture.materialId) as any).count)).toBe(1)
    expectConserved(fixture.materialId, 12)

    const returnRecord = db.prepare('SELECT batch_id FROM return_records WHERE id = ?').get(first.body.data.id) as any
    expect(returnRecord.batch_id).not.toBe(fixture.batches[0].id)
    const deleted = await request(app).delete(`/api/v1/returns/${first.body.data.id}`)
    expect(deleted.status).toBe(200)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[0].id) as any).remaining)).toBe(10)
    expect(db.prepare('SELECT quantity, remaining, status FROM batches WHERE id = ?').get(returnRecord.batch_id))
      .toMatchObject({ quantity: 0, remaining: 0, status: 0 })
    expectConserved(fixture.materialId, 10)
  })

  it('报废扣减批次事实，幂等重放不二次扣减', async () => {
    const fixture = seedMaterial('SCRAP', [{ quantity: 10, expiry: '2027-01-01' }])
    const key = nextId('IDEM-SCRAP')
    const payload = { materialId: fixture.materialId, quantity: 2, reason: 'expired' }
    const first = await post('/api/v1/scraps', key, payload)
    const replay = await post('/api/v1/scraps', key, payload)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM scrap_records WHERE material_id = ? AND is_deleted = 0').get(fixture.materialId) as any).count)).toBe(1)
    expectConserved(fixture.materialId, 8)

    const deleted = await request(app).delete(`/api/v1/scraps/${first.body.data.id}`)
    expect(deleted.status).toBe(200)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[0].id) as any).remaining)).toBe(10)
    expectConserved(fixture.materialId, 10)
  })

  it('盘点调整批次事实，创建与入账重放均不重复', async () => {
    const fixture = seedMaterial('STOCKTAKING', [{ quantity: 10, expiry: '2027-01-01' }])
    const createKey = nextId('IDEM-STOCKTAKING-CREATE')
    const createPayload = { materialId: fixture.materialId, actualStock: 7 }
    const created = await post('/api/v1/stocktaking', createKey, createPayload)
    const createReplay = await post('/api/v1/stocktaking', createKey, createPayload)
    expect(created.status).toBe(200)
    expect(createReplay.status).toBe(200)
    expect(createReplay.body.data.id).toBe(created.body.data.id)

    const adjustKey = nextId('IDEM-STOCKTAKING-ADJUST')
    const adjusted = await post(`/api/v1/stocktaking/${created.body.data.id}/adjust`, adjustKey, { reason: 'normal' })
    const adjustReplay = await post(`/api/v1/stocktaking/${created.body.data.id}/adjust`, adjustKey, { reason: 'normal' })
    expect(adjusted.status).toBe(200)
    expect(adjustReplay.status).toBe(200)
    expect(adjustReplay.body.data).toEqual(adjusted.body.data)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM stocktaking_records WHERE material_id = ? AND is_deleted = 0').get(fixture.materialId) as any).count)).toBe(1)
    expect(Number((db.prepare("SELECT COUNT(*) AS count FROM stock_logs WHERE related_id = ? AND related_type = 'stocktaking'").get(created.body.data.id) as any).count)).toBe(1)
    expect(db.prepare('SELECT status_code FROM idempotency_keys WHERE idempotency_key = ?').get(adjustKey)).toMatchObject({ status_code: 200 })
    expectConserved(fixture.materialId, 7)
  })

  it('供应商退货扣减批次事实，幂等重放不二次扣减', async () => {
    const fixture = seedMaterial('SUPPLIER-RETURN', [{ quantity: 10, expiry: '2027-01-01' }])
    const key = nextId('IDEM-SUPPLIER-RETURN')
    const payload = { materialId: fixture.materialId, quantity: 2, reason: 'quality_issue' }
    const first = await post('/api/v1/supplier-returns', key, payload)
    const replay = await post('/api/v1/supplier-returns', key, payload)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM supplier_returns WHERE material_id = ? AND is_deleted = 0').get(fixture.materialId) as any).count)).toBe(1)
    expectConserved(fixture.materialId, 8)

    const deleted = await request(app).delete(`/api/v1/supplier-returns/${first.body.data.id}`)
    expect(deleted.status).toBe(200)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[0].id) as any).remaining)).toBe(10)
    expectConserved(fixture.materialId, 10)
  })

  it('legacy inventory cache without batch facts cannot be consumed by scrap or supplier return', async () => {
    for (const route of ['/api/v1/scraps', '/api/v1/supplier-returns']) {
      const fixture = seedMaterial(`LEGACY-CONSUME-${route}`)
      db.prepare('UPDATE inventory SET stock = 10 WHERE material_id = ?').run(fixture.materialId)
      const before = {
        inventory: stockOf(fixture.materialId),
        batches: Number((db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(fixture.materialId) as any).count),
        scraps: Number((db.prepare('SELECT COUNT(*) AS count FROM scrap_records WHERE material_id = ?').get(fixture.materialId) as any).count),
        supplierReturns: Number((db.prepare('SELECT COUNT(*) AS count FROM supplier_returns WHERE material_id = ?').get(fixture.materialId) as any).count),
        logs: Number((db.prepare('SELECT COUNT(*) AS count FROM stock_logs WHERE material_id = ?').get(fixture.materialId) as any).count),
      }

      const response = await post(route, nextId('IDEM-LEGACY-CONSUME'), {
        materialId: fixture.materialId,
        quantity: 2,
        reason: route.endsWith('scraps') ? 'expired' : 'quality_issue',
      })

      expect(response.status).toBe(422)
      expect(response.body.error.code).toBe('STOCK_INSUFFICIENT')
      expect(stockOf(fixture.materialId)).toBe(before.inventory)
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(before.batches)
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM scrap_records WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(before.scraps)
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM supplier_returns WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(before.supplierReturns)
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM stock_logs WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(before.logs)
    }
  })

  it('additive writes fail closed instead of erasing legacy cache-only stock', async () => {
    for (const route of ['/api/v1/inbound', '/api/v1/returns']) {
      const fixture = seedMaterial(`LEGACY-ADDITIVE-${route}`)
      db.prepare('UPDATE inventory SET stock = 10 WHERE material_id = ?').run(fixture.materialId)
      const response = await post(route, nextId('IDEM-LEGACY-ADDITIVE'), route.endsWith('inbound')
        ? { type: 'direct', materialId: fixture.materialId, quantity: 2, locationId: fixture.locationId }
        : { materialId: fixture.materialId, quantity: 2, reason: 'unused' })

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('LEDGER_DRIFT')
      expect(stockOf(fixture.materialId)).toBe(10)
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(0)
    }
  })

  it('inactive batch with positive remaining fails closed instead of becoming unreachable stock', async () => {
    const fixture = seedMaterial('INACTIVE-POSITIVE', [{ quantity: 5, expiry: '2027-01-01' }])
    db.prepare('UPDATE batches SET status = 0 WHERE id = ?').run(fixture.batches[0].id)

    const response = await post('/api/v1/scraps', nextId('IDEM-INACTIVE-POSITIVE'), {
      materialId: fixture.materialId,
      quantity: 1,
      reason: 'expired',
    })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('LEDGER_DRIFT')
    expect(stockOf(fixture.materialId)).toBe(5)
    expect(db.prepare('SELECT remaining, status FROM batches WHERE id = ?').get(fixture.batches[0].id))
      .toMatchObject({ remaining: 5, status: 0 })
  })

  it('batch remaining greater than received quantity fails closed before mutation', async () => {
    const fixture = seedMaterial('IMPOSSIBLE-BATCH', [{ quantity: 5, expiry: '2027-01-01' }])
    db.prepare('UPDATE batches SET quantity = 3 WHERE id = ?').run(fixture.batches[0].id)

    const response = await post('/api/v1/scraps', nextId('IDEM-IMPOSSIBLE-BATCH'), {
      materialId: fixture.materialId,
      quantity: 1,
      reason: 'expired',
    })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('LEDGER_DRIFT')
    expect(stockOf(fixture.materialId)).toBe(5)
    expect(db.prepare('SELECT quantity, remaining, status FROM batches WHERE id = ?').get(fixture.batches[0].id))
      .toMatchObject({ quantity: 3, remaining: 5, status: 1 })
  })

  it('active batch drift fails closed before consumption can erase cache stock', async () => {
    const fixture = seedMaterial('ACTIVE-BATCH-DRIFT', [{ quantity: 5, expiry: '2027-01-01' }])
    db.prepare('UPDATE inventory SET stock = 10 WHERE material_id = ?').run(fixture.materialId)

    const response = await post('/api/v1/scraps', nextId('IDEM-ACTIVE-BATCH-DRIFT'), {
      materialId: fixture.materialId,
      quantity: 1,
      reason: 'expired',
    })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('LEDGER_DRIFT')
    expect(stockOf(fixture.materialId)).toBe(10)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[0].id) as any).remaining)).toBe(5)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM scrap_records WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(0)
  })

  it('zero-difference stocktake rejects a drifted cache instead of certifying dual truth', async () => {
    const fixture = seedMaterial('STOCKTAKING-LEGACY-ZERO')
    db.prepare('UPDATE inventory SET stock = 10 WHERE material_id = ?').run(fixture.materialId)

    const response = await post('/api/v1/stocktaking', nextId('IDEM-STOCKTAKING-LEGACY-ZERO'), {
      materialId: fixture.materialId,
      actualStock: 10,
    })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('LEDGER_DRIFT')
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM stocktaking_records WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(0)
    expect(stockOf(fixture.materialId)).toBe(10)
  })

  it('legacy inbound record without a batch fact fails closed on mutation', async () => {
    const mutations = [
      { name: 'update', run: (id: string) => request(app).put(`/api/v1/inbound/${id}`).send({ quantity: 7 }) },
      { name: 'delete', run: (id: string) => request(app).delete(`/api/v1/inbound/${id}`) },
      { name: 'cancel', run: (id: string) => request(app).post(`/api/v1/inbound/${id}/cancel`).send({ reason: 'legacy drift' }) },
    ]
    for (const mutation of mutations) {
      const fixture = seedMaterial(`LEGACY-INBOUND-${mutation.name}`)
      const inboundId = nextId('LEGACY-INBOUND')
      db.prepare('UPDATE inventory SET stock = 5 WHERE material_id = ?').run(fixture.materialId)
      db.prepare(`
        INSERT INTO inbound_records
          (id, inbound_no, type, material_id, batch_no, quantity, unit, price, amount,
           location_id, operator, status)
        VALUES (?, ?, 'direct', ?, NULL, 5, 'unit', 10, 50, ?, 'legacy', 'completed')
      `).run(inboundId, nextId('LEGACY-INBOUND-NO'), fixture.materialId, fixture.locationId)

      const response = await mutation.run(inboundId)

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('LEDGER_DRIFT')
      expect(stockOf(fixture.materialId)).toBe(5)
      expect(db.prepare('SELECT quantity, status, is_deleted FROM inbound_records WHERE id = ?').get(inboundId))
        .toMatchObject({ quantity: 5, status: 'completed', is_deleted: 0 })
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(fixture.materialId) as any).count)).toBe(0)
    }
  })

  it('inbound mutation fails closed when cache and active batch facts already drift', async () => {
    const fixture = seedMaterial('INBOUND-ACTIVE-DRIFT', [{ quantity: 5, expiry: '2027-01-01' }])
    const inboundId = nextId('INBOUND-ACTIVE-DRIFT')
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
         location_id, operator, status, remark)
      VALUES (?, ?, 'direct', ?, ?, ?, 5, 'unit', 10, 50, ?, 'seed', 'completed', 'before')
    `).run(inboundId, nextId('INBOUND-ACTIVE-DRIFT-NO'), fixture.materialId, fixture.batches[0].id, fixture.batches[0].batchNo, fixture.locationId)
    db.prepare('UPDATE inventory SET stock = 10 WHERE material_id = ?').run(fixture.materialId)

    const response = await request(app).put(`/api/v1/inbound/${inboundId}`).send({ remark: 'after' })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('LEDGER_DRIFT')
    expect((db.prepare('SELECT remark FROM inbound_records WHERE id = ?').get(inboundId) as any).remark).toBe('before')
    expect(stockOf(fixture.materialId)).toBe(10)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[0].id) as any).remaining)).toBe(5)
  })

  it('inbound quantity edit reactivates a depleted batch and preserves status conservation', async () => {
    const fixture = seedMaterial('INBOUND-EDIT-STATUS', [{ quantity: 5, expiry: '2027-01-01' }])
    const inboundId = nextId('INBOUND-EDIT-STATUS')
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
         location_id, operator, status)
      VALUES (?, ?, 'direct', ?, ?, ?, 5, 'unit', 10, 50, ?, 'seed', 'completed')
    `).run(inboundId, nextId('INBOUND-EDIT-STATUS-NO'), fixture.materialId, fixture.batches[0].id, fixture.batches[0].batchNo, fixture.locationId)
    db.prepare('UPDATE batches SET remaining = 0, status = 0 WHERE id = ?').run(fixture.batches[0].id)
    db.prepare('UPDATE inventory SET stock = 0 WHERE material_id = ?').run(fixture.materialId)

    const response = await request(app).put(`/api/v1/inbound/${inboundId}`).send({ quantity: 7 })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT quantity, remaining, status FROM batches WHERE id = ?').get(fixture.batches[0].id))
      .toMatchObject({ quantity: 7, remaining: 2, status: 1 })
    expectConserved(fixture.materialId, 2)
  })

  it('inbound batch reassignment persists the canonical batch id', async () => {
    const fixture = seedMaterial('INBOUND-EDIT-BATCH', [
      { quantity: 5, expiry: '2027-01-01' },
      { quantity: 3, expiry: '2027-02-01' },
    ])
    const inboundId = nextId('INBOUND-EDIT-BATCH')
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
         location_id, operator, status)
      VALUES (?, ?, 'direct', ?, ?, ?, 5, 'unit', 10, 50, ?, 'seed', 'completed')
    `).run(inboundId, nextId('INBOUND-EDIT-BATCH-NO'), fixture.materialId, fixture.batches[0].id, fixture.batches[0].batchNo, fixture.locationId)

    const response = await request(app).put(`/api/v1/inbound/${inboundId}`).send({ batchNo: fixture.batches[1].batchNo })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT batch_id, batch_no FROM inbound_records WHERE id = ?').get(inboundId))
      .toMatchObject({ batch_id: fixture.batches[1].id, batch_no: fixture.batches[1].batchNo })
    expect(db.prepare('SELECT quantity, remaining, status FROM batches WHERE id = ?').get(fixture.batches[0].id))
      .toMatchObject({ quantity: 0, remaining: 0, status: 0 })
    expect(db.prepare('SELECT quantity, remaining, status FROM batches WHERE id = ?').get(fixture.batches[1].id))
      .toMatchObject({ quantity: 8, remaining: 8, status: 1 })
    expectConserved(fixture.materialId, 8)
  })

  it('inbound status transitions reject unknown states and mixed quantity restoration', async () => {
    const invalidFixture = seedMaterial('INBOUND-INVALID-STATUS', [{ quantity: 5, expiry: '2027-01-01' }])
    const invalidId = nextId('INBOUND-INVALID-STATUS')
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
         location_id, operator, status)
      VALUES (?, ?, 'direct', ?, ?, ?, 5, 'unit', 10, 50, ?, 'seed', 'completed')
    `).run(invalidId, nextId('INBOUND-INVALID-STATUS-NO'), invalidFixture.materialId, invalidFixture.batches[0].id, invalidFixture.batches[0].batchNo, invalidFixture.locationId)
    const invalid = await request(app).put(`/api/v1/inbound/${invalidId}`).send({ status: 'pending' })
    expect(invalid.status).toBe(400)
    expect((db.prepare('SELECT status FROM inbound_records WHERE id = ?').get(invalidId) as any).status).toBe('completed')
    expectConserved(invalidFixture.materialId, 5)

    const restoreFixture = seedMaterial('INBOUND-MIXED-RESTORE', [{ quantity: 5, expiry: '2027-01-01' }])
    const restoreId = nextId('INBOUND-MIXED-RESTORE')
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
         location_id, operator, status)
      VALUES (?, ?, 'direct', ?, ?, ?, 5, 'unit', 10, 50, ?, 'seed', 'cancelled')
    `).run(restoreId, nextId('INBOUND-MIXED-RESTORE-NO'), restoreFixture.materialId, restoreFixture.batches[0].id, restoreFixture.batches[0].batchNo, restoreFixture.locationId)
    db.prepare('UPDATE batches SET quantity = 0, remaining = 0, status = 0 WHERE id = ?').run(restoreFixture.batches[0].id)
    db.prepare('UPDATE inventory SET stock = 0 WHERE material_id = ?').run(restoreFixture.materialId)

    const mixed = await request(app).put(`/api/v1/inbound/${restoreId}`).send({ status: 'completed', quantity: 7 })
    expect(mixed.status).toBe(400)
    expect(db.prepare('SELECT quantity, status FROM inbound_records WHERE id = ?').get(restoreId))
      .toMatchObject({ quantity: 5, status: 'cancelled' })
    expectConserved(restoreFixture.materialId, 0)
  })

  it('inbound expiry and price edits update the batch fact used by FEFO and costing', async () => {
    const fixture = seedMaterial('INBOUND-EDIT-METADATA', [
      { quantity: 5, expiry: '2027-02-01', price: 10 },
      { quantity: 5, expiry: '2027-01-01', price: 20 },
    ])
    const inboundId = nextId('INBOUND-EDIT-METADATA')
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
         location_id, expiry_date, operator, status)
      VALUES (?, ?, 'direct', ?, ?, ?, 5, 'unit', 10, 50, ?, '2027-02-01', 'seed', 'completed')
    `).run(inboundId, nextId('INBOUND-EDIT-METADATA-NO'), fixture.materialId, fixture.batches[0].id, fixture.batches[0].batchNo, fixture.locationId)

    const updated = await request(app).put(`/api/v1/inbound/${inboundId}`).send({ expiryDate: '2026-01-01', price: 4 })
    expect(updated.status).toBe(200)
    expect(db.prepare('SELECT expiry_date, inbound_price FROM batches WHERE id = ?').get(fixture.batches[0].id))
      .toMatchObject({ expiry_date: '2026-01-01', inbound_price: 4 })

    const outbound = await post('/api/v1/outbound', nextId('IDEM-INBOUND-METADATA-FEFO'), {
      type: 'direct',
      items: [{ materialId: fixture.materialId, quantity: 1 }],
    })
    expect(outbound.status).toBe(201)
    expect(db.prepare('SELECT batch_id, unit_cost FROM outbound_items WHERE outbound_id = ?').get(outbound.body.data.id))
      .toMatchObject({ batch_id: fixture.batches[0].id, unit_cost: 4 })
    expectConserved(fixture.materialId, 9)
  })

  it('cancelling a single-batch supplier return restores the exact batch once', async () => {
    const fixture = seedMaterial('SUPPLIER-CANCEL-EXACT', [{ quantity: 10, expiry: '2027-01-01' }])
    const created = await post('/api/v1/supplier-returns', nextId('IDEM-SUPPLIER-CANCEL'), {
      materialId: fixture.materialId,
      quantity: 2,
      reason: 'quality_issue',
    })
    expect(created.status).toBe(200)
    expectConserved(fixture.materialId, 8)

    const cancelled = await request(app)
      .put(`/api/v1/supplier-returns/${created.body.data.id}/status`)
      .send({ status: 'cancelled' })

    expect(cancelled.status).toBe(200)
    expect(Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(fixture.batches[0].id) as any).remaining)).toBe(10)
    expect((db.prepare('SELECT status FROM supplier_returns WHERE id = ?').get(created.body.data.id) as any).status).toBe('cancelled')
    expectConserved(fixture.materialId, 10)
  })

  it('cancelling a cross-batch supplier return fails closed without an allocation ledger', async () => {
    const fixture = seedMaterial('SUPPLIER-CANCEL-CROSS', [
      { quantity: 6, expiry: '2027-01-01' },
      { quantity: 4, expiry: '2027-02-01' },
    ])
    const created = await post('/api/v1/supplier-returns', nextId('IDEM-SUPPLIER-CROSS'), {
      materialId: fixture.materialId,
      quantity: 7,
      reason: 'quality_issue',
    })
    expect(created.status).toBe(200)
    expectConserved(fixture.materialId, 3)
    const beforeRemaining = fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining))

    const cancelled = await request(app)
      .put(`/api/v1/supplier-returns/${created.body.data.id}/status`)
      .send({ status: 'cancelled' })

    expect(cancelled.status).toBe(409)
    expect(cancelled.body.error.code).toBe('LEDGER_DRIFT')
    expect((db.prepare('SELECT status FROM supplier_returns WHERE id = ?').get(created.body.data.id) as any).status).toBe('pending')
    expect(fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining))).toEqual(beforeRemaining)
    expectConserved(fixture.materialId, 3)

    const deleted = await request(app).delete(`/api/v1/supplier-returns/${created.body.data.id}`)
    expect(deleted.status).toBe(409)
    expect(deleted.body.error.code).toBe('LEDGER_DRIFT')
    expect(fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining))).toEqual(beforeRemaining)
    expectConserved(fixture.materialId, 3)
  })

  it('deleting a cross-batch scrap fails closed without changing either batch', async () => {
    const fixture = seedMaterial('SCRAP-DELETE-CROSS', [
      { quantity: 6, expiry: '2027-01-01' },
      { quantity: 4, expiry: '2027-02-01' },
    ])
    const created = await post('/api/v1/scraps', nextId('IDEM-SCRAP-CROSS'), {
      materialId: fixture.materialId,
      quantity: 7,
      reason: 'expired',
    })
    expect(created.status).toBe(200)
    const beforeRemaining = fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining))
    expect(beforeRemaining).toEqual([0, 3])

    const deleted = await request(app).delete(`/api/v1/scraps/${created.body.data.id}`)

    expect(deleted.status).toBe(409)
    expect(deleted.body.error.code).toBe('LEDGER_DRIFT')
    expect(fixture.batches.map((batch) => Number((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(batch.id) as any).remaining))).toEqual(beforeRemaining)
    expectConserved(fixture.materialId, 3)
  })

  it('deleting an adjusted stocktake fails closed when exact batch provenance was not persisted', async () => {
    const fixture = seedMaterial('STOCKTAKING-DELETE', [{ quantity: 10, expiry: '2027-01-01' }])
    const created = await post('/api/v1/stocktaking', nextId('IDEM-STOCKTAKING-DELETE-CREATE'), {
      materialId: fixture.materialId,
      actualStock: 15,
    })
    const adjusted = await post(
      `/api/v1/stocktaking/${created.body.data.id}/adjust`,
      nextId('IDEM-STOCKTAKING-DELETE-ADJUST'),
      { reason: 'normal' },
    )
    expect(adjusted.status).toBe(200)
    const beforeBatches = db.prepare(`
      SELECT id, remaining, status FROM batches WHERE material_id = ? ORDER BY id
    `).all(fixture.materialId)
    expectConserved(fixture.materialId, 15)

    const deleted = await request(app).delete(`/api/v1/stocktaking/${created.body.data.id}`)

    expect(deleted.status).toBe(409)
    expect(deleted.body.error.code).toBe('LEDGER_DRIFT')
    expect((db.prepare('SELECT is_deleted FROM stocktaking_records WHERE id = ?').get(created.body.data.id) as any).is_deleted).toBe(0)
    expect(db.prepare('SELECT id, remaining, status FROM batches WHERE material_id = ? ORDER BY id').all(fixture.materialId)).toEqual(beforeBatches)
    expectConserved(fixture.materialId, 15)
  })

  it('reversal deletes recheck the active record after acquiring the write lock', async () => {
    const scenarios = [
      { route: '/api/v1/returns', table: 'return_records', expectedAfterCreate: 12, body: { reason: 'unused' } },
      { route: '/api/v1/scraps', table: 'scrap_records', expectedAfterCreate: 8, body: { reason: 'expired' } },
      { route: '/api/v1/supplier-returns', table: 'supplier_returns', expectedAfterCreate: 8, body: { reason: 'quality_issue' } },
    ]
    for (const scenario of scenarios) {
      const fixture = seedMaterial(`LOCK-RECHECK-${scenario.table}`, [{ quantity: 10, expiry: '2027-01-01' }])
      const created = await post(scenario.route, nextId(`IDEM-${scenario.table}`), {
        materialId: fixture.materialId,
        quantity: 2,
        ...scenario.body,
      })
      expect(created.status).toBe(200)
      expectConserved(fixture.materialId, scenario.expectedAfterCreate)

      const response = await injectBeforeWriteLock(
        () => { db.prepare(`UPDATE ${scenario.table} SET is_deleted = 1 WHERE id = ?`).run(created.body.data.id) },
        () => request(app).delete(`${scenario.route}/${created.body.data.id}`),
      )

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('CONCURRENT_MODIFICATION')
      expectConserved(fixture.materialId, scenario.expectedAfterCreate)
    }
  })

  it('inbound delete and cancel recheck the source record after acquiring the write lock', async () => {
    for (const operation of ['delete', 'cancel'] as const) {
      const fixture = seedMaterial(`INBOUND-LOCK-${operation}`)
      const created = await post('/api/v1/inbound', nextId(`IDEM-INBOUND-LOCK-${operation}`), {
        type: 'direct',
        materialId: fixture.materialId,
        quantity: 5,
        locationId: fixture.locationId,
      })
      expect(created.status).toBe(201)
      expectConserved(fixture.materialId, 5)

      const response = await injectBeforeWriteLock(
        () => {
          if (operation === 'delete') {
            db.prepare('UPDATE inbound_records SET is_deleted = 1 WHERE id = ?').run(created.body.data.id)
          } else {
            db.prepare("UPDATE inbound_records SET status = 'cancelled' WHERE id = ?").run(created.body.data.id)
          }
        },
        () => operation === 'delete'
          ? request(app).delete(`/api/v1/inbound/${created.body.data.id}`)
          : request(app).post(`/api/v1/inbound/${created.body.data.id}/cancel`).send({ reason: 'race' }),
      )

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('CONCURRENT_MODIFICATION')
      expectConserved(fixture.materialId, 5)
    }
  })
})
