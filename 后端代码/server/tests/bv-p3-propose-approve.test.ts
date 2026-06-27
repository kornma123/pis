/**
 * BV Phase 3：对账 propose→approve + SoD（核心）
 *
 * - POST /logs 只落 pending 提案，不再直接改 bom_items
 * - approve 由他人执行 → bom_items 更新 + bom_versions 落新版本 + log.status=applied + boms.version 升
 * - 自审（提交人=审核人）→ 403 SELF_REVIEW_FORBIDDEN
 * - reject → bom_items 不变、status=rejected
 * - 乐观锁：approve 时现值已被他人改动 → 409
 *
 * 本阶段不限制角色（RBAC 在 P6），仅 authenticateToken，用 admin/caiwu 两用户验证 SoD。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let adminToken: string
let financeToken: string
let db: any

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}

function seedBom(suffix: string, usage: number) {
  db.prepare(
    `INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
     VALUES (?, ?, ?, 'µL', 'CAT-A', 100, 1, 0)`,
  ).run(`MAT-${suffix}`, `C-${suffix}`, `抗体${suffix}`)
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status, is_deleted)
     VALUES (?, ?, ?, 'v1.0', 'ihc', 1, 0)`).run(`BOM-${suffix}`, `BC-${suffix}`, `BOM${suffix}`)
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
     VALUES (?, ?, ?, ?, 'µL')`).run(`BI-${suffix}`, `BOM-${suffix}`, `MAT-${suffix}`, usage)
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status, is_deleted)
     VALUES (?, ?, ?, 'ihc', ?, 1, 0)`).run(`PRJ-${suffix}`, `PC-${suffix}`, `项目${suffix}`, `BOM-${suffix}`)
}

function currentUsage(suffix: string): number {
  return Number(
    (db.prepare(`SELECT usage_per_sample FROM bom_items WHERE id = ?`).get(`BI-${suffix}`) as any).usage_per_sample,
  )
}

async function propose(token: string, suffix: string, newUsage: number) {
  const request = (await import('supertest')).default
  return request(app)
    .post('/api/v1/reconciliation/logs')
    .set('Authorization', `Bearer ${token}`)
    .send({
      type: 'bom_fix',
      projectId: `PRJ-${suffix}`,
      materialId: `MAT-${suffix}`,
      newUsage,
      reason: '实测超耗，建议上调标准用量',
    })
}

async function act(token: string, id: string, action: 'approve' | 'reject', body: any = {}) {
  const request = (await import('supertest')).default
  return request(app)
    .post(`/api/v1/reconciliation/logs/${id}/${action}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

beforeAll(async () => {
  db = await getDb()
  const reconciliationRoutes = (await import('../src/routes/reconciliation-v1.1.js')).default
  const authRoutes = (await import('../src/routes/auth.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/reconciliation', router: reconciliationRoutes, middleware: [authenticateToken] },
  ])
  adminToken = await loginAdmin(app)
  financeToken = await login('caiwu', 'CoreOne2026!')
  seedBom('A', 2)
  seedBom('B', 2)
  seedBom('C', 2)
  seedBom('D', 2)
})

describe('BV-P3：对账 propose→approve + SoD', () => {
  it('POST /logs 只落 pending 提案，不动 bom_items', async () => {
    const res = await propose(adminToken, 'A', 5)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('pending')
    expect(currentUsage('A')).toBe(2) // 未生效
    const log = db.prepare(`SELECT * FROM reconciliation_logs WHERE id = ?`).get(res.body.data.id) as any
    expect(log.status).toBe('pending')
    expect(log.type).toBe('bom_fix_proposal')
    expect(Number(log.proposed_usage)).toBe(5)
    expect(Number(log.old_value)).toBe(2)
  })

  it('他人 approve → bom_items 更新 + bom_versions 新版本 + status=applied', async () => {
    const p = await propose(adminToken, 'B', 7)
    const id = p.body.data.id
    const res = await act(financeToken, id, 'approve')
    expect(res.status).toBe(200)
    expect(currentUsage('B')).toBe(7) // 生效
    const log = db.prepare(`SELECT * FROM reconciliation_logs WHERE id = ?`).get(id) as any
    expect(log.status).toBe('applied')
    expect(log.reviewed_by).toBe('caiwu')
    const versions = db.prepare(`SELECT * FROM bom_versions WHERE bom_id = 'BOM-B'`).all() as any[]
    expect(versions.length).toBeGreaterThanOrEqual(1)
    const bom = db.prepare(`SELECT version FROM boms WHERE id = 'BOM-B'`).get() as any
    expect(bom.version).not.toBe('v1.0') // 版本已升
  })

  it('自审（提交人=审核人）→ 403 SELF_REVIEW_FORBIDDEN，bom_items 不变', async () => {
    const p = await propose(adminToken, 'C', 9)
    const id = p.body.data.id
    const res = await act(adminToken, id, 'approve')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_REVIEW_FORBIDDEN')
    expect(currentUsage('C')).toBe(2) // 未生效
  })

  it('reject → bom_items 不变、status=rejected', async () => {
    const p = await propose(adminToken, 'D', 9)
    const id = p.body.data.id
    const res = await act(financeToken, id, 'reject', { remark: '不认可' })
    expect(res.status).toBe(200)
    expect(currentUsage('D')).toBe(2)
    const log = db.prepare(`SELECT status FROM reconciliation_logs WHERE id = ?`).get(id) as any
    expect(log.status).toBe('rejected')
  })

  it('乐观锁：approve 时现值已被他人改动 → 409，且不重复应用', async () => {
    const p = await propose(adminToken, 'A', 8) // A 当前仍为 2
    const id = p.body.data.id
    // 模拟他人直接改了标准（绕过提案）
    db.prepare(`UPDATE bom_items SET usage_per_sample = 3 WHERE id = 'BI-A'`).run()
    const res = await act(financeToken, id, 'approve')
    expect(res.status).toBe(409)
    expect(currentUsage('A')).toBe(3) // 未被提案值覆盖
    const log = db.prepare(`SELECT status FROM reconciliation_logs WHERE id = ?`).get(id) as any
    expect(log.status).toBe('pending') // 仍待审
  })
})
