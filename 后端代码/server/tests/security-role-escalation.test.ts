/**
 * SEC-RBAC：角色提权天花板（HTTP 隔离库 + 临时文件双连接）。
 *
 * 合同：
 * - lab_director 仍可管理普通用户/自定义角色，但不能授予 admin 或等价全写角色；
 * - 非 admin 不能制造全写角色，也不能修改/删除系统种子角色；
 * - 最后一个有效 admin 不能被停用、删除或降权；
 * - 合法 admin 操作成功，统一审计 actor 只取认证上下文。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from './p0-harness.js'
import { MODULES } from '../src/middleware/rbac-matrix.js'
import {
  requestActorHasCurrentPermission,
  roleMutationExceedsSecurityCeiling,
  wouldRemoveLastEffectiveAdmin,
} from '../src/middleware/permissions.js'

let app: express.Express
let db: Awaited<ReturnType<typeof getDb>>
let adminToken: string
let directorToken: string
let resetDenialTracker: () => void
let authenticateToken: express.RequestHandler
let userRoutes: express.Router
let roleRoutes: express.Router

interface CountRow { count: number }
interface PasswordRow { password: string }
interface RolePermissionsRow { permissions: string }
interface RoleIdRow { id: string }
interface AuditRow {
  username: string
  user_id: string
  request_data?: string
}

const DIRECTOR_ID = 'USER-SEC-DIRECTOR'
const DIRECTOR_USERNAME = 'sec_director'
const DIRECTOR_PASSWORD = 'SecDirector-N7v!Q2m@R8x#'

const allWritePermissions = () => Object.fromEntries(MODULES.map((module) => [module, 'W']))

function createSecurityRaceDb(path: string): DatabaseSync {
  const raceDb = new DatabaseSync(path)
  raceDb.exec(`
    PRAGMA busy_timeout = 0;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      status INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL
    );
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      permissions TEXT,
      status INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL
    );
    CREATE TABLE user_roles (user_id TEXT NOT NULL, role_code TEXT NOT NULL);
  `)
  return raceDb
}

function closeSecurityRaceDb(raceDb: DatabaseSync): void {
  try { raceDb.exec('ROLLBACK') } catch { /* no active transaction */ }
  raceDb.close()
}

function buildActorStatusRaceApp(path: string, router: express.Router): express.Express {
  const raceApp = express()
  raceApp.use(express.json())
  raceApp.use(path, authenticateToken, (_req, _res, next) => {
    // 确定性模拟：认证上下文已建立，另一连接在 handler 拿 BEGIN IMMEDIATE 前停用 actor。
    db.prepare('UPDATE users SET status = 0 WHERE id = ?').run(DIRECTOR_ID)
    next()
  }, router)
  return raceApp
}

function seedUser(id: string, username: string, password: string, roleCode: string): void {
  const hash = bcrypt.hashSync(password, 10)
  db.prepare(`
    INSERT INTO users (id, username, password, real_name, role, primary_role, status, is_deleted)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)
  `).run(id, username, hash, username, roleCode, roleCode)
  db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
    .run(`UR-${id}-${roleCode}`, id, roleCode)
}

function seedRole(id: string, code: string, permissions: Record<string, string>, status = 1): void {
  db.prepare(`
    INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
    VALUES (?, ?, ?, '', ?, ?, 0)
  `).run(id, code, code, JSON.stringify(permissions), status)
}

async function login(username: string, password: string): Promise<string> {
  const response = await request(app).post('/api/v1/auth/login').send({ username, password })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body.data.token
}

function userSnapshot(userId: string) {
  return {
    user: db.prepare('SELECT role, primary_role, status, is_deleted FROM users WHERE id = ?').get(userId),
    roles: db.prepare('SELECT role_code FROM user_roles WHERE user_id = ? ORDER BY role_code').all(userId),
  }
}

function roleSnapshot(roleId: string) {
  return db.prepare('SELECT code, name, description, permissions, status, is_deleted FROM roles WHERE id = ?').get(roleId)
}

async function withSoleAdmin(
  run: (token: string, userId: string) => Promise<void>,
): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const soleId = `USER-SOLE-ADMIN-${suffix}`
  const soleName = `sole_admin_${suffix}`
  const solePassword = 'SoleAdmin-T4k%Z9p&L3d^'
  const seedAdmin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get() as {
    id: string
    role: string
    primary_role: string
    status: number
    is_deleted: number
  }
  const seedAdminRoles = db.prepare('SELECT id, role_code FROM user_roles WHERE user_id = ?')
    .all(seedAdmin.id) as Array<{ id: string; role_code: string }>

  seedUser(soleId, soleName, solePassword, 'admin')
  // 主角色故意不是 admin，仅 user_roles 持 admin：最后-admin 计数必须复用真实多角色语义。
  db.prepare("UPDATE users SET role = 'finance', primary_role = 'finance' WHERE id = ?").run(soleId)
  const token = await login(soleName, solePassword)

  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(seedAdmin.id)
  db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
    .run(`UR-${seedAdmin.id}-finance-temp`, seedAdmin.id, 'finance')
  db.prepare("UPDATE users SET role = 'finance', primary_role = 'finance' WHERE id = ?").run(seedAdmin.id)

  try {
    await run(token, soleId)
  } finally {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(seedAdmin.id)
    const insertRole = db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
    for (const row of seedAdminRoles) insertRole.run(row.id, seedAdmin.id, row.role_code)
    db.prepare('UPDATE users SET role = ?, primary_role = ?, status = ?, is_deleted = ? WHERE id = ?')
      .run(seedAdmin.role, seedAdmin.primary_role, seedAdmin.status, seedAdmin.is_deleted, seedAdmin.id)
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(soleId)
    db.prepare('DELETE FROM users WHERE id = ?').run(soleId)
  }
}

beforeAll(async () => {
  db = await getDb()
  authenticateToken = (await import('../src/middleware/auth.js')).authenticateToken
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const { auditWrite, __resetDenialTrackerForTest } = await import('../src/middleware/audit-log.js')
  const { errorHandler } = await import('../src/middleware/errorHandler.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  userRoutes = (await import('../src/routes/users-v1.1.js')).default
  roleRoutes = (await import('../src/routes/roles-v1.1.js')).default

  seedUser(DIRECTOR_ID, DIRECTOR_USERNAME, DIRECTOR_PASSWORD, 'lab_director')

  app = express()
  app.use(express.json())
  app.use(auditWrite)
  app.use('/api/v1/auth', authRoutes)
  app.use('/api/v1/users', authenticateToken, requirePermission('users', 'R'), userRoutes)
  app.use('/api/v1/roles', authenticateToken, requirePermission('roles', 'R'), roleRoutes)
  app.use(errorHandler)

  adminToken = await login('admin', 'admin123')
  directorToken = await login(DIRECTOR_USERNAME, DIRECTOR_PASSWORD)
  resetDenialTracker = __resetDenialTrackerForTest
}, 60_000)

beforeEach(() => resetDenialTracker())

afterEach(() => {
  // 每个用例必须把直接构造的 SEC fixture 清掉，避免用例顺序掩盖最后-admin 判定。
  db.prepare("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'sec_%' AND id != ?)").run(DIRECTOR_ID)
  db.prepare("DELETE FROM users WHERE username LIKE 'sec_%' AND id != ?").run(DIRECTOR_ID)
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(DIRECTOR_ID)
  db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
    .run(`UR-${DIRECTOR_ID}-lab_director`, DIRECTOR_ID, 'lab_director')
  db.prepare("UPDATE users SET role = 'lab_director', primary_role = 'lab_director', status = 1, is_deleted = 0 WHERE id = ?")
    .run(DIRECTOR_ID)
  db.prepare("DELETE FROM roles WHERE code LIKE 'sec_%'").run()
})

describe('非 admin 的用户角色提权被 fail-closed 拒绝', () => {
  it('创建他人并授予 admin → 403，users/user_roles 零副作用且拒绝审计 actor=认证用户', async () => {
    const username = `sec_admin_target_${Date.now()}`
    const beforeUsers = (db.prepare('SELECT COUNT(*) count FROM users').get() as CountRow).count
    const beforeAssignments = (db.prepare('SELECT COUNT(*) count FROM user_roles').get() as CountRow).count

    const response = await request(app).post('/api/v1/users')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({
        username,
        password: 'Escalate-B6y*C1w(H5s)',
        realName: '越权目标',
        roles: ['admin'],
      })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) count FROM users').get() as CountRow).count).toBe(beforeUsers)
    expect((db.prepare('SELECT COUNT(*) count FROM user_roles').get() as CountRow).count).toBe(beforeAssignments)
    const audit = db.prepare("SELECT * FROM operation_logs WHERE outcome = 'denied' ORDER BY rowid DESC LIMIT 1").get() as AuditRow
    expect(audit.username).toBe(DIRECTOR_USERNAME)
    expect(audit.user_id).toBe(DIRECTOR_ID)
  })

  it('旧单值 role=admin 同样被拦截，不能绕过 roles[] 天花板', async () => {
    const username = `sec_legacy_admin_${Date.now()}`
    const response = await request(app).post('/api/v1/users')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({
        username,
        password: 'LegacyAdmin-H5s!B6y*C1w',
        realName: '旧单值绕过目标',
        role: 'admin',
      })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)).toBeUndefined()
  })

  it('主任给自己授予 admin → 403，主角色和多角色关联均不变', async () => {
    const before = userSnapshot(DIRECTOR_ID)
    const response = await request(app).put(`/api/v1/users/${DIRECTOR_ID}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ roles: ['lab_director', 'admin'], primaryRole: 'admin' })
    const after = userSnapshot(DIRECTOR_ID)

    expect(response.status).toBe(403)
    expect(after).toEqual(before)
  })

  it('主任给自己授予等价全写自定义角色 → 403，DB 零副作用', async () => {
    const roleId = `ROLE-SEC-EQUIV-${Date.now()}`
    const roleCode = `sec_equiv_${Date.now()}`
    seedRole(roleId, roleCode, allWritePermissions())
    const before = userSnapshot(DIRECTOR_ID)

    const response = await request(app).put(`/api/v1/users/${DIRECTOR_ID}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ roles: ['lab_director', roleCode], primaryRole: roleCode })
    const after = userSnapshot(DIRECTOR_ID)

    expect(response.status).toBe(403)
    expect(after).toEqual(before)
  })

  it('多个非全写角色的权限并集达到全 W → 403，不能拆分角色绕过', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const splitAt = Math.ceil(MODULES.length / 2)
    const leftCode = `sec_split_left_${suffix}`
    const rightCode = `sec_split_right_${suffix}`
    seedRole(`ROLE-SEC-SPLIT-L-${suffix}`, leftCode, Object.fromEntries(MODULES.slice(0, splitAt).map((m) => [m, 'W'])))
    seedRole(`ROLE-SEC-SPLIT-R-${suffix}`, rightCode, Object.fromEntries(MODULES.slice(splitAt).map((m) => [m, 'W'])))
    const username = `sec_split_target_${suffix}`

    const response = await request(app).post('/api/v1/users')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({
        username,
        password: 'SplitUnion-V6c#M8z$K3q!',
        realName: '拆分全写目标',
        roles: [leftCode, rightCode],
      })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)).toBeUndefined()
  })

  it('主任不能重置有效 admin 的密码并接管其身份', async () => {
    const admin = db.prepare("SELECT id, password FROM users WHERE username = 'admin'").get() as { id: string; password: string }
    const response = await request(app).put(`/api/v1/users/${admin.id}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ password: 'Takeover-Q2m@R8x#N7v!' })
    const after = db.prepare('SELECT password FROM users WHERE id = ?').get(admin.id) as PasswordRow

    try {
      expect(response.status).toBe(403)
      expect(after.password).toBe(admin.password)
    } finally {
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(admin.password, admin.id)
    }
  })

  it('主任不能先接管停用 admin 再激活其身份', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const userId = `USER-SEC-INACTIVE-ADMIN-${suffix}`
    const username = `sec_inactive_admin_${suffix}`
    seedUser(userId, username, 'InactiveAdmin-F5r&L2x!C8v$', 'admin')
    db.prepare('UPDATE users SET status = 0 WHERE id = ?').run(userId)
    const before = {
      ...userSnapshot(userId),
      password: (db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as PasswordRow).password,
    }

    const response = await request(app).put(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ password: 'TakeInactive-A9m#P4s@W7k!', status: 'active' })
    const after = {
      ...userSnapshot(userId),
      password: (db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as PasswordRow).password,
    }

    expect(response.status).toBe(403)
    expect(after).toEqual(before)
  })

  it.each([
    ['活跃', 1, false],
    ['停用', 0, true],
  ])('主任不能接管%s的自定义全 W 账号', async (_label, status, reactivate) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roleCode = `sec_equivalent_account_${suffix}`
    const userId = `USER-SEC-EQUIVALENT-${suffix}`
    seedRole(`ROLE-SEC-EQUIVALENT-${suffix}`, roleCode, allWritePermissions())
    seedUser(userId, `sec_equivalent_user_${suffix}`, 'EquivalentUser-R6t!N2x@H8q$', roleCode)
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId)
    const before = {
      ...userSnapshot(userId),
      password: (db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as PasswordRow).password,
    }

    const response = await request(app).put(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ password: 'TakeEquivalent-P7m#B4v@K9s!', ...(reactivate ? { status: 'active' } : {}) })
    const after = {
      ...userSnapshot(userId),
      password: (db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as PasswordRow).password,
    }

    expect(response.status).toBe(403)
    expect(after).toEqual(before)
  })

  it('数字 role/code → 400，SQLite TEXT affinity 不能绕过等价全 W 检查', async () => {
    const directorRole = db.prepare("SELECT permissions FROM roles WHERE code = 'lab_director'").get() as RolePermissionsRow
    const directorPermissions = JSON.parse(directorRole.permissions || '{}') as Record<string, string>
    const complement = Object.fromEntries(MODULES.filter((module) => directorPermissions[module] !== 'W').map((module) => [module, 'W']))
    seedRole('ROLE-SEC-NUMERIC-123', '123.0', complement)
    const before = userSnapshot(DIRECTOR_ID)

    try {
      const assignment = await request(app).put(`/api/v1/users/${DIRECTOR_ID}`)
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ roles: ['lab_director', 123], primaryRole: 123 })
      const creation = await request(app).post('/api/v1/roles')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ code: 456, name: '数字角色码', permissions: complement, status: 'active' })
      const directServiceRequest = {
        user: { userId: DIRECTOR_ID, username: DIRECTOR_USERNAME, role: 'lab_director' },
        method: 'POST',
        params: {},
        body: { code: 456, name: '数字角色码', permissions: complement, status: 'active' },
      } as unknown as express.Request

      expect(assignment.status).toBe(400)
      expect(creation.status).toBe(400)
      expect(roleMutationExceedsSecurityCeiling(db, directServiceRequest, 'create')).toBe(true)
      expect(userSnapshot(DIRECTOR_ID)).toEqual(before)
      expect(db.prepare("SELECT 1 FROM roles WHERE code IN ('456', '456.0')").get()).toBeUndefined()
    } finally {
      db.prepare("DELETE FROM roles WHERE code = '123.0'").run()
    }
  })
})

describe('事务内 actor DB 真值复核', () => {
  it('users 写：认证后 actor 被停用 → 403 且目标用户零副作用', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const username = `sec_actor_race_user_${suffix}`
    const raceApp = buildActorStatusRaceApp('/api/v1/users', userRoutes)

    try {
      const response = await request(raceApp).post('/api/v1/users')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({
          username,
          password: 'ActorRace-U8k!F3p@M6w#',
          realName: 'actor race user',
          roles: ['finance'],
        })

      expect(response.status).toBe(403)
      expect(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)).toBeUndefined()
    } finally {
      const created = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as RoleIdRow | undefined
      if (created) db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(created.id)
      db.prepare('DELETE FROM users WHERE username = ?').run(username)
      db.prepare('UPDATE users SET status = 1 WHERE id = ?').run(DIRECTOR_ID)
    }
  })

  it('roles 写：认证后 actor 被停用 → 403 且目标角色零副作用', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const code = `sec_actor_race_role_${suffix}`
    const raceApp = buildActorStatusRaceApp('/api/v1/roles', roleRoutes)

    try {
      const response = await request(raceApp).post('/api/v1/roles')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ code, name: 'actor race role', permissions: { inventory: 'R' }, status: 'active' })

      expect(response.status).toBe(403)
      expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)).toBeUndefined()
    } finally {
      db.prepare('DELETE FROM roles WHERE code = ?').run(code)
      db.prepare('UPDATE users SET status = 1 WHERE id = ?').run(DIRECTOR_ID)
    }
  })
})

describe('非 admin 不能制造权限等价 admin，也不能改系统角色', () => {
  it('创建全写自定义角色 → 403，roles 零副作用', async () => {
    const code = `sec_full_write_${Date.now()}`
    const beforeCount = (db.prepare('SELECT COUNT(*) count FROM roles').get() as CountRow).count
    const response = await request(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ code, name: '越权全写角色', permissions: allWritePermissions(), status: 'active' })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) count FROM roles').get() as CountRow).count).toBe(beforeCount)
  })

  it("旧数组 permissions:['*'] 同样识别为全写 → 403", async () => {
    const code = `sec_star_write_${Date.now()}`
    const response = await request(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ code, name: '星号全写角色', permissions: ['*'], status: 'active' })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)).toBeUndefined()
  })

  it('旧数组列出全部模块同样识别为全写 → 403', async () => {
    const code = `sec_flat_full_write_${Date.now()}`
    const response = await request(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ code, name: '旧数组全写角色', permissions: [...MODULES], status: 'active' })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)).toBeUndefined()
  })

  it('把普通自定义角色升级为全写 → 403，角色行逐字段不变', async () => {
    const roleId = `ROLE-SEC-PARTIAL-${Date.now()}`
    const code = `sec_partial_${Date.now()}`
    seedRole(roleId, code, { inventory: 'R', users: 'W', roles: 'W' })
    const before = roleSnapshot(roleId)

    const response = await request(app).put(`/api/v1/roles/${roleId}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ permissions: allWritePermissions() })
    const after = roleSnapshot(roleId)

    try {
      expect(response.status).toBe(403)
      expect(after).toEqual(before)
    } finally {
      db.prepare('UPDATE roles SET code = ?, name = ?, description = ?, permissions = ?, status = ?, is_deleted = ? WHERE id = ?')
        .run(before.code, before.name, before.description, before.permissions, before.status, before.is_deleted, roleId)
    }
  })

  it.each([
    ['活跃', 1],
    ['停用', 0],
  ])('更新一个非全写角色后使%s用户多角色并集达到全 W → 403', async (_label, status) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const splitAt = Math.ceil(MODULES.length / 2)
    const leftCode = `sec_union_left_${suffix}`
    const rightCode = `sec_union_right_${suffix}`
    const rightModules = MODULES.slice(splitAt)
    const leftId = `ROLE-SEC-UNION-L-${suffix}`
    const rightId = `ROLE-SEC-UNION-R-${suffix}`
    seedRole(leftId, leftCode, Object.fromEntries(MODULES.slice(0, splitAt).map((m) => [m, 'W'])))
    seedRole(rightId, rightCode, Object.fromEntries(rightModules.slice(0, -1).map((m) => [m, 'W'])))
    const targetId = `USER-SEC-UNION-${suffix}`
    seedUser(targetId, `sec_union_user_${suffix}`, 'UnionTarget-K3q!V6c#M8z$', leftCode)
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, targetId)
    db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run(`UR-${targetId}-${rightCode}`, targetId, rightCode)
    const before = roleSnapshot(rightId)

    const response = await request(app).put(`/api/v1/roles/${rightId}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ permissions: Object.fromEntries(rightModules.map((m) => [m, 'W'])) })

    expect(response.status).toBe(403)
    expect(roleSnapshot(rightId)).toEqual(before)
  })

  it('创建角色不得激活预埋 role_code 并让既有用户权限并集达到全 W', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const code = `sec_orphan_union_${suffix}`
    const directorRole = db.prepare("SELECT permissions FROM roles WHERE code = 'lab_director'").get() as RolePermissionsRow
    const directorPermissions = JSON.parse(directorRole.permissions || '{}') as Record<string, string>
    const complement = Object.fromEntries(MODULES.filter((module) => directorPermissions[module] !== 'W').map((module) => [module, 'W']))
    db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run(`UR-${DIRECTOR_ID}-${code}`, DIRECTOR_ID, code)

    const response = await request(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ code, name: '孤儿关联激活角色', permissions: complement, status: 'active' })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)).toBeUndefined()
  })

  it('删除当前角色不得让用户回退到 users.role=admin', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roleId = `ROLE-SEC-FALLBACK-DELETE-${suffix}`
    const roleCode = `sec_fallback_delete_${suffix}`
    const userId = `USER-SEC-FALLBACK-DELETE-${suffix}`
    seedRole(roleId, roleCode, { inventory: 'R' })
    seedUser(userId, `sec_fallback_delete_${suffix}`, 'FallbackDelete-M8z!Q4w#T7k$', roleCode)
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId)
    const before = roleSnapshot(roleId)

    const response = await request(app).delete(`/api/v1/roles/${roleId}`)
      .set('Authorization', `Bearer ${directorToken}`)

    expect(response.status).toBe(403)
    expect(roleSnapshot(roleId)).toEqual(before)
  })

  it('停用当前角色不得让用户回退到 users.role 指向的全 W 角色', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roleId = `ROLE-SEC-FALLBACK-INACTIVE-${suffix}`
    const roleCode = `sec_fallback_inactive_${suffix}`
    const fallbackCode = `sec_fallback_full_w_${suffix}`
    const userId = `USER-SEC-FALLBACK-INACTIVE-${suffix}`
    seedRole(roleId, roleCode, { inventory: 'R' })
    seedRole(`ROLE-SEC-FALLBACK-FULL-W-${suffix}`, fallbackCode, allWritePermissions())
    seedUser(userId, `sec_fallback_inactive_${suffix}`, 'FallbackInactive-R6t!V2n@H9q$', roleCode)
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(fallbackCode, userId)
    const before = roleSnapshot(roleId)

    const response = await request(app).put(`/api/v1/roles/${roleId}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ status: 'inactive' })

    expect(response.status).toBe(403)
    expect(roleSnapshot(roleId)).toEqual(before)
  })

  it('角色改码不得让旧 user_roles 失效后回退到 users.role=admin', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roleId = `ROLE-SEC-FALLBACK-RENAME-${suffix}`
    const roleCode = `sec_fallback_rename_${suffix}`
    const userId = `USER-SEC-FALLBACK-RENAME-${suffix}`
    seedRole(roleId, roleCode, { inventory: 'R' })
    seedUser(userId, `sec_fallback_rename_${suffix}`, 'FallbackRename-C5p!N8x@K3s$', roleCode)
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId)
    const before = roleSnapshot(roleId)

    const response = await request(app).put(`/api/v1/roles/${roleId}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ code: `sec_fallback_renamed_${suffix}` })

    expect(response.status).toBe(403)
    expect(roleSnapshot(roleId)).toEqual(before)
  })

  it('修改系统种子角色 → 403，角色行逐字段不变', async () => {
    const role = db.prepare("SELECT id FROM roles WHERE code = 'technician' AND is_deleted = 0").get() as RoleIdRow
    const before = roleSnapshot(role.id)
    const response = await request(app).put(`/api/v1/roles/${role.id}`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ description: 'tampered-by-non-admin' })
    const after = roleSnapshot(role.id)

    try {
      expect(response.status).toBe(403)
      expect(after).toEqual(before)
    } finally {
      db.prepare('UPDATE roles SET code = ?, name = ?, description = ?, permissions = ?, status = ?, is_deleted = ? WHERE id = ?')
        .run(before.code, before.name, before.description, before.permissions, before.status, before.is_deleted, role.id)
    }
  })

  it('删除系统种子角色 → 403，角色行逐字段不变', async () => {
    const role = db.prepare("SELECT id FROM roles WHERE code = 'finance' AND is_deleted = 0").get() as RoleIdRow
    const before = roleSnapshot(role.id)
    const response = await request(app).delete(`/api/v1/roles/${role.id}`)
      .set('Authorization', `Bearer ${directorToken}`)
    const after = roleSnapshot(role.id)

    try {
      expect(response.status).toBe(403)
      expect(after).toEqual(before)
    } finally {
      db.prepare('UPDATE roles SET code = ?, name = ?, description = ?, permissions = ?, status = ?, is_deleted = ? WHERE id = ?')
        .run(before.code, before.name, before.description, before.permissions, before.status, before.is_deleted, role.id)
    }
  })
})

describe('最后一个有效 admin 不可被移除', () => {
  it.each([
    ['停用', async (token: string, userId: string) => request(app).put(`/api/v1/users/${userId}`).set('Authorization', `Bearer ${token}`).send({ status: 'inactive' })],
    ['降权', async (token: string, userId: string) => request(app).put(`/api/v1/users/${userId}`).set('Authorization', `Bearer ${token}`).send({ roles: ['finance'], primaryRole: 'finance' })],
    ['删除', async (token: string, userId: string) => request(app).delete(`/api/v1/users/${userId}`).set('Authorization', `Bearer ${token}`)],
  ])('%s最后一个有效 admin → 409 且用户/角色关联零副作用', async (_label, mutate) => {
    await withSoleAdmin(async (token, userId) => {
      const before = userSnapshot(userId)
      const response = await mutate(token, userId)
      const after = userSnapshot(userId)
      expect(response.status).toBe(409)
      expect(after).toEqual(before)
    })
  })

  it('同一进程重叠派发两个仅存 admin 自降权 → 恰好一个成功，另一个 409 且保持 admin', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const secondId = `USER-SEC-CONCURRENT-ADMIN-${suffix}`
    const secondName = `sec_concurrent_admin_${suffix}`
    const secondPassword = 'ConcurrentAdmin-J8p!D3w@Q6n%'
    const seedAdmin = db.prepare("SELECT id, role, primary_role, status, is_deleted FROM users WHERE username = 'admin'").get() as {
      id: string
      role: string
      primary_role: string
      status: number
      is_deleted: number
    }
    const seedAdminRoles = db.prepare('SELECT id, role_code FROM user_roles WHERE user_id = ? ORDER BY role_code')
      .all(seedAdmin.id) as Array<{ id: string; role_code: string }>

    seedUser(secondId, secondName, secondPassword, 'admin')
    const secondToken = await login(secondName, secondPassword)
    const beforeSeed = userSnapshot(seedAdmin.id)
    const beforeSecond = userSnapshot(secondId)

    try {
      const [seedResponse, secondResponse] = await Promise.all([
        request(app).put(`/api/v1/users/${seedAdmin.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ roles: ['finance'], primaryRole: 'finance' }),
        request(app).put(`/api/v1/users/${secondId}`)
          .set('Authorization', `Bearer ${secondToken}`)
          .send({ roles: ['finance'], primaryRole: 'finance' }),
      ])

      expect([seedResponse.status, secondResponse.status].sort()).toEqual([200, 409])
      const cases = [
        { response: seedResponse, before: beforeSeed, after: userSnapshot(seedAdmin.id) },
        { response: secondResponse, before: beforeSecond, after: userSnapshot(secondId) },
      ]
      for (const item of cases) {
        if (item.response.status === 409) expect(item.after).toEqual(item.before)
        else expect(item.after.roles).toEqual([{ role_code: 'finance' }])
      }
      const remaining = cases.filter((item) => item.after.roles.some((role) => role.role_code === 'admin'))
      expect(remaining).toHaveLength(1)
    } finally {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(seedAdmin.id)
      const restoreSeedRole = db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      for (const row of seedAdminRoles) restoreSeedRole.run(row.id, seedAdmin.id, row.role_code)
      db.prepare('UPDATE users SET role = ?, primary_role = ?, status = ?, is_deleted = ? WHERE id = ?')
        .run(seedAdmin.role, seedAdmin.primary_role, seedAdmin.status, seedAdmin.is_deleted, seedAdmin.id)
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(secondId)
      db.prepare('DELETE FROM users WHERE id = ?').run(secondId)
    }
  })

  it('真实双连接锁竞争 → 最后-admin service 重读后拒绝，竞争连接零副作用', () => {
    const raceDir = mkdtempSync(join(tmpdir(), 'coreone-rbac-last-admin-'))
    const racePath = join(raceDir, 'race.db')
    const first = createSecurityRaceDb(racePath)
    first.exec(`
      INSERT INTO roles VALUES ('ROLE-ADMIN', 'admin', '["*"]', 1, 0);
      INSERT INTO roles VALUES ('ROLE-FINANCE', 'finance', '{}', 1, 0);
      INSERT INTO users VALUES ('ADMIN-A', 'admin', 1, 0);
      INSERT INTO users VALUES ('ADMIN-B', 'admin', 1, 0);
      INSERT INTO user_roles VALUES ('ADMIN-A', 'admin');
      INSERT INTO user_roles VALUES ('ADMIN-B', 'admin');
    `)
    const second = new DatabaseSync(racePath)
    second.exec('PRAGMA busy_timeout = 0')

    try {
      first.exec('BEGIN IMMEDIATE')
      expect(wouldRemoveLastEffectiveAdmin(first, 'ADMIN-A', { roles: ['finance'] })).toBe(false)
      first.prepare("UPDATE users SET role = 'finance' WHERE id = 'ADMIN-A'").run()
      first.prepare("DELETE FROM user_roles WHERE user_id = 'ADMIN-A'").run()
      first.prepare("INSERT INTO user_roles VALUES ('ADMIN-A', 'finance')").run()

      expect(() => second.exec('BEGIN IMMEDIATE')).toThrow(/busy|locked/i)
      expect(second.prepare("SELECT role FROM users WHERE id = 'ADMIN-B'").get()).toEqual({ role: 'admin' })

      first.exec('COMMIT')
      second.exec('BEGIN IMMEDIATE')
      expect(wouldRemoveLastEffectiveAdmin(second, 'ADMIN-B', { roles: ['finance'] })).toBe(true)
      second.exec('ROLLBACK')
      expect(second.prepare("SELECT COUNT(*) AS count FROM user_roles WHERE role_code = 'admin'").get())
        .toEqual({ count: 1 })
    } finally {
      closeSecurityRaceDb(first)
      closeSecurityRaceDb(second)
      rmSync(raceDir, { recursive: true, force: true })
    }
  })

  it('真实双连接角色候选竞争 → 锁后重算阻断拆分全 W write-skew', () => {
    const raceDir = mkdtempSync(join(tmpdir(), 'coreone-rbac-role-ceiling-'))
    const racePath = join(raceDir, 'race.db')
    const first = createSecurityRaceDb(racePath)
    const splitAt = Math.ceil(MODULES.length / 2)
    const leftPermissions = Object.fromEntries(MODULES.slice(0, splitAt).map((module) => [module, 'W']))
    const rightPermissions = Object.fromEntries(MODULES.slice(splitAt).map((module) => [module, 'W']))
    first.prepare('INSERT INTO roles VALUES (?, ?, ?, ?, ?)')
      .run('ROLE-DIRECTOR', 'lab_director', JSON.stringify({ users: 'W', roles: 'W' }), 1, 0)
    first.prepare('INSERT INTO roles VALUES (?, ?, ?, ?, ?)')
      .run('ROLE-FINANCE', 'finance', '{}', 1, 0)
    first.exec(`
      INSERT INTO users VALUES ('DIRECTOR', 'lab_director', 1, 0);
      INSERT INTO users VALUES ('TARGET', 'finance', 1, 0);
      INSERT INTO user_roles VALUES ('DIRECTOR', 'lab_director');
      INSERT INTO user_roles VALUES ('TARGET', 'RACE-LEFT');
      INSERT INTO user_roles VALUES ('TARGET', 'RACE-RIGHT');
    `)
    const second = new DatabaseSync(racePath)
    second.exec('PRAGMA busy_timeout = 0')
    const actor = { userId: 'DIRECTOR', username: 'director', role: 'lab_director', roles: ['lab_director'] }
    const leftRequest = {
      user: actor,
      method: 'POST',
      params: {},
      body: { code: 'RACE-LEFT', permissions: leftPermissions, status: 'active' },
    } as unknown as express.Request
    const rightRequest = {
      user: actor,
      method: 'POST',
      params: {},
      body: { code: 'RACE-RIGHT', permissions: rightPermissions, status: 'active' },
    } as unknown as express.Request

    try {
      first.exec('BEGIN IMMEDIATE')
      expect(requestActorHasCurrentPermission(first, leftRequest, 'roles', 'W')).toBe(true)
      expect(roleMutationExceedsSecurityCeiling(first, leftRequest, 'create')).toBe(false)
      first.prepare('INSERT INTO roles VALUES (?, ?, ?, ?, ?)')
        .run('ROLE-RACE-LEFT', 'RACE-LEFT', JSON.stringify(leftPermissions), 1, 0)

      expect(() => second.exec('BEGIN IMMEDIATE')).toThrow(/busy|locked/i)
      expect(second.prepare("SELECT 1 FROM roles WHERE code = 'RACE-RIGHT'").get()).toBeUndefined()

      first.exec('COMMIT')
      second.exec('BEGIN IMMEDIATE')
      expect(requestActorHasCurrentPermission(second, rightRequest, 'roles', 'W')).toBe(true)
      expect(roleMutationExceedsSecurityCeiling(second, rightRequest, 'create')).toBe(true)
      second.exec('ROLLBACK')
      expect(second.prepare("SELECT 1 FROM roles WHERE code = 'RACE-LEFT'").get()).toBeTruthy()
      expect(second.prepare("SELECT 1 FROM roles WHERE code = 'RACE-RIGHT'").get()).toBeUndefined()
    } finally {
      closeSecurityRaceDb(first)
      closeSecurityRaceDb(second)
      rmSync(raceDir, { recursive: true, force: true })
    }
  })
})

describe('合法 admin 操作与可信审计', () => {
  it('仍有另一名有效 admin 时，合法 admin 可降权非种子 admin', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const userId = `USER-SEC-SECOND-ADMIN-${suffix}`
    const username = `sec_second_admin_${suffix}`
    seedUser(userId, username, 'SecondAdmin-M8z$K3q!V6c#', 'admin')

    const response = await request(app).put(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: ['finance'], primaryRole: 'finance' })

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(userSnapshot(userId).roles).toEqual([{ role_code: 'finance' }])
  })

  it('普通 lab_director 用户/角色管理仍成功，不能把修复做成 blanket requireAdmin', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const code = `sec_regular_${suffix}`
    const username = `sec_regular_user_${suffix}`
    const roleResponse = await request(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ code, name: '普通自定义角色', permissions: { inventory: 'R' }, status: 'active' })
    const userResponse = await request(app).post('/api/v1/users')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ username, password: 'Regular-C1w(H5s!B6y*', realName: '普通用户', roles: [code] })

    expect(roleResponse.status, JSON.stringify(roleResponse.body)).toBe(200)
    expect(userResponse.status, JSON.stringify(userResponse.body)).toBe(201)
    expect(db.prepare('SELECT 1 FROM roles WHERE code = ? AND is_deleted = 0').get(code)).toBeTruthy()
    expect(db.prepare('SELECT 1 FROM users WHERE username = ? AND is_deleted = 0').get(username)).toBeTruthy()
  })

  it('伪造 actor/operator 字段被拒，不能在审计详情植入第二主体', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const code = `sec_forged_actor_${suffix}`
    const marker = `forged-director-${suffix}`
    const response = await request(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code, name: '伪造审计主体', permissions: { inventory: 'R' }, actor: marker })

    expect(response.status).toBe(400)
    expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)).toBeUndefined()
    const audit = db.prepare("SELECT * FROM operation_logs WHERE outcome = 'denied' ORDER BY rowid DESC LIMIT 1").get() as AuditRow
    expect(audit.username).toBe('admin')
    expect(audit.user_id).toBe('USER-001')
    expect(String(audit.request_data)).not.toContain(marker)
  })

  it('DELETE 请求同样拒绝伪造 operator，目标用户保持不变', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const userId = `USER-SEC-DELETE-ACTOR-${suffix}`
    const marker = `forged-delete-operator-${suffix}`
    seedUser(userId, `sec_delete_actor_${suffix}`, 'DeleteActor-Q7n@D4w%J9p!', 'finance')
    const before = userSnapshot(userId)

    const response = await request(app).delete(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ operator: marker })

    expect(response.status).toBe(400)
    expect(userSnapshot(userId)).toEqual(before)
    const audit = db.prepare("SELECT * FROM operation_logs WHERE outcome = 'denied' ORDER BY rowid DESC LIMIT 1").get() as AuditRow
    expect(audit.username).toBe('admin')
    expect(audit.user_id).toBe('USER-001')
    expect(String(audit.request_data)).not.toContain(marker)
  })

  it('admin 可创建全写自定义角色，审计 actor 来自认证上下文', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const code = `sec_admin_full_${suffix}`
    const response = await request(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code,
        name: '管理员创建的全写角色',
        permissions: allWritePermissions(),
        status: 'active',
      })

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(db.prepare('SELECT 1 FROM roles WHERE code = ? AND is_deleted = 0').get(code)).toBeTruthy()
    const audit = db.prepare("SELECT * FROM operation_logs WHERE operation = 'POST roles' ORDER BY rowid DESC LIMIT 1").get() as AuditRow
    expect(audit.username).toBe('admin')
    expect(audit.user_id).toBe('USER-001')
  })
})
