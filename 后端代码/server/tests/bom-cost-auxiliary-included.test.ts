/**
 * BOM 材料成本口径守卫：辅料（is_alternative=1）用量必须计入材料成本
 *
 * 背景（2026-07-01 非ABC前置会 §4.6/§7 对抗复核）：有复核意见依据字段名
 *   `is_alternative` / `main_item_id` 推断"主料—替代料=二选一"，据此判定
 *   updateBomStandardCost / cost-preview / GET 把主料与替代料用量一并累加是"成本高估"。
 *
 * 复核结论（本仓语义实情）：本项目 `is_alternative=1` 表示 **辅料**（通用试剂/耗材/质控），
 *   与主料 **同时消耗**（"都要用"），并非二选一。唯一赋予该字段行为语义的读取路径
 *   outbound-v1.1.ts（辅料缺货跳过、主料缺货阻断）与 tests/p1-01-bom-auxiliary-skip.ts
 *   共同锚定此语义。因此把主料+辅料用量都计入材料标准成本是 **正确的**，不是高估。
 *
 * 本测试作为口径守卫：锁定"辅料用量计入成本"这一正确行为，防止后人误据字段名
 *   给成本 SELECT 加上 `WHERE is_alternative = 0` 而把辅料成本漏计（会造成成本低估）。
 *
 * 注：本仓成本口径为 GET /:id 的动态展示（costRatio，见 routes/bom-v1.1.ts）——本测试即锚定该 GET 口径；
 *   不涉及某些派生线上另有的 updateBomStandardCost/cost-preview 函数（本仓无）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

function seedMaterial(id: string, code: string, price: number) {
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, ?, ?, '瓶', 'CAT', ?, 1, 0)`).run(id, code, code, price)
}

beforeAll(async () => {
  db = await getDb()
  const bomRoutes = (await import('../src/routes/bom-v1.1.js')).default
  app = await buildTestApp([{ path: '/api/v1/bom', router: bomRoutes }])

  // 主料 price 10 × 用量 2 = 20；辅料 price 10 × 用量 1 = 10；合计材料成本 30
  seedMaterial('MAT-MAIN', 'MAIN', 10)
  seedMaterial('MAT-AUX', 'AUX', 10)
  db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted)
    VALUES ('BOM-COST', 'BM-COST', 'BOM成本口径', 'standard', 1, 0)`).run()
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit, is_alternative)
    VALUES ('BI-MAIN', 'BOM-COST', 'MAT-MAIN', 2, '瓶', 0)`).run()
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit, is_alternative)
    VALUES ('BI-AUX', 'BOM-COST', 'MAT-AUX', 1, '瓶', 1)`).run()
})

describe('BOM 材料成本口径：辅料用量计入（非二选一替代料）', () => {
  it('GET /:id 返回主料与辅料两项，且辅料计入材料成本（costRatio 反映合计含辅料）', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).get('/api/v1/bom/BOM-COST')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const materials = res.body.data.materials as any[]
    // 辅料未被过滤掉：两项都在
    expect(materials).toHaveLength(2)

    const main = materials.find((m) => m.id === 'MAT-MAIN')
    const aux = materials.find((m) => m.id === 'MAT-AUX')
    expect(main).toBeTruthy()
    expect(aux).toBeTruthy()

    // 合计材料成本 = 20(主) + 10(辅) = 30。若误把辅料排除在合计之外，
    // 两者 costRatio 之和会 > 1，且主料占比会变为 1。这里锁定正确口径：
    //   main = 20/30 ≈ 0.6667，aux = 10/30 ≈ 0.3333，二者之和 = 1
    expect(main.costRatio).toBeCloseTo(2 / 3, 4)
    expect(aux.costRatio).toBeCloseTo(1 / 3, 4)
    expect(main.costRatio + aux.costRatio).toBeCloseTo(1, 6)
  })
})
