/**
 * RBAC Phase 2：能力解析（DB 真值并集）+ requirePermission 守卫 + authenticateToken 即时生效
 */
import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import { buildTestApp, getDb } from './p0-harness.js'
import { getEffectivePermissions } from '../src/middleware/permissions.js'

let app: any
let db: any

function userId(username: string): string {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as any).id
}
async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')

  // 临时测试路由：用 requirePermission 守卫
  const testRouter = express.Router()
  testRouter.get('/inv-read', requirePermission('inventory', 'R'), (_req, res) => res.json({ ok: true }))
  testRouter.get('/out-write', requirePermission('outbound', 'W'), (_req, res) => res.json({ ok: true }))
  testRouter.get('/whoami', (req: any, res) => res.json({ roles: req.user?.roles }))

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/rbactest', router: testRouter, middleware: [authenticateToken] },
  ])
})

describe('RBAC-P2：getEffectivePermissions 并集（DB 真值）', () => {
  it('admin → 全 27 模块 W', () => {
    const eff = getEffectivePermissions(db, userId('admin'))
    expect(Object.keys(eff).length).toBe(27)
    expect(eff.outbound).toBe('W')
    expect(eff.abc_dashboard).toBe('W')
  })

  it('单角色 finance → 矩阵一致（成本 W、库存 R、无出库）', () => {
    const eff = getEffectivePermissions(db, userId('caiwu'))
    expect(eff.abc_dashboard).toBe('W')
    expect(eff.inventory).toBe('R')
    expect(eff.outbound).toBeUndefined()
  })

  it('多角色 → 并集 W 优先（finance + warehouse_manager）', () => {
    const uid = userId('caiwu')
    db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run('UR-caiwu-whm', uid, 'warehouse_manager')
    const eff = getEffectivePermissions(db, uid)
    expect(eff.outbound).toBe('W') // 来自 warehouse_manager
    expect(eff.abc_dashboard).toBe('W') // 来自 finance
    expect(eff.inventory).toBe('W') // WHM=W 覆盖 finance 的 R
    // 还原，避免污染后续用例
    db.prepare('DELETE FROM user_roles WHERE id = ?').run('UR-caiwu-whm')
  })
})

describe('RBAC-P2：requirePermission 守卫 R/W 边界', () => {
  it('finance：inventory R → 200；outbound W → 403', async () => {
    const request = (await import('supertest')).default
    const token = await login('caiwu', 'CoreOne2026!')
    const r = await request(app).get('/api/v1/rbactest/inv-read').set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    const w = await request(app).get('/api/v1/rbactest/out-write').set('Authorization', `Bearer ${token}`)
    expect(w.status).toBe(403)
  })

  it('technician：outbound W → 200', async () => {
    const request = (await import('supertest')).default
    const token = await login('jishuyuan1', 'CoreOne2026!')
    const w = await request(app).get('/api/v1/rbactest/out-write').set('Authorization', `Bearer ${token}`)
    expect(w.status).toBe(200)
  })
})

describe('RBAC-P2：authenticateToken 挂 roles + 改角色即时生效（无 ROLE_CHANGED）', () => {
  it('whoami 返回 DB 角色集合', async () => {
    const request = (await import('supertest')).default
    const token = await login('caiwu', 'CoreOne2026!')
    const res = await request(app).get('/api/v1/rbactest/whoami').set('Authorization', `Bearer ${token}`)
    expect(res.body.roles).toContain('finance')
  })

  it('改 user_roles 后同 token 即时反映新权限（不需重登、不 401）', async () => {
    const request = (await import('supertest')).default
    const uid = userId('caiwu')
    const token = await login('caiwu', 'CoreOne2026!')
    // 初始：finance 无 outbound W → 403
    let w = await request(app).get('/api/v1/rbactest/out-write').set('Authorization', `Bearer ${token}`)
    expect(w.status).toBe(403)
    // 加 technician 角色（DB）
    db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run('UR-caiwu-tech', uid, 'technician')
    // 同 token 立即生效 → 200（无需重登，无 ROLE_CHANGED）
    w = await request(app).get('/api/v1/rbactest/out-write').set('Authorization', `Bearer ${token}`)
    expect(w.status).toBe(200)
    db.prepare('DELETE FROM user_roles WHERE id = ?').run('UR-caiwu-tech')
  })
})
