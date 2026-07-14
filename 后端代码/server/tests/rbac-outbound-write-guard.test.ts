/**
 * RBAC 相邻缺口修复回归门禁 —— outbound 路由写端点 W 守卫。
 *
 * 背景（「全砍 depletion 功能」PR 独立对抗复核·2026-07-09 顺带发现·同 labor-times/indirect-costs (#752e1571)
 * 与 #76 项 E 性质）：app.ts 挂载层按模块 R 放行（`requirePermission('outbound','R')`），
 * 同文件的 PUT /:id、DELETE /:id 已正确用 `requirePermission('outbound','W')` 内层守卫，
 * 但创建（写）端点此前无 inline W 守卫：
 *   - POST /            （创建出库/领用·LIVE·前端 outboundApi.create）—— 减库存 + 写 batch_usage_tracking + stock_logs
 * → 持 outbound:R（只读）的角色即可越权创建出库（减库存/写台账）。SEED_MATRIX 的 lab_director:{outbound:'R'}
 *   正是这样一个「只读出库」角色；角色矩阵编辑器（对象格式 {outbound:'R'}）也能造出这种只读授予。
 * 修法=把已有的 `requireWriteAccess = requirePermission('outbound','W')` 上提到文件顶部，
 *   补挂到 POST（PUT/DELETE 原已引用，逻辑不变）。GET 读端点不动。
 *
 * 现网真实用户零行为变更：运行库全部角色用旧扁平数组权限格式（parsePermissions 一律映射为 W），
 *   无法表达 R-only；能到达该端点的角色（warehouse_manager/technician/pathologist）皆持 outbound:W
 *   → 新守卫对它们放行。缺口仅在**对象格式** {outbound:'R'}（SEED_MATRIX / 矩阵编辑器）路径下潜伏。
 *
 * 本测试用**合成角色**（对象矩阵权限，不依赖运行库/种子形态，drift-proof）做 W-403 双向断言：
 *   - reader（outbound:R-only）打写端点 → 403（内层 W 守卫拦截·守卫在业务查找/校验前跑）。
 *   - writer（outbound:W）打写端点 → ≠403（守卫放行，写体校验另算 400/404）。
 * 约定同 rbac-cost-config-write-guard / rbac-p3 / rbac-e：403 = RBAC 拦截；≠403（400/404/409/422/500）= 守卫放行。
 *
 * 变异测试（人工）：把 outbound-v1.1.ts 里 POST / 的 `requireWriteAccess` 移除
 *   → 对应 reader 断言会从 403 翻成 ≠403（红），证守卫真生效、非摆设。
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
function seedRoleUser(db: any, code: string, perms: Record<string, 'R' | 'W'>, username: string): void {
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
  const db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const outboundRoutes = (await import('../src/routes/outbound-v1.1.js')).default

  // 合成 reader（outbound:R-only）+ writer（outbound:W）
  seedRoleUser(db, 'rbac_ob_reader', { outbound: 'R' }, 'ob_reader')
  seedRoleUser(db, 'rbac_ob_writer', { outbound: 'W' }, 'ob_writer')

  // 镜像 app.ts 挂载：挂载层仅要求模块 R（写权限本应由路由内 W 守卫兜住）
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/outbound', router: outboundRoutes, middleware: [authenticateToken, requirePermission('outbound', 'R')] },
  ])

  tokens.reader = await login('ob_reader', 'CoreOne2026!')
  tokens.writer = await login('ob_writer', 'CoreOne2026!')
})

// 每个写端点：{ method, path }。PUT/DELETE 用不存在 id（守卫在业务查找前跑，reader 应 403 而非 404）。
const WRITE_ENDPOINTS: Array<{ label: string; method: 'POST' | 'PUT' | 'DELETE'; path: string }> = [
  { label: 'POST /outbound (创建出库·LIVE)', method: 'POST', path: '/api/v1/outbound' },
  // 已有 requireWriteAccess 守卫，纳入门禁防未来误删
  { label: 'PUT /outbound/:id (改出库)', method: 'PUT', path: '/api/v1/outbound/nonexistent' },
  { label: 'DELETE /outbound/:id (删出库)', method: 'DELETE', path: '/api/v1/outbound/nonexistent' },
]

describe('RBAC 相邻缺口：outbound 写端点 reader(outbound:R-only) 一律 403（内层 W 守卫止越权创建出库）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`reader → 403 · ${ep.label}`, async () => {
      const res = await send(ep.method, ep.path, tokens.reader)
      expect(res.status).toBe(403)
    })
  }
})

describe('RBAC 相邻缺口：writer(outbound:W) 同端点 ≠403（守卫放行，写体校验另算 400/404）', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(`writer → ≠403 · ${ep.label}`, async () => {
      const res = await send(ep.method, ep.path, tokens.writer)
      expect(res.status).not.toBe(403)
    })
  }
})
