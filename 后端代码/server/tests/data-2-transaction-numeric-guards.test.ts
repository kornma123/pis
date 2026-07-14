/**
 * DATA-2 · 库存交易数值入口护栏（TDD 红测）
 *
 * 目标：所有外部交易数值在读取幂等键、开启持久事务或写业务表前，先完成
 * 类型、有限性和既有正负/零值语义校验。非法输入不得污染库存、批次、采购状态、
 * 业务流水或幂等键；全局 auditWrite 对 4xx 写入保留 denied 审计不属于业务污染。
 *
 * 本文件刻意不定义 FEFO 跨批次、历史清洗、DB CHECK、权限或 BOM 产品去留。
 */
process.env.DATABASE_PATH = ':memory:'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-data-2'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { Response, Test } from 'supertest'
import {
  parseFiniteNonNegativeNumber,
  parseFiniteNumber,
  parseFinitePositiveNumber,
} from '../src/utils/numeric-input.js'
import { fingerprintRequest } from '../src/utils/idempotency.js'

const RAW_1E400 = '__RAW_JSON_1E400__'

type Fixture = {
  suffix: string
  categoryId: string
  supplierId: string
  fromLocationId: string
  toLocationId: string
  materialId: string
  inboundId: string
  batchId: string
  purchaseOrderId: string
  projectId: string
  bomId: string
  supplierReturnId: string
  keyPrefix: string
}

type ExecSpy = {
  mock: { calls: unknown[][] }
  mockClear(): void
  mockImplementation(implementation: (sql: string) => void): unknown
  mockRestore(): void
}

let app: Express
let db: DatabaseSync
let token = ''
let sequence = 0
let execSpy: ExecSpy

function auth(req: Test, idempotencyKey?: string): Test {
  req.set('Authorization', `Bearer ${token}`)
  if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey)
  return req
}

function rawJson(payload: unknown): string {
  return JSON.stringify(payload).replace(JSON.stringify(RAW_1E400), '1e400')
}

function postRaw(path: string, payload: unknown, idempotencyKey?: string): Test {
  return auth(request(app).post(path), idempotencyKey)
    .set('Content-Type', 'application/json')
    .send(rawJson(payload))
}

function putRaw(path: string, payload: unknown, idempotencyKey?: string): Test {
  return auth(request(app).put(path), idempotencyKey)
    .set('Content-Type', 'application/json')
    .send(rawJson(payload))
}

function nextSuffix(label: string): string {
  sequence += 1
  return `${label}-${Date.now()}-${sequence}`
}

function seedFixture(label: string, options: { stock?: number; price?: number } = {}): Fixture {
  const suffix = nextSuffix(label)
  const stock = options.stock ?? 100
  const price = options.price ?? 10
  const categoryId = `cat-${suffix}`
  const supplierId = `sup-${suffix}`
  const fromLocationId = `loc-a-${suffix}`
  const toLocationId = `loc-b-${suffix}`
  const materialId = `mat-${suffix}`
  const inboundId = `ib-${suffix}`
  const batchId = `batch-${suffix}`
  const purchaseOrderId = `po-${suffix}`
  const projectId = `project-${suffix}`
  const bomId = `bom-${suffix}`
  const supplierReturnId = `sr-${suffix}`

  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, 1)')
    .run(categoryId, `CAT-${suffix}`, 'DATA-2 分类')
  db.prepare('INSERT INTO suppliers (id, code, name, status) VALUES (?, ?, ?, 1)')
    .run(supplierId, `SUP-${suffix}`, 'DATA-2 供应商')
  db.prepare("INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, 'shelf', 'A', 1)")
    .run(fromLocationId, `LOC-A-${suffix}`, 'DATA-2 A 库位')
  db.prepare("INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, 'shelf', 'B', 1)")
    .run(toLocationId, `LOC-B-${suffix}`, 'DATA-2 B 库位')
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, supplier_id, price, location_id, status)
    VALUES (?, ?, 'DATA-2 物料', '瓶', ?, ?, ?, ?, 1)
  `).run(materialId, `MAT-${suffix}`, categoryId, supplierId, price, fromLocationId)
  db.prepare(`
    INSERT INTO inbound_records
      (id, inbound_no, type, material_id, batch_no, quantity, unit, price, amount,
       supplier_id, location_id, operator, status)
    VALUES (?, ?, 'direct', ?, ?, 5, '瓶', ?, ?, ?, ?, 'seed', 'completed')
  `).run(inboundId, `IB-SEED-${suffix}`, materialId, `B-${suffix}`, price, price * 5, supplierId, fromLocationId)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock, location_id) VALUES (?, ?, ?, 0, ?)')
    .run(`inv-${suffix}`, materialId, stock, fromLocationId)
  db.prepare(`
    INSERT INTO batches
      (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, supplier_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(batchId, materialId, `B-${suffix}`, stock, stock, inboundId, price, supplierId)
  db.prepare(`
    INSERT INTO purchase_orders
      (id, order_no, material_id, material_name, supplier_id, ordered_qty, received_qty,
       unit, unit_price, total_amount, status)
    VALUES (?, ?, ?, 'DATA-2 物料', ?, 100, 0, '瓶', 10, 1000, 'pending')
  `).run(purchaseOrderId, `PO-${suffix}`, materialId, supplierId)
  db.prepare(`
    INSERT INTO projects (id, code, name, type, status)
    VALUES (?, ?, 'DATA-2 项目', 'ihc', 1)
  `).run(projectId, `PROJECT-${suffix}`)
  db.prepare(`
    INSERT INTO boms (id, code, name, version, type, status)
    VALUES (?, ?, 'DATA-2 BOM', 'v1.0', 'ihc', 1)
  `).run(bomId, `BOM-${suffix}`)
  db.prepare(`
    INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
    VALUES (?, ?, ?, 1, '瓶')
  `).run(`bom-item-${suffix}`, bomId, materialId)
  db.prepare(`
    INSERT INTO supplier_returns
      (id, return_no, material_id, quantity, supplier_id, inbound_record_id, reason,
       refund_amount, status, operator)
    VALUES (?, ?, ?, 1, ?, ?, 'quality_issue', 0, 'pending', 'seed')
  `).run(supplierReturnId, `SR-SEED-${suffix}`, materialId, supplierId, inboundId)

  return {
    suffix,
    categoryId,
    supplierId,
    fromLocationId,
    toLocationId,
    materialId,
    inboundId,
    batchId,
    purchaseOrderId,
    projectId,
    bomId,
    supplierReturnId,
    keyPrefix: `data2-${suffix}-`,
  }
}

function seedOutboundForUpdate(fixture: Fixture): string {
  const outboundId = `ob-${fixture.suffix}`
  const outboundItemId = `ob-item-${fixture.suffix}`
  const trackingId = `TRK-SEED-${fixture.suffix}`
  const batchNo = `B-${fixture.suffix}`

  db.prepare(`
    INSERT INTO outbound_records
      (id, outbound_no, type, project_id, total_cost, operator, status)
    VALUES (?, ?, 'project', ?, 10, 'seed', 'completed')
  `).run(outboundId, `OB-SEED-${fixture.suffix}`, fixture.projectId)
  db.prepare(`
    INSERT INTO outbound_items
      (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage)
    VALUES (?, ?, ?, ?, ?, 1, '瓶', 10, 10, 'self')
  `).run(outboundItemId, outboundId, fixture.materialId, fixture.batchId, batchNo)
  db.prepare('UPDATE inventory SET stock = 99 WHERE material_id = ?').run(fixture.materialId)
  db.prepare('UPDATE batches SET remaining = 99 WHERE id = ?').run(fixture.batchId)
  db.prepare(`
    INSERT INTO batch_usage_tracking
      (id, material_id, material_name, batch, spec, total_qty, remaining, unit,
       start_date, days_used, expected_days, progress, usage, status)
    VALUES (?, ?, 'DATA-2 物料', ?, '', 1, 1, '瓶', '2026-07-12', 0, 30, 0, 'self', 'in-use')
  `).run(trackingId, fixture.materialId, batchNo)
  db.prepare(`
    INSERT INTO stock_logs
      (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
    VALUES (?, 'outbound', ?, -1, 100, 99, ?, 'outbound', 'seed')
  `).run(`log-${fixture.suffix}`, fixture.materialId, outboundId)
  return outboundId
}

function rows(sql: string, ...params: unknown[]): unknown[] {
  return db.prepare(sql).all(...params)
}

function snapshot(fixture: Fixture): Record<string, unknown> {
  return {
    inbound: rows(`
      SELECT id, type, quantity, price, amount, status, is_deleted, purchase_order_id
      FROM inbound_records WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    inventory: rows(`
      SELECT id, stock, locked_stock, location_id, last_inbound_id, last_outbound_id
      FROM inventory WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    batches: rows(`
      SELECT id, quantity, remaining, inbound_price, status
      FROM batches WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    purchaseOrders: rows(`
      SELECT id, ordered_qty, received_qty, unit_price, total_amount, status, is_deleted
      FROM purchase_orders WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    outboundRecords: rows(`
      SELECT DISTINCT r.id, r.total_cost, r.status, r.is_deleted
      FROM outbound_records r
      LEFT JOIN outbound_items oi ON oi.outbound_id = r.id
      WHERE r.project_id = ? OR oi.material_id = ?
      ORDER BY r.id
    `, fixture.projectId, fixture.materialId),
    outboundItems: rows(`
      SELECT oi.id, oi.outbound_id, oi.batch_id, oi.quantity, oi.unit_cost, oi.total_cost
      FROM outbound_items oi WHERE oi.material_id = ? ORDER BY oi.id
    `, fixture.materialId),
    outboundAbc: rows(`
      SELECT id, outbound_id, sample_count, material_cost, total_cost
      FROM outbound_abc_details WHERE project_id = ? OR bom_id = ? ORDER BY id
    `, fixture.projectId, fixture.bomId),
    stocktaking: rows(`
      SELECT id, system_stock, actual_stock, difference, status, is_deleted
      FROM stocktaking_records WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    returns: rows(`
      SELECT id, quantity, status, is_deleted FROM return_records
      WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    scraps: rows(`
      SELECT id, quantity, status, is_deleted FROM scrap_records
      WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    supplierReturns: rows(`
      SELECT id, quantity, refund_amount, status, is_deleted FROM supplier_returns
      WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    usageTracking: rows(`
      SELECT id, total_qty, remaining, status FROM batch_usage_tracking
      WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    stockLogs: rows(`
      SELECT id, type, quantity, before_stock, after_stock, related_id, related_type
      FROM stock_logs WHERE material_id = ? ORDER BY id
    `, fixture.materialId),
    idempotency: rows(`
      SELECT idempotency_key, scope, request_fingerprint, status_code, response_body
      FROM idempotency_keys WHERE idempotency_key LIKE ? ORDER BY idempotency_key
    `, `${fixture.keyPrefix}%`),
  }
}

function beginImmediateCalls(): unknown[][] {
  return execSpy.mock.calls.filter((call: unknown[]) => /\bBEGIN\s+IMMEDIATE\b/i.test(String(call[0])))
}

async function expectRejectedWithoutBusinessEffects(
  responsePromise: PromiseLike<Response>,
  fixture: Fixture,
  before: Record<string, unknown>,
  expectedStatus = 400,
  expectedCode = 'INVALID_PARAMETER',
): Promise<void> {
  const response = await responsePromise
  expect.soft(response.status).toBe(expectedStatus)
  expect.soft(response.body?.error?.code).toBe(expectedCode)
  expect.soft(snapshot(fixture)).toEqual(before)
  expect.soft(beginImmediateCalls()).toEqual([])
}

beforeAll(async () => {
  const { default: loadedApp } = await import('../src/app.js')
  const { getDatabase } = await import('../src/database/DatabaseManager.js')
  app = loadedApp
  db = getDatabase()
  const login = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })
  expect(login.status).toBe(200)
  token = login.body.data.token
  execSpy = vi.spyOn(db, 'exec')
})

beforeEach(() => {
  execSpy?.mockClear()
})

afterAll(() => {
  execSpy?.mockRestore()
})

describe('DATA-2 shared numeric helper contract', () => {
  it.each([
    { label: 'boolean', value: true },
    { label: 'array', value: [1] },
    { label: 'object', value: { value: 1 } },
    { label: 'null', value: null },
    { label: 'blank string', value: '   ' },
  ])('rejects $label without broad JavaScript coercion', ({ value }) => {
    expect(parseFiniteNumber(value)).toBeNull()
  })

  it('normalizes complete numeric strings and preserves sign-specific zero semantics', () => {
    expect(parseFiniteNumber(' -2.5 ')).toBe(-2.5)
    expect(parseFinitePositiveNumber('2.5')).toBe(2.5)
    expect(parseFinitePositiveNumber(0)).toBeNull()
    expect(parseFinitePositiveNumber(-1)).toBeNull()
    expect(parseFiniteNonNegativeNumber('0')).toBe(0)
    expect(parseFiniteNonNegativeNumber(-1)).toBeNull()
  })
})

describe('DATA-2 inbound / purchase-order numeric guards', () => {
  it('finite inbound price and quantity whose amount overflows are rejected before idempotency or transaction', async () => {
    const f = seedFixture('inbound-create-amount-overflow')
    const before = snapshot(f)
    const key = `${f.keyPrefix}inbound-amount-overflow`
    await expectRejectedWithoutBusinessEffects(auth(request(app).post('/api/v1/inbound'), key).send({
      type: 'direct',
      materialId: f.materialId,
      batchNo: `B-OVERFLOW-${f.suffix}`,
      quantity: 2,
      price: 1e308,
      supplierId: f.supplierId,
      locationId: f.fromLocationId,
    }), f, before)
  })

  it('raw JSON 1e400 inbound price is rejected before idempotency claim or transaction', async () => {
    const f = seedFixture('inbound-create-price')
    const before = snapshot(f)
    const key = `${f.keyPrefix}inbound-create`
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/inbound', {
      type: 'direct',
      materialId: f.materialId,
      batchNo: `B-NEW-${f.suffix}`,
      quantity: 2,
      price: RAW_1E400,
      supplierId: f.supplierId,
      locationId: f.fromLocationId,
    }, key), f, before)
  })

  it.each([
    {
      label: 'inventory stock addition',
      prepare: (f: Fixture) => db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(1e308, f.materialId),
      body: (f: Fixture) => ({ batchNo: `B-NEW-${f.suffix}` }),
    },
    {
      label: 'existing batch quantity/remaining addition',
      prepare: (f: Fixture) => db.prepare('UPDATE batches SET quantity = ?, remaining = ? WHERE id = ?').run(1e308, 1e308, f.batchId),
      body: (f: Fixture) => ({ batchNo: `B-${f.suffix}` }),
    },
    {
      label: 'purchase-order received quantity addition',
      prepare: (f: Fixture) => db.prepare('UPDATE purchase_orders SET ordered_qty = ?, received_qty = ? WHERE id = ?').run(1e308, 1e308, f.purchaseOrderId),
      body: (f: Fixture) => ({ purchaseOrderId: f.purchaseOrderId }),
    },
  ])('finite inbound quantity is rejected when $label overflows', async ({ label, prepare, body }) => {
    const f = seedFixture(`inbound-${label.replace(/\W+/g, '-')}`)
    prepare(f)
    const before = snapshot(f)
    const key = `${f.keyPrefix}inbound-db-add-overflow`
    await expectRejectedWithoutBusinessEffects(auth(request(app).post('/api/v1/inbound'), key).send({
      type: 'direct',
      materialId: f.materialId,
      quantity: 1e308,
      price: 0,
      supplierId: f.supplierId,
      locationId: f.fromLocationId,
      ...body(f),
    }), f, before)
  })

  it('negative inbound update price is rejected before transaction and stock log write', async () => {
    const f = seedFixture('inbound-update-price')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(
      auth(request(app).put(`/api/v1/inbound/${f.inboundId}`)).send({ price: -1 }),
      f,
      before,
    )
  })

  it('inbound restore rejects finite inventory addition overflow before transaction', async () => {
    const f = seedFixture('inbound-update-restore-overflow')
    db.prepare("UPDATE inbound_records SET quantity = ?, status = 'cancelled' WHERE id = ?").run(1e308, f.inboundId)
    db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(1e308, f.materialId)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(
      auth(request(app).put(`/api/v1/inbound/${f.inboundId}`)).send({ status: 'completed' }),
      f,
      before,
    )
  })

  it('inbound completed quantity edit rejects finite inventory delta overflow before transaction', async () => {
    const f = seedFixture('inbound-update-quantity-overflow')
    db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(1e308, f.materialId)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(
      auth(request(app).put(`/api/v1/inbound/${f.inboundId}`)).send({ quantity: 1e308 }),
      f,
      before,
    )
  })

  it('inbound update reports a missing inventory row explicitly before opening a transaction', async () => {
    const f = seedFixture('inbound-update-missing-inventory')
    db.prepare('DELETE FROM inventory WHERE material_id = ?').run(f.materialId)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(
      auth(request(app).put(`/api/v1/inbound/${f.inboundId}`)).send({ quantity: 6 }),
      f,
      before,
      422,
      'INVENTORY_NOT_FOUND',
    )
  })

  it('inbound quantity edit reuses finite plan values in the stock log', async () => {
    const f = seedFixture('inbound-update-finite-log')
    db.prepare('UPDATE inbound_records SET quantity = ? WHERE id = ?').run(8e307, f.inboundId)
    db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(Number.MAX_VALUE, f.materialId)
    db.prepare('UPDATE batches SET quantity = ?, remaining = ? WHERE id = ?').run(8e307, 8e307, f.batchId)

    const response = await auth(request(app).put(`/api/v1/inbound/${f.inboundId}`)).send({ quantity: 1 })
    expect(response.status).toBe(200)

    const inventoryStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(f.materialId) as { stock: number }).stock
    const log = db.prepare(`
      SELECT quantity, before_stock, after_stock
      FROM stock_logs
      WHERE related_id = ? AND related_type = 'inbound_update'
      ORDER BY created_at DESC LIMIT 1
    `).get(f.inboundId) as { before_stock: number; after_stock: number }
    expect(Number.isFinite(inventoryStock)).toBe(true)
    expect(Number.isFinite(log.before_stock)).toBe(true)
    expect(Number.isFinite(log.after_stock)).toBe(true)
    expect(log.before_stock).toBe(Number.MAX_VALUE)
    expect(log.after_stock).toBe(inventoryStock)
  })

  it('inbound update rolls back when the source record changes before the locked recheck', async () => {
    const f = seedFixture('inbound-update-source-conflict')
    const before = snapshot(f)
    const originalPrepare = db.prepare.bind(db)
    let sourceReads = 0
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql === 'SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0') {
        sourceReads += 1
        if (sourceReads === 2) {
          originalPrepare('UPDATE inbound_records SET quantity = ? WHERE id = ?').run(6, f.inboundId)
        }
      }
      return originalPrepare(sql)
    })

    try {
      const response = await auth(request(app).put(`/api/v1/inbound/${f.inboundId}`)).send({ quantity: 7 })
      expect(response.status).toBe(409)
      expect(response.body?.error?.code).toBe('CONCURRENT_MODIFICATION')
    } finally {
      prepareSpy.mockRestore()
    }

    expect(snapshot(f)).toEqual(before)
  })

  it('inbound update reports inventory removed while waiting for the lock and rolls back business changes', async () => {
    const f = seedFixture('inbound-update-inventory-lock-drift')
    const before = snapshot(f)
    const expectedAfterDrift = JSON.parse(JSON.stringify(before)) as Record<string, unknown>
    expectedAfterDrift.inventory = []
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    let injected = false
    execSpy.mockImplementation((sql: string) => {
      if (!injected && /^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        injected = true
        db.prepare('DELETE FROM inventory WHERE material_id = ?').run(f.materialId)
      }
      originalExec(sql)
    })

    try {
      const response = await auth(request(app).put(`/api/v1/inbound/${f.inboundId}`)).send({ quantity: 6 })
      expect.soft(response.status).toBe(422)
      expect.soft(response.body?.error?.code).toBe('INVENTORY_NOT_FOUND')
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect(snapshot(f)).toEqual(expectedAfterDrift)
  })

  it('raw JSON 1e400 purchase orderedQty is rejected without creating a purchase order', async () => {
    const f = seedFixture('purchase-ordered')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/purchase-orders', {
      materialId: f.materialId,
      materialName: 'DATA-2 物料',
      supplierId: f.supplierId,
      orderedQty: RAW_1E400,
      unitPrice: 10,
    }), f, before)
  })

  it('raw JSON 1e400 purchase unitPrice is rejected without creating a purchase order', async () => {
    const f = seedFixture('purchase-price')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/purchase-orders', {
      materialId: f.materialId,
      materialName: 'DATA-2 物料',
      supplierId: f.supplierId,
      orderedQty: 2,
      unitPrice: RAW_1E400,
    }), f, before)
  })

  it('finite purchase quantity and unit price whose totalAmount overflows are rejected without a write', async () => {
    const f = seedFixture('purchase-total-overflow')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(auth(request(app).post('/api/v1/purchase-orders')).send({
      materialId: f.materialId,
      materialName: 'DATA-2 物料',
      supplierId: f.supplierId,
      orderedQty: 2,
      unitPrice: 1e308,
    }), f, before)
  })

  it('boolean purchase receive quantity is rejected without changing receivedQty/status', async () => {
    const f = seedFixture('purchase-receive')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(
      auth(request(app).put(`/api/v1/purchase-orders/${f.purchaseOrderId}/receive`)).send({ quantity: true }),
      f,
      before,
    )
  })
})

describe('DATA-2 outbound numeric guards', () => {
  it('ordinary outbound rejects duplicate material whose aggregated quantity exceeds inventory before idempotency or transaction', async () => {
    const f = seedFixture('outbound-duplicate-material')
    const before = snapshot(f)
    const key = `${f.keyPrefix}outbound-duplicate-material`
    await expectRejectedWithoutBusinessEffects(auth(request(app).post('/api/v1/outbound'), key).send({
      type: 'project',
      projectId: f.projectId,
      items: [
        { materialId: f.materialId, quantity: 60 },
        { materialId: f.materialId, quantity: 60 },
      ],
    }), f, before, 422, 'STOCK_INSUFFICIENT')
  })

  it('ordinary outbound rejects duplicate lines that each fit but together exceed the selected first batch', async () => {
    const f = seedFixture('outbound-first-batch-insufficient', { stock: 10 })
    db.prepare("UPDATE batches SET quantity = 6, remaining = 6, expiry_date = '2026-07-13' WHERE id = ?").run(f.batchId)
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, supplier_id, expiry_date, status)
      VALUES (?, ?, ?, 4, 4, ?, 10, ?, '2027-07-13', 1)
    `).run(`batch-later-${f.suffix}`, f.materialId, `B-LATER-${f.suffix}`, f.inboundId, f.supplierId)
    const before = snapshot(f)
    const key = `${f.keyPrefix}first-batch-insufficient`

    const response = await auth(request(app).post('/api/v1/outbound'), key).send({
      type: 'project',
      projectId: f.projectId,
      items: [
        { materialId: f.materialId, quantity: 4 },
        { materialId: f.materialId, quantity: 3 },
      ],
    })

    expect.soft(response.status).toBe(422)
    expect.soft(response.body?.error?.code).toBe('STOCK_INSUFFICIENT')
    expect.soft(beginImmediateCalls()).toHaveLength(1)
    expect.soft(snapshot(f)).toEqual(before)
  })

  it('ordinary outbound rechecks the selected batch after lock acquisition and preserves a concurrent batch drift', async () => {
    const f = seedFixture('outbound-first-batch-lock-drift', { stock: 10 })
    db.prepare("UPDATE batches SET quantity = 10, remaining = 10, expiry_date = '2026-07-13' WHERE id = ?").run(f.batchId)
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, supplier_id, expiry_date, status)
      VALUES (?, ?, ?, 7, 7, ?, 10, ?, '2027-07-13', 1)
    `).run(`batch-later-${f.suffix}`, f.materialId, `B-LATER-${f.suffix}`, f.inboundId, f.supplierId)
    const before = snapshot(f)
    const expectedAfterDrift = JSON.parse(JSON.stringify(before)) as Record<string, unknown>
    const driftedBatch = (expectedAfterDrift.batches as Array<{ id: string; remaining: number }>).find((batch) => batch.id === f.batchId)
    if (!driftedBatch) throw new Error('seeded batch missing from snapshot')
    driftedBatch.remaining = 3
    const key = `${f.keyPrefix}first-batch-lock-drift`
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    let injected = false
    execSpy.mockImplementation((sql: string) => {
      if (!injected && /^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        injected = true
        db.prepare('UPDATE batches SET remaining = 3 WHERE id = ?').run(f.batchId)
      }
      originalExec(sql)
    })

    try {
      const response = await auth(request(app).post('/api/v1/outbound'), key).send({
        type: 'project',
        projectId: f.projectId,
        items: [{ materialId: f.materialId, quantity: 7 }],
      })
      expect.soft(response.status).toBe(422)
      expect.soft(response.body?.error?.code).toBe('STOCK_INSUFFICIENT')
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect(snapshot(f)).toEqual(expectedAfterDrift)
  })

  it('ordinary outbound rejects a selected batch that became inactive while waiting for the lock', async () => {
    const f = seedFixture('outbound-batch-status-lock-drift', { stock: 10 })
    db.prepare('UPDATE batches SET quantity = 10, remaining = 10 WHERE id = ?').run(f.batchId)
    const before = snapshot(f)
    const expectedAfterDrift = JSON.parse(JSON.stringify(before)) as Record<string, unknown>
    const driftedBatch = (expectedAfterDrift.batches as Array<{ id: string; status: number }>).find((batch) => batch.id === f.batchId)
    if (!driftedBatch) throw new Error('seeded batch missing from snapshot')
    driftedBatch.status = 0
    const key = `${f.keyPrefix}batch-status-lock-drift`
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    let injected = false
    execSpy.mockImplementation((sql: string) => {
      if (!injected && /^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        injected = true
        db.prepare('UPDATE batches SET status = 0 WHERE id = ?').run(f.batchId)
      }
      originalExec(sql)
    })

    try {
      const response = await auth(request(app).post('/api/v1/outbound'), key).send({
        type: 'project',
        projectId: f.projectId,
        items: [{ materialId: f.materialId, quantity: 5 }],
      })
      expect.soft(response.status).toBe(422)
      expect.soft(response.body?.error?.code).toBe('STOCK_INSUFFICIENT')
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect(snapshot(f)).toEqual(expectedAfterDrift)
  })

  it('ordinary outbound replays a same-key result committed while waiting for the lock before reporting stale stock', async () => {
    const f = seedFixture('outbound-ordinary-claim-race', { stock: 5 })
    const key = `${f.keyPrefix}ordinary-claim-race`
    const payload = {
      type: 'project',
      projectId: f.projectId,
      items: [{ materialId: f.materialId, quantity: 5 }],
    }
    const scope = 'outbound:create'
    const fingerprint = fingerprintRequest(payload)
    const replayBody = {
      success: true,
      data: { id: `already-committed-${f.suffix}`, outboundNo: `OB-COMMITTED-${f.suffix}` },
      message: 'Outbound created',
    }
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    let injected = false
    execSpy.mockImplementation((sql: string) => {
      if (!injected && /^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        injected = true
        db.prepare(`
          INSERT INTO outbound_records
            (id, outbound_no, type, project_id, total_cost, operator, status)
          VALUES (?, ?, ?, ?, 50, 'concurrent', 'completed')
        `).run(replayBody.data.id, replayBody.data.outboundNo, 'project', f.projectId)
        db.prepare(`
          INSERT INTO outbound_items
            (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage)
          VALUES (?, ?, ?, ?, ?, 5, '瓶', 10, 50, 'self')
        `).run(`committed-item-${f.suffix}`, replayBody.data.id, f.materialId, f.batchId, `B-${f.suffix}`)
        db.prepare(`
          INSERT INTO stock_logs
            (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, -5, 5, 0, ?, 'outbound', 'concurrent')
        `).run(`committed-log-${f.suffix}`, f.materialId, replayBody.data.id)
        db.prepare(`
          INSERT INTO idempotency_keys
            (idempotency_key, scope, request_fingerprint, status_code, response_body, operator)
          VALUES (?, ?, ?, 201, ?, 'concurrent')
        `).run(key, scope, fingerprint, JSON.stringify(replayBody))
        db.prepare('UPDATE inventory SET stock = 0 WHERE material_id = ?').run(f.materialId)
        db.prepare('UPDATE batches SET remaining = 0, status = 0 WHERE id = ?').run(f.batchId)
      }
      originalExec(sql)
    })

    try {
      const response = await auth(request(app).post('/api/v1/outbound'), key).send(payload)
      expect(response.status).toBe(201)
      expect(response.body).toEqual(replayBody)
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect(rows('SELECT id FROM outbound_records WHERE project_id = ?', f.projectId))
      .toEqual([{ id: replayBody.data.id }])
    expect(rows('SELECT id, outbound_id FROM outbound_items WHERE material_id = ?', f.materialId))
      .toEqual([{ id: `committed-item-${f.suffix}`, outbound_id: replayBody.data.id }])
    expect(rows('SELECT id, related_id FROM stock_logs WHERE material_id = ?', f.materialId))
      .toEqual([{ id: `committed-log-${f.suffix}`, related_id: replayBody.data.id }])
    expect(rows('SELECT idempotency_key, status_code FROM idempotency_keys WHERE idempotency_key = ?', key))
      .toEqual([{ idempotency_key: key, status_code: 201 }])
  })

  it('finite outbound quantity whose itemCost overflows is rejected before idempotency or transaction', async () => {
    const f = seedFixture('outbound-item-cost-overflow', { price: 1e200, stock: 1e200 })
    const before = snapshot(f)
    const key = `${f.keyPrefix}outbound-cost-overflow`
    await expectRejectedWithoutBusinessEffects(auth(request(app).post('/api/v1/outbound'), key).send({
      type: 'project',
      projectId: f.projectId,
      items: [{ materialId: f.materialId, quantity: 1e200 }],
    }), f, before)
  })

  it('raw JSON 1e400 outbound item quantity returns 400, not a stock error or write', async () => {
    const f = seedFixture('outbound-item')
    const before = snapshot(f)
    const key = `${f.keyPrefix}outbound-item`
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/outbound', {
      type: 'project',
      projectId: f.projectId,
      items: [{ materialId: f.materialId, quantity: RAW_1E400 }],
    }, key), f, before)
  })

  it('purchase receive locked recheck adds to the latest received quantity instead of overwriting it', async () => {
    const f = seedFixture('purchase-receive-source-drift')
    const originalPrepare = db.prepare.bind(db)
    let sourceReads = 0
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const statement = originalPrepare(sql)
      if (sql !== 'SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0') return statement
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'get') {
            return (...params: unknown[]) => {
              const row = target.get(...params)
              sourceReads += 1
              if (sourceReads === 1) {
                originalPrepare("UPDATE purchase_orders SET received_qty = 10, status = 'partial' WHERE id = ?").run(f.purchaseOrderId)
              }
              return row
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as StatementSync
    })

    try {
      const response = await auth(request(app).put(`/api/v1/purchase-orders/${f.purchaseOrderId}/receive`))
        .send({ quantity: 5 })
      expect(response.status).toBe(200)
      expect(response.body.data.receivedQty).toBe(15)
    } finally {
      prepareSpy.mockRestore()
    }

    expect(rows('SELECT received_qty, status FROM purchase_orders WHERE id = ?', f.purchaseOrderId))
      .toEqual([{ received_qty: 15, status: 'partial' }])
  })

  it('raw JSON 1e400 outbound update quantity is rejected before reading or mutating old items', async () => {
    const f = seedFixture('outbound-update-raw-quantity')
    const outboundId = seedOutboundForUpdate(f)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(putRaw(`/api/v1/outbound/${outboundId}`, {
      type: 'project',
      projectId: f.projectId,
      items: [{ materialId: f.materialId, quantity: RAW_1E400 }],
    }), f, before)
  })

  it('finite outbound update quantity whose itemCost overflows preserves old items and all stock evidence', async () => {
    const f = seedFixture('outbound-update-cost-overflow')
    const outboundId = seedOutboundForUpdate(f)
    db.prepare('UPDATE batches SET inbound_price = ? WHERE id = ?').run(1e308, f.batchId)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(auth(request(app).put(`/api/v1/outbound/${outboundId}`)).send({
      type: 'project',
      projectId: f.projectId,
      items: [{ materialId: f.materialId, quantity: 2 }],
    }), f, before)
  })

  it('outbound update rejects overflow while restoring an old item before transaction', async () => {
    const f = seedFixture('outbound-update-old-restore-overflow')
    const outboundId = seedOutboundForUpdate(f)
    db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(1e308, f.materialId)
    db.prepare('UPDATE outbound_items SET quantity = ? WHERE outbound_id = ?').run(1e308, outboundId)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(auth(request(app).put(`/api/v1/outbound/${outboundId}`)).send({
      type: 'project',
      projectId: f.projectId,
      items: [{ materialId: f.materialId, quantity: 1 }],
    }), f, before)
  })

  it('outbound update rejects duplicate material whose aggregate exceeds stock after old-item restore', async () => {
    const f = seedFixture('outbound-update-duplicate-material')
    const outboundId = seedOutboundForUpdate(f)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(auth(request(app).put(`/api/v1/outbound/${outboundId}`)).send({
      type: 'project',
      projectId: f.projectId,
      items: [
        { materialId: f.materialId, quantity: 60 },
        { materialId: f.materialId, quantity: 60 },
      ],
    }), f, before, 422, 'STOCK_INSUFFICIENT')
  })

  it('outbound update rolls back when the selected first batch remains insufficient after restoring old items', async () => {
    const f = seedFixture('outbound-update-first-batch-insufficient', { stock: 10 })
    const outboundId = seedOutboundForUpdate(f)
    db.prepare('UPDATE inventory SET stock = 9 WHERE material_id = ?').run(f.materialId)
    db.prepare("UPDATE batches SET quantity = 3, remaining = 3, expiry_date = '2026-07-13' WHERE id = ?").run(f.batchId)
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, supplier_id, expiry_date, status)
      VALUES (?, ?, ?, 7, 7, ?, 10, ?, '2027-07-13', 1)
    `).run(`batch-later-${f.suffix}`, f.materialId, `B-LATER-${f.suffix}`, f.inboundId, f.supplierId)
    const before = snapshot(f)

    const response = await auth(request(app).put(`/api/v1/outbound/${outboundId}`)).send({
      type: 'project',
      projectId: f.projectId,
      items: [
        { materialId: f.materialId, quantity: 4 },
        { materialId: f.materialId, quantity: 3 },
      ],
    })

    expect.soft(response.status).toBe(422)
    expect.soft(response.body?.error?.code).toBe('STOCK_INSUFFICIENT')
    expect.soft(beginImmediateCalls()).toHaveLength(1)
    expect.soft(snapshot(f)).toEqual(before)
  })

  it('outbound update applies restore-old then subtract-new plan with accurate stock evidence', async () => {
    const f = seedFixture('outbound-update-valid-plan')
    const outboundId = seedOutboundForUpdate(f)

    const response = await auth(request(app).put(`/api/v1/outbound/${outboundId}`)).send({
      type: 'project',
      projectId: f.projectId,
      items: [{ materialId: f.materialId, quantity: 2 }],
    })
    expect(response.status).toBe(200)

    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(f.materialId) as { stock: number }).stock).toBe(98)
    expect((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(f.batchId) as { remaining: number }).remaining).toBe(98)

    const updatedItems = rows('SELECT id, quantity FROM outbound_items WHERE outbound_id = ?', outboundId) as Array<{ id: string; quantity: number }>
    expect(updatedItems).toHaveLength(1)
    expect(updatedItems[0].id).not.toBe(`ob-item-${f.suffix}`)
    expect(updatedItems[0].quantity).toBe(2)

    const tracking = rows("SELECT id, total_qty, remaining FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'", f.materialId, `B-${f.suffix}`) as Array<{ id: string; total_qty: number; remaining: number }>
    expect(tracking).toHaveLength(1)
    expect(tracking[0].id).not.toBe(`TRK-SEED-${f.suffix}`)
    expect(tracking[0].total_qty).toBe(2)
    expect(tracking[0].remaining).toBe(2)

    const updateLogs = rows('SELECT quantity, before_stock, after_stock FROM stock_logs WHERE related_id = ? AND id != ? ORDER BY rowid', outboundId, `log-${f.suffix}`) as Array<{ quantity: number; before_stock: number; after_stock: number }>
    expect(updateLogs).toEqual([
      { quantity: 1, before_stock: 99, after_stock: 100 },
      { quantity: -2, before_stock: 100, after_stock: 98 },
    ])
  })

  it('outbound update locked recheck rejects a record deleted after preflight without replaying stock', async () => {
    const f = seedFixture('outbound-update-delete-conflict')
    const outboundId = seedOutboundForUpdate(f)
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    execSpy.mockImplementation((sql: string) => {
      if (/^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        db.prepare('UPDATE outbound_records SET is_deleted = 1 WHERE id = ?').run(outboundId)
        db.prepare('UPDATE inventory SET stock = 100 WHERE material_id = ?').run(f.materialId)
        db.prepare('UPDATE batches SET remaining = 100, status = 1 WHERE id = ?').run(f.batchId)
      }
      originalExec(sql)
    })

    try {
      const response = await auth(request(app).put(`/api/v1/outbound/${outboundId}`)).send({
        type: 'project',
        projectId: f.projectId,
        items: [{ materialId: f.materialId, quantity: 2 }],
      })
      expect(response.status).toBe(409)
      expect(response.body?.error?.code).toBe('CONCURRENT_MODIFICATION')
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect(rows('SELECT is_deleted, total_cost FROM outbound_records WHERE id = ?', outboundId))
      .toEqual([{ is_deleted: 1, total_cost: 10 }])
    expect(rows('SELECT id, quantity FROM outbound_items WHERE outbound_id = ?', outboundId))
      .toEqual([{ id: `ob-item-${f.suffix}`, quantity: 1 }])
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(f.materialId) as { stock: number }).stock).toBe(100)
    expect((db.prepare('SELECT remaining FROM batches WHERE id = ?').get(f.batchId) as { remaining: number }).remaining).toBe(100)
    expect(rows('SELECT quantity, before_stock, after_stock FROM stock_logs WHERE related_id = ?', outboundId))
      .toEqual([{ quantity: -1, before_stock: 100, after_stock: 99 }])
  })
})

describe('DATA-2 stocktaking / returns / scraps / transfers numeric guards', () => {
  it('finite stocktaking values whose actual-minus-system difference overflows are rejected without a write', async () => {
    const f = seedFixture('stocktaking-difference-overflow', { stock: -1e308 })
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(auth(request(app).post('/api/v1/stocktaking')).send({
      materialId: f.materialId,
      actualStock: 1e308,
    }), f, before)
  })

  it('raw JSON 1e400 single stocktaking actualStock is rejected without registering a count', async () => {
    const f = seedFixture('stocktaking-single')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/stocktaking', {
      materialId: f.materialId,
      actualStock: RAW_1E400,
    }), f, before)
  })

  it('raw JSON 1e400 batch stocktaking actualStock is rejected before the batch transaction', async () => {
    const f = seedFixture('stocktaking-batch')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/stocktaking/batch', {
      items: [{ materialId: f.materialId, actualStock: RAW_1E400 }],
    }), f, before, 422)
  })

  it('finite return quantity whose inventory addition overflows is rejected before transaction', async () => {
    const f = seedFixture('returns-stock-overflow', { stock: 1e308 })
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(auth(request(app).post('/api/v1/returns')).send({
      materialId: f.materialId,
      quantity: 1e308,
      reason: 'excess',
    }), f, before)
  })

  it('raw JSON 1e400 return quantity is rejected before inventory is increased', async () => {
    const f = seedFixture('returns')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/returns', {
      materialId: f.materialId,
      quantity: RAW_1E400,
      reason: 'excess',
    }), f, before)
  })

  it('raw JSON 1e400 scrap quantity returns 400, not STOCK_INSUFFICIENT', async () => {
    const f = seedFixture('scraps')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/scraps', {
      materialId: f.materialId,
      quantity: RAW_1E400,
      reason: 'expired',
    }), f, before)
  })

  it('scrap locked plan logs the current stock balance instead of a stale preflight snapshot', async () => {
    const f = seedFixture('scrap-stock-drift', { stock: 10 })
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    execSpy.mockImplementation((sql: string) => {
      if (/^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        db.prepare('UPDATE inventory SET stock = 8 WHERE material_id = ?').run(f.materialId)
      }
      originalExec(sql)
    })
    let scrapId = ''

    try {
      const response = await auth(request(app).post('/api/v1/scraps')).send({
        materialId: f.materialId,
        quantity: 5,
        reason: 'expired',
      })
      expect(response.status).toBe(200)
      scrapId = response.body.data.id
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(f.materialId) as { stock: number }).stock).toBe(3)
    expect(rows('SELECT quantity, before_stock, after_stock FROM stock_logs WHERE related_id = ?', scrapId))
      .toEqual([{ quantity: -5, before_stock: 8, after_stock: 3 }])
  })

  it('raw JSON 1e400 transfer quantity is rejected before transfer record/location mutation', async () => {
    const f = seedFixture('transfers')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/transfers/inbound', {
      materialId: f.materialId,
      quantity: RAW_1E400,
      fromLocationId: f.fromLocationId,
      toLocationId: f.toLocationId,
    }), f, before)
  })

  it('transfer locked recheck logs the current stock balance after a preflight drift', async () => {
    const f = seedFixture('transfer-stock-drift', { stock: 10 })
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    execSpy.mockImplementation((sql: string) => {
      if (/^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        db.prepare('UPDATE inventory SET stock = 8 WHERE material_id = ?').run(f.materialId)
      }
      originalExec(sql)
    })
    let transferId = ''

    try {
      const response = await auth(request(app).post('/api/v1/transfers/inbound')).send({
        materialId: f.materialId,
        quantity: 2,
        fromLocationId: f.fromLocationId,
        toLocationId: f.toLocationId,
      })
      expect(response.status).toBe(200)
      transferId = response.body.data.id
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(f.materialId) as { stock: number }).stock).toBe(8)
    expect(rows('SELECT quantity, before_stock, after_stock FROM stock_logs WHERE related_id = ?', transferId))
      .toEqual([{ quantity: 0, before_stock: 8, after_stock: 8 }])
  })
})

describe('DATA-2 supplier-return quantity/refund numeric guards', () => {
  it('raw JSON 1e400 supplier-return quantity returns 400, not STOCK_INSUFFICIENT', async () => {
    const f = seedFixture('supplier-return-quantity')
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(postRaw('/api/v1/supplier-returns', {
      materialId: f.materialId,
      quantity: RAW_1E400,
      supplierId: f.supplierId,
      reason: 'quality_issue',
    }), f, before)
  })

  it.each([
    { label: 'negative', refundAmount: -1 },
    { label: 'raw JSON 1e400', refundAmount: RAW_1E400 },
  ])('$label supplier-return create refundAmount is rejected before stock/refund write', async ({ refundAmount }) => {
    const f = seedFixture(`supplier-return-refund-create-${String(refundAmount)}`, { price: 0 })
    const before = snapshot(f)
    const payload = {
      materialId: f.materialId,
      quantity: 1,
      supplierId: f.supplierId,
      reason: 'quality_issue',
      refundAmount,
    }
    const response = refundAmount === RAW_1E400
      ? postRaw('/api/v1/supplier-returns', payload)
      : auth(request(app).post('/api/v1/supplier-returns')).send(payload)
    await expectRejectedWithoutBusinessEffects(response, f, before)
  })

  it('supplier-return create falls back from a linked zero-price receipt to the next positive source', async () => {
    const f = seedFixture('supplier-return-create-linked-zero-fallback')
    db.prepare('UPDATE inbound_records SET price = 0 WHERE id = ?').run(f.inboundId)

    const response = await auth(request(app).post('/api/v1/supplier-returns')).send({
      materialId: f.materialId,
      quantity: 1,
      supplierId: f.supplierId,
      inboundRecordId: f.inboundId,
      reason: 'quality_issue',
      refundAmount: 5,
    })

    expect(response.status).toBe(200)
    expect(rows(`
      SELECT refund_amount FROM supplier_returns
      WHERE material_id = ? AND id != ? ORDER BY created_at DESC
    `, f.materialId, f.supplierReturnId)).toEqual([{ refund_amount: 5 }])
  })

  it('supplier-return locked recheck preserves a newer stock balance and rolls back when it is insufficient', async () => {
    const f = seedFixture('supplier-return-stock-drift', { stock: 10 })
    const before = snapshot(f)
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    execSpy.mockImplementation((sql: string) => {
      if (/^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        db.prepare('UPDATE inventory SET stock = 2 WHERE material_id = ?').run(f.materialId)
      }
      originalExec(sql)
    })

    try {
      const response = await auth(request(app).post('/api/v1/supplier-returns')).send({
        materialId: f.materialId,
        quantity: 5,
        supplierId: f.supplierId,
        reason: 'quality_issue',
      })
      expect(response.status).toBe(422)
      expect(response.body?.error?.code).toBe('STOCK_INSUFFICIENT')
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    const after = snapshot(f)
    expect((after.inventory as Array<{ stock: number }>)[0].stock).toBe(2)
    expect(after.supplierReturns).toEqual(before.supplierReturns)
    expect(after.stockLogs).toEqual(before.stockLogs)
  })

  it('raw JSON 1e400 refund correction is rejected before refund/audit transaction', async () => {
    const f = seedFixture('supplier-return-refund-update', { price: 0 })
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(
      putRaw(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`, { refundAmount: RAW_1E400 }),
      f,
      before,
    )
  })

  it('refund correction locked recheck cannot overwrite a return that became refunded', async () => {
    const f = seedFixture('supplier-return-refund-status-drift')
    const originalExec = Object.getPrototypeOf(db).exec.bind(db) as (sql: string) => void
    execSpy.mockImplementation((sql: string) => {
      if (/^BEGIN\s+IMMEDIATE$/i.test(sql)) {
        db.prepare("UPDATE supplier_returns SET status = 'refunded' WHERE id = ?").run(f.supplierReturnId)
      }
      originalExec(sql)
    })

    try {
      const response = await auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`))
        .send({ refundAmount: 5 })
      expect(response.status).toBe(409)
      expect(response.body?.error?.code).toBe('REFUND_LOCKED')
    } finally {
      execSpy.mockImplementation(originalExec)
      execSpy.mockClear()
    }

    expect(rows('SELECT status, refund_amount FROM supplier_returns WHERE id = ?', f.supplierReturnId))
      .toEqual([{ status: 'refunded', refund_amount: 0 }])
    expect(rows("SELECT id FROM operation_logs WHERE operation = 'supplier_return_refund_amount' AND request_data LIKE ?", `%${f.supplierReturnId}%`))
      .toEqual([])
  })

  it('refund correction rejects a non-finite source price before transaction or audit write', async () => {
    const f = seedFixture('supplier-return-refund-source-overflow')
    db.prepare('UPDATE inbound_records SET price = ? WHERE id = ?').run(Number.POSITIVE_INFINITY, f.inboundId)
    const before = snapshot(f)
    await expectRejectedWithoutBusinessEffects(
      auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`)).send({ refundAmount: 1 }),
      f,
      before,
    )
    expect(rows("SELECT id FROM operation_logs WHERE operation = 'supplier_return_refund_amount' AND request_data LIKE ?", `%${f.supplierReturnId}%`))
      .toEqual([])
  })

  it('refund correction falls back from a NULL linked inbound price to the next finite source', async () => {
    const f = seedFixture('supplier-return-refund-null-fallback')
    db.prepare('UPDATE inbound_records SET price = NULL WHERE id = ?').run(f.inboundId)
    const response = await auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`))
      .send({ refundAmount: 5 })
    expect(response.status).toBe(200)
    expect(rows('SELECT refund_amount FROM supplier_returns WHERE id = ?', f.supplierReturnId))
      .toEqual([{ refund_amount: 5 }])
  })

  it('refund correction falls back from a linked zero-price receipt to the next positive source', async () => {
    const f = seedFixture('supplier-return-refund-linked-zero-fallback')
    db.prepare('UPDATE inbound_records SET price = 0 WHERE id = ?').run(f.inboundId)
    const response = await auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`))
      .send({ refundAmount: 5 })
    expect(response.status).toBe(200)
    expect(rows('SELECT refund_amount FROM supplier_returns WHERE id = ?', f.supplierReturnId))
      .toEqual([{ refund_amount: 5 }])
  })

  it('refund correction falls back from an unlinked zero-price batch and still enforces the material-price cap', async () => {
    const f = seedFixture('supplier-return-refund-batch-zero-fallback')
    db.prepare('UPDATE supplier_returns SET inbound_record_id = NULL WHERE id = ?').run(f.supplierReturnId)
    db.prepare('UPDATE batches SET inbound_price = 0 WHERE id = ?').run(f.batchId)

    const accepted = await auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`))
      .send({ refundAmount: 5 })
    expect(accepted.status).toBe(200)

    execSpy.mockClear()
    const beforeRejected = snapshot(f)
    execSpy.mockClear()
    await expectRejectedWithoutBusinessEffects(
      auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`)).send({ refundAmount: 11 }),
      f,
      beforeRejected,
      422,
      'REFUND_EXCEEDS_SOURCE_COST',
    )
  })

  it('refund correction keeps the legacy no-cap behavior when every source is zero or NULL', async () => {
    const f = seedFixture('supplier-return-refund-all-zero-or-null')
    db.prepare('UPDATE inbound_records SET price = NULL WHERE id = ?').run(f.inboundId)
    db.prepare('UPDATE batches SET inbound_price = 0 WHERE id = ?').run(f.batchId)
    db.prepare('UPDATE materials SET price = 0 WHERE id = ?').run(f.materialId)

    const response = await auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`))
      .send({ refundAmount: 999 })
    expect(response.status).toBe(200)
    expect(rows('SELECT refund_amount FROM supplier_returns WHERE id = ?', f.supplierReturnId))
      .toEqual([{ refund_amount: 999 }])
  })
})

describe('DATA-2 compatibility: canonical numeric strings and existing zero semantics stay valid', () => {
  it('keeps numeric strings valid and allows zero inbound/purchase prices', async () => {
    const inboundFixture = seedFixture('compat-inbound')
    const inbound = await auth(request(app).post('/api/v1/inbound')).send({
      type: 'direct',
      materialId: inboundFixture.materialId,
      batchNo: `B-COMPAT-${inboundFixture.suffix}`,
      quantity: '2',
      price: '0',
      supplierId: inboundFixture.supplierId,
      locationId: inboundFixture.fromLocationId,
    })
    expect(inbound.status).toBe(201)

    const purchaseFixture = seedFixture('compat-purchase')
    const purchase = await auth(request(app).post('/api/v1/purchase-orders')).send({
      materialId: purchaseFixture.materialId,
      materialName: 'DATA-2 物料',
      supplierId: purchaseFixture.supplierId,
      orderedQty: '2',
      unitPrice: '0',
    })
    expect(purchase.status).toBe(200)
    const receive = await auth(request(app).put(`/api/v1/purchase-orders/${purchaseFixture.purchaseOrderId}/receive`))
      .send({ quantity: '2' })
    expect(receive.status).toBe(200)
    expect((db.prepare('SELECT received_qty FROM purchase_orders WHERE id = ?').get(purchaseFixture.purchaseOrderId) as { received_qty: number }).received_qty).toBe(2)
  })

  it('keeps positive numeric strings valid for direct outbound', async () => {
    const directFixture = seedFixture('compat-outbound-direct')
    const direct = await auth(request(app).post('/api/v1/outbound')).send({
      type: 'project',
      projectId: directFixture.projectId,
      items: [{ materialId: directFixture.materialId, quantity: '2' }],
    })
    expect(direct.status).toBe(201)
  })

  it('keeps string zero valid for stocktaking actualStock and positive strings for lane-C quantities', async () => {
    const singleFixture = seedFixture('compat-stocktaking-single')
    const single = await auth(request(app).post('/api/v1/stocktaking')).send({
      materialId: singleFixture.materialId,
      actualStock: '0',
    })
    expect(single.status).toBe(200)

    const batchFixture = seedFixture('compat-stocktaking-batch')
    const batch = await auth(request(app).post('/api/v1/stocktaking/batch')).send({
      items: [{ materialId: batchFixture.materialId, actualStock: '0' }],
    })
    expect(batch.status).toBe(201)

    const returnFixture = seedFixture('compat-return')
    const returned = await auth(request(app).post('/api/v1/returns')).send({
      materialId: returnFixture.materialId,
      quantity: '2',
      reason: 'excess',
    })
    expect(returned.status).toBe(200)

    const scrapFixture = seedFixture('compat-scrap')
    const scrapped = await auth(request(app).post('/api/v1/scraps')).send({
      materialId: scrapFixture.materialId,
      quantity: '2',
      reason: 'expired',
    })
    expect(scrapped.status).toBe(200)

    const transferFixture = seedFixture('compat-transfer')
    const transferred = await auth(request(app).post('/api/v1/transfers/inbound')).send({
      materialId: transferFixture.materialId,
      quantity: '2',
      fromLocationId: transferFixture.fromLocationId,
      toLocationId: transferFixture.toLocationId,
    })
    expect(transferred.status).toBe(200)
  })

  it('keeps supplier-return numeric strings valid and allows zero refund', async () => {
    const f = seedFixture('compat-supplier-return')
    const created = await auth(request(app).post('/api/v1/supplier-returns')).send({
      materialId: f.materialId,
      quantity: '2',
      supplierId: f.supplierId,
      reason: 'quality_issue',
      refundAmount: '0',
    })
    expect(created.status).toBe(200)
    const updated = await auth(request(app).put(`/api/v1/supplier-returns/${f.supplierReturnId}/refund-amount`))
      .send({ refundAmount: '0' })
    expect(updated.status).toBe(200)
  })
})
