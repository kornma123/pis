/**
 * P1-01 辅料缺货整单回滚 → 辅料缺货跳过该项、主料缺才阻断
 *
 * Bug: outbound-v1.1.ts /bom 预检对每个 bom item 缺货即 422 挡整单
 *   → 任一辅料（通用试剂/耗材/质控）缺货导致整批 BOM 出库失败，主料也出不去。
 *
 * master 数据模型实情：bom_items 有 is_alternative 列（默认 0）区分主/辅料；
 *   bom-v1.1 创建时未写该列（恒 0），故采保守实现——以 is_alternative 为辅料标记：
 *     - is_alternative=1（辅料）缺货 → 跳过该项（不计出库、不阻断整单）
 *     - is_alternative=0（主料）缺货 → 422 阻断整单
 *   （限制：依赖 BOM 维护时标注 is_alternative；当前 bom-v1.1 创建路径未提供该入参，
 *    数据全为主料；待 BOM 主/辅料维护补齐后此判定自动生效。）
 *
 * 红测试：
 *   - 主料库存充足 + 辅料缺货 → 201 创建成功（主料出库），整单不回滚（修复前 422）
 *   - 主料缺货 → 422 阻断（回归：主料仍守住）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

function seedMaterial(id: string, code: string, stock: number) {
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, ?, ?, '瓶', 'CAT', 10, 1, 0)`).run(id, code, code)
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES (?, ?, ?)`).run(`INV-${id}`, id, stock)
  // 给充足库存的物料配一个批次，便于成本/批次扣减路径
  if (stock > 0) {
    db.prepare(`INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, status, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, 10, 1, '2030-01-01')`).run(`B-${id}`, id, `BN-${id}`, stock, stock, `IN-${id}`)
  }
}

beforeAll(async () => {
  db = await getDb()
  const outboundRoutes = (await import('../src/routes/outbound-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/outbound', router: outboundRoutes },
  ])

  // 项目
  db.prepare(`INSERT INTO projects (id, code, name, type, status, is_deleted) VALUES ('PRJ-01', 'P01', '项目1', 'routine', 1, 0)`).run()

  // 场景1 BOM：主料充足(stock 100) + 辅料缺货(stock 0, is_alternative=1)
  db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted) VALUES ('BOM-AUX', 'BM-AUX', 'BOM辅料缺', 'standard', 1, 0)`).run()
  seedMaterial('MAT-MAIN', 'MAIN', 100)
  seedMaterial('MAT-AUX', 'AUX', 0)
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit, is_alternative)
    VALUES ('BI-MAIN', 'BOM-AUX', 'MAT-MAIN', 2, '瓶', 0)`).run()
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit, is_alternative)
    VALUES ('BI-AUX', 'BOM-AUX', 'MAT-AUX', 1, '瓶', 1)`).run()

  // 场景2 BOM：主料缺货(stock 0, is_alternative=0)
  db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted) VALUES ('BOM-MAINSHORT', 'BM-MS', 'BOM主料缺', 'standard', 1, 0)`).run()
  seedMaterial('MAT-MAINSHORT', 'MAINSHORT', 0)
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit, is_alternative)
    VALUES ('BI-MS', 'BOM-MAINSHORT', 'MAT-MAINSHORT', 2, '瓶', 0)`).run()
})

describe('P1-01 BOM 出库：辅料缺货跳过、主料缺货阻断', () => {
  it('主料充足 + 辅料缺货 → 201 主料出库、整单不回滚', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).post('/api/v1/outbound/bom').send({
      projectId: 'PRJ-01', bomId: 'BOM-AUX', sampleCount: 5,
    })
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    const obId = res.body.data.id

    // 主料 stock 100 - (2×5=10) = 90，已扣减
    const mainStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get('MAT-MAIN') as any).stock
    expect(Number(mainStock)).toBe(90)

    // 辅料缺货被跳过：未生成出库明细
    const auxItem = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ? AND material_id = ?').get(obId, 'MAT-AUX')
    expect(auxItem).toBeUndefined()
    // 主料生成了出库明细
    const mainItem = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ? AND material_id = ?').get(obId, 'MAT-MAIN')
    expect(mainItem).toBeTruthy()
  })

  it('主料缺货 → 422 阻断整单（回归）', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).post('/api/v1/outbound/bom').send({
      projectId: 'PRJ-01', bomId: 'BOM-MAINSHORT', sampleCount: 1,
    })
    expect(res.status).toBe(422)
    expect(res.body.success).toBe(false)
  })
})
