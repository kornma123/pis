/**
 * RBAC Phase 7：成本可见性开关（可配置默认 + 即时生效）
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from './p0-harness.js'

const testDatabaseDirectory = mkdtempSync(join(tmpdir(), 'coreone-loc007-cost-visibility-'))
const testDatabasePath = join(testDatabaseDirectory, 'cost-visibility.db')
const previousDatabasePath = process.env.DATABASE_PATH
process.env.DATABASE_PATH = testDatabasePath

let app: express.Express
let db: Awaited<ReturnType<typeof getDb>>
let resetDenialTracker: () => void
let baselineSetting: { value: string; updated_at: string }

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  return res.body.data.token
}
async function caps(token: string) {
  const request = (await import('supertest')).default
  return (await request(app).get('/api/v1/auth/me/capabilities').set('Authorization', `Bearer ${token}`)).body.data
}

beforeAll(async () => {
  db = await getDb()
  baselineSetting = db.prepare(
    "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
  ).get() as typeof baselineSetting
  const authRoutes = (await import('../src/routes/auth.js')).default
  const { auditWrite, __resetDenialTrackerForTest } = await import('../src/middleware/audit-log.js')
  const { errorHandler } = await import('../src/middleware/errorHandler.js')
  resetDenialTracker = __resetDenialTrackerForTest
  app = express()
  app.use(express.json())
  app.use(auditWrite)
  app.use('/api/v1/auth', authRoutes)
  app.use(errorHandler)
})

beforeEach(() => {
  resetDenialTracker()
  db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'cost_visibility_roles'")
    .run(baselineSetting.value, baselineSetting.updated_at)
})

afterEach(() => {
  db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'cost_visibility_roles'")
    .run(baselineSetting.value, baselineSetting.updated_at)
})

afterAll(async () => {
  const { closeDatabase } = await import('../src/database/DatabaseManager.js')
  closeDatabase()
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = previousDatabasePath
  rmSync(testDatabaseDirectory, { recursive: true, force: true })
})

describe('RBAC-P7：成本可见性默认', () => {
  it('默认 finance/admin canSeeCost=true，technician=false', async () => {
    expect((await caps(await login('caiwu', 'CoreOne2026!'))).canSeeCost).toBe(true)
    expect((await caps(await login('admin', 'admin123'))).canSeeCost).toBe(true)
    expect((await caps(await login('jishuyuan1', 'CoreOne2026!'))).canSeeCost).toBe(false)
  })

  it('GET /cost-visibility 返回默认角色集合', async () => {
    const request = (await import('supertest')).default
    const token = await login('admin', 'admin123')
    const res = await request(app).get('/api/v1/auth/cost-visibility').set('Authorization', `Bearer ${token}`)
    expect(res.body.data.roles).toEqual(expect.arrayContaining(['finance', 'lab_director', 'admin']))
  })
})

describe('RBAC-P7：开关即时生效', () => {
  it('admin 把 technician 加入 → technician canSeeCost 立即 true（不发版）', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    // 改前
    expect((await caps(await login('jishuyuan1', 'CoreOne2026!'))).canSeeCost).toBe(false)
    // 加入 technician
    const put = await request(app).put('/api/v1/auth/cost-visibility').set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: ['finance', 'lab_director', 'technician'] })
    expect(put.status).toBe(200)
    expect(put.body.data.roles).toContain('admin') // 防误锁，自动保留 admin
    // 改后：technician 立即可见
    expect((await caps(await login('jishuyuan1', 'CoreOne2026!'))).canSeeCost).toBe(true)
    // 还原
    await request(app).put('/api/v1/auth/cost-visibility').set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: ['finance', 'lab_director', 'admin'] })
  })

  it('非管理角色 PUT /cost-visibility → 403', async () => {
    const request = (await import('supertest')).default
    const token = await login('caiwu', 'CoreOne2026!') // finance 非 admin/lab_director
    const res = await request(app).put('/api/v1/auth/cost-visibility').set('Authorization', `Bearer ${token}`)
      .send({ roles: ['finance'] })
    expect(res.status).toBe(403)
  })
})

describe('RBAC-P7：事务内重读 runtime actor', () => {
  type RouteLayer = {
    name?: string
    regexp?: { toString(): string }
    handle?: express.RequestHandler & { stack?: RouteLayer[] }
    route?: {
      path: string
      methods: Record<string, boolean>
      stack: Array<{ handle: express.RequestHandler }>
    }
  }

  function costVisibilityHandlerLayer(): { handle: express.RequestHandler } {
    const authRouter = (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack
      .find((layer) => layer.name === 'router' && layer.regexp?.toString().includes('api\\/v1\\/auth'))
    const routeLayer = authRouter?.handle?.stack
      ?.find((layer) => layer.route?.path === '/cost-visibility' && layer.route.methods.put)
    const handlerLayer = routeLayer?.route?.stack.at(-1)
    if (!handlerLayer) throw new Error('production PUT /cost-visibility handler not found')
    return handlerLayer
  }

  it.each([
    ['disabled', (second: DatabaseSync) => {
      second.prepare("UPDATE users SET status = 0 WHERE id = 'USER-001'").run()
    }],
    ['revoked', (second: DatabaseSync) => {
      second.prepare("DELETE FROM user_roles WHERE user_id = 'USER-001'").run()
      second.prepare("UPDATE users SET role = 'finance', primary_role = 'finance' WHERE id = 'USER-001'").run()
    }],
  ] as const)('%s actor 在认证后由第二连接变更 → 403 且 app_settings 零写', async (_case, mutateActor) => {
    const token = await login('admin', 'admin123')
    const userBefore = db.prepare(
      'SELECT role, primary_role, status, is_deleted FROM users WHERE id = ?',
    ).get('USER-001')
    const assignmentsBefore = db.prepare(
      'SELECT id, role_code FROM user_roles WHERE user_id = ? ORDER BY id',
    ).all('USER-001') as Array<{ id: string; role_code: string }>
    const settingBefore = db.prepare(
      "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
    ).get()
    const second = new DatabaseSync(testDatabasePath)
    second.exec('PRAGMA busy_timeout = 0')
    const handlerLayer = costVisibilityHandlerLayer()
    const originalHandler = handlerLayer.handle
    let mutationHits = 0
    handlerLayer.handle = ((req, res, next) => {
      mutationHits += 1
      mutateActor(second)
      return originalHandler(req, res, next)
    }) as express.RequestHandler

    try {
      const response = await (await import('supertest')).default(app)
        .put('/api/v1/auth/cost-visibility')
        .set('Authorization', `Bearer ${token}`)
        .send({ roles: ['finance', 'lab_director', 'admin'] })

      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('FORBIDDEN')
      expect(mutationHits).toBe(1)
      expect(db.prepare(
        "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
      ).get()).toEqual(settingBefore)
    } finally {
      handlerLayer.handle = originalHandler
      second.close()
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run('USER-001')
      const restoreAssignment = db.prepare(
        'INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)',
      )
      for (const assignment of assignmentsBefore) {
        restoreAssignment.run(assignment.id, 'USER-001', assignment.role_code)
      }
      const user = userBefore as { role: string; primary_role: string; status: number; is_deleted: number }
      db.prepare('UPDATE users SET role = ?, primary_role = ?, status = ?, is_deleted = ? WHERE id = ?')
        .run(user.role, user.primary_role, user.status, user.is_deleted, 'USER-001')
    }
  })
})

describe('RBAC-P7：成功 payload 只接受精确 {roles}', () => {
  it.each([
    ['actor', { actor: { userId: 'FORGED', username: 'forged-admin' } }],
    ['operator', { operator: 'forged-operator' }],
    ['role', { role: 'admin' }],
  ] as const)('合法 roles + forged %s → 400、settings 零写、拒绝审计无 body', async (_field, forged) => {
    const token = await login('admin', 'admin123')
    const beforeSetting = db.prepare(
      "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
    ).get()
    const beforeAuditRowId = (db.prepare(
      'SELECT COALESCE(MAX(rowid), 0) AS id FROM operation_logs',
    ).get() as { id: number }).id

    const response = await (await import('supertest')).default(app)
      .put('/api/v1/auth/cost-visibility')
      .set('Authorization', `Bearer ${token}`)
      .send({ roles: ['finance', 'lab_director', 'admin'], ...forged })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_PARAMETER')
    expect(db.prepare(
      "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
    ).get()).toEqual(beforeSetting)
    const audit = db.prepare(`
      SELECT username, user_id, request_data, outcome
      FROM operation_logs
      WHERE rowid > ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(beforeAuditRowId) as {
      username: string
      user_id: string
      request_data: string
      outcome: string
    }
    expect(audit).toMatchObject({ username: 'admin', user_id: 'USER-001', outcome: 'denied' })
    expect(JSON.parse(audit.request_data)).toEqual({ status: 400, code: 'INVALID_PARAMETER' })
    expect(audit.request_data).not.toContain('FORGED')
    expect(audit.request_data).not.toContain('forged-')
  })
})

describe('RBAC-P7：角色集合必须来自同一 canonical active-role resolver', () => {
  const invalidVariants = [
    ['显式空 roles', []],
    ['重复角色码', ['finance', 'finance']],
    ['空角色码', ['']],
    ['纯空白角色码', ['   ']],
    ['前后空白角色码', [' finance ']],
    ['NFKC 兼容字符', ['ｆｉｎａｎｃｅ']],
    ['Unicode confusable', ['fіnance']],
    ['非 canonical 大小写', ['Finance']],
    ['零宽字符', ['fin\u200bance']],
    ['bidi 控制符', ['fin\u202eance']],
    ['原型名', ['__proto__']],
    ['非字符串', ['finance', 42]],
    ['未知 canonical 码', ['loc007_unknown_role']],
  ] as const

  it.each(invalidVariants)('%s → 400 且 app_settings 零写', async (_label, roles) => {
    const token = await login('admin', 'admin123')
    const beforeSetting = db.prepare(
      "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
    ).get()

    const response = await (await import('supertest')).default(app)
      .put('/api/v1/auth/cost-visibility')
      .set('Authorization', `Bearer ${token}`)
      .send({ roles })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_PARAMETER')
    expect(db.prepare(
      "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
    ).get()).toEqual(beforeSetting)
  })

  it.each([
    ['disabled', 0, 0],
    ['soft deleted', 1, 1],
  ] as const)('%s DB role → 400 且 app_settings 零写', async (_label, status, isDeleted) => {
    const suffix = `${status}-${isDeleted}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const code = `loc007_inactive_${suffix}`
    db.prepare(`
      INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
      VALUES (?, ?, ?, '', '{}', ?, ?)
    `).run(`ROLE-${suffix}`, code, code, status, isDeleted)
    const token = await login('admin', 'admin123')
    const beforeSetting = db.prepare(
      "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
    ).get()
    try {
      const response = await (await import('supertest')).default(app)
        .put('/api/v1/auth/cost-visibility')
        .set('Authorization', `Bearer ${token}`)
        .send({ roles: [code] })
      expect(response.status).toBe(400)
      expect(db.prepare(
        "SELECT value, updated_at FROM app_settings WHERE key = 'cost_visibility_roles'",
      ).get()).toEqual(beforeSetting)
    } finally {
      db.prepare('DELETE FROM roles WHERE code = ?').run(code)
    }
  })
})
