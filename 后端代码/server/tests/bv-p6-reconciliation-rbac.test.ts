/**
 * BV Phase 6：对账核准链 RBAC 收口
 *
 * 镜像 app.ts 收口后的挂载：authenticateToken + requireRole('admin','finance','technician')
 *  - pathologist（诊断线）→ 完全不可达对账写（mount 403）
 *  - technician 可 propose，但 approve → 403（审批限 admin/finance，路由内守卫）
 *  - finance approve 他人提案 → 200
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let adminToken: string
let financeToken: string
let techToken: string
let pathoToken: string
let db: any

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}

async function propose(token: string, suffix: string, newUsage: number) {
  const request = (await import('supertest')).default
  return request(app).post('/api/v1/reconciliation/logs').set('Authorization', `Bearer ${token}`).send({
    projectId: `PRJ-${suffix}`, materialId: `MAT-${suffix}`, newUsage, reason: '实测超耗',
  })
}
async function approve(token: string, id: string) {
  const request = (await import('supertest')).default
  return request(app).post(`/api/v1/reconciliation/logs/${id}/approve`).set('Authorization', `Bearer ${token}`).send({})
}

function seedBom(suffix: string) {
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
     VALUES (?, ?, ?, 'µL', 'CAT-A', 100, 1, 0)`).run(`MAT-${suffix}`, `C-${suffix}`, `抗体${suffix}`)
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status, is_deleted)
     VALUES (?, ?, ?, 'v1.0', 'ihc', 1, 0)`).run(`BOM-${suffix}`, `BC-${suffix}`, `BOM${suffix}`)
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
     VALUES (?, ?, ?, 2, 'µL')`).run(`BI-${suffix}`, `BOM-${suffix}`, `MAT-${suffix}`)
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status, is_deleted)
     VALUES (?, ?, ?, 'ihc', ?, 1, 0)`).run(`PRJ-${suffix}`, `PC-${suffix}`, `项目${suffix}`, `BOM-${suffix}`)
}

beforeAll(async () => {
  db = await getDb()
  const reconciliationRoutes = (await import('../src/routes/reconciliation-v1.1.js')).default
  const authRoutes = (await import('../src/routes/auth.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/reconciliation',
      router: reconciliationRoutes,
      middleware: [authenticateToken, requireRole('admin', 'finance', 'technician')], // 收口后
    },
  ])
  adminToken = await loginAdmin(app)
  financeToken = await login('caiwu', 'CoreOne2026!')
  techToken = await login('jishuyuan1', 'CoreOne2026!')
  pathoToken = await login('yishi1', 'CoreOne2026!')
  seedBom('R1')
  seedBom('R2')
})

describe('BV-P6：对账核准链 RBAC', () => {
  it('pathologist 不可达对账写（mount 403）', async () => {
    const res = await propose(pathoToken, 'R1', 5)
    expect(res.status).toBe(403)
  })

  it('technician 可 propose', async () => {
    const res = await propose(techToken, 'R1', 5)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('pending')
  })

  it('technician approve → 403（审批限 admin/finance）', async () => {
    const p = await propose(adminToken, 'R2', 6)
    const res = await approve(techToken, p.body.data.id)
    expect(res.status).toBe(403)
  })

  it('finance approve 他人提案 → 200', async () => {
    const p = await propose(adminToken, 'R1', 7) // R1 现值仍 2
    const res = await approve(financeToken, p.body.data.id)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('applied')
  })
})
