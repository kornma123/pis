import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

describe('reset-passwords production guard', () => {
  it('rejects execution without an explicit DATABASE_PATH', () => {
    const env = { ...process.env, RESET_ADMIN_PASSWORD: 'Review-Only-Strong-2026' }
    delete env.DATABASE_PATH
    const result = runReset(env)

    expect(result.status).toBe(1)
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
    const result = runReset({
      ...process.env,
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: nextPassword,
    })
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
    const result = runReset({
      ...process.env,
      DATABASE_PATH: dbPath,
      RESET_ADMIN_PASSWORD: 'Review-Only-Strong-2026',
      RESET_PASSWORDS_JSON: JSON.stringify({ ghost: 'Another-Strong-2026' }),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ghost')

    const check = new DatabaseSync(dbPath)
    const row = check.prepare("SELECT password FROM users WHERE username='admin'").get() as {
      password: string
    }
    check.close()
    expect(bcrypt.compareSync('old-password', row.password)).toBe(true) // 未被改（整体回滚）
  })
})
