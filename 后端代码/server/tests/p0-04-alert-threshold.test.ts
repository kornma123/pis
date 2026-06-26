/**
 * P0-04 预警阈值统一
 *
 * Bug: 仓管在“安全库存/库存预警阈值”栏填值 → 前端存入 min_stock，
 *      但预警引擎只读 safety_stock(默认 0) → 低库存预警静默失效。
 *
 * 修复：引擎低库存阈值改为有效阈值 COALESCE(NULLIF(m.min_stock,0), m.safety_stock)。
 *
 * 红测试（修复前失败）：seed 物料 min_stock=10 / safety_stock=0 / stock=3 →
 *   POST /generate 后该物料应出现在 low-stock 预警（修复前 safety_stock=0 静默不报）。
 *   并回归：仅设 safety_stock 的旧数据仍能触发（回退路径）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let token: string

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const alertRoutes = (await import('../src/routes/alerts-v1.1.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/alerts',
      router: alertRoutes,
      middleware: [
        authenticateToken,
        requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance'),
      ],
    },
  ])
  token = await loginAdmin(app)

  // 启用 low-stock 规则
  db.prepare(`INSERT INTO alert_rules (id, type, name, enabled) VALUES ('AR-LOW', 'low-stock', '低库存', 1)`).run()

  // 物料 A：min_stock=10, safety_stock=0, stock=3 → 应触发（修复前不触发）
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, min_stock, safety_stock, status, is_deleted)
    VALUES ('MAT-A04', 'C-A04', '试剂A', '瓶', 'CAT', 10, 0, 1, 0)`).run()
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('INV-A04', 'MAT-A04', 3)`).run()

  // 物料 B：min_stock=0, safety_stock=8, stock=2 → 回退路径仍应触发（旧数据兼容）
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, min_stock, safety_stock, status, is_deleted)
    VALUES ('MAT-B04', 'C-B04', '试剂B', '瓶', 'CAT', 0, 8, 1, 0)`).run()
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('INV-B04', 'MAT-B04', 2)`).run()

  // 物料 C：min_stock=5, safety_stock=0, stock=20 → 库存充足，不应触发
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, min_stock, safety_stock, status, is_deleted)
    VALUES ('MAT-C04', 'C-C04', '试剂C', '瓶', 'CAT', 5, 0, 1, 0)`).run()
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('INV-C04', 'MAT-C04', 20)`).run()
})

describe('P0-04 预警阈值统一（有效阈值 = COALESCE(NULLIF(min_stock,0), safety_stock)）', () => {
  it('min_stock 填值、safety_stock=0 的物料应触发低库存预警', async () => {
    const request = (await import('supertest')).default
    const gen = await request(app).post('/api/v1/alerts/generate').set('Authorization', `Bearer ${token}`)
    expect(gen.status).toBe(200)

    const list = await request(app)
      .get('/api/v1/alerts?type=low-stock&pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    const ids = list.body.data.list.map((a: any) => a.materialId)

    // 修复前：MAT-A04 因 safety_stock=0 静默漏报
    expect(ids).toContain('MAT-A04')
    // 回退路径：仅 safety_stock 的旧数据仍触发
    expect(ids).toContain('MAT-B04')
    // 库存充足者不应触发
    expect(ids).not.toContain('MAT-C04')
  })
})
