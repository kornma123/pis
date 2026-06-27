/**
 * RBAC Phase 5：管理员编辑角色矩阵 → DB → 即时生效（不发版）。
 * 端到端证明：admin 改 technician 的 stocktaking R/W → 该用户同 token 立即被拒。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import { buildTestApp, getDb } from './p0-harness.js'

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
  const roleRoutes = (await import('../src/routes/roles-v1.1.js')).default

  const stockRouter = express.Router()
  stockRouter.post('/write', requirePermission('stocktaking', 'W'), (_req, res) => res.json({ ok: true }))

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/roles', router: roleRoutes, middleware: [authenticateToken, requirePermission('roles', 'R')] },
    { path: '/api/v1/stk', router: stockRouter, middleware: [authenticateToken] },
  ])
})

describe('RBAC-P5：编辑矩阵即时生效', () => {
  it('技术员初始有 stocktaking W → POST 放行（非 403）', async () => {
    const request = (await import('supertest')).default
    const token = await login('jishuyuan1', 'CoreOne2026!')
    expect((await request(app).post('/api/v1/stk/write').set('Authorization', `Bearer ${token}`)).status).not.toBe(403)
  })

  it('admin 改 technician 角色矩阵去掉 stocktaking → 技术员同 token 立即 403（不发版）', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    const techToken = await login('jishuyuan1', 'CoreOne2026!')

    // 新矩阵：去掉 stocktaking（保留其余）
    const newPerms: Record<string, string> = {
      inventory: 'R', outbound: 'W', returns: 'W', scraps: 'W',
      materials: 'R', categories: 'R', bom: 'W', projects: 'W',
      reconciliation: 'W', equipment: 'W', labor_times: 'R', alerts: 'R',
    }
    const put = await request(app).put('/api/v1/roles/ROLE-TECH')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissions: newPerms })
    expect(put.status).toBe(200)

    // 同 token，无需重登 → 立即 403
    const after = await request(app).post('/api/v1/stk/write').set('Authorization', `Bearer ${techToken}`)
    expect(after.status).toBe(403)

    // 还原（避免污染后续）
    await request(app).put('/api/v1/roles/ROLE-TECH')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissions: { ...newPerms, stocktaking: 'W' } })
  })

  it('GET /roles 返回对象矩阵形态（管理员可渲染网格）', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    const res = await request(app).get('/api/v1/roles?pageSize=50').set('Authorization', `Bearer ${adminToken}`)
    const tech = (res.body.data.list as any[]).find((r) => r.code === 'technician')
    expect(tech.permissions.outbound).toBe('W')
    expect(typeof tech.permissions).toBe('object')
    expect(Array.isArray(tech.permissions)).toBe(false)
  })

  it('admin 角色不可改（403）', async () => {
    const request = (await import('supertest')).default
    const adminToken = await login('admin', 'admin123')
    const res = await request(app).put('/api/v1/roles/ROLE-ADMIN')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissions: { inventory: 'R' } })
    expect(res.status).toBe(403)
  })
})
