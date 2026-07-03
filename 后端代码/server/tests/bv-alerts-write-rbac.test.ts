/**
 * BV：预警写操作 RBAC 口径锁（有意为之，2026-07-02 复核固化）
 *
 * 口径：处理预警(POST /:id/handle) 与生成预警(POST /generate) 只需 alerts:'R'，**不额外要求 'W'**。
 * 依据：
 *  - 预警是信息性运营操作、无金额/口径影响；真正敏感的阈值配置(PUT /rules/:id) 已单独 W+admin 锁定。
 *  - SEED_MATRIX 中**全部非 admin 角色仅有 alerts:'R'（无 'W'）**，故「能看预警的都能处理/生成」= 产品意图(adoption-first)。
 *
 * 本测试镜像 app.ts 的**真实生产挂载** `authenticateToken + requirePermission('alerts','R')`
 *（非旧 requireRole shim），用 R 级角色（pathologist：alerts:'R' 且无 'W'）验证其可 handle/generate。
 *
 * ⚠️ 若未来有人给端点加 requirePermission('alerts','W')，pathologist(R-only) 将 403 → 本测试失败，
 *    从而拦住「未同步 SEED_MATRIX + 既有库回填迁移」的误收紧（=supplier_returns 迁移缺口的复刻）。
 *    若产品**确要**收紧，须一并把下列 R 级角色的期望由 200 翻为 403，并落 SEED_MATRIX 改动 + 回填迁移。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let pathoToken: string // pathologist：alerts:'R'，无 'W'（R 级样本）
let whmToken: string // warehouse_manager：alerts:'R'（运营角色代表）

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}

async function generate(token?: string) {
  const request = (await import('supertest')).default
  const req = request(app).post('/api/v1/alerts/generate')
  return token ? req.set('Authorization', `Bearer ${token}`) : req
}
async function handle(token: string, id: string) {
  const request = (await import('supertest')).default
  return request(app)
    .post(`/api/v1/alerts/${id}/handle`)
    .set('Authorization', `Bearer ${token}`)
    .send({ action: 'processed' })
}
function seedPendingAlert(id: string) {
  db.prepare(
    `INSERT INTO alerts (id, type, level, material_id, material_name, message, status)
     VALUES (?, 'low-stock', 'warning', 'MAT-RBAC', '试剂RBAC', 'x', 'pending')`
  ).run(id)
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const alertRoutes = (await import('../src/routes/alerts-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')

  // 镜像 app.ts:90 的真实生产挂载（R 级即可进入路由）
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/alerts',
      router: alertRoutes,
      middleware: [authenticateToken, requirePermission('alerts', 'R')],
    },
  ])
  await loginAdmin(app) // 确保 harness 就绪
  pathoToken = await login('yishi1', 'CoreOne2026!')
  whmToken = await login('cangguan', 'CoreOne2026!')

  // 启用 low-stock 规则 + 一个低库存物料（供 /generate 产出）
  db.prepare(`INSERT INTO alert_rules (id, type, name, enabled) VALUES ('AR-LOW-RBAC', 'low-stock', '低库存', 1)`).run()
  db.prepare(
    `INSERT INTO materials (id, code, name, unit, category_id, min_stock, safety_stock, status, is_deleted)
     VALUES ('MAT-RBAC', 'C-RBAC', '试剂RBAC', '瓶', 'CAT', 10, 0, 1, 0)`
  ).run()
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('INV-RBAC', 'MAT-RBAC', 3)`).run()
})

describe('BV：预警写操作 RBAC 口径锁（R 即可 handle/generate；勿误加 W）', () => {
  it('未登录 → 401（挂载层鉴权确实生效）', async () => {
    const res = await generate()
    expect(res.status).toBe(401)
  })

  it('pathologist（alerts:R，无 W）可 POST /generate → 200（R 足够）', async () => {
    const res = await generate(pathoToken)
    expect(res.status).toBe(200)
    // 低库存物料应被扫出（证明确实进入了业务逻辑，而非仅通过守卫）
    expect(res.body.data.generatedCount).toBeGreaterThanOrEqual(1)
  })

  it('pathologist（alerts:R，无 W）可 POST /:id/handle → 200（R 足够）', async () => {
    seedPendingAlert('ALERT-RBAC-P')
    const res = await handle(pathoToken, 'ALERT-RBAC-P')
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT status FROM alerts WHERE id = ?').get('ALERT-RBAC-P') as any
    expect(row.status).toBe('processed')
  })

  it('warehouse_manager（运营角色，alerts:R）可 POST /:id/handle → 200', async () => {
    seedPendingAlert('ALERT-RBAC-W')
    const res = await handle(whmToken, 'ALERT-RBAC-W')
    expect(res.status).toBe(200)
  })
})
