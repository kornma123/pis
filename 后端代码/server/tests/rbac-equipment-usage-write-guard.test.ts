/**
 * RBAC 相邻缺口修复回归门禁 —— equipment 使用量写端点 W 守卫（Issue #138）。
 *
 * 背景（原规划第 5 项遗留 #127 → #138 拆条·2026-07-12 只读复核发现）：
 * app.ts:117 挂载层按模块 R 放行（`requirePermission('equipment','R')`），同文件的
 * POST / · PUT /:id · DELETE /:id 已正确用 `requireEquipmentWrite = requirePermission('equipment','W')`
 * 内层守卫，但**登记设备使用**这个写端点无 inline W 守卫：
 *   - POST /:id/usage （登记设备使用·写 equipment_usage·影响累计折旧/成本、设备净值）
 * → 持 equipment:R（只读）的角色即可越权登记使用量、改变设备折旧/成本事实。
 * 修法=把已有的 `requireEquipmentWrite` 补挂到 POST /:id/usage（其余写端点原已引用，逻辑不变）。
 * GET 读端点（含 GET /:id/usage）不动。
 *
 * 现网真实用户零行为变更：运行库全部角色用旧扁平数组权限格式（parsePermissions 一律映射为 W），
 *   无法表达 R-only；缺口仅在**对象格式** {equipment:'R'}（SEED_MATRIX / 角色矩阵编辑器）路径下潜伏。
 *
 * 本测试用**合成角色**（对象矩阵权限，不依赖运行库/种子形态，drift-proof）做 W-403 双向断言：
 *   - reader（equipment:R-only）打写端点 → 403（内层 W 守卫拦截·守卫在业务查找/校验前跑）。
 *   - writer（equipment:W）打写端点 → ≠403（守卫放行，写体校验/业务查找另算 400/404）。
 * 约定同 rbac-outbound-write-guard / rbac-cost-config-write-guard：403 = RBAC 拦截；
 *   ≠403（400/404/409/422/500）= 守卫放行。
 *
 * 变异测试（人工）：把 equipment-v1.1.ts 的 POST /:id/usage 的 `requireEquipmentWrite` 移除
 *   → reader 对该端点的断言会从 403 翻成 ≠403（红），证守卫真生效、非摆设。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
const tokens: Record<string, string> = {}

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error(`login failed ${username}: ` + JSON.stringify(res.body))
  return res.body.data.token
}
async function send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token: string, body: any = {}) {
  const request = (await import('supertest')).default
  const base =
    method === 'POST'
      ? request(app).post(path)
      : method === 'PUT'
        ? request(app).put(path)
        : method === 'DELETE'
          ? request(app).delete(path)
          : request(app).get(path)
  return base.set('Authorization', `Bearer ${token}`).send(body)
}

/** 造一个合成角色（对象矩阵权限）+ 对应用户 + user_roles 映射；status 可控用于禁用账号断言 */
function seedRoleUser(
  db: any,
  code: string,
  perms: Record<string, 'R' | 'W'>,
  username: string,
  status: 0 | 1 = 1,
): void {
  const pw = bcrypt.hashSync('CoreOne2026!', 10)
  db.prepare(
    `INSERT OR REPLACE INTO roles (id, code, name, description, permissions, status, is_deleted)
     VALUES (?, ?, ?, '', ?, 1, 0)`,
  ).run(`ROLE-${code}`, code, code, JSON.stringify(perms))
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password, real_name, role, primary_role, status, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(`USER-${code}`, username, pw, username, code, code, status)
  db.prepare(`INSERT OR REPLACE INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)`).run(
    `UR-${code}`, `USER-${code}`, code,
  )
}

beforeAll(async () => {
  const db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const equipmentRoutes = (await import('../src/routes/equipment-v1.1.js')).default

  // 合成 reader（equipment:R-only）+ writer（equipment:W）+ 禁用的 writer（status=0）
  seedRoleUser(db, 'rbac_eq_reader', { equipment: 'R' }, 'eq_reader')
  seedRoleUser(db, 'rbac_eq_writer', { equipment: 'W' }, 'eq_writer')
  seedRoleUser(db, 'rbac_eq_disabled', { equipment: 'W' }, 'eq_disabled', 0)

  // 镜像 app.ts:117 挂载：挂载层仅要求模块 R（写权限本应由路由内 W 守卫兜住）
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/equipment', router: equipmentRoutes, middleware: [authenticateToken, requirePermission('equipment', 'R')] },
  ])

  tokens.reader = await login('eq_reader', 'CoreOne2026!')
  tokens.writer = await login('eq_writer', 'CoreOne2026!')
})

// 每个写端点：{ method, path }。PUT/DELETE/:id/usage 用不存在 id（守卫在业务查找前跑，reader 应 403 而非 404）。
const WRITE_ENDPOINTS: Array<{ label: string; method: 'POST' | 'PUT' | 'DELETE'; path: string }> = [
  // 本次修复的缺口端点
  { label: 'POST /equipment/:id/usage (登记使用量·本次补 W 守卫)', method: 'POST', path: '/api/v1/equipment/nonexistent/usage' },
  // 已有 requireEquipmentWrite 守卫，纳入门禁防未来误删
  { label: 'POST /equipment (新增设备)', method: 'POST', path: '/api/v1/equipment' },
  { label: 'PUT /equipment/:id (改设备)', method: 'PUT', path: '/api/v1/equipment/nonexistent' },
  { label: 'DELETE /equipment/:id (删设备)', method: 'DELETE', path: '/api/v1/equipment/nonexistent' },
]

describe('RBAC 相邻缺口 #138：equipment 写端点 reader(equipment:R-only) 一律 403（内层 W 守卫止越权改设备使用/成本事实）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`reader → 403 · ${ep.label}`, async () => {
      const res = await send(ep.method, ep.path, tokens.reader)
      expect(res.status).toBe(403)
    })
  }
})

describe('RBAC 相邻缺口 #138：writer(equipment:W) 同端点 ≠403（守卫放行，写体校验/业务查找另算 400/404）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`writer → ≠403 · ${ep.label}`, async () => {
      const res = await send(ep.method, ep.path, tokens.writer)
      expect(res.status).not.toBe(403)
    })
  }
})

describe('RBAC #138 读不回归：reader(equipment:R) 仍可读使用量列表', () => {
  it('reader GET /equipment/:id/usage → ≠403（读端点不受 W 守卫影响）', async () => {
    const res = await send('GET', '/api/v1/equipment/nonexistent/usage', tokens.reader)
    expect(res.status).not.toBe(403)
  })
})

describe('RBAC #138 禁用账号：status=0 的 equipment:W 用户拿不到 token（登录被拒→无法写）', () => {
  it('disabled writer 登录被拒（无 token）', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).post('/api/v1/auth/login').send({ username: 'eq_disabled', password: 'CoreOne2026!' })
    expect(res.body?.data?.token).toBeFalsy()
  })
})
