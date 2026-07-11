import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runReset(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/reset-passwords.ts'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
}

const STANDARD_USERS = [
  'admin', 'cangguan', 'jishuyuan1', 'jishuyuan2', 'yishi1', 'yishi2', 'caigou', 'caiwu',
] as const

const RESET_ENV_KEYS = [
  'RESET_ADMIN_PASSWORD',
  'RESET_CANGGUAN_PASSWORD',
  'RESET_JISHUYUAN1_PASSWORD',
  'RESET_JISHUYUAN2_PASSWORD',
  'RESET_YISHI1_PASSWORD',
  'RESET_YISHI2_PASSWORD',
  'RESET_CAIGOU_PASSWORD',
  'RESET_CAIWU_PASSWORD',
  'RESET_PASSWORDS_JSON',
] as const

function cleanResetEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of RESET_ENV_KEYS) delete env[key]
  return { ...env, ...overrides }
}

function toFullwidthAscii(value: string): string {
  return value.replace(/[!-~]/gu, character => String.fromCharCode(character.charCodeAt(0) + 0xfee0))
}

function createUsersDatabase(dbPath: string, usernames: readonly string[] = STANDARD_USERS): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    status INTEGER DEFAULT 1,
    is_deleted INTEGER DEFAULT 0
  )`)
  const insert = db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)')
  for (const username of usernames) {
    const oldPassword = username === 'admin' ? 'admin123' : 'CoreOne2026!'
    insert.run(`USER-${username}`, username, bcrypt.hashSync(oldPassword, 4))
  }
  db.close()
}

describe('reset-passwords production guard', () => {
  it('rejects execution without an explicit DATABASE_PATH', () => {
    const env = cleanResetEnv({ RESET_ADMIN_PASSWORD: 'Review-Only-Strong-2026' })
    delete env.DATABASE_PATH
    const result = runReset(env)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DATABASE_PATH')
  })

  it('rejects a nonexistent DATABASE_PATH without creating a misleading empty database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'missing-production.db')
    const result = runReset(cleanResetEnv({
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: 'Review-Only-Strong-2026',
    }))

    expect(result.status).toBe(1)
    expect(existsSync(dbPath)).toBe(false)
    expect(result.stderr).toContain('DATABASE_PATH')
  })

  it('updates only the explicitly selected database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      status INTEGER DEFAULT 1,
      is_deleted INTEGER DEFAULT 0
    )`)
    db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)')
      .run('USER-001', 'admin', bcrypt.hashSync('old-password', 4))
    db.close()

    const nextPassword = 'Review-Only-Strong-2026'
    const result = runReset(cleanResetEnv({
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: nextPassword,
    }))
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(nextPassword)

    const check = new DatabaseSync(dbPath)
    const row = check.prepare("SELECT password, status, is_deleted FROM users WHERE username='admin'").get() as {
      password: string
      status: number
      is_deleted: number
    }
    check.close()
    expect(bcrypt.compareSync('old-password', row.password)).toBe(false)
    expect(bcrypt.compareSync(nextPassword, row.password)).toBe(true)
    expect(row.status).toBe(1)
    expect(row.is_deleted).toBe(0)
  })

  it('rolls back and fails when any target account is missing (reset cannot create)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      status INTEGER DEFAULT 1,
      is_deleted INTEGER DEFAULT 0
    )`)
    db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)')
      .run('USER-001', 'admin', bcrypt.hashSync('old-password', 4))
    db.close()

    // admin 存在、ghost 不存在 → 必须整体回滚 + 非零退出，admin 口令不被改。
    const result = runReset(cleanResetEnv({
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: 'Review-Only-Strong-2026',
      RESET_PASSWORDS_JSON: JSON.stringify({ ghost: 'Another-Strong-2026' }),
    }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ghost')
    expect(result.stdout).not.toContain('✅ 已重置口令：admin')
    expect(result.stdout).not.toContain('完成：')

    const check = new DatabaseSync(dbPath)
    const row = check.prepare("SELECT password FROM users WHERE username='admin'").get() as {
      password: string
    }
    check.close()
    expect(bcrypt.compareSync('old-password', row.password)).toBe(true) // 未被改（整体回滚）
  })

  it('atomically resets all eight historical seed accounts through dedicated environment variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    createUsersDatabase(dbPath)

    const passwords = {
      admin: 'Owner-Rotated-2026!',
      cangguan: 'Warehouse-Rotated-2026!',
      jishuyuan1: 'Technician-Rotated-2026!',
      jishuyuan2: 'Technician-Two-Rotated-2026!',
      yishi1: 'Pathologist-Rotated-2026!',
      yishi2: 'Pathologist-Two-Rotated-2026!',
      caigou: 'Procurement-Rotated-2026!',
      caiwu: 'Finance-Rotated-2026!',
    }
    const result = runReset(cleanResetEnv({
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: passwords.admin,
      RESET_CANGGUAN_PASSWORD: passwords.cangguan,
      RESET_JISHUYUAN1_PASSWORD: passwords.jishuyuan1,
      RESET_JISHUYUAN2_PASSWORD: passwords.jishuyuan2,
      RESET_YISHI1_PASSWORD: passwords.yishi1,
      RESET_YISHI2_PASSWORD: passwords.yishi2,
      RESET_CAIGOU_PASSWORD: passwords.caigou,
      RESET_CAIWU_PASSWORD: passwords.caiwu,
    }))

    expect(result.status).toBe(0)
    const check = new DatabaseSync(dbPath)
    const passwordMatches: boolean[] = []
    try {
      for (const username of STANDARD_USERS) {
        const row = check.prepare('SELECT password FROM users WHERE username = ?').get(username) as { password: string }
        passwordMatches.push(bcrypt.compareSync(passwords[username], row.password))
      }
    } finally {
      check.close()
    }
    expect(passwordMatches).toEqual(STANDARD_USERS.map(() => true))
  }, 60_000)

  it('rejects a duplicate username across dedicated variables and JSON before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    createUsersDatabase(dbPath, ['admin'])

    const result = runReset(cleanResetEnv({
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: 'Admin-Rotated-2026!',
      RESET_PASSWORDS_JSON: JSON.stringify({ admin: 'Second-Admin-Password-2026!' }),
    }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('admin')
    expect(result.stderr).toMatch(/重复/)
    expect(result.stdout).not.toContain('✅')

    const check = new DatabaseSync(dbPath)
    const row = check.prepare("SELECT password FROM users WHERE username='admin'").get() as { password: string }
    check.close()
    expect(bcrypt.compareSync('admin123', row.password)).toBe(true)
  })

  it('rejects reusing one password for multiple targets before beginning the transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    createUsersDatabase(dbPath, ['admin', 'caiwu'])
    const reusedPassword = 'Shared-N7v!Q2m@R8x#'

    const result = runReset(cleanResetEnv({
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: reusedPassword,
      RESET_CAIWU_PASSWORD: reusedPassword,
    }))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/复用|相同口令/)
    expect(result.stderr).not.toContain(reusedPassword)
    expect(result.stdout).not.toContain('✅')

    const check = new DatabaseSync(dbPath)
    const rows = check.prepare('SELECT username, password FROM users ORDER BY username').all() as Array<{
      username: string
      password: string
    }>
    check.close()
    expect(rows.every(row => bcrypt.compareSync(row.username === 'admin' ? 'admin123' : 'CoreOne2026!', row.password))).toBe(true)
  })

  it('rejects NFKC-equivalent password reuse before beginning the transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'coreone.db')
    createUsersDatabase(dbPath, ['admin', 'caiwu'])
    const sharedCanonicalPassword = 'Shared-N7v!Q2m@R8x#'
    const fullwidthEquivalent = toFullwidthAscii(sharedCanonicalPassword)
    expect(fullwidthEquivalent.normalize('NFKC')).toBe(sharedCanonicalPassword)

    const result = runReset(cleanResetEnv({
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: sharedCanonicalPassword,
      RESET_CAIWU_PASSWORD: fullwidthEquivalent,
    }))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/复用|相同口令/)
    expect(result.stderr).not.toContain(sharedCanonicalPassword)
    expect(result.stderr).not.toContain(fullwidthEquivalent)

    const check = new DatabaseSync(dbPath)
    const rows = check.prepare('SELECT username, password FROM users ORDER BY username').all() as Array<{
      username: string
      password: string
    }>
    check.close()
    expect(rows.every(row => bcrypt.compareSync(row.username === 'admin' ? 'admin123' : 'CoreOne2026!', row.password))).toBe(true)
  })

  it.each([
    ['purely numeric', '1234567890123456'],
    ['single repeated character', 'aaaaaaaaaaaaaaaa'],
  ])('rejects %s passwords before writing', (_label, password) => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-reset-passwords-'))
    tempDirs.push(dir)
    const result = runReset(cleanResetEnv({
      DATABASE_PATH: join(dir, 'unused.db'),
      RESET_ADMIN_PASSWORD: password,
    }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('口令')
  })
})
