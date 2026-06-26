/**
 * BV Phase 4：追溯重算编排（黄金相邻）
 *
 * - future_only approve → 历史不动（不产生 cost_runs）
 * - retroactive approve（未关账月）→ 触发 runCostRecalculation（该月 cost_runs 出现）
 * - retroactive approve（已关账月）→ 不重算 + 响应标记 closedMonths/requiresAdjustment
 *
 * 本测试验证「是否重算」的编排，不重算具体成本数值（黄金用例已钉死引擎口径）。
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
  return res.body.data.token
}
async function propose(suffix: string, newUsage: number) {
  const request = (await import('supertest')).default
  return request(app).post('/api/v1/reconciliation/logs').set('Authorization', `Bearer ${adminToken}`).send({
    projectId: `PRJ-${suffix}`, materialId: `MAT-${suffix}`, newUsage, reason: '追溯测试',
  })
}
async function approve(id: string, effectiveScope: string) {
  const request = (await import('supertest')).default
  return request(app).post(`/api/v1/reconciliation/logs/${id}/approve`).set('Authorization', `Bearer ${financeToken}`).send({ effectiveScope })
}

function seedCostedOutbound(suffix: string, month: string) {
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
     VALUES (?, ?, ?, 'µL', 'CAT-A', 100, 1, 0)`).run(`MAT-${suffix}`, `C-${suffix}`, `抗体${suffix}`)
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status, is_deleted)
     VALUES (?, ?, ?, 'v1.0', 'ihc', 1, 0)`).run(`BOM-${suffix}`, `BC-${suffix}`, `BOM${suffix}`)
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
     VALUES (?, ?, ?, 2, 'µL')`).run(`BI-${suffix}`, `BOM-${suffix}`, `MAT-${suffix}`)
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status, is_deleted)
     VALUES (?, ?, ?, 'ihc', ?, 1, 0)`).run(`PRJ-${suffix}`, `PC-${suffix}`, `项目${suffix}`, `BOM-${suffix}`)
  // 该月一条已完成 BOM 出库（runCostRecalculation 会按月重算它）
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, operator, status, is_deleted, sample_count, total_cost, created_at)
     VALUES (?, ?, 'bom', ?, 'admin', 'completed', 0, 1, 100, ?)`)
    .run(`OB-${suffix}`, `OBN-${suffix}`, `PRJ-${suffix}`, `${month}-15 10:00:00`)
}

function costRunCount(month: string): number {
  return Number((db.prepare(`SELECT COUNT(*) as c FROM cost_runs WHERE year_month = ?`).get(month) as any).c)
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
  seedCostedOutbound('F', '2026-03') // future_only
  seedCostedOutbound('R', '2026-04') // retroactive open
  seedCostedOutbound('K', '2026-02') // retroactive closed
  db.prepare(`INSERT INTO abc_periods (id, year_month, status) VALUES ('PER-K', '2026-02', 'closed')`).run()
})

describe('BV-P4：追溯重算编排', () => {
  it('future_only approve → 历史不动（无 cost_runs）', async () => {
    const before = costRunCount('2026-03')
    const p = await propose('F', 5)
    const res = await approve(p.body.data.id, 'future_only')
    expect(res.status).toBe(200)
    expect(res.body.data.retroactive).toBeNull()
    expect(costRunCount('2026-03')).toBe(before) // 未触发重算
  })

  it('retroactive approve（未关账月）→ 触发该月重算', async () => {
    const before = costRunCount('2026-04')
    const p = await propose('R', 5)
    const res = await approve(p.body.data.id, 'retroactive')
    expect(res.status).toBe(200)
    expect(costRunCount('2026-04')).toBeGreaterThan(before) // 重算已发生
    expect(res.body.data.retroactive.recalculatedMonths).toBeGreaterThanOrEqual(1)
    expect(res.body.data.retroactive.closedMonths).toBe(0)
  })

  it('retroactive approve（已关账月）→ 不重算 + 标记 closedMonths/requiresAdjustment', async () => {
    const before = costRunCount('2026-02')
    const p = await propose('K', 5)
    const res = await approve(p.body.data.id, 'retroactive')
    expect(res.status).toBe(200)
    expect(costRunCount('2026-02')).toBe(before) // 关账月未重算
    expect(res.body.data.retroactive.closedMonths).toBeGreaterThanOrEqual(1)
    expect(res.body.data.retroactive.requiresAdjustment).toBe(true)
  })
})
