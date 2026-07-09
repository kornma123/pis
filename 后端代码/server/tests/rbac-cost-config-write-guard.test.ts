/**
 * RBAC 相邻缺口修复回归门禁 —— labor-times / indirect-costs 两路由写端点 W 守卫。
 *
 * 背景（授权组合子重构独立复核发现的相邻缺口·同 #76 项 E 性质）：app.ts 挂载层注释声称
 * "写权限由路由内 requirePermission(module,'W') 守卫"，但这两个路由的写端点内**根本没有 W 守卫**、
 * 挂载层只有 R → 持该模块只读权限的角色即可越权增删改**成本配置主数据**（工时定义 / 间接成本中心 / 月度分摊）。
 * 修法=逐文件补 inline W 守卫（仿已正确的 abc-v1.1 requireCostWrite / cost-adjustment）：
 *   - labor-times 写端点 → requirePermission('labor_times','W')
 *   - indirect-costs 写端点 → requirePermission('abc_config','W')（口径同 abc-v1.1，两者皆 abc_config 域）
 *
 * （耗尽台账 depletion 的写端点是**无消费者死端点**——前端零调用、构建纪律 C2 存量违规在册、PM 确认弃用，
 *   处置=废弃删除而非补守卫，故**不在本 PR 范围**。见 session-log / PR body。）
 *
 * 本测试用**合成角色**（不依赖种子矩阵形态，drift-proof）做 W-403 双向断言：
 *   - reader（两模块 R-only）打写端点 → 403（内层 W 守卫拦截·守卫在业务查找/校验前跑）。
 *   - writer（两模块 W）打写端点 → ≠403（守卫放行，写体校验另算 400/404）。
 * 约定同 rbac-p3 / rbac-e：403 = RBAC 拦截；≠403（400/404/409/500）= 守卫放行。
 *
 * 变异测试（人工）：把任一路由文件里的 `requireLaborTimeWrite`/`requireIndirectCostWrite` 从写端点移除
 *   → 对应 reader 断言会从 403 翻成 ≠403（红），证守卫真生效、非摆设。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
const tokens: Record<string, string> = {}

const MODULES_UNDER_TEST = ['labor_times', 'abc_config'] as const

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error(`login failed ${username}: ` + JSON.stringify(res.body))
  return res.body.data.token
}
async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, token: string, body: any = {}) {
  const request = (await import('supertest')).default
  const base =
    method === 'POST'
      ? request(app).post(path)
      : method === 'PUT'
        ? request(app).put(path)
        : request(app).delete(path)
  return base.set('Authorization', `Bearer ${token}`).send(body)
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
  const laborTimeRoutes = (await import('../src/routes/labor-time-v1.1.js')).default
  const indirectCostRoutes = (await import('../src/routes/indirect-cost-v1.1.js')).default

  // 合成 reader（两模块 R-only）+ writer（两模块 W）
  const readerPerms = Object.fromEntries(MODULES_UNDER_TEST.map((m) => [m, 'R'])) as Record<string, 'R' | 'W'>
  const writerPerms = Object.fromEntries(MODULES_UNDER_TEST.map((m) => [m, 'W'])) as Record<string, 'R' | 'W'>
  seedRoleUser('rbac_cc_reader', readerPerms, 'cc_reader')
  seedRoleUser('rbac_cc_writer', writerPerms, 'cc_writer')

  // 镜像 app.ts 挂载：挂载层仅要求模块 R（写权限本应由路由内 W 守卫兜住）
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/labor-times', router: laborTimeRoutes, middleware: [authenticateToken, requirePermission('labor_times', 'R')] },
    { path: '/api/v1/indirect-costs', router: indirectCostRoutes, middleware: [authenticateToken, requirePermission('abc_config', 'R')] },
  ])

  tokens.reader = await login('cc_reader', 'CoreOne2026!')
  tokens.writer = await login('cc_writer', 'CoreOne2026!')
})

// 每个写端点：{ method, path }。PUT/DELETE 用不存在 id（守卫在业务查找前跑，reader 应 403 而非 404）。
const WRITE_ENDPOINTS: Array<{ label: string; method: 'POST' | 'PUT' | 'DELETE'; path: string }> = [
  // labor-times（工时定义主数据）
  { label: 'POST /labor-times (建工时)', method: 'POST', path: '/api/v1/labor-times' },
  { label: 'PUT /labor-times/:id (改工时)', method: 'PUT', path: '/api/v1/labor-times/nonexistent' },
  { label: 'DELETE /labor-times/:id (归档工时)', method: 'DELETE', path: '/api/v1/labor-times/nonexistent' },
  // indirect-costs（间接成本中心 + 月度分摊）
  { label: 'POST /indirect-costs (建成本中心)', method: 'POST', path: '/api/v1/indirect-costs' },
  { label: 'PUT /indirect-costs/:id (改成本中心)', method: 'PUT', path: '/api/v1/indirect-costs/nonexistent' },
  { label: 'DELETE /indirect-costs/:id (删成本中心)', method: 'DELETE', path: '/api/v1/indirect-costs/nonexistent' },
  { label: 'POST /indirect-costs/:id/allocations (录入分摊)', method: 'POST', path: '/api/v1/indirect-costs/nonexistent/allocations' },
]

describe('RBAC 相邻缺口：labor-times/indirect-costs 写端点 reader(R-only) 一律 403（内层 W 守卫止越权写成本配置）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`reader → 403 · ${ep.label}`, async () => {
      const res = await send(ep.method, ep.path, tokens.reader)
      expect(res.status).toBe(403)
    })
  }
})

describe('RBAC 相邻缺口：writer(W) 同端点 ≠403（守卫放行，写体校验另算 400/404）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`writer → ≠403 · ${ep.label}`, async () => {
      const res = await send(ep.method, ep.path, tokens.writer)
      expect(res.status).not.toBe(403)
    })
  }
})
