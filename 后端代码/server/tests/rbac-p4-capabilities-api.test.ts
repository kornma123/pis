/**
 * RBAC Phase 4：能力 API —— 登录响应 + GET /auth/me/capabilities 下发 capabilities/roles/canSeeCost
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

async function login(username: string, password: string) {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  return res.body
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  app = await buildTestApp([{ path: '/api/v1/auth', router: authRoutes }])
})

describe('RBAC-P4：登录响应携带能力', () => {
  it('财务登录 → capabilities(成本 W/库存 R) + roles + canSeeCost=true', async () => {
    const body = await login('caiwu', 'CoreOne2026!')
    const u = body.data.user
    expect(u.roles).toContain('finance')
    expect(u.primaryRole).toBe('finance')
    expect(u.capabilities.abc_dashboard).toBe('W')
    expect(u.capabilities.inventory).toBe('R')
    expect(u.capabilities.outbound).toBeUndefined()
    expect(u.canSeeCost).toBe(true)
  })

  it('病理登录 → 无成本能力 + canSeeCost=false', async () => {
    const body = await login('yishi1', 'CoreOne2026!')
    const u = body.data.user
    expect(u.capabilities.abc_dashboard).toBeUndefined()
    expect(u.capabilities.inventory).toBe('R')
    expect(u.capabilities.projects).toBe('W')
    expect(u.canSeeCost).toBe(false)
  })

  it('admin 登录 → 全 27 模块 W + canSeeCost', async () => {
    const body = await login('admin', 'admin123')
    const u = body.data.user
    expect(Object.keys(u.capabilities).length).toBe(29)
    expect(u.canSeeCost).toBe(true)
  })
})

describe('RBAC-P4：GET /me/capabilities', () => {
  it('带 token 返回 capabilities/roles/canSeeCost', async () => {
    const request = (await import('supertest')).default
    const body = await login('caigou', 'CoreOne2026!')
    const res = await request(app).get('/api/v1/auth/me/capabilities').set('Authorization', `Bearer ${body.data.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.roles).toContain('procurement')
    expect(res.body.data.capabilities.suppliers).toBe('W')
    expect(res.body.data.capabilities.cost_analysis).toBe('R')
    expect(res.body.data.canSeeCost).toBe(false)
  })

  it('多角色 → /me/capabilities 反映并集（procurement + finance）', async () => {
    const request = (await import('supertest')).default
    const uid = (db.prepare("SELECT id FROM users WHERE username='caigou'").get() as any).id
    db.prepare("INSERT OR IGNORE INTO user_roles (id, user_id, role_code) VALUES ('UR-caigou-fin', ?, 'finance')").run(uid)
    const body = await login('caigou', 'CoreOne2026!')
    const res = await request(app).get('/api/v1/auth/me/capabilities').set('Authorization', `Bearer ${body.data.token}`)
    expect(res.body.data.capabilities.abc_dashboard).toBe('W') // 来自 finance
    expect(res.body.data.capabilities.suppliers).toBe('W') // 来自 procurement
    expect(res.body.data.canSeeCost).toBe(true) // finance 在成本可见名单
    db.prepare("DELETE FROM user_roles WHERE id = 'UR-caigou-fin'").run()
  })
})
