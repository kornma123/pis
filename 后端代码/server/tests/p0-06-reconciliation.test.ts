/**
 * P0-06 物料级对账口径一致性
 *
 * Bug: GET /reconciliation/materials 的 actual SQL 无 project_id 过滤，
 *      SUM 了全部出库（含无项目直接出库），而 theory 只算项目派生 → 永远不平。
 *
 * 红测试（修复前失败）：seed 1 个项目出库 + 1 个无项目直接出库，
 *   断言物料级 actualTotal 只计项目出库、diff=0、status=match。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let token: string

beforeAll(async () => {
  const db = await getDb()
  const reconciliationRoutes = (await import('../src/routes/reconciliation-v1.1.js')).default
  const authRoutes = (await import('../src/routes/auth.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/reconciliation',
      router: reconciliationRoutes,
      middleware: [authenticateToken, requireRole('admin', 'pathologist', 'finance')],
    },
  ])
  token = await loginAdmin(app)

  // ---- seed 业务数据 ----
  // 物料
  db.prepare(`INSERT INTO materials (id, code, name, spec, unit, category_id, price, status, is_deleted)
    VALUES ('MAT-P0-06', 'C-P0-06', '抗体X', '5ml', '瓶', 'CAT-A', 100, 1, 0)`).run()
  // BOM + 1 个 item，每例用量 1 瓶
  db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted)
    VALUES ('BOM-P0-06', 'BC-06', 'BOM06', 'ihc', 1, 0)`).run()
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
    VALUES ('BI-P0-06', 'BOM-P0-06', 'MAT-P0-06', 1, '瓶')`).run()
  // 项目挂 BOM
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status, is_deleted)
    VALUES ('PRJ-P0-06', 'PC-06', '项目06', 'ihc', 'BOM-P0-06', 1, 0)`).run()
  // 该项目 5 个病例 → theory = 5 * 1 = 5
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO lis_cases (id, case_no, project_id, operate_time)
      VALUES (?, ?, 'PRJ-P0-06', '2026-06-01 10:00:00')`).run(`LC-06-${i}`, `CASE-06-${i}`)
  }

  // 项目出库：5 瓶（与理论一致）
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, operator, status, is_deleted)
    VALUES ('OB-06-PRJ', 'OBN-06-PRJ', 'project', 'PRJ-P0-06', 'admin', 'completed', 0)`).run()
  db.prepare(`INSERT INTO outbound_items (id, outbound_id, material_id, quantity, unit, unit_cost, total_cost)
    VALUES ('OI-06-PRJ', 'OB-06-PRJ', 'MAT-P0-06', 5, '瓶', 100, 500)`).run()

  // 无项目直接出库：额外 7 瓶（自用/无项目）——不应计入物料级对账 actual
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, operator, status, is_deleted)
    VALUES ('OB-06-SELF', 'OBN-06-SELF', 'self', NULL, 'admin', 'completed', 0)`).run()
  db.prepare(`INSERT INTO outbound_items (id, outbound_id, material_id, quantity, unit, unit_cost, total_cost)
    VALUES ('OI-06-SELF', 'OB-06-SELF', 'MAT-P0-06', 7, '瓶', 100, 700)`).run()
})

describe('P0-06 物料级对账只按项目口径汇总 actual', () => {
  it('actualTotal 只计项目出库(5)，不含无项目直接出库(7)，diff=0 status=match', async () => {
    const request = (await import('supertest')).default
    const res = await request(app)
      .get('/api/v1/reconciliation/materials')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const row = res.body.data.list.find((r: any) => r.materialId === 'MAT-P0-06')
    expect(row).toBeTruthy()
    expect(row.theoryTotal).toBe(5)
    // 修复前：actualTotal=12（5项目+7无项目）→ diff=7 → status!=match
    expect(row.actualTotal).toBe(5)
    expect(row.diff).toBe(0)
    expect(row.status).toBe('match')
  })
})
