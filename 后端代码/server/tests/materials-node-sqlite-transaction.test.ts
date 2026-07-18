import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const databaseState = vi.hoisted(() => ({ current: undefined as any }))

vi.mock('../src/database/DatabaseManager.js', () => ({
  getDatabase: () => databaseState.current,
}))

vi.mock('../src/middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

import materialRoutes from '../src/routes/materials.js'

type TransactionControl = 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK'

const openDatabases: DatabaseSync[] = []
const temporaryDirectories: string[] = []

function openDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  openDatabases.push(db)
  return db
}

function temporaryDatabaseFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coreone-materials-tx-'))
  temporaryDirectories.push(directory)
  return join(directory, 'materials.db')
}

function seedMaterials(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      spec TEXT,
      unit TEXT NOT NULL,
      spec_qty REAL DEFAULT 0,
      spec_unit TEXT,
      category_id TEXT NOT NULL,
      supplier_id TEXT,
      price REAL DEFAULT 0,
      min_stock INTEGER DEFAULT 0,
      max_stock INTEGER DEFAULT 999999,
      safety_stock INTEGER DEFAULT 0,
      location_id TEXT,
      status INTEGER NOT NULL,
      remark TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE inventory (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL UNIQUE,
      stock REAL NOT NULL DEFAULT 0,
      locked_stock REAL NOT NULL DEFAULT 0,
      location_id TEXT
    );
    INSERT INTO materials (id, code, name, unit, category_id, status)
    VALUES
      ('material-1', 'MAT-1', '物料一', '瓶', 'category-1', 1),
      ('material-2', 'MAT-2', '物料二', '瓶', 'category-1', 1);
  `)
}

function materialStatuses(db: DatabaseSync): Array<{ id: string; status: number }> {
  return db.prepare('SELECT id, status FROM materials ORDER BY id').all() as Array<{ id: string; status: number }>
}

function trackTransactions(db: DatabaseSync): { db: any; controls: TransactionControl[] } {
  const controls: TransactionControl[] = []
  return {
    controls,
    db: {
      prepare: db.prepare.bind(db),
      exec(sql: string): void {
        const normalized = sql.trim().replace(/\s+/g, ' ').toUpperCase()
        if (normalized === 'BEGIN IMMEDIATE' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
          controls.push(normalized)
        }
        db.exec(sql)
      },
    },
  }
}

function buildApp(db: any) {
  databaseState.current = db
  const app = express()
  app.use(express.json())
  app.use('/api/v1/materials', materialRoutes)
  return app
}

afterEach(() => {
  databaseState.current = undefined
  while (openDatabases.length > 0) {
    try { openDatabases.pop()?.close() } catch { /* already closed */ }
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe('PATCH /materials/batch-status on node:sqlite DatabaseSync', () => {
  it('uses the real DatabaseSync API and commits one successful multi-row update exactly once', async () => {
    const database = openDatabase()
    seedMaterials(database)
    const tracked = trackTransactions(database)

    const response = await request(buildApp(tracked.db))
      .patch('/api/v1/materials/batch-status')
      .send({ ids: ['material-1', 'missing', 'material-2'], status: 'inactive' })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ success: true, data: { updatedCount: 2 } })
    expect(materialStatuses(database)).toEqual([
      { id: 'material-1', status: 0 },
      { id: 'material-2', status: 0 },
    ])
    expect(tracked.controls).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    expect((database as any).isTransaction).toBe(false)
  })

  it('commits material and inventory creation together exactly once', async () => {
    const database = openDatabase()
    seedMaterials(database)
    const tracked = trackTransactions(database)

    const response = await request(buildApp(tracked.db))
      .post('/api/v1/materials')
      .send({ code: 'MAT-CREATE-OK', name: '事务创建物料', unit: '盒', categoryId: 'category-1', price: 12.5 })

    expect(response.status).toBe(201)
    expect(database.prepare('SELECT code, name, price FROM materials WHERE id = ?').get(response.body.data.id))
      .toEqual({ code: 'MAT-CREATE-OK', name: '事务创建物料', price: 12.5 })
    expect(database.prepare('SELECT material_id, stock, locked_stock FROM inventory WHERE material_id = ?').get(response.body.data.id))
      .toEqual({ material_id: response.body.data.id, stock: 0, locked_stock: 0 })
    expect(tracked.controls).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    expect((database as any).isTransaction).toBe(false)
  })

  it('rolls back the material row when the following inventory insert fails', async () => {
    const database = openDatabase()
    seedMaterials(database)
    database.exec(`
      CREATE TRIGGER fail_inventory_insert
      BEFORE INSERT ON inventory
      BEGIN
        SELECT RAISE(ABORT, 'synthetic inventory constraint');
      END;
    `)
    const tracked = trackTransactions(database)

    const response = await request(buildApp(tracked.db))
      .post('/api/v1/materials')
      .send({ code: 'MAT-CREATE-FAIL', name: '不得残留的物料', unit: '盒', categoryId: 'category-1' })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试' },
    })
    expect(database.prepare('SELECT id FROM materials WHERE code = ?').get('MAT-CREATE-FAIL')).toBeUndefined()
    expect(database.prepare('SELECT id FROM inventory').all()).toEqual([])
    expect(tracked.controls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
    expect((database as any).isTransaction).toBe(false)
  })

  it('keeps the existing duplicate-code response contract without side effects', async () => {
    const database = openDatabase()
    seedMaterials(database)
    const tracked = trackTransactions(database)
    const before = materialStatuses(database)

    const response = await request(buildApp(tracked.db))
      .post('/api/v1/materials')
      .send({ code: 'MAT-1', name: '重复编码', unit: '盒', categoryId: 'category-1' })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      success: false,
      error: { code: 'RESOURCE_CONFLICT', message: 'Code already exists' },
    })
    expect(materialStatuses(database)).toEqual(before)
    expect(tracked.controls).toEqual([])
  })

  it('rolls back every earlier row when a later update hits a SQLite constraint', async () => {
    const database = openDatabase()
    seedMaterials(database)
    database.exec(`
      CREATE TRIGGER fail_second_material
      BEFORE UPDATE OF status ON materials
      WHEN NEW.id = 'material-2'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic material constraint');
      END;
    `)
    const before = materialStatuses(database)
    const tracked = trackTransactions(database)

    const response = await request(buildApp(tracked.db))
      .patch('/api/v1/materials/batch-status')
      .send({ ids: ['material-1', 'material-2'], status: 'inactive' })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试' },
    })
    expect(materialStatuses(database)).toEqual(before)
    expect(tracked.controls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
    expect((database as any).isTransaction).toBe(false)
  })

  it('preserves the existing 500 INTERNAL_ERROR contract when BEGIN IMMEDIATE is busy', async () => {
    const databaseFile = temporaryDatabaseFile()
    const seed = openDatabase(databaseFile)
    seedMaterials(seed)
    seed.close()
    openDatabases.splice(openDatabases.indexOf(seed), 1)

    const locker = openDatabase(databaseFile)
    const contender = openDatabase(databaseFile)
    contender.exec('PRAGMA busy_timeout = 0')
    locker.exec('BEGIN IMMEDIATE')
    const before = materialStatuses(contender)
    const tracked = trackTransactions(contender)

    const response = await request(buildApp(tracked.db))
      .patch('/api/v1/materials/batch-status')
      .send({ ids: ['material-1'], status: 'inactive' })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试' },
    })
    expect(materialStatuses(contender)).toEqual(before)
    expect(tracked.controls).toEqual(['BEGIN IMMEDIATE'])
    expect((contender as any).isTransaction).toBe(false)
    locker.exec('ROLLBACK')
  })

  it('keeps the local node:sqlite declaration aligned with the Node 24 runtime surface', () => {
    const database = openDatabase()
    expect((database as any).transaction).toBeUndefined()

    const declaration = readFileSync(
      fileURLToPath(new URL('../src/types/node-sqlite.d.ts', import.meta.url)),
      'utf8',
    )
    const routeSource = readFileSync(
      fileURLToPath(new URL('../src/routes/materials.ts', import.meta.url)),
      'utf8',
    )

    expect(declaration).not.toMatch(/^\s*transaction\s*(?:<[^>]*>)?\s*\(/m)
    expect(routeSource).not.toMatch(/\.transaction\s*\(/)
  })
})
