import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
let seq = 0

type SeededPosition = {
  materialId: string
  positionId: string
  batchId: string | null
  locationId: string
  quantity: number
}

const FAILURE_TRIGGERS = [
  'st_fail_position',
  'st_fail_batch',
  'st_fail_cache',
  'st_fail_allocation',
  'st_fail_log',
  'st_fail_event',
]

function tableExists(name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function clearOptionalTable(name: string): void {
  if (tableExists(name)) db.exec(`DELETE FROM ${name}`)
}

function countRows(name: string): number {
  if (!tableExists(name)) return 0
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as any).count)
}

function seedRole(code: string, permissions: Record<string, 'R' | 'W'>): void {
  db.prepare(`
    INSERT OR REPLACE INTO roles (id, code, name, permissions, status, is_deleted)
    VALUES (?, ?, ?, ?, 1, 0)
  `).run(`ROLE-${code}`, code, code, JSON.stringify(permissions))
}

function withActor(role = 'admin', username = role) {
  return {
    post: (path: string) => request(app).post(path).set('x-test-role', role).set('x-test-user', username),
    delete: (path: string) => request(app).delete(path).set('x-test-role', role).set('x-test-user', username),
  }
}

function seedPosition(batchManaged: boolean, quantity = 10): SeededPosition {
  const suffix = `${++seq}`
  const materialId = `ST-MAT-${suffix}`
  const positionId = `ST-POS-${suffix}`
  const batchId = batchManaged ? `ST-BATCH-${suffix}` : null
  const locationId = 'ST-LOC'
  db.prepare(`
    INSERT INTO materials
      (id, code, name, unit, category_id, price, status, is_deleted, batch_managed)
    VALUES (?, ?, ?, 'pcs', 'ST-CAT', 10, 1, 0, ?)
  `).run(materialId, materialId, materialId, batchManaged ? 1 : 0)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES (?, ?, ?, 0)')
    .run(`ST-INV-${suffix}`, materialId, quantity)
  if (batchId) {
    db.prepare(`
      INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(batchId, materialId, batchId, quantity, quantity, `ST-IN-${suffix}`)
  }
  db.prepare(`
    INSERT INTO inventory_positions (id, material_id, batch_id, location_id, quantity)
    VALUES (?, ?, ?, ?, ?)
  `).run(positionId, materialId, batchId, locationId, quantity)
  return { materialId, positionId, batchId, locationId, quantity }
}

function recordBody(position: SeededPosition, actualStock: unknown, reason?: string) {
  return {
    positionId: position.positionId,
    materialId: position.materialId,
    locationId: position.locationId,
    actualStock,
    ...(position.batchId === null ? {} : { batchId: position.batchId }),
    ...(reason === undefined ? {} : { reason }),
    operator: 'spoofed-client-actor',
  }
}

async function record(position: SeededPosition, actualStock: unknown, reason?: string, role = 'admin') {
  return withActor(role).post('/api/v1/stocktaking').send(recordBody(position, actualStock, reason))
}

function inventoryFacts(materialId: string) {
  return {
    inventory: db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId),
    batches: db.prepare(`
      SELECT id, quantity, remaining, status FROM batches WHERE material_id = ? ORDER BY id
    `).all(materialId),
    positions: db.prepare(`
      SELECT id, material_id, batch_id, location_id, quantity, version
      FROM inventory_positions WHERE material_id = ? ORDER BY id
    `).all(materialId),
    allocations: db.prepare(`
      SELECT operation_kind, owner_id, material_id, batch_id, location_id, direction, quantity, source_allocation_id
      FROM inventory_transaction_allocations WHERE material_id = ? ORDER BY created_at, id
    `).all(materialId),
    logs: db.prepare(`
      SELECT type, quantity, before_stock, after_stock, related_id, related_type, operator, remark
      FROM stock_logs WHERE material_id = ? ORDER BY created_at, id
    `).all(materialId),
  }
}

function fullFacts(materialId: string) {
  return {
    inventory: inventoryFacts(materialId),
    records: db.prepare(`
      SELECT * FROM stocktaking_records WHERE material_id = ? ORDER BY created_at, id
    `).all(materialId),
    events: tableExists('stocktaking_adjustment_events')
      ? db.prepare(`
        SELECT * FROM stocktaking_adjustment_events WHERE material_id = ? ORDER BY chain_depth, created_at, id
      `).all(materialId)
      : [],
    explanations: tableExists('stocktaking_explanations')
      ? db.prepare('SELECT * FROM stocktaking_explanations ORDER BY created_at, id').all()
      : [],
  }
}

function oldHistory(materialId: string) {
  return {
    inbound: db.prepare('SELECT * FROM inbound_records WHERE material_id = ? ORDER BY id').all(materialId),
    outbound: db.prepare(`
      SELECT o.* FROM outbound_records o
      JOIN outbound_items i ON i.outbound_id = o.id
      WHERE i.material_id = ? ORDER BY o.id
    `).all(materialId),
    outboundItems: db.prepare('SELECT * FROM outbound_items WHERE material_id = ? ORDER BY id').all(materialId),
  }
}

beforeAll(async () => {
  db = await getDb()
  const routes = (await import('../src/routes/stocktaking-v1.1.js')).default
  const injectActor = (req: any, _res: any, next: any) => {
    const role = String(req.header('x-test-role') || 'admin')
    const username = String(req.header('x-test-user') || role)
    req.user = { username, role, roles: [role] }
    next()
  }
  app = await buildTestApp([{
    path: '/api/v1/stocktaking',
    router: routes,
    middleware: [injectActor],
  }])
})

beforeEach(() => {
  for (const trigger of FAILURE_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
  clearOptionalTable('stocktaking_explanations')
  clearOptionalTable('stocktaking_adjustment_events')
  db.exec(`
    DELETE FROM inventory_transaction_allocations;
    DELETE FROM stock_logs;
    DELETE FROM stocktaking_records;
    DELETE FROM outbound_items;
    DELETE FROM outbound_records;
    DELETE FROM inbound_records;
    DELETE FROM inventory_positions;
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM material_categories;
    DELETE FROM locations;
  `)
  db.prepare("INSERT INTO material_categories (id, code, name, level) VALUES ('ST-CAT', 'ST-CAT', 'stocktaking', 1)").run()
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, capacity, status)
    VALUES ('ST-LOC', 'ST-LOC', 'stocktaking', 'shelf', 'A', 999999, 1)
  `).run()
  seedRole('record-only', { stocktaking: 'W' })
  seedRole('adjust-only', { stocktaking: 'R', stocktaking_adjust: 'W' })
  seedRole('reverse-only', { stocktaking: 'R', stocktaking_reverse: 'W' })
})

describe('PIS-W1 existing-position stocktaking contract', () => {
  it.each([
    { name: 'batch managed', batchManaged: true },
    { name: 'non-batch', batchManaged: false },
  ])('records a named zero-difference $name position without quantity, allocation, log, or event writes', async ({ batchManaged }) => {
    const position = seedPosition(batchManaged)
    const before = inventoryFacts(position.materialId)
    const response = await record(position, position.quantity)
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      status: 'completed',
      positionId: position.positionId,
      materialId: position.materialId,
      batchId: position.batchId,
      locationId: position.locationId,
    })
    const saved = db.prepare('SELECT * FROM stocktaking_records WHERE id = ?').get(response.body.data.id) as any
    expect(saved).toMatchObject({
      position_id: position.positionId,
      material_id: position.materialId,
      batch_id: position.batchId,
      location_id: position.locationId,
      resolution_state: 'resolved',
      operator: 'admin',
      status: 'completed',
    })
    expect(Number(saved.system_stock)).toBe(position.quantity)
    expect(Number(saved.actual_stock)).toBe(position.quantity)
    expect(Number(saved.difference)).toBe(0)
    expect(inventoryFacts(position.materialId)).toEqual(before)
    expect(countRows('stocktaking_adjustment_events')).toBe(0)
  })

  it('applies a batch-position surplus atomically and keeps inbound/outbound history unchanged', async () => {
    const position = seedPosition(true)
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, location_id, operator)
      VALUES ('ST-OLD-IN', 'ST-OLD-IN', 'direct', ?, ?, ?, 10, 'pcs', ?, 'old-in-user')
    `).run(position.materialId, position.batchId, position.batchId, position.locationId)
    db.prepare(`
      INSERT INTO outbound_records (id, outbound_no, type, total_cost, operator)
      VALUES ('ST-OLD-OUT', 'ST-OLD-OUT', 'direct', 0, 'old-out-user')
    `).run()
    db.prepare(`
      INSERT INTO outbound_items
        (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost)
      VALUES ('ST-OLD-OUT-I', 'ST-OLD-OUT', ?, ?, ?, 1, 'pcs', 0, 0)
    `).run(position.materialId, position.batchId, position.batchId)
    const historyBefore = oldHistory(position.materialId)
    const created = await record(position, 12, 'unknown')
    expect(created.status).toBe(200)
    expect(created.body.data.status).toBe('pending')

    const adjusted = await withActor('admin', 'warehouse-a')
      .post(`/api/v1/stocktaking/${created.body.data.id}/adjust`)
      .send({ reason: 'spoofed replacement reason', operator: 'spoofed-client-actor' })
    expect(adjusted.status).toBe(200)
    expect(adjusted.body.data.status).toBe('adjusted')
    const eventId = adjusted.body.data.eventId
    expect(db.prepare('SELECT quantity, version FROM inventory_positions WHERE id = ?').get(position.positionId))
      .toEqual({ quantity: 12, version: 1 })
    expect(db.prepare('SELECT quantity, remaining, status FROM batches WHERE id = ?').get(position.batchId))
      .toEqual({ quantity: 12, remaining: 12, status: 1 })
    expect(db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(position.materialId)).toEqual({ stock: 12 })
    expect(db.prepare(`
      SELECT operation_kind, owner_id, batch_id, location_id, direction, quantity
      FROM inventory_transaction_allocations WHERE owner_id = ?
    `).get(eventId)).toEqual({
      operation_kind: 'stocktaking',
      owner_id: eventId,
      batch_id: position.batchId,
      location_id: position.locationId,
      direction: 'in',
      quantity: 2,
    })
    expect(db.prepare(`
      SELECT event_kind, parent_event_id, quantity_delta, batch_quantity_delta, operator, reason, chain_depth
      FROM stocktaking_adjustment_events WHERE id = ?
    `).get(eventId)).toEqual({
      event_kind: 'adjustment',
      parent_event_id: null,
      quantity_delta: 2,
      batch_quantity_delta: 2,
      operator: 'warehouse-a',
      reason: 'unknown',
      chain_depth: 0,
    })
    expect(oldHistory(position.materialId)).toEqual(historyBefore)
  })

  it('applies a non-batch position deficit without manufacturing a batch', async () => {
    const position = seedPosition(false)
    const created = await record(position, 7, 'physical_count')
    const adjusted = await withActor().post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({})
    expect(adjusted.status).toBe(200)
    const eventId = adjusted.body.data.eventId
    expect(db.prepare('SELECT batch_id, quantity FROM inventory_positions WHERE id = ?').get(position.positionId))
      .toEqual({ batch_id: null, quantity: 7 })
    expect(db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(position.materialId)).toEqual({ stock: 7 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM batches WHERE material_id = ?').get(position.materialId)).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT batch_id, direction, quantity FROM inventory_transaction_allocations WHERE owner_id = ?
    `).get(eventId)).toEqual({ batch_id: null, direction: 'out', quantity: 3 })
    expect(db.prepare(`
      SELECT type, quantity, before_stock, after_stock, related_id, operator
      FROM stock_logs WHERE related_id = ?
    `).get(eventId)).toEqual({
      type: 'stocktaking_adjustment',
      quantity: -3,
      before_stock: 10,
      after_stock: 7,
      related_id: eventId,
      operator: 'admin',
    })
  })

  it('keeps an unknown original reason immutable while appending later explanations', async () => {
    const position = seedPosition(true)
    const created = await record(position, 11, 'unknown')
    const adjusted = await withActor().post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({})
    const eventBefore = db.prepare('SELECT * FROM stocktaking_adjustment_events WHERE id = ?')
      .get(adjusted.body.data.eventId)
    const first = await withActor('admin', 'investigator-a')
      .post(`/api/v1/stocktaking/${created.body.data.id}/explanations`)
      .send({ explanation: 'sealed package count was wrong' })
    const second = await withActor('admin', 'investigator-b')
      .post(`/api/v1/stocktaking/${created.body.data.id}/explanations`)
      .send({ explanation: 'supplier confirmed packing variance' })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(db.prepare('SELECT * FROM stocktaking_adjustment_events WHERE id = ?').get(adjusted.body.data.eventId))
      .toEqual(eventBefore)
    expect(db.prepare(`
      SELECT explanation, operator FROM stocktaking_explanations
      WHERE stocktaking_record_id = ? ORDER BY sequence
    `).all(created.body.data.id)).toEqual([
      { explanation: 'sealed package count was wrong', operator: 'investigator-a' },
      { explanation: 'supplier confirmed packing variance', operator: 'investigator-b' },
    ])
  })

  it('creates linked exact compensations, rejects duplicate reversal, and corrects a wrong reversal by compensating it', async () => {
    const position = seedPosition(true)
    const created = await record(position, 12, 'unknown')
    const adjusted = await withActor('admin', 'adjuster')
      .post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({})
    const originalEventId = adjusted.body.data.eventId

    const reversed = await withActor('admin', 'reverser')
      .post(`/api/v1/stocktaking/${created.body.data.id}/reverse`)
      .send({ eventId: originalEventId, reason: 'entry error' })
    expect(reversed.status).toBe(200)
    expect(reversed.body.data.status).toBe('compensated')
    const reversalEventId = reversed.body.data.eventId
    expect(db.prepare('SELECT quantity FROM inventory_positions WHERE id = ?').get(position.positionId)).toEqual({ quantity: 10 })
    expect(db.prepare('SELECT quantity, remaining FROM batches WHERE id = ?').get(position.batchId))
      .toEqual({ quantity: 10, remaining: 10 })

    const duplicate = await withActor('admin', 'other-reverser')
      .post(`/api/v1/stocktaking/${created.body.data.id}/reverse`)
      .send({ eventId: originalEventId, reason: 'retry' })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error.code).toBe('ALREADY_REVERSED')

    const corrected = await withActor('admin', 'correction-user')
      .post(`/api/v1/stocktaking/${created.body.data.id}/reverse`)
      .send({ eventId: reversalEventId, reason: 'reversal was wrong' })
    expect(corrected.status).toBe(200)
    expect(corrected.body.data.status).toBe('adjusted')
    expect(db.prepare('SELECT quantity FROM inventory_positions WHERE id = ?').get(position.positionId)).toEqual({ quantity: 12 })
    expect(db.prepare('SELECT quantity, remaining FROM batches WHERE id = ?').get(position.batchId))
      .toEqual({ quantity: 12, remaining: 12 })
    expect(db.prepare(`
      SELECT id, event_kind, parent_event_id, quantity_delta, batch_quantity_delta, chain_depth
      FROM stocktaking_adjustment_events WHERE stocktaking_record_id = ? ORDER BY chain_depth
    `).all(created.body.data.id)).toEqual([
      { id: originalEventId, event_kind: 'adjustment', parent_event_id: null, quantity_delta: 2, batch_quantity_delta: 2, chain_depth: 0 },
      { id: reversalEventId, event_kind: 'compensation', parent_event_id: originalEventId, quantity_delta: -2, batch_quantity_delta: -2, chain_depth: 1 },
      { id: corrected.body.data.eventId, event_kind: 'compensation', parent_event_id: reversalEventId, quantity_delta: 2, batch_quantity_delta: 2, chain_depth: 2 },
    ])
    expect(db.prepare(`
      SELECT source_allocation_id FROM inventory_transaction_allocations WHERE owner_id = ?
    `).get(reversalEventId)).toMatchObject({ source_allocation_id: expect.any(String) })
  })

  it('rejects negative counts and explicit unknown or mismatched position identities with zero business writes', async () => {
    const position = seedPosition(true)
    const before = fullFacts(position.materialId)
    const negative = await record(position, -1)
    expect(negative.status).toBe(409)
    expect(negative.body.error.code).toBe('INVENTORY_LEDGER_CORRUPT')

    const unknown = await withActor().post('/api/v1/stocktaking').send({
      ...recordBody(position, 10),
      positionId: 'POSITION-NOT-FOUND',
    })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('POSITION_NOT_FOUND')

    const mismatch = await withActor().post('/api/v1/stocktaking').send({
      ...recordBody(position, 10),
      locationId: 'OTHER-LOCATION',
    })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.error.code).toBe('POSITION_IDENTITY_MISMATCH')
    expect(fullFacts(position.materialId)).toEqual(before)
  })

  it('records unresolved evidence but never guesses a batch or applies a quantity change', async () => {
    const position = seedPosition(true)
    const before = inventoryFacts(position.materialId)
    const unresolved = await withActor('admin', 'counter-a').post('/api/v1/stocktaking').send({
      materialId: position.materialId,
      locationId: position.locationId,
      actualStock: 8,
      reason: 'unknown',
    })
    expect(unresolved.status).toBe(200)
    expect(unresolved.body.data.status).toBe('unresolved')
    const saved = db.prepare('SELECT * FROM stocktaking_records WHERE id = ?').get(unresolved.body.data.id) as any
    expect(saved).toMatchObject({
      material_id: position.materialId,
      position_id: null,
      batch_id: null,
      location_id: position.locationId,
      resolution_state: 'unresolved',
      status: 'unresolved',
      operator: 'counter-a',
    })
    const adjusted = await withActor().post(`/api/v1/stocktaking/${unresolved.body.data.id}/adjust`).send({})
    expect(adjusted.status).toBe(422)
    expect(adjusted.body.error.code).toBe('POSITION_UNRESOLVED')
    expect(inventoryFacts(position.materialId)).toEqual(before)
    expect(countRows('stocktaking_adjustment_events')).toBe(0)
  })

  it('rejects a stale position snapshot after a later inventory event with zero partial stocktaking writes', async () => {
    const position = seedPosition(true)
    const created = await record(position, 8, 'physical_count')
    const inventory = await import('../src/services/inventory-transactions.js')
    db.exec('BEGIN IMMEDIATE')
    const laterPlan = inventory.planInventoryDeductions(db, [{
      materialId: position.materialId,
      quantity: 1,
      ownerLineId: 'LATER-BUSINESS-EVENT',
    }])
    inventory.applyInventoryPlan(db, laterPlan)
    inventory.replaceAllocationFacts(db, {
      operationKind: 'scrap',
      ownerId: 'LATER-BUSINESS-EVENT',
      direction: 'out',
      allocations: laterPlan.allocations,
    })
    db.exec('COMMIT')
    const beforeRejected = fullFacts(position.materialId)
    const response = await withActor().post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({})
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('STOCK_CHANGED')
    expect(fullFacts(position.materialId)).toEqual(beforeRejected)
  })

  it('enforces separately configurable record, adjust, and reversal permissions', async () => {
    const position = seedPosition(true)
    const deniedRecord = await record(position, 12, 'unknown', 'adjust-only')
    expect(deniedRecord.status).toBe(403)

    const created = await record(position, 12, 'unknown', 'record-only')
    expect(created.status).toBe(200)
    const deniedAdjust = await withActor('record-only').post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({})
    expect(deniedAdjust.status).toBe(403)

    const adjusted = await withActor('adjust-only', 'adjust-user')
      .post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({})
    expect(adjusted.status).toBe(200)
    const deniedReverse = await withActor('adjust-only')
      .post(`/api/v1/stocktaking/${created.body.data.id}/reverse`)
      .send({ eventId: adjusted.body.data.eventId, reason: 'wrong' })
    expect(deniedReverse.status).toBe(403)

    const deniedRecordForReverse = await record(position, 12, 'unknown', 'reverse-only')
    expect(deniedRecordForReverse.status).toBe(403)
    const reversed = await withActor('reverse-only', 'reverse-user')
      .post(`/api/v1/stocktaking/${created.body.data.id}/reverse`)
      .send({ eventId: adjusted.body.data.eventId, reason: 'wrong' })
    expect(reversed.status).toBe(200)
  })

  it.each([
    {
      point: 'position',
      trigger: `CREATE TRIGGER st_fail_position BEFORE UPDATE OF quantity ON inventory_positions
        BEGIN SELECT RAISE(ABORT, 'injected position write failure'); END`,
    },
    {
      point: 'batch',
      trigger: `CREATE TRIGGER st_fail_batch BEFORE UPDATE OF quantity, remaining ON batches
        BEGIN SELECT RAISE(ABORT, 'injected batch write failure'); END`,
    },
    {
      point: 'cache',
      trigger: `CREATE TRIGGER st_fail_cache BEFORE UPDATE OF stock ON inventory
        BEGIN SELECT RAISE(ABORT, 'injected cache write failure'); END`,
    },
    {
      point: 'allocation',
      trigger: `CREATE TRIGGER st_fail_allocation BEFORE INSERT ON inventory_transaction_allocations
        BEGIN SELECT RAISE(ABORT, 'injected allocation write failure'); END`,
    },
    {
      point: 'log',
      trigger: `CREATE TRIGGER st_fail_log BEFORE INSERT ON stock_logs
        BEGIN SELECT RAISE(ABORT, 'injected log write failure'); END`,
    },
    {
      point: 'event',
      trigger: `CREATE TRIGGER st_fail_event BEFORE INSERT ON stocktaking_adjustment_events
        BEGIN SELECT RAISE(ABORT, 'injected event write failure'); END`,
    },
  ])('rolls back every fact when the $point write fails', async ({ trigger }) => {
    const position = seedPosition(true)
    const created = await record(position, 12, 'unknown')
    expect(created.status).toBe(200)
    const before = fullFacts(position.materialId)
    db.exec(trigger)
    try {
      const response = await withActor().post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({})
      expect(response.status).toBe(500)
      expect(fullFacts(position.materialId)).toEqual(before)
    } finally {
      for (const name of FAILURE_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`)
    }
  })

  it('upgrades the allocation-kind constraint without losing existing allocation facts', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { ensureInventoryPositionSchema } = await import('../src/database/DatabaseManager.js')
    const legacy = new DatabaseSync(':memory:')
    try {
      legacy.exec(`
        CREATE TABLE materials (id TEXT PRIMARY KEY);
        CREATE TABLE inventory_transaction_allocations (
          id TEXT PRIMARY KEY,
          operation_kind TEXT NOT NULL
            CHECK (operation_kind IN ('inbound', 'outbound', 'return', 'scrap', 'supplier_return', 'transfer')),
          owner_id TEXT NOT NULL,
          owner_line_id TEXT,
          material_id TEXT NOT NULL,
          batch_id TEXT,
          location_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          quantity REAL NOT NULL CHECK (quantity > 0),
          source_allocation_id TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO inventory_transaction_allocations
          (id, operation_kind, owner_id, material_id, location_id, direction, quantity)
        VALUES ('LEGACY-ALLOC', 'outbound', 'LEGACY-OWNER', 'LEGACY-MAT', 'LEGACY-LOC', 'out', 1);
      `)
      ensureInventoryPositionSchema(legacy)
      expect(legacy.prepare(`
        SELECT id, operation_kind, owner_id, quantity
        FROM inventory_transaction_allocations WHERE id = 'LEGACY-ALLOC'
      `).get()).toEqual({
        id: 'LEGACY-ALLOC',
        operation_kind: 'outbound',
        owner_id: 'LEGACY-OWNER',
        quantity: 1,
      })
      expect(() => legacy.prepare(`
        INSERT INTO inventory_transaction_allocations
          (id, operation_kind, owner_id, material_id, location_id, direction, quantity)
        VALUES ('W1-ALLOC', 'stocktaking', 'W1-OWNER', 'W1-MAT', 'W1-LOC', 'in', 1)
      `).run()).not.toThrow()
    } finally {
      legacy.close()
    }
  })
})
