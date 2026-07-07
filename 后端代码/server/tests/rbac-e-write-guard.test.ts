/**
 * RBAC-E：授权/提权修复回归门禁 —— users/roles/returns/scraps/transfers/stocktaking 六路由写端点 W 守卫。
 *
 * 背景（非-P0 域首轮对抗审计 · 项 E）：app.ts 挂载层注释声称"写权限由路由内 requirePermission(module,'W') 守卫"，
 * 但这六个路由的写端点内**根本没有 W 守卫**、挂载层只有 R → 持该模块只读权限的角色即可越权：
 * 改用户角色/密码（提权）、增删角色权限矩阵、突变库存/库位。修法=逐文件补 inline W 守卫（仿 projects/outbound）。
 *
 * 本测试用**合成角色**（不依赖种子矩阵形态，drift-proof）做 W-403 双向断言：
 *   - reader（模块 R-only）打写端点 → 403（内层 W 守卫拦截）。
 *   - writer（模块 W）打写端点 → ≠403（守卫放行，写体校验另算 400/404）。
 * 约定同 rbac-p3：403 = RBAC 拦截；≠403（400/404/409/500）= 守卫放行。
 *
 * 变异测试（人工）：把任一路由文件里的 `requireXxxWrite` 从写端点移除 → 对应 reader 断言会从 403 翻成 ≠403（红），
 * 证守卫真生效、非摆设。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
const tokens: Record<string, string> = {}

const MODULES_UNDER_TEST = ['users', 'roles', 'returns', 'scraps', 'transfers', 'stocktaking'] as const

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error(`login failed ${username}: ` + JSON.stringify(res.body))
  return res.body.data.token
}
async function POST(path: string, token: string, body: any = {}) {
  const request = (await import('supertest')).default
  return request(app).post(path).set('Authorization', `Bearer ${token}`).send(body)
}
async function DEL(path: string, token: string) {
  const request = (await import('supertest')).default
  return request(app).delete(path).set('Authorization', `Bearer ${token}`)
}

/** 造一个合成角色（对象矩阵权限）+ 对应用户 + user_roles 映射，返回登录 token */
function seedRoleUser(code: string, perms: Record<string, 'R' | 'W'>, username: string): void {
  const pw = bcrypt.hashSync('CoreOne2026!', 10)
  db.prepare(
    `INSERT OR REPLACE INTO roles (id, code, name, description, permissions, status, is_deleted)
     VALUES (?, ?, ?, '', ?, 1, 0)`,
  ).run(`ROLE-${code}`, code, code, JSON.stringify(perms))
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password, real_name, role, primary_role, status, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
  ).run(`USER-${code}`, username, pw, username, code, code)
  db.prepare(`INSERT OR REPLACE INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)`).run(
    `UR-${code}`, `USER-${code}`, code,
  )
}

beforeAll(async () => {
  db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const userRoutes = (await import('../src/routes/users-v1.1.js')).default
  const roleRoutes = (await import('../src/routes/roles-v1.1.js')).default
  const returnRoutes = (await import('../src/routes/returns-v1.1.js')).default
  const scrapRoutes = (await import('../src/routes/scraps-v1.1.js')).default
  const transferRoutes = (await import('../src/routes/transfers-v1.1.js')).default
  const stocktakingRoutes = (await import('../src/routes/stocktaking-v1.1.js')).default

  // 合成 reader（六模块 R-only）+ writer（六模块 W）
  const readerPerms = Object.fromEntries(MODULES_UNDER_TEST.map((m) => [m, 'R'])) as Record<string, 'R' | 'W'>
  const writerPerms = Object.fromEntries(MODULES_UNDER_TEST.map((m) => [m, 'W'])) as Record<string, 'R' | 'W'>
  seedRoleUser('rbac_e_reader', readerPerms, 'e_reader')
  seedRoleUser('rbac_e_writer', writerPerms, 'e_writer')

  // 镜像 app.ts 挂载：挂载层仅要求模块 R（写权限本应由路由内 W 守卫兜住）
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/users', router: userRoutes, middleware: [authenticateToken, requirePermission('users', 'R')] },
    { path: '/api/v1/roles', router: roleRoutes, middleware: [authenticateToken, requirePermission('roles', 'R')] },
    { path: '/api/v1/returns', router: returnRoutes, middleware: [authenticateToken, requirePermission('returns', 'R')] },
    { path: '/api/v1/scraps', router: scrapRoutes, middleware: [authenticateToken, requirePermission('scraps', 'R')] },
    { path: '/api/v1/transfers', router: transferRoutes, middleware: [authenticateToken, requirePermission('transfers', 'R')] },
    { path: '/api/v1/stocktaking', router: stocktakingRoutes, middleware: [authenticateToken, requirePermission('stocktaking', 'R')] },
  ])

  tokens.reader = await login('e_reader', 'CoreOne2026!')
  tokens.writer = await login('e_writer', 'CoreOne2026!')
})

// 每个写端点：{ method, path }。DELETE 用不存在 id（守卫在业务查找前跑，reader 应 403 而非 404）。
const WRITE_ENDPOINTS: Array<{ label: string; method: 'POST' | 'DELETE'; path: string }> = [
  // 提权面最大：改权限矩阵 / 改用户角色·密码
  { label: 'POST /roles (建角色)', method: 'POST', path: '/api/v1/roles' },
  { label: 'DELETE /roles/:id', method: 'DELETE', path: '/api/v1/roles/nonexistent' },
  { label: 'POST /users (建用户)', method: 'POST', path: '/api/v1/users' },
  { label: 'DELETE /users/:id', method: 'DELETE', path: '/api/v1/users/nonexistent' },
  // 越权突变库存/库位
  { label: 'POST /returns (退库+库存)', method: 'POST', path: '/api/v1/returns' },
  { label: 'DELETE /returns/:id', method: 'DELETE', path: '/api/v1/returns/nonexistent' },
  { label: 'POST /scraps (报废-库存)', method: 'POST', path: '/api/v1/scraps' },
  { label: 'DELETE /scraps/:id', method: 'DELETE', path: '/api/v1/scraps/nonexistent' },
  { label: 'POST /transfers/inbound (移库)', method: 'POST', path: '/api/v1/transfers/inbound' },
  { label: 'DELETE /transfers/:id', method: 'DELETE', path: '/api/v1/transfers/nonexistent' },
  { label: 'POST /stocktaking (盘点登记)', method: 'POST', path: '/api/v1/stocktaking' },
  { label: 'POST /stocktaking/:id/adjust (入账改库存·副作用最强)', method: 'POST', path: '/api/v1/stocktaking/nonexistent/adjust' },
  { label: 'POST /stocktaking/batch (批量入账)', method: 'POST', path: '/api/v1/stocktaking/batch' },
  { label: 'DELETE /stocktaking/:id', method: 'DELETE', path: '/api/v1/stocktaking/nonexistent' },
]

describe('RBAC-E：六路由写端点 reader(R-only) 一律 403（内层 W 守卫止提权/越权写）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`reader → 403 · ${ep.label}`, async () => {
      const res = ep.method === 'POST' ? await POST(ep.path, tokens.reader) : await DEL(ep.path, tokens.reader)
      expect(res.status).toBe(403)
    })
  }
})

describe('RBAC-E：writer(W) 同端点 ≠403（守卫放行，写体校验另算）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`writer → ≠403 · ${ep.label}`, async () => {
      const res = ep.method === 'POST' ? await POST(ep.path, tokens.writer) : await DEL(ep.path, tokens.writer)
      expect(res.status).not.toBe(403)
    })
  }
})

// PUT 端点（roles/:id、users/:id）单列：reader 403 / writer ≠403
describe('RBAC-E：PUT 提权端点（改角色矩阵 / 改用户角色·密码）', () => {
  it('PUT /roles/:id → reader 403 / writer ≠403', async () => {
    const request = (await import('supertest')).default
    const rReader = await request(app).put('/api/v1/roles/nonexistent').set('Authorization', `Bearer ${tokens.reader}`).send({ name: 'x' })
    const rWriter = await request(app).put('/api/v1/roles/nonexistent').set('Authorization', `Bearer ${tokens.writer}`).send({ name: 'x' })
    expect(rReader.status).toBe(403)
    expect(rWriter.status).not.toBe(403)
  })
  it('PUT /users/:id → reader 403 / writer ≠403', async () => {
    const request = (await import('supertest')).default
    const rReader = await request(app).put('/api/v1/users/nonexistent').set('Authorization', `Bearer ${tokens.reader}`).send({ realName: 'x' })
    const rWriter = await request(app).put('/api/v1/users/nonexistent').set('Authorization', `Bearer ${tokens.writer}`).send({ realName: 'x' })
    expect(rReader.status).toBe(403)
    expect(rWriter.status).not.toBe(403)
  })
})
