/**
 * 统一检测项目目录 API（只读）—— 路由集成。
 * 验证：lookup 命中/未命中、待校对清单、标准项清单、反查、鉴权（无 token 401）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let token = ''

async function mountApp() {
  const routes = (await import('../src/routes/project-catalog-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/project-catalog',
      router: routes,
      middleware: [authenticateToken, requirePermission('projects', 'R')],
    },
  ])
}

beforeAll(async () => {
  await getDb()
  app = await mountApp()
  token = await loginAdmin(app)
})

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`)

describe('project-catalog 只读路由', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/v1/project-catalog/lookup?alias=免疫组化数')
    expect(res.status).toBe(401)
  })

  it('GET /lookup 命中：国标码 → PC-IHC-STD', async () => {
    const res = await auth(request(app).get('/api/v1/project-catalog/lookup').query({ alias: '012100000120000', system: 'guobiao_code' }))
    expect(res.status).toBe(200)
    expect(res.body.data.matched).toBe(true)
    expect(res.body.data.catalog.canonicalCode).toBe('PC-IHC-STD')
  })

  it('GET /lookup 未命中噪音：matched:false（不 500）', async () => {
    const res = await auth(request(app).get('/api/v1/project-catalog/lookup').query({ alias: '水费', system: 'statement_item' }))
    expect(res.status).toBe(200)
    expect(res.body.data.matched).toBe(false)
    expect(res.body.data.reason).toBe('noise')
  })

  it('GET /lookup 缺 alias → 400', async () => {
    const res = await auth(request(app).get('/api/v1/project-catalog/lookup'))
    expect(res.status).toBe(400)
  })

  it('GET /review-queue 返回待校对清单', async () => {
    const res = await auth(request(app).get('/api/v1/project-catalog/review-queue'))
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBeGreaterThan(0)
    expect(Array.isArray(res.body.data.rows)).toBe(true)
  })

  it('GET /catalog 返回标准项清单', async () => {
    const res = await auth(request(app).get('/api/v1/project-catalog/catalog'))
    expect(res.status).toBe(200)
    expect(res.body.data.some((c: any) => c.canonicalCode === 'PC-IHC-STD')).toBe(true)
  })

  it('GET /catalog/:code/aliases 反查别名', async () => {
    const res = await auth(request(app).get('/api/v1/project-catalog/catalog/PC-IHC-STD/aliases'))
    expect(res.status).toBe(200)
    expect(res.body.data.aliases.length).toBeGreaterThan(0)
  })

  it('GET / 概览含 summary', async () => {
    const res = await auth(request(app).get('/api/v1/project-catalog/'))
    expect(res.status).toBe(200)
    expect(res.body.data.summary.catalogCount).toBeGreaterThan(0)
  })
})
