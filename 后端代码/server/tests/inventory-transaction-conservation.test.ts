import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: any
let inventoryTransactions: typeof import('../src/services/inventory-transactions.js')

const materialId = 'LOC-001-MATERIAL'

function seedBatch(input: {
  id: string
  batchNo: string
  quantity: number
  remaining: number
  expiryDate?: string | null
  createdAt: string
  status?: number
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
    input.expiryDate ?? null,
    `IN-${input.id}`,
    input.status ?? (input.remaining > 0 ? 1 : 0),
    input.createdAt,
  )
}

function snapshot() {
  return {
    stock: (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock,
    batches: db.prepare(`
      SELECT id, quantity, remaining, status
      FROM batches
      WHERE material_id = ?
      ORDER BY id
    `).all(materialId),
    allocations: db.prepare(`
      SELECT operation_kind, owner_id, owner_line_id, batch_id, direction, quantity, is_reversed
      FROM inventory_transaction_allocations
      ORDER BY batch_id
    `).all(),
  }
}

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
  inventoryTransactions = await import('../src/services/inventory-transactions.js')
})

beforeEach(() => {
  db.exec(`
    DELETE FROM inventory_transaction_allocations;
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM material_categories;
  `)
  db.prepare(`
    INSERT INTO material_categories (id, code, name, level)
    VALUES ('LOC-001-CAT', 'LOC-001-CAT', 'LOC-001', 1)
  `).run()
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id)
    VALUES (?, 'LOC-001-MAT', 'LOC-001 material', 'pcs', 'LOC-001-CAT')
  `).run(materialId)
  db.prepare(`
    INSERT INTO inventory (id, material_id, stock, locked_stock)
    VALUES ('LOC-001-INV', ?, 12, 0)
  `).run(materialId)
  seedBatch({
    id: 'B-LATE',
    batchNo: 'LATE',
    quantity: 5,
    remaining: 5,
    expiryDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  seedBatch({
    id: 'B-FIRST',
    batchNo: 'FIRST',
    quantity: 4,
    remaining: 4,
    expiryDate: '2026-08-01',
    createdAt: '2026-01-02T00:00:00.000Z',
  })
  seedBatch({
    id: 'B-SECOND',
    batchNo: 'SECOND',
    quantity: 3,
    remaining: 3,
    expiryDate: '2026-09-01',
    createdAt: '2026-01-03T00:00:00.000Z',
  })
})

describe('LOC-001 locked inventory transaction fact', () => {
  it('plans deterministic FEFO across batches, persists each allocation, and derives cache from remaining', () => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const plan = inventoryTransactions.planInventoryDeductions(db, [{
        materialId,
        quantity: 6,
        ownerLineId: 'LINE-1',
      }])
      expect(plan.allocations.map((allocation) => [allocation.batchId, allocation.quantity])).toEqual([
        ['B-FIRST', 4],
        ['B-SECOND', 2],
      ])

      inventoryTransactions.applyInventoryPlan(db, plan)
      inventoryTransactions.replaceAllocationFacts(db, {
        operationKind: 'outbound',
        ownerId: 'OUT-1',
        direction: 'out',
        allocations: plan.allocations,
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    expect(snapshot()).toEqual({
      stock: 6,
      batches: [
        { id: 'B-FIRST', quantity: 4, remaining: 0, status: 0 },
        { id: 'B-LATE', quantity: 5, remaining: 5, status: 1 },
        { id: 'B-SECOND', quantity: 3, remaining: 1, status: 1 },
      ],
      allocations: [
        {
          operation_kind: 'outbound',
          owner_id: 'OUT-1',
          owner_line_id: 'LINE-1',
          batch_id: 'B-FIRST',
          direction: 'out',
          quantity: 4,
          is_reversed: 0,
        },
        {
          operation_kind: 'outbound',
          owner_id: 'OUT-1',
          owner_line_id: 'LINE-1',
          batch_id: 'B-SECOND',
          direction: 'out',
          quantity: 2,
          is_reversed: 0,
        },
      ],
    })
    expect(inventoryTransactions.assertInventoryConserved(db, materialId)).toBe(6)
  })

  it('never falls back when an explicit batch is insufficient', () => {
    const before = snapshot()
    expect(() => inventoryTransactions.planInventoryDeductions(db, [{
      materialId,
      quantity: 5,
      pinnedBatchId: 'B-FIRST',
      ownerLineId: 'LINE-PINNED',
    }])).toThrowError(expect.objectContaining({
      code: 'BATCH_STOCK_INSUFFICIENT',
      status: 422,
    }))
    expect(snapshot()).toEqual(before)
  })

  it('treats cache drift and corrupt batch numbers as unknown, not as usable zero or stock', () => {
    db.prepare('UPDATE inventory SET stock = 99 WHERE material_id = ?').run(materialId)
    expect(() => inventoryTransactions.planInventoryDeductions(db, [{
      materialId,
      quantity: 1,
    }])).toThrowError(expect.objectContaining({
      code: 'INVENTORY_LEDGER_CORRUPT',
      status: 409,
    }))

    db.prepare('UPDATE inventory SET stock = 12 WHERE material_id = ?').run(materialId)
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare("UPDATE batches SET remaining = 'not-a-number' WHERE id = 'B-FIRST'").run()
    db.exec('PRAGMA ignore_check_constraints = OFF')
    expect(() => inventoryTransactions.assertInventoryConserved(db, materialId)).toThrowError(expect.objectContaining({
      code: 'INVENTORY_LEDGER_CORRUPT',
      status: 409,
    }))
  })

  it('uses persisted facts for an exact reversal and rolls back every partial write on a later failure', () => {
    const plan = inventoryTransactions.planInventoryDeductions(db, [{
      materialId,
      quantity: 2,
      ownerLineId: 'LINE-ROLLBACK',
    }])

    const before = snapshot()
    expect(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        inventoryTransactions.applyInventoryPlan(db, plan)
        inventoryTransactions.replaceAllocationFacts(db, {
          operationKind: 'scrap',
          ownerId: 'SCRAP-ROLLBACK',
          direction: 'out',
          allocations: plan.allocations,
        })
        throw new Error('injected business write failure')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }).toThrow('injected business write failure')
    expect(snapshot()).toEqual(before)
  })
})
