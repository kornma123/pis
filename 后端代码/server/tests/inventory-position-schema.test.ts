import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureInventoryPositionSchema,
  migrateLegacyInventoryPositions,
} from '../src/database/DatabaseManager.js'

let database: DatabaseSync | null = null

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      batch_managed INTEGER NOT NULL DEFAULT 1,
      units_per_package REAL,
      slots_per_package REAL
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      capacity INTEGER DEFAULT 999999,
      used INTEGER DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE inventory (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL UNIQUE,
      stock REAL NOT NULL,
      locked_stock REAL NOT NULL DEFAULT 0,
      location_id TEXT
    );
    CREATE TABLE batches (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      batch_no TEXT NOT NULL,
      quantity REAL NOT NULL,
      remaining REAL NOT NULL,
      inbound_id TEXT NOT NULL,
      expiry_date TEXT,
      status INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE inbound_records (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      batch_id TEXT,
      location_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
  `)
  return db
}

function positionRows(db: DatabaseSync): any[] {
  return db.prepare(`
    SELECT material_id, batch_id, location_id, quantity
    FROM inventory_positions
    ORDER BY material_id, COALESCE(batch_id, ''), location_id
  `).all() as any[]
}

afterEach(() => {
  database?.close()
  database = null
})

describe('PIS-INV-G01 position schema and synthetic legacy migration', () => {
  it('backfills provable batch and non-batch single-location balances without fake batches', () => {
    database = legacyDatabase()
    ensureInventoryPositionSchema(database)
    database.exec(`
      INSERT INTO locations (id) VALUES ('LOC-A');
      INSERT INTO materials (id, batch_managed) VALUES ('MAT-B', 1), ('MAT-N', 0);
      INSERT INTO inventory (id, material_id, stock, location_id)
        VALUES ('INV-B', 'MAT-B', 10, 'LOC-A'), ('INV-N', 'MAT-N', 7, 'LOC-A');
      INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status, created_at)
        VALUES
          ('B-1', 'MAT-B', 'EARLY', 4, 4, 'IN-1', 1, '2026-01-01'),
          ('B-2', 'MAT-B', 'LATE', 6, 6, 'IN-2', 1, '2026-01-02');
      INSERT INTO inbound_records (id, material_id, batch_id, location_id)
        VALUES ('IN-1', 'MAT-B', 'B-1', 'LOC-A'), ('IN-2', 'MAT-B', 'B-2', 'LOC-A');
    `)

    expect(migrateLegacyInventoryPositions(database)).toEqual({ materials: 2, positions: 3 })
    expect(positionRows(database)).toEqual([
      { material_id: 'MAT-B', batch_id: 'B-1', location_id: 'LOC-A', quantity: 4 },
      { material_id: 'MAT-B', batch_id: 'B-2', location_id: 'LOC-A', quantity: 6 },
      { material_id: 'MAT-N', batch_id: null, location_id: 'LOC-A', quantity: 7 },
    ])
    expect((database.prepare('SELECT COUNT(*) AS c FROM batches WHERE material_id = ?').get('MAT-N') as any).c).toBe(0)

    expect(migrateLegacyInventoryPositions(database)).toEqual({ materials: 0, positions: 0 })
    expect(positionRows(database)).toHaveLength(3)
  })

  it.each([
    {
      name: 'material cache differs from batch remaining',
      mutate: (db: DatabaseSync) => db.prepare("UPDATE inventory SET stock = 11 WHERE material_id = 'MAT-B'").run(),
    },
    {
      name: 'a batch was received into two different locations',
      mutate: (db: DatabaseSync) => db.prepare(`
        INSERT INTO inbound_records (id, material_id, batch_id, location_id)
        VALUES ('IN-X', 'MAT-B', 'B-1', 'LOC-B')
      `).run(),
    },
    {
      name: 'a positive balance has no provable location',
      mutate: (db: DatabaseSync) => db.prepare("UPDATE inventory SET location_id = NULL WHERE material_id = 'MAT-B'").run(),
    },
    {
      name: 'a non-batch material has a historical batch',
      mutate: (db: DatabaseSync) => db.prepare(`
        INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
        VALUES ('B-N', 'MAT-N', 'FORBIDDEN', 7, 7, 'IN-N', 1)
      `).run(),
    },
  ])('fails closed with zero partial position writes when $name', ({ mutate }) => {
    database = legacyDatabase()
    ensureInventoryPositionSchema(database)
    database.exec(`
      INSERT INTO locations (id) VALUES ('LOC-A'), ('LOC-B');
      INSERT INTO materials (id, batch_managed) VALUES ('MAT-B', 1), ('MAT-N', 0);
      INSERT INTO inventory (id, material_id, stock, location_id)
        VALUES ('INV-B', 'MAT-B', 10, 'LOC-A'), ('INV-N', 'MAT-N', 7, 'LOC-A');
      INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status, created_at)
        VALUES
          ('B-1', 'MAT-B', 'EARLY', 4, 4, 'IN-1', 1, '2026-01-01'),
          ('B-2', 'MAT-B', 'LATE', 6, 6, 'IN-2', 1, '2026-01-02');
      INSERT INTO inbound_records (id, material_id, batch_id, location_id)
        VALUES ('IN-1', 'MAT-B', 'B-1', 'LOC-A'), ('IN-2', 'MAT-B', 'B-2', 'LOC-A');
    `)
    mutate(database)

    expect(() => migrateLegacyInventoryPositions(database!)).toThrowError(expect.objectContaining({
      code: 'INVENTORY_POSITION_MIGRATION_UNPROVABLE',
    }))
    expect(positionRows(database)).toEqual([])
    expect((database.prepare('SELECT COUNT(*) AS c FROM inventory_position_migrations').get() as any).c).toBe(0)
  })
})
