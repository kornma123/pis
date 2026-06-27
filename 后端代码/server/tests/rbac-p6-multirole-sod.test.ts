/**
 * RBAC Phase 6：用户多角色分配 + SoD 告警（告警非阻断）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { detectSoDConflicts } from '../src/middleware/permissions.js'
import { getEffectivePermissions } from '../src/middleware/permissions.js'

let app: any
let db: any

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  return res.body.data.token
}

beforeAll(async () => {
  db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const userRoutes = (await import('../src/routes/users-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/users', router: userRoutes, middleware: [authenticateToken, requirePermission('users', 'R')] },
  ])
})

describe('RBAC-P6：detectSoDConflicts（纯）', () => {
  it('采购+财务 / 仓管+财务 / 病理+技术 → 冲突；安全组合 → 无', () => {
    expect(detectSoDConflicts(['procurement', 'finance'])).toContain('procurement+finance')
    expect(detectSoDConflicts(['warehouse_manager', 'finance'])).toContain('warehouse_manager+finance')
    expect(detectSoDConflicts(['pathologist', 'technician'])).toContain('pathologist+technician')
    expect(detectSoDConflicts(['technician', 'finance'])).toEqual([])
    expect(detectSoDConflicts(['admin'])).toEqual([])
  })
})

describe('RBAC-P6：创建/更新多角色用户', () => {
  it('POST roles:[technician,finance] → user_roles 2 行 + effective 并集 + 无 SoD', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    const res = await request(app).post('/api/v1/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'multi1', password: 'CoreOne2026!', realName: '多角色1', roles: ['technician', 'finance'], primaryRole: 'finance' })
    expect(res.status).toBe(201)
    expect(res.body.data.roles.sort()).toEqual(['finance', 'technician'])
    expect(res.body.data.primaryRole).toBe('finance')
    expect(res.body.data.sodWarning).toEqual([])

    const uid = res.body.data.id
    const rows = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?').all(uid) as any[]
    expect(rows.length).toBe(2)
    const eff = getEffectivePermissions(db, uid)
    expect(eff.outbound).toBe('W') // technician
    expect(eff.abc_dashboard).toBe('W') // finance
  })

  it('POST roles:[procurement,finance] → 201 + sodWarning（告警非阻断）', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    const res = await request(app).post('/api/v1/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'multi2', password: 'CoreOne2026!', realName: '多角色2', roles: ['procurement', 'finance'] })
    expect(res.status).toBe(201) // 不阻断
    expect(res.body.data.sodWarning).toContain('procurement+finance')
  })

  it('PUT roles 覆盖 → user_roles 同步 + primary_role 落库', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    const created = await request(app).post('/api/v1/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'multi3', password: 'CoreOne2026!', realName: '多角色3', roles: ['technician'] })
    const uid = created.body.data.id
    const put = await request(app).put(`/api/v1/users/${uid}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: ['warehouse_manager', 'procurement'], primaryRole: 'procurement' })
    expect(put.status).toBe(200)
    expect(put.body.data.roles.sort()).toEqual(['procurement', 'warehouse_manager'])
    const u = db.prepare('SELECT primary_role FROM users WHERE id = ?').get(uid) as any
    expect(u.primary_role).toBe('procurement')
  })

  it('GET /users 返回 roles[] + primaryRole', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    const res = await request(app).get('/api/v1/users?keyword=multi1').set('Authorization', `Bearer ${adminToken}`)
    const u = (res.body.data.list as any[]).find((x) => x.username === 'multi1')
    expect(u.roles.sort()).toEqual(['finance', 'technician'])
    expect(u.primaryRole).toBe('finance')
  })
})
