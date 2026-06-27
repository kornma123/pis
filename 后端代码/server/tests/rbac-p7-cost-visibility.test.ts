/**
 * RBAC Phase 7：成本可见性开关（可配置默认 + 即时生效）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any

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
  await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  app = await buildTestApp([{ path: '/api/v1/auth', router: authRoutes }])
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
