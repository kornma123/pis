/**
 * P4 — 逐院配置 API 路由测试（CRUD/版本/回滚/基线 + RBAC 财务可写·病理 403 + 乐观锁）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any, db: any
let adminToken = '', financeToken = '', pathoToken = ''
const PID = 'PT-CFG-1'

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  const r = await request(app).post('/api/v1/auth/login').send({ username: u, password: p })
  return r.body?.data?.token || ''
}
async function st() { return (await import('supertest')).default }

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'PT-CFG01', '配置测试医院', 1)`).run(PID)
  const authRoutes = (await import('../src/routes/auth.js')).default
  const cfgRoutes = (await import('../src/routes/partner-config-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partner-config', router: cfgRoutes },
  ])
  adminToken = await login('admin', 'admin123')
  financeToken = await login('caiwu', 'CoreOne2026!')
  pathoToken = await login('yishi1', 'CoreOne2026!')
})

describe('GET /:id（首访默认 seed）+ RBAC', () => {
  it('admin GET → 200，默认 8 业务线，version 1', async () => {
    const request = await st()
    const res = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.version).toBe(1)
    expect(res.body.data.config.lines).toHaveLength(8)
    expect(res.body.data.config.basic.full).toBe('配置测试医院')
  })
  it('finance 可读 → 200', async () => {
    const request = await st()
    const res = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${financeToken}`)
    expect(res.status).toBe(200)
  })
  it('pathologist 读 → 403（仅财务/管理员）', async () => {
    const request = await st()
    const res = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${pathoToken}`)
    expect(res.status).toBe(403)
  })
  it('不存在医院 → 404', async () => {
    const request = await st()
    const res = await request(app).get(`/api/v1/partner-config/NOPE`).set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(404)
  })
})

describe('PUT /:id 保存 → 版本+变更 + RBAC + 乐观锁', () => {
  it('finance 改默认扣率 0.9→0.85 → 200 version 2', async () => {
    const request = await st()
    const get = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${financeToken}`)
    const config = get.body.data.config
    config.discount.def = 0.85
    const res = await request(app).put(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${financeToken}`).send({ config, tab: '结算扣率' })
    expect(res.status).toBe(200)
    expect(res.body.data.version).toBe(2)
    expect(res.body.data.diffs.some((d: any) => d.path === 'discount.def')).toBe(true)
  })
  it('pathologist 写 → 403', async () => {
    const request = await st()
    const get = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`)
    const res = await request(app).put(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${pathoToken}`).send({ config: get.body.data.config })
    expect(res.status).toBe(403)
  })
  it('乐观锁：expectedVersion=1（当前已 v2）→ 409', async () => {
    const request = await st()
    const get = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`)
    const config = get.body.data.config
    config.discount.def = 0.7
    const res = await request(app).put(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`).send({ config, expectedVersion: 1 })
    expect(res.status).toBe(409)
  })
  it('配置缺 lines → 400', async () => {
    const request = await st()
    const res = await request(app).put(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`).send({ config: { basic: {} } })
    expect(res.status).toBe(400)
  })
})

describe('GET /:id/changes + 回滚 + 基线', () => {
  it('changes 含 seed + edit', async () => {
    const request = await st()
    const res = await request(app).get(`/api/v1/partner-config/${PID}/changes`).set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const kinds = res.body.data.map((c: any) => c.kind)
    expect(kinds).toContain('seed')
    expect(kinds).toContain('edit')
  })
  it('回滚到 v1 → 新版本 v3 + 扣率还原 0.9', async () => {
    const request = await st()
    const res = await request(app).post(`/api/v1/partner-config/${PID}/rollback`).set('Authorization', `Bearer ${financeToken}`).send({ toVersion: 1 })
    expect(res.status).toBe(200)
    expect(res.body.data.version).toBe(3)
    const get = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`)
    expect(get.body.data.config.discount.def).toBe(0.9)
  })
  it('回滚不存在版本 → 404', async () => {
    const request = await st()
    const res = await request(app).post(`/api/v1/partner-config/${PID}/rollback`).set('Authorization', `Bearer ${adminToken}`).send({ toVersion: 99 })
    expect(res.status).toBe(404)
  })
  it('设 v1 为基线 → 200', async () => {
    const request = await st()
    const res = await request(app).post(`/api/v1/partner-config/${PID}/baseline`).set('Authorization', `Bearer ${financeToken}`).send({ version: 1 })
    expect(res.status).toBe(200)
    expect(res.body.data.baselineVersion).toBe(1)
  })
})
