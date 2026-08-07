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
    DELETE FROM inventory_positions;
    DELETE FROM inventory_position_tombstones;
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM material_categories;
    DELETE FROM locations;
  `)
  db.prepare(`
    INSERT INTO material_categories (id, code, name, level)
    VALUES ('SCHEMA-CAT', 'SCHEMA-CAT', 'schema', 1)
  `).run()
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id)
    VALUES ('SCHEMA-MAT', 'SCHEMA-MAT', 'schema material', 'pcs', 'SCHEMA-CAT')
  `).run()
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, status)
    VALUES ('SCHEMA-LOC', 'SCHEMA-LOC', 'schema location', 'shelf', 'A', 1)
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
    { id: 'negative-quantity', quantity: -1, remaining: 0, status: 0 },
    { id: 'negative-remaining', quantity: 1, remaining: -1, status: 1 },
    { id: 'over-precision', quantity: 1, remaining: 1.00001, status: 1 },
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
    expect(() => insertBatch({ id: 'STOCKTAKING-SURPLUS', quantity: 1, remaining: 2, status: 1 })).not.toThrow()
  })

  it('constrains the generalized allocation fact structurally', () => {
    insertBatch({ id: 'ALLOC-BATCH', quantity: 1, remaining: 1, status: 1 })
    const insert = db.prepare(`
      INSERT INTO inventory_transaction_allocations
        (id, operation_kind, owner_id, material_id, batch_id, location_id, direction, quantity)
      VALUES (?, ?, 'OWNER', 'SCHEMA-MAT', 'ALLOC-BATCH', 'SCHEMA-LOC', ?, ?)
    `)
    expect(() => insert.run('BAD-DIRECTION', 'outbound', 'sideways', 1)).toThrow(/constraint/i)
    expect(() => insert.run('BAD-QUANTITY', 'outbound', 'out', -1)).toThrow(/constraint/i)
    expect(() => insert.run('BAD-KIND', 'unknown', 'out', 1)).toThrow(/constraint/i)
    expect(() => insert.run('GOOD', 'outbound', 'out', 1)).not.toThrow()
    expect(() => db.prepare(`
      INSERT INTO inventory_transaction_allocations
        (id, operation_kind, owner_id, material_id, batch_id, location_id, direction, quantity)
      VALUES ('GOOD-NONBATCH', 'return', 'OWNER-NONBATCH', 'SCHEMA-MAT', NULL, 'SCHEMA-LOC', 'in', 1)
    `).run()).not.toThrow()
    expect(() => db.prepare(`
      INSERT INTO inventory_transaction_allocations
        (id, operation_kind, owner_id, material_id, batch_id, direction, quantity)
      VALUES ('MISSING-LOCATION', 'outbound', 'OWNER-MISSING', 'SCHEMA-MAT', 'ALLOC-BATCH', 'out', 1)
    `).run()).toThrow(/constraint/i)
  })

  it('rebuilds the legacy remaining<=quantity schema without losing rows or foreign keys', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const manager = await import('../src/database/DatabaseManager.js')
    const ensureBatchSchema = (manager as any).ensureBatchStocktakingSurplusSchema
    expect(typeof ensureBatchSchema).toBe('function')
    const legacy = new DatabaseSync(':memory:')
    try {
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE batches (
          id TEXT PRIMARY KEY,
          material_id TEXT NOT NULL,
          batch_no TEXT NOT NULL,
          quantity REAL NOT NULL CHECK (quantity >= 0),
          remaining REAL NOT NULL CHECK (remaining >= 0),
          production_date TEXT,
          expiry_date TEXT,
          inbound_id TEXT NOT NULL,
          inbound_price REAL DEFAULT 0,
          supplier_id TEXT,
          status INTEGER NOT NULL CHECK (status IN (0, 1)),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK (remaining <= quantity),
          CHECK ((remaining = 0 AND status = 0) OR (remaining > 0 AND status = 1)),
          UNIQUE(material_id, batch_no)
        );
        CREATE TABLE batch_refs (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL REFERENCES batches(id)
        );
        INSERT INTO batches
          (id, material_id, batch_no, quantity, remaining, production_date, expiry_date,
           inbound_id, inbound_price, supplier_id, status, created_at, updated_at)
        VALUES
          ('LEGACY-BATCH', 'LEGACY-MAT', 'LEGACY-NO', 10, 10, '2026-01-01', NULL,
           'LEGACY-IN', 5, 'LEGACY-SUP', 1, '2026-01-02', '2026-01-03');
        INSERT INTO batch_refs (id, batch_id) VALUES ('LEGACY-REF', 'LEGACY-BATCH');
      `)
      ensureBatchSchema(legacy)
      expect(legacy.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(legacy.prepare(`
        SELECT id, material_id, batch_no, quantity, remaining, production_date, expiry_date,
               inbound_id, inbound_price, supplier_id, status, created_at, updated_at
        FROM batches WHERE id = 'LEGACY-BATCH'
      `).get()).toEqual({
        id: 'LEGACY-BATCH', material_id: 'LEGACY-MAT', batch_no: 'LEGACY-NO',
        quantity: 10, remaining: 10, production_date: '2026-01-01', expiry_date: null,
        inbound_id: 'LEGACY-IN', inbound_price: 5, supplier_id: 'LEGACY-SUP', status: 1,
        created_at: '2026-01-02', updated_at: '2026-01-03',
      })
      expect(legacy.prepare("SELECT * FROM batch_refs WHERE id = 'LEGACY-REF'").get())
        .toEqual({ id: 'LEGACY-REF', batch_id: 'LEGACY-BATCH' })
      expect(() => legacy.prepare("UPDATE batches SET remaining = 12 WHERE id = 'LEGACY-BATCH'").run()).not.toThrow()
      expect(() => legacy.prepare(`
        INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
        VALUES ('BAD-NEG', 'M', 'BAD-NEG', 1, -1, 'I', 1)
      `).run()).toThrow(/constraint/i)
      expect(() => legacy.prepare(`
        INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
        VALUES ('BAD-PRECISION', 'M', 'BAD-PRECISION', 1, 1.00001, 'I', 1)
      `).run()).toThrow(/constraint/i)
      expect(() => legacy.prepare(`
        INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
        VALUES ('BAD-STATUS', 'M', 'BAD-STATUS', 1, 1, 'I', 0)
      `).run()).toThrow(/constraint/i)
    } finally {
      legacy.close()
    }
  })
})
