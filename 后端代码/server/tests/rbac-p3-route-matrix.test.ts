/**
 * RBAC Phase 3：路由守卫迁移 —— 按 §8.2 矩阵逐角色逐模块断言 200/403。
 * 镜像 app.ts 挂载（requirePermission(module,'R') + 路由内 W 守卫），验证迁移正确。
 * 约定：403 = RBAC 拦截；≠403（200/400/404/500）= 守卫放行（写入体校验另算）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error(`login failed ${username}: ` + JSON.stringify(res.body))
  return res.body.data.token
}
async function GET(path: string, token: string) {
  const request = (await import('supertest')).default
  return request(app).get(path).set('Authorization', `Bearer ${token}`)
}
async function POST(path: string, token: string, body: any = {}) {
  const request = (await import('supertest')).default
  return request(app).post(path).set('Authorization', `Bearer ${token}`).send(body)
}
const tokens: Record<string, string> = {}

beforeAll(async () => {
  db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const inventoryRoutes = (await import('../src/routes/inventory-v1.1.js')).default
  const reportRoutes = (await import('../src/routes/reports-v1.1.js')).default
  const abcRoutes = (await import('../src/routes/abc-v1.1.js')).default
  const outboundRoutes = (await import('../src/routes/outbound-v1.1.js')).default
  const bomRoutes = (await import('../src/routes/bom-v1.1.js')).default
  const projectRoutes = (await import('../src/routes/projects-v1.1.js')).default
  const reconciliationRoutes = (await import('../src/routes/reconciliation-v1.1.js')).default

  // 创建 lab_director 用户（种子无）
  const pw = bcrypt.hashSync('CoreOne2026!', 10)
  db.prepare(`INSERT OR IGNORE INTO users (id, username, password, real_name, role, status, is_deleted, primary_role)
    VALUES ('USER-DIR1','zhuren',?,'主任','lab_director',1,0,'lab_director')`).run(pw)
  db.prepare("UPDATE users SET password=?, status=1, is_deleted=0 WHERE username='zhuren'").run(pw)
  db.prepare("INSERT OR IGNORE INTO user_roles (id, user_id, role_code) VALUES ('UR-DIR1','USER-DIR1','lab_director')").run()

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/inventory', router: inventoryRoutes, middleware: [authenticateToken, requirePermission('inventory', 'R')] },
    { path: '/api/v1/reports', router: reportRoutes, middleware: [authenticateToken, requirePermission('cost_analysis', 'R')] },
    { path: '/api/v1/abc', router: abcRoutes, middleware: [authenticateToken, requirePermission('abc_dashboard', 'R')] },
    { path: '/api/v1/outbound', router: outboundRoutes, middleware: [authenticateToken, requirePermission('outbound', 'R')] },
    { path: '/api/v1/boms', router: bomRoutes, middleware: [authenticateToken, requirePermission('bom', 'R')] },
    { path: '/api/v1/projects', router: projectRoutes, middleware: [authenticateToken, requirePermission('projects', 'R')] },
    { path: '/api/v1/reconciliation', router: reconciliationRoutes, middleware: [authenticateToken, requirePermission('reconciliation', 'R')] },
  ])

  tokens.admin = await login('admin', 'admin123')
  tokens.finance = await login('caiwu', 'CoreOne2026!')
  tokens.technician = await login('jishuyuan1', 'CoreOne2026!')
  tokens.pathologist = await login('yishi1', 'CoreOne2026!')
  tokens.warehouse = await login('cangguan', 'CoreOne2026!')
  tokens.procurement = await login('caigou', 'CoreOne2026!')
  tokens.director = await login('zhuren', 'CoreOne2026!')
})

describe('RBAC-P3：库存/成本读权限（403-toast 根因纠正）', () => {
  it('财务 GET /inventory → 200（矩阵新增 finance 库存 R；旧版 403 = toast 根因）', async () => {
    expect((await GET('/api/v1/inventory?page=1', tokens.finance)).status).toBe(200)
  })
  it('病理 GET /reports → 403（诊断线无 cost_analysis；旧版误开）', async () => {
    expect((await GET('/api/v1/reports', tokens.pathologist)).status).toBe(403)
  })
  it('病理 GET /abc/* → 403（无 abc_dashboard）', async () => {
    expect((await GET('/api/v1/abc/activity-centers', tokens.pathologist)).status).toBe(403)
  })
  it('采购 GET /reports → 非 403（procurement cost_analysis R）', async () => {
    expect((await GET('/api/v1/reports', tokens.procurement)).status).not.toBe(403)
  })
  it('主任 GET /abc/* + /inventory → 非 403（lab_director 运营总览）', async () => {
    expect((await GET('/api/v1/abc/activity-centers', tokens.director)).status).not.toBe(403)
    expect((await GET('/api/v1/inventory?page=1', tokens.director)).status).toBe(200)
  })
})

describe('RBAC-P3：写权限边界（W 守卫）', () => {
  it('技术员 POST /outbound → 非 403（outbound W）；病理 → 403', async () => {
    expect((await POST('/api/v1/outbound', tokens.technician)).status).not.toBe(403)
    expect((await POST('/api/v1/outbound', tokens.pathologist)).status).toBe(403)
  })
  it('BOM 写：技术员 非403、病理 403、仓管 403（bom W=admin/主任/技术）', async () => {
    expect((await POST('/api/v1/boms', tokens.technician)).status).not.toBe(403)
    expect((await POST('/api/v1/boms', tokens.pathologist)).status).toBe(403)
    expect((await POST('/api/v1/boms', tokens.warehouse)).status).toBe(403)
  })
  it('检测项目：技术员 GET 200、仓管 GET 403、病理 POST 非403（projects W）', async () => {
    expect((await GET('/api/v1/projects', tokens.technician)).status).toBe(200)
    expect((await GET('/api/v1/projects', tokens.warehouse)).status).toBe(403)
    expect((await POST('/api/v1/projects', tokens.pathologist)).status).not.toBe(403)
  })
})

describe('RBAC-P3：对账核准 SoD（approve 限 admin/finance/lab_director，技术员仅提案）', () => {
  it('技术员 POST /reconciliation/logs/:id/approve → 403（提案≠核准）', async () => {
    expect((await POST('/api/v1/reconciliation/logs/nonexistent/approve', tokens.technician)).status).toBe(403)
  })
  it('财务/主任 approve 守卫放行 → 非 403（无此 log 则 404/400，但非 RBAC 拦截）', async () => {
    expect((await POST('/api/v1/reconciliation/logs/nonexistent/approve', tokens.finance)).status).not.toBe(403)
    expect((await POST('/api/v1/reconciliation/logs/nonexistent/approve', tokens.director)).status).not.toBe(403)
  })
})
