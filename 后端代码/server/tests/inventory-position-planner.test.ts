import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: any
let inventory: typeof import('../src/services/inventory-transactions.js')

const materialId = 'POS-MAT'

function rows(table: string, orderBy: string): any[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as any[]
}

function seedBatch(input: {
  id: string
  batchNo: string
  quantity: number
  remaining: number
  expiryDate: string | null
  createdAt: string
}) {
  db.prepare(`
    INSERT INTO batches
      (id, material_id, batch_no, quantity, remaining, expiry_date, inbound_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    materialId,
    input.batchNo,
    input.quantity,
    input.remaining,
    input.expiryDate,
    `IN-${input.id}`,
    input.remaining > 0 ? 1 : 0,
    input.createdAt,
  )
}

function seedPosition(id: string, batchId: string | null, locationId: string, quantity: number) {
  db.prepare(`
    INSERT INTO inventory_positions (id, material_id, batch_id, location_id, quantity)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, materialId, batchId, locationId, quantity)
}

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
  inventory = await import('../src/services/inventory-transactions.js')
})

beforeEach(() => {
  db.exec(`
    DELETE FROM inventory_capacity_audits;
    DELETE FROM inventory_transaction_allocations;
    DELETE FROM inventory_positions;
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM material_categories;
    DELETE FROM locations;
  `)
  db.prepare("INSERT INTO material_categories (id, code, name, level) VALUES ('POS-CAT', 'POS-CAT', 'position', 1)").run()
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, capacity, status)
    VALUES ('LOC-A', 'POS-A', 'A', 'shelf', 'A', 999999, 1),
           ('LOC-B', 'POS-B', 'B', 'shelf', 'B', 999999, 1),
           ('LOC-C', 'POS-C', 'C', 'shelf', 'C', 999999, 1)
  `).run()
  db.prepare(`
    INSERT INTO materials
      (id, code, name, unit, category_id, batch_managed, units_per_package, slots_per_package)
    VALUES (?, 'POS-MAT', 'position material', 'pcs', 'POS-CAT', 1, 10, 1)
  `).run(materialId)
  db.prepare("INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES ('POS-INV', ?, 12, 0)").run(materialId)
  seedBatch({ id: 'B-01', batchNo: 'A', quantity: 7, remaining: 7, expiryDate: '2026-08-01', createdAt: '2026-01-01' })
  seedBatch({ id: 'B-02', batchNo: 'B', quantity: 5, remaining: 5, expiryDate: '2026-09-01', createdAt: '2026-01-01' })
  seedPosition('P-01-A', 'B-01', 'LOC-A', 4)
  seedPosition('P-01-B', 'B-01', 'LOC-B', 3)
  seedPosition('P-02-A', 'B-02', 'LOC-A', 5)
})

describe('PIS-INV-G01 position planner', () => {
  it('deducts by expiry, batch creation, batch identity, then location and persists exact locations', () => {
    const plan = inventory.planInventoryDeductions(db, [{ materialId, quantity: 8, ownerLineId: 'LINE-1' }])
    expect(plan.allocations.map((row) => [row.batchId, row.locationId, row.quantity])).toEqual([
      ['B-01', 'LOC-A', 4],
      ['B-01', 'LOC-B', 3],
      ['B-02', 'LOC-A', 1],
    ])

    db.exec('BEGIN IMMEDIATE')
    inventory.applyInventoryPlan(db, plan)
    inventory.replaceAllocationFacts(db, {
      operationKind: 'outbound',
      ownerId: 'OUT-1',
      direction: 'out',
      allocations: plan.allocations,
    })
    db.exec('COMMIT')

    expect(rows('inventory_positions', 'batch_id, location_id').map((row) => ({
      batchId: row.batch_id,
      locationId: row.location_id,
      quantity: row.quantity,
    }))).toEqual([{ batchId: 'B-02', locationId: 'LOC-A', quantity: 4 }])
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock).toBe(4)
    expect(rows('batches', 'id').map((row) => [row.id, row.remaining, row.status])).toEqual([
      ['B-01', 0, 0],
      ['B-02', 4, 1],
    ])
    expect(rows('inventory_transaction_allocations', 'created_at, id').map((row) => [
      row.batch_id, row.location_id, row.quantity,
    ])).toEqual([
      ['B-01', 'LOC-A', 4],
      ['B-01', 'LOC-B', 3],
      ['B-02', 'LOC-A', 1],
    ])
  })

  it('rejects an operator-supplied batch override before any write', () => {
    const before = rows('inventory_positions', 'id')
    expect(() => inventory.planInventoryDeductions(db, [{
      materialId,
      quantity: 1,
      pinnedBatchId: 'B-02',
    }])).toThrowError(expect.objectContaining({ code: 'FEFO_OVERRIDE_FORBIDDEN', status: 400 }))
    expect(rows('inventory_positions', 'id')).toEqual(before)
  })

  it('moves a real 70/30 split and merges an existing target position without changing caches', () => {
    db.exec(`
      DELETE FROM inventory_positions;
      DELETE FROM batches;
      UPDATE inventory SET stock = 100 WHERE material_id = '${materialId}';
    `)
    seedBatch({ id: 'B-100', batchNo: 'ONE', quantity: 100, remaining: 100, expiryDate: '2027-01-01', createdAt: '2026-01-01' })
    seedPosition('P-100-A', 'B-100', 'LOC-A', 80)
    seedPosition('P-100-B', 'B-100', 'LOC-B', 20)

    const plan = inventory.planInventoryTransfers(db, [{
      materialId,
      quantity: 30,
      fromLocationId: 'LOC-A',
      toLocationId: 'LOC-B',
      ownerLineId: 'TF-1',
    }])
    inventory.applyInventoryPlan(db, plan)
    inventory.replaceAllocationFacts(db, {
      operationKind: 'transfer', ownerId: 'TF-1', direction: 'out', allocations: plan.allocations,
    })

    expect(db.prepare(`
      SELECT location_id, quantity FROM inventory_positions
      WHERE material_id = ? AND batch_id = 'B-100' ORDER BY location_id
    `).all(materialId)).toEqual([
      { location_id: 'LOC-A', quantity: 50 },
      { location_id: 'LOC-B', quantity: 50 },
    ])
    expect((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock).toBe(100)
    expect((db.prepare("SELECT remaining FROM batches WHERE id = 'B-100'").get() as any).remaining).toBe(100)
  })

  it('keeps non-batch transfers null-batched instead of manufacturing a batch', () => {
    db.exec(`
      DELETE FROM inventory_positions;
      DELETE FROM batches;
      UPDATE materials SET batch_managed = 0 WHERE id = '${materialId}';
      UPDATE inventory SET stock = 10 WHERE material_id = '${materialId}';
    `)
    seedPosition('P-NULL-A', null, 'LOC-A', 10)
    const plan = inventory.planInventoryTransfers(db, [{
      materialId, quantity: 3, fromLocationId: 'LOC-A', toLocationId: 'LOC-B', ownerLineId: 'TF-N',
    }])
    inventory.applyInventoryPlan(db, plan)
    expect(db.prepare(`
      SELECT batch_id, location_id, quantity FROM inventory_positions
      WHERE material_id = ? ORDER BY location_id
    `).all(materialId)).toEqual([
      { batch_id: null, location_id: 'LOC-A', quantity: 7 },
      { batch_id: null, location_id: 'LOC-B', quantity: 3 },
    ])
    expect((db.prepare('SELECT COUNT(*) AS c FROM batches WHERE material_id = ?').get(materialId) as any).c).toBe(0)
  })

  it('blocks a known over-capacity target but allows and audits missing conversion', () => {
    db.exec(`
      DELETE FROM inventory_positions;
      DELETE FROM batches;
      UPDATE materials SET batch_managed = 0 WHERE id = '${materialId}';
      UPDATE inventory SET stock = 0 WHERE material_id = '${materialId}';
    `)
    db.prepare("UPDATE locations SET capacity = 1 WHERE id = 'LOC-C'").run()
    expect(() => inventory.planPositionAdditions(db, [{
      materialId, batchId: null, locationId: 'LOC-C', quantity: 11, ownerLineId: 'IN-CAP',
    }], { operationKind: 'inbound', ownerId: 'IN-CAP' })).toThrowError(expect.objectContaining({
      code: 'LOCATION_CAPACITY_EXCEEDED',
      status: 422,
    }))
    expect((db.prepare("SELECT COUNT(*) AS c FROM inventory_positions WHERE location_id = 'LOC-C'").get() as any).c).toBe(0)

    db.prepare('UPDATE materials SET units_per_package = NULL WHERE id = ?').run(materialId)
    const warningPlan = inventory.planPositionAdditions(db, [{
      materialId, batchId: null, locationId: 'LOC-C', quantity: 1, ownerLineId: 'IN-WARN',
    }], { operationKind: 'inbound', ownerId: 'IN-WARN' })
    inventory.applyInventoryPlan(db, warningPlan)
    expect((db.prepare("SELECT quantity FROM inventory_positions WHERE material_id = ? AND batch_id IS NULL AND location_id = 'LOC-C'").get(materialId) as any).quantity).toBe(1)
    expect(db.prepare(`
      SELECT decision, operation_kind, owner_id, material_id, location_id
      FROM inventory_capacity_audits
      WHERE owner_id = 'IN-WARN'
    `).all()).toEqual([{
      decision: 'allowed_missing_conversion',
      operation_kind: 'inbound',
      owner_id: 'IN-WARN',
      material_id: materialId,
      location_id: 'LOC-C',
    }])
  })

  it('fails closed when a derived cache is corrupt and rolls back a later business failure', () => {
    db.prepare('UPDATE inventory SET stock = 99 WHERE material_id = ?').run(materialId)
    expect(() => inventory.planInventoryDeductions(db, [{ materialId, quantity: 1 }]))
      .toThrowError(expect.objectContaining({ code: 'INVENTORY_LEDGER_CORRUPT', status: 409 }))
    db.prepare('UPDATE inventory SET stock = 12 WHERE material_id = ?').run(materialId)

    const before = rows('inventory_positions', 'id')
    const plan = inventory.planInventoryDeductions(db, [{ materialId, quantity: 1 }])
    expect(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        inventory.applyInventoryPlan(db, plan)
        inventory.replaceAllocationFacts(db, {
          operationKind: 'scrap', ownerId: 'ROLLBACK', direction: 'out', allocations: plan.allocations,
        })
        throw new Error('injected failure')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }).toThrow('injected failure')
    expect(rows('inventory_positions', 'id')).toEqual(before)
    expect((db.prepare("SELECT COUNT(*) AS c FROM inventory_transaction_allocations WHERE owner_id = 'ROLLBACK'").get() as any).c).toBe(0)
  })
})
