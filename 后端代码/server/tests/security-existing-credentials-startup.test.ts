import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

const tempDirs: string[] = []
const originalNodeEnv = process.env.NODE_ENV
const originalDatabasePath = process.env.DATABASE_PATH
const originalAdminInitialPassword = process.env.ADMIN_INITIAL_PASSWORD

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = originalDatabasePath
  if (originalAdminInitialPassword === undefined) delete process.env.ADMIN_INITIAL_PASSWORD
  else process.env.ADMIN_INITIAL_PASSWORD = originalAdminInitialPassword
  vi.resetModules()
})

async function loadProductionDatabaseModule(dbPath: string) {
  process.env.NODE_ENV = 'production'
  process.env.DATABASE_PATH = dbPath
  vi.resetModules()
  return import('../src/database/DatabaseManager.js')
}

describe('production startup guard for existing credentials', () => {
  it('fails closed when an upgraded database still has active leaked default passwords', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-existing-credentials-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    const oldDb = new DatabaseSync(dbPath)
    oldDb.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      real_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      department TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )`)
    const insert = oldDb.prepare(
      'INSERT INTO users (id,username,password,real_name,role,status,is_deleted) VALUES (?,?,?,?,?,1,0)'
    )
    insert.run('USER-001', 'admin', bcrypt.hashSync('admin123', 4), '管理员', 'admin')
    insert.run('USER-FIN', 'caiwu', bcrypt.hashSync('CoreOne2026!', 4), '孙财务', 'finance')
    oldDb.close()

    const databaseModule = await loadProductionDatabaseModule(dbPath)
    try {
      expect(() => databaseModule.initializeDatabase()).toThrow(/admin.*caiwu|caiwu.*admin/)
      const tables = databaseModule
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
      expect(tables.map(row => row.name)).toEqual(['users'])
    } finally {
      databaseModule.resetDatabase()
    }
  })

  it('treats missing status/is_deleted columns as active and still blocks a leaked historical account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-existing-credentials-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    const oldDb = new DatabaseSync(dbPath)
    oldDb.exec('CREATE TABLE users (username TEXT, password TEXT)')
    oldDb.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
      .run('admin', bcrypt.hashSync('admin123', 4))
    oldDb.close()

    const databaseModule = await loadProductionDatabaseModule(dbPath)
    try {
      expect(() => databaseModule.initializeDatabase()).toThrow(/admin/)
    } finally {
      databaseModule.resetDatabase()
    }
  })

  it('fails closed before migrations when an existing users table lacks username/password columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-existing-credentials-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    const oldDb = new DatabaseSync(dbPath)
    oldDb.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
    oldDb.close()

    const databaseModule = await loadProductionDatabaseModule(dbPath)
    try {
      expect(() => databaseModule.initializeDatabase()).toThrow(/username.*password|password.*username/)
      const tables = databaseModule
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
      expect(tables.map(row => row.name)).toEqual(['users'])
    } finally {
      databaseModule.resetDatabase()
    }
  })

  it('creates the canonical users table and a strong initial admin on a new production database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-existing-credentials-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    process.env.ADMIN_INITIAL_PASSWORD = 'N7v!Q2m@R8x#T4k%Z9p&L3d^'

    const databaseModule = await loadProductionDatabaseModule(dbPath)
    try {
      expect(() => databaseModule.initializeDatabase()).not.toThrow()
      const admin = databaseModule
        .getDatabase()
        .prepare("SELECT password FROM users WHERE username = 'admin'")
        .get() as { password: string }
      expect(bcrypt.compareSync(process.env.ADMIN_INITIAL_PASSWORD, admin.password)).toBe(true)
    } finally {
      delete process.env.ADMIN_INITIAL_PASSWORD
      databaseModule.resetDatabase()
    }
  })

  it.each(['short', '   '])(
    'rejects an explicit weak initial admin password before creating any business tables: %j',
    async weakPassword => {
      const dir = mkdtempSync(join(tmpdir(), 'coreone-existing-credentials-'))
      tempDirs.push(dir)
      const dbPath = join(dir, 'coreone.db')
      process.env.ADMIN_INITIAL_PASSWORD = weakPassword

      const databaseModule = await loadProductionDatabaseModule(dbPath)
      try {
        expect(() => databaseModule.initializeDatabase()).toThrow(/ADMIN_INITIAL_PASSWORD/)
        const tables = databaseModule
          .getDatabase()
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
        expect(tables).toEqual([])
      } finally {
        databaseModule.resetDatabase()
      }
    }
  )
})
