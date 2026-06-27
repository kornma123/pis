/**
 * W2 合作医院（partner）CRUD + RBAC + upsert 帮手。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { findOrCreatePartner } from '../src/utils/partner-upsert.js'

let app: any
let db: any
let adminToken = ''
let financeToken = ''
let pathologistToken = ''

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  return res.body?.data?.token || ''
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const partnerRoutes = (await import('../src/routes/partners-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partners', router: partnerRoutes },
  ])
  adminToken = await login('admin', 'admin123')
  financeToken = await login('caiwu', 'CoreOne2026!')
  pathologistToken = await login('yishi1', 'CoreOne2026!')
})

describe('partner-upsert：findOrCreatePartner 幂等', () => {
  it('首次建（created=true，PT- 码），再次同名返回已存在（created=false，同 id）', () => {
    let n = 0
    const gen = () => `PT-TEST-${++n}`
    const a = findOrCreatePartner(db, '东安县人民医院', gen, { serviceScope: 'technical_only' })
    expect(a.created).toBe(true)
    expect(a.code).toMatch(/^PT-\d{5}$/)
    const b = findOrCreatePartner(db, '东安县人民医院', gen)
    expect(b.created).toBe(false)
    expect(b.id).toBe(a.id)
  })
  it('空名抛错', () => {
    expect(() => findOrCreatePartner(db, '   ', () => 'x')).toThrow()
  })
})

describe('partners CRUD（admin）', () => {
  let createdId = ''
  it('POST 建院（默认 technical_only）→ 201 + code', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).post('/api/v1/partners').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '上海和睦家医院', serviceScope: 'with_diagnosis', shortName: '和睦家' })
    expect(res.status).toBe(201)
    expect(res.body.data.code).toMatch(/^PT-\d{5}$/)
    createdId = res.body.data.id
  })
  it('同名再建 → 409', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).post('/api/v1/partners').set('Authorization', `Bearer ${adminToken}`).send({ name: '上海和睦家医院' })
    expect(res.status).toBe(409)
  })
  it('name 缺失 → 400；serviceScope 非法 → 400', async () => {
    const request = (await import('supertest')).default
    expect((await request(app).post('/api/v1/partners').set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(400)
    expect((await request(app).post('/api/v1/partners').set('Authorization', `Bearer ${adminToken}`).send({ name: 'X院', serviceScope: 'bogus' })).status).toBe(400)
  })
  it('GET 列表含新建院，serviceScope 落对', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).get('/api/v1/partners?keyword=和睦家').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const p = res.body.data.list.find((x: any) => x.id === createdId)
    expect(p.serviceScope).toBe('with_diagnosis')
    expect(p.shortName).toBe('和睦家')
  })
  it('PUT 改 service_scope → technical_only', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).put(`/api/v1/partners/${createdId}`).set('Authorization', `Bearer ${adminToken}`).send({ serviceScope: 'technical_only' })
    expect(res.status).toBe(200)
    const got = await request(app).get(`/api/v1/partners/${createdId}`).set('Authorization', `Bearer ${adminToken}`)
    expect(got.body.data.serviceScope).toBe('technical_only')
  })
  it('DELETE 软删 → 404 再查不到', async () => {
    const request = (await import('supertest')).default
    expect((await request(app).delete(`/api/v1/partners/${createdId}`).set('Authorization', `Bearer ${adminToken}`)).status).toBe(200)
    expect((await request(app).get(`/api/v1/partners/${createdId}`).set('Authorization', `Bearer ${adminToken}`)).status).toBe(404)
  })
})

describe('partners RBAC', () => {
  it('finance：可读(R)，但写被拒(403)', async () => {
    const request = (await import('supertest')).default
    expect((await request(app).get('/api/v1/partners').set('Authorization', `Bearer ${financeToken}`)).status).toBe(200)
    const w = await request(app).post('/api/v1/partners').set('Authorization', `Bearer ${financeToken}`).send({ name: '财务不能建的院' })
    expect(w.status).toBe(403)
  })
  it('pathologist：无 partners 权限，读也被拒(403)', async () => {
    const request = (await import('supertest')).default
    expect((await request(app).get('/api/v1/partners').set('Authorization', `Bearer ${pathologistToken}`)).status).toBe(403)
  })
})
