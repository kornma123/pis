/**
 * seedDefaultUsers 集成测试 —— 复审 P1#3：证明生产级不种默认凭据、不强制启用；夹具环境行为不变。
 * 直接在裸 :memory: 库上调用抽出的可测函数（不经单例/NODE_ENV，注入 allowFixtures）。
 */
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import { seedDefaultUsers } from '../src/database/DatabaseManager.js'

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    real_name TEXT,
    role TEXT,
    department TEXT,
    status INTEGER DEFAULT 1,
    is_deleted INTEGER DEFAULT 0
  )`)
  return db
}
const count = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c

function insertUserWithPassword(
  db: DatabaseSync,
  username: string,
  password: string,
  opts: { status?: number; isDeleted?: number } = {}
): void {
  db.prepare(
    'INSERT INTO users (id,username,password,real_name,role,department,status,is_deleted) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    `USER-${username}`,
    username,
    bcrypt.hashSync(password, 4),
    username,
    username === 'admin' ? 'admin' : 'finance',
    '病理科',
    opts.status ?? 1,
    opts.isDeleted ?? 0
  )
}

describe('seedDefaultUsers —— 生产级（allowFixtures=false）默认安全', () => {
  it('不种任何固定口令账号', () => {
    const db = freshDb()
    seedDefaultUsers(db, { allowFixtures: false })
    expect(count(db)).toBe(0)
  })

  it('仅合格 ADMIN_INITIAL_PASSWORD 才受控创建 admin（且不是 admin123）', () => {
    const db = freshDb()
    const strongPassword = 'N7v!Q2m@R8x#T4k%Z9p&L3d^'
    seedDefaultUsers(db, { allowFixtures: false, adminInitialPassword: strongPassword })
    const admin = db.prepare("SELECT password FROM users WHERE username='admin'").get() as
      | { password: string }
      | undefined
    expect(admin).toBeTruthy()
    expect(bcrypt.compareSync(strongPassword, admin!.password)).toBe(true)
    expect(bcrypt.compareSync('admin123', admin!.password)).toBe(false)
  })

  it('拒绝用泄露口令 admin123 创建 admin', () => {
    const db = freshDb()
    expect(() => seedDefaultUsers(db, { allowFixtures: false, adminInitialPassword: 'admin123' })).toThrow()
    expect(db.prepare("SELECT id FROM users WHERE username='admin'").get()).toBeFalsy()
  })

  it('拒绝过短 ADMIN_INITIAL_PASSWORD', () => {
    const db = freshDb()
    expect(() => seedDefaultUsers(db, { allowFixtures: false, adminInitialPassword: 'short' })).toThrow()
    expect(db.prepare("SELECT id FROM users WHERE username='admin'").get()).toBeFalsy()
  })

  it('将 docker compose 传入的空字符串归一为未提供，但显式空白仍拒绝', () => {
    const emptyDb = freshDb()
    expect(() => seedDefaultUsers(emptyDb, { allowFixtures: false, adminInitialPassword: '' })).not.toThrow()
    expect(emptyDb.prepare("SELECT id FROM users WHERE username='admin'").get()).toBeFalsy()

    const whitespaceDb = freshDb()
    expect(() => seedDefaultUsers(whitespaceDb, { allowFixtures: false, adminInitialPassword: '   ' })).toThrow()
    expect(whitespaceDb.prepare("SELECT id FROM users WHERE username='admin'").get()).toBeFalsy()
  })

  it('非历史账号即便沿用公开口令也不进入有界启动扫描', () => {
    const db = freshDb()
    insertUserWithPassword(db, 'custom-user', 'CoreOne2026!')

    expect(() => seedDefaultUsers(db, { allowFixtures: false })).not.toThrow()
  })

  it('不强制重新启用被软删除的既有 admin', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO users (id,username,password,real_name,role,department,status,is_deleted) VALUES ('USER-001','admin','x','管理员','admin','病理科',0,1)"
    ).run()
    seedDefaultUsers(db, { allowFixtures: false })
    const admin = db.prepare("SELECT status,is_deleted FROM users WHERE username='admin'").get() as {
      status: number
      is_deleted: number
    }
    expect(admin.is_deleted).toBe(1) // 仍禁用 —— 生产级绝不擅自复活
    expect(admin.status).toBe(0)
  })

  it('旧库仍有活跃 admin/admin123 与 caiwu/CoreOne2026! 时拒绝启动', () => {
    const db = freshDb()
    insertUserWithPassword(db, 'admin', 'admin123')
    insertUserWithPassword(db, 'caiwu', 'CoreOne2026!')

    expect(() => seedDefaultUsers(db, { allowFixtures: false })).toThrow(/admin.*caiwu|caiwu.*admin/)
  })

  it('已禁用或软删除的泄露口令账号不阻断启动', () => {
    const db = freshDb()
    insertUserWithPassword(db, 'admin', 'admin123', { status: 0 })
    insertUserWithPassword(db, 'caiwu', 'CoreOne2026!', { isDeleted: 1 })

    expect(() => seedDefaultUsers(db, { allowFixtures: false })).not.toThrow()
  })
})

describe('seedDefaultUsers —— 夹具环境（allowFixtures=true）行为与历史一致', () => {
  it('种 admin/admin123 + 5 角色（口令 CoreOne2026!）', () => {
    const db = freshDb()
    seedDefaultUsers(db, { allowFixtures: true })
    expect(count(db)).toBe(6)
    const admin = db.prepare("SELECT password FROM users WHERE username='admin'").get() as { password: string }
    expect(bcrypt.compareSync('admin123', admin.password)).toBe(true)
    const fin = db.prepare("SELECT password FROM users WHERE username='caiwu'").get() as { password: string }
    expect(bcrypt.compareSync('CoreOne2026!', fin.password)).toBe(true)
  })

  it('强制重新启用被软删除的 admin（E2E 依赖）', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO users (id,username,password,real_name,role,department,status,is_deleted) VALUES ('USER-001','admin','x','管理员','admin','病理科',0,1)"
    ).run()
    seedDefaultUsers(db, { allowFixtures: true })
    const admin = db.prepare("SELECT status,is_deleted FROM users WHERE username='admin'").get() as {
      status: number
      is_deleted: number
    }
    expect(admin.is_deleted).toBe(0)
    expect(admin.status).toBe(1)
  })
})
