import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: any

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
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
    VALUES ('SCHEMA-CAT', 'SCHEMA-CAT', 'schema', 1)
  `).run()
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id)
    VALUES ('SCHEMA-MAT', 'SCHEMA-MAT', 'schema material', 'pcs', 'SCHEMA-CAT')
  `).run()
})

function insertBatch(input: {
  id: string
  quantity: unknown
  remaining: unknown
  status: unknown
}) {
  return db.prepare(`
    INSERT INTO batches
      (id, material_id, batch_no, quantity, remaining, inbound_id, status)
    VALUES (?, 'SCHEMA-MAT', ?, ?, ?, ?, ?)
  `).run(input.id, input.id, input.quantity, input.remaining, `IN-${input.id}`, input.status)
}

describe('LOC-001 fresh inventory schema constraints', () => {
  it.each([
    { id: 'remaining-over-quantity', quantity: 1, remaining: 2, status: 1 },
    { id: 'negative-quantity', quantity: -1, remaining: 0, status: 0 },
    { id: 'negative-remaining', quantity: 1, remaining: -1, status: 1 },
    { id: 'unsafe-quantity', quantity: Number.MAX_SAFE_INTEGER, remaining: 1, status: 1 },
    { id: 'illegal-status', quantity: 1, remaining: 1, status: 7 },
    { id: 'inactive-positive', quantity: 1, remaining: 1, status: 0 },
    { id: 'active-zero', quantity: 1, remaining: 0, status: 1 },
  ])('rejects corrupt batch row: $id', (row) => {
    expect(() => insertBatch(row)).toThrow(/constraint/i)
  })

  it('accepts legal zero and finite four-decimal quantities', () => {
    expect(() => insertBatch({ id: 'ZERO', quantity: 0, remaining: 0, status: 0 })).not.toThrow()
    expect(() => insertBatch({ id: 'FRACTION', quantity: 1.2345, remaining: 0.2345, status: 1 })).not.toThrow()
  })

  it('constrains the generalized allocation fact structurally', () => {
    insertBatch({ id: 'ALLOC-BATCH', quantity: 1, remaining: 1, status: 1 })
    const insert = db.prepare(`
      INSERT INTO inventory_transaction_allocations
        (id, operation_kind, owner_id, material_id, batch_id, direction, quantity)
      VALUES (?, ?, 'OWNER', 'SCHEMA-MAT', 'ALLOC-BATCH', ?, ?)
    `)
    expect(() => insert.run('BAD-DIRECTION', 'outbound', 'sideways', 1)).toThrow(/constraint/i)
    expect(() => insert.run('BAD-QUANTITY', 'outbound', 'out', -1)).toThrow(/constraint/i)
    expect(() => insert.run('BAD-KIND', 'unknown', 'out', 1)).toThrow(/constraint/i)
    expect(() => insert.run('GOOD', 'outbound', 'out', 1)).not.toThrow()
  })
})
