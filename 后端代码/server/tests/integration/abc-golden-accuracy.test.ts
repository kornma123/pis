process.env.DATABASE_PATH = ':memory:'

/**
 * ABC 单张切片成本 — 黄金用例准确性测试（L4-2「先红后绿」靶子）
 *
 * 唯一真相源：docs/COREONE-成本核算事实源说明-2026-06-24.md §7（黄金核算用例）。
 * 验收对应：plans/abc-full-chain-correction-2026-06-24.md
 *   - CHAIN-04（无平均分：各中心费率必须不同）
 *   - CHAIN-05（准确性：单张切片成本 ≤5% 偏差）
 *   - CHAIN-06（完全吸收：Σ池 = Σ来源）
 *   - AC-COST-ACCURACY（docs/07_Acceptance_Criteria.md）
 *
 * ⚠️ 当前状态 = 先红（M1 立靶子，引擎尚未重建）。
 *   现状退化引擎（autoCollectCostPools: abc-v1.1.ts:457-483 的 `/ centers.length` + 全局样本量）实测产出：
 *     - SECTION 费率 = IHC 费率 = ¥70（两中心相同）  → 违反 CHAIN-04
 *     - 单张切片成本 = ¥155（黄金目标 ¥120，偏差 +29.2%）→ 违反 CHAIN-05
 *   因此本 describe 当前置为 `.skip`，避免在引擎重建前污染 CI。
 *
 * ✅ 解除 skip 的条件：完成 M3（L3-1 删平均分 + L3-2 每中心真实动因量 + L2-1 来源→中心映射）后，
 *   把 `describe.skip` 改为 `describe`，并按 L4-3 纳入 CI 红线。届时引擎应按 §7.2 真实归集，
 *   SECTION 费率=¥35/块、IHC 费率=¥52.5/张，单张切片成本=¥120，测试转绿。
 *
 * （本轮 M1 已临时取消 skip 实跑确认其因平均分摊而真红，确认后恢复 skip 提交。）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'

const MONTH = '2026-06'

// —— 黄金基准（docs/COREONE-成本核算事实源说明-2026-06-24.md §7.3）——
const GOLDEN = {
  costPerSlide: 120, // ¥/张
  totalCost: 240, // ¥
  materialCost: 100, // ¥（单样本口径，不乘 slideCount）
  sectionRate: 35, // ¥/块（池 350 ÷ 10 块）
  ihcRate: 52.5, // ¥/张（池 1050 ÷ 20 张）
  sourceTotal: 1400, // 人工 800 + 设备 400 + 间接 200
  tolerance: 0.05, // ±5% 准确性容差（章程 S4）
  absorptionEps: 0.01, // 完全吸收：绝对额 ≤¥0.01（四舍五入级，不与 5% 准确性容差混用，见 §7.5）
}

async function getApp() {
  const { default: app } = await import('../../src/app.js')
  const { getDatabase, initializeDatabase } = await import('../../src/database/DatabaseManager.js')
  return { app, db: getDatabase(), initializeDatabase }
}

async function loginAdmin(app: any): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: 'admin123' })
  expect(res.status).toBe(200)
  return res.body.data.token
}

/**
 * 受控两中心黄金月份。删除默认 seed 的作业中心/工时，注入 §7.1 的已知输入，
 * 使手算无歧义。M3 重建后，同一份 seed 应让引擎按 §7.2 真实归集而转绿。
 */
function seedGoldenMonth(db: any) {
  // 1) 作业中心：只保留 SECTION(block_count) 与 IHC(slide_count)
  db.prepare('DELETE FROM abc_activity_centers').run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status)
              VALUES ('ac-section', 'SECTION', '切片', 'block_count', 20, 'active')`).run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status)
              VALUES ('ac-ihc', 'IHC', '免疫组化', 'slide_count', 40, 'active')`).run()

  // 2) 人工：切片步骤(all) 10min×¥2、免疫组化步骤(ihc) 30min×¥2
  //    归属（L2-1 activity_center_id）：golden_section→SECTION、golden_ihc→IHC
  db.prepare('DELETE FROM standard_labor_times').run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id)
              VALUES ('lab-section', 'golden_section', '切片', 'all', 10, 2, 0, 10, 'ac-section')`).run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id)
              VALUES ('lab-ihc', 'golden_ihc', '免疫组化染色', 'ihc', 30, 2, 0, 20, 'ac-ihc')`).run()

  // 3) 设备折旧（本月）：切片机 ¥100 → SECTION，免疫组化仪 ¥300 → IHC（L2-1 用量定格 activity_center_id）
  db.prepare('DELETE FROM equipment_usage').run()
  db.prepare(`INSERT INTO equipment_usage (id, equipment_id, depreciation_cost, usage_minutes, usage_date, activity_center_id)
              VALUES ('eu-section', 'eq-section', 100, 60, '${MONTH}-10', 'ac-section')`).run()
  db.prepare(`INSERT INTO equipment_usage (id, equipment_id, depreciation_cost, usage_minutes, usage_date, activity_center_id)
              VALUES ('eu-ihc', 'eq-ihc', 300, 120, '${MONTH}-10', 'ac-ihc')`).run()

  // 4) 间接费（本月）合计 ¥200
  db.prepare('DELETE FROM indirect_cost_allocations').run()
  db.prepare(`INSERT INTO indirect_cost_allocations (id, cost_center_id, year_month, total_amount, allocation_base_value, allocation_rate)
              VALUES ('ica-golden', 'cc-golden', '${MONTH}', 200, 10, 20)`).run()

  // 5) 物料（¥50/单位）+ BOM（用量 2）+ 作业关联（SECTION 1 块、IHC 2 张）
  db.prepare(`INSERT INTO material_categories (id, code, name, level) VALUES ('cat-golden', 'CG', '黄金分类', 1)`).run()
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price)
              VALUES ('mat-golden', 'MG-1', '黄金物料', 'ml', 'cat-golden', 50)`).run()
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status)
              VALUES ('bom-golden', 'BOM-GOLDEN', '黄金IHC检测', 'v1.0', 'ihc', 1)`).run()
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
              VALUES ('bi-golden', 'bom-golden', 'mat-golden', 2, 'ml')`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order)
              VALUES ('bal-section', 'bom-golden', 'ac-section', 1, '块', 0)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order)
              VALUES ('bal-ihc', 'bom-golden', 'ac-ihc', 2, '张', 1)`).run()

  // 6) 项目 + 本月一笔出库（10 样本，决定 getCostSourceTotals 的样本量）
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status)
              VALUES ('proj-golden', 'PRJ-GOLDEN', '黄金项目', 'ihc', 'bom-golden', 1)`).run()
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, created_at, sample_count)
              VALUES ('ob-golden', 'OB-GOLDEN', 'bom', 'proj-golden', 0, 'admin', 'completed', '${MONTH}-15 10:00:00', 10)`).run()

  // 7) 本月动因实际总量（供 M3 计算每中心 driver_quantity）：10 块、20 张。
  //    必须带 cost_month（期间键）与 cost_status='costed'（聚合过滤），否则不计入本期动因量。
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, bom_id, project_id, sample_count, slide_count, block_count, cost_month, cost_status)
              VALUES ('oad-golden', 'ob-golden', 'bom-golden', 'proj-golden', 10, 20, 10, '${MONTH}', 'costed')`).run()
}

// M1 立靶子时为先红（平均分摊：两中心费率都=¥70、单张切片 ¥155）。
// M3 引擎重建后转绿：按 §7.2 真实归集 → SECTION ¥35/块、IHC ¥52.5/张、单张切片 ¥120；已接入 CI 红线（L4-3）。
describe('ABC 黄金用例：单张切片真实成本（L4-2 钉死 ≤5% + 完全吸收）', () => {
  let app: any
  let db: any
  let token: string
  let initializeDatabase: () => void

  beforeAll(async () => {
    ({ app, db, initializeDatabase } = await getApp())
    token = await loginAdmin(app)
    seedGoldenMonth(db)
  })

  afterAll(() => {
    initializeDatabase()
  })

  it('成本池归集后：各作业中心费率必须按动因不同（CHAIN-04，禁止平均分）', async () => {
    const res = await request(app)
      .post('/api/v1/abc/cost-pools/auto-collect')
      .set('Authorization', `Bearer ${token}`)
      .send({ yearMonth: MONTH })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const pools = db.prepare(
      `SELECT activity_center_id, driver_rate, total_cost FROM abc_cost_pools WHERE year_month = ?`,
    ).all(MONTH) as any[]
    expect(pools.length).toBe(2)

    const sectionRate = Number(pools.find(p => p.activity_center_id === 'ac-section')?.driver_rate)
    const ihcRate = Number(pools.find(p => p.activity_center_id === 'ac-ihc')?.driver_rate)

    // 完全吸收（CHAIN-06）：Σ池 = 来源合计 1400，绝对额 ≤¥0.01（平均分摊也保留总额，此为绿色护栏）
    const sumPools = pools.reduce((s, p) => s + Number(p.total_cost), 0)
    expect(Math.abs(sumPools - GOLDEN.sourceTotal)).toBeLessThanOrEqual(GOLDEN.absorptionEps)

    // CHAIN-04：两个动因不同的中心，费率必须不同（现状平均分 → 都=70 → 红）
    expect(sectionRate).not.toBe(ihcRate)
    // 目标真实费率（M3 后）
    expect(Math.abs(sectionRate - GOLDEN.sectionRate)).toBeLessThanOrEqual(GOLDEN.sectionRate * GOLDEN.tolerance)
    expect(Math.abs(ihcRate - GOLDEN.ihcRate)).toBeLessThanOrEqual(GOLDEN.ihcRate * GOLDEN.tolerance)
  })

  it('单张切片成本与手算黄金值偏差 ≤5%（CHAIN-05，AC-COST-ACCURACY）', async () => {
    await request(app)
      .post('/api/v1/abc/cost-pools/auto-collect')
      .set('Authorization', `Bearer ${token}`)
      .send({ yearMonth: MONTH })

    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const result = calculateSlideCostWithFee(db, {
      bomId: 'bom-golden',
      slideCount: 2,
      blockCount: 1,
      month: MONTH,
    })

    // 材料成本现状已正确（绿色护栏）
    expect(result.materialCost).toBe(GOLDEN.materialCost)

    // CHAIN-05：单张切片成本 ≤5% 偏差（现状 155 vs 120 → 红）
    const slideDelta = Math.abs(result.costPerSlide - GOLDEN.costPerSlide) / GOLDEN.costPerSlide
    expect(slideDelta).toBeLessThanOrEqual(GOLDEN.tolerance)

    // 总成本 ≤5% 偏差（现状 310 vs 240 → 红）
    const totalDelta = Math.abs(result.totalCost - GOLDEN.totalCost) / GOLDEN.totalCost
    expect(totalDelta).toBeLessThanOrEqual(GOLDEN.tolerance)
  })
})

// ============================================================================
// 高间接占比黄金用例（L4 必补，事实源 §7.6）
// 验证：间接费占来源 80%（远 > 直接）时，引擎仍 ①完全吸收 ②按动因给出不同费率
// ③单张切片成本确定 = 手算 ¥100 ④间接按单一基准披露（标注估算）。
// 受控月份 2026-07，两中心；手算用整除干净数。
// ============================================================================
const MONTH_HI = '2026-07'
const GOLDEN_HI = {
  costPerSlide: 100, // ¥/张 = 作业 200 / 2 张（材料 0）
  totalCost: 200, // SECTION 50×1 + IHC 75×2
  materialCost: 0, // 本用例无材料，隔离间接/作业
  sectionRate: 50, // 池 500 ÷ 10 块
  ihcRate: 75, // 池 1500 ÷ 20 张
  sourceTotal: 2000, // 人工 400 + 设备 0 + 间接 1600
  indirectShare: 0.8, // 间接 1600 / 2000 = 80%（间接 >> 直接 400）
  tolerance: 0.05,
  absorptionEps: 0.01,
}

// 来源（已知）：人工 SECTION 100（5min×¥2×10样本）、IHC 300（15min×¥2×10）；设备 0；间接 1600。
// by_direct_cost 分摊间接：SECTION 1600×100/400=400→池 500；IHC 1600×300/400=1200→池 1500；Σ池 2000=来源 ✓。
function seedHighIndirectMonth(db: any) {
  db.prepare('DELETE FROM abc_activity_centers').run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status)
              VALUES ('ac-sec-hi', 'SECTION_HI', '切片', 'block_count', 20, 'active')`).run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status)
              VALUES ('ac-ihc-hi', 'IHC_HI', '免疫组化', 'slide_count', 40, 'active')`).run()

  db.prepare('DELETE FROM standard_labor_times').run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id)
              VALUES ('lab-sec-hi', 'hi_section', '切片', 'all', 5, 2, 0, 10, 'ac-sec-hi')`).run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id)
              VALUES ('lab-ihc-hi', 'hi_ihc', '免疫组化', 'all', 15, 2, 0, 20, 'ac-ihc-hi')`).run()

  db.prepare('DELETE FROM equipment_usage').run() // 设备 0

  db.prepare('DELETE FROM indirect_cost_allocations').run()
  db.prepare(`INSERT INTO indirect_cost_allocations (id, cost_center_id, year_month, total_amount, allocation_base_value, allocation_rate)
              VALUES ('ica-hi', 'cc-hi', '${MONTH_HI}', 1600, 10, 160)`).run()

  db.prepare(`INSERT INTO boms (id, code, name, version, type, status)
              VALUES ('bom-hi', 'BOM-HI', '高间接占比IHC', 'v1.0', 'ihc', 1)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order)
              VALUES ('bal-sec-hi', 'bom-hi', 'ac-sec-hi', 1, '块', 0)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order)
              VALUES ('bal-ihc-hi', 'bom-hi', 'ac-ihc-hi', 2, '张', 1)`).run()

  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status)
              VALUES ('proj-hi', 'PRJ-HI', '高间接项目', 'ihc', 'bom-hi', 1)`).run()
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, created_at, sample_count)
              VALUES ('ob-hi', 'OB-HI', 'bom', 'proj-hi', 0, 'admin', 'completed', '${MONTH_HI}-15 10:00:00', 10)`).run()
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, bom_id, project_id, sample_count, slide_count, block_count, cost_month, cost_status)
              VALUES ('oad-hi', 'ob-hi', 'bom-hi', 'proj-hi', 10, 20, 10, '${MONTH_HI}', 'costed')`).run()
}

describe('ABC 高间接占比用例：间接主导下仍完全吸收且费率按动因（L4 必补，§7.6）', () => {
  let app: any
  let db: any
  let token: string
  let initializeDatabase: () => void

  beforeAll(async () => {
    ({ app, db, initializeDatabase } = await getApp())
    token = await loginAdmin(app)
    seedHighIndirectMonth(db)
  })

  afterAll(() => {
    initializeDatabase()
  })

  it('间接 80% 主导：完全吸收 Σ池=2000 且 SECTION/IHC 费率 50≠75（CHAIN-04/06）', async () => {
    const res = await request(app)
      .post('/api/v1/abc/cost-pools/auto-collect')
      .set('Authorization', `Bearer ${token}`)
      .send({ yearMonth: MONTH_HI })
    expect(res.status).toBe(200)

    const pools = db.prepare(
      `SELECT activity_center_id, driver_rate, total_cost FROM abc_cost_pools WHERE year_month = ?`,
    ).all(MONTH_HI) as any[]
    expect(pools.length).toBe(2)

    const sectionRate = Number(pools.find(p => p.activity_center_id === 'ac-sec-hi')?.driver_rate)
    const ihcRate = Number(pools.find(p => p.activity_center_id === 'ac-ihc-hi')?.driver_rate)
    const sumPools = pools.reduce((s, p) => s + Number(p.total_cost), 0)

    // 完全吸收：间接占 80% 也不破坏 Σ池 = 来源
    expect(Math.abs(sumPools - GOLDEN_HI.sourceTotal)).toBeLessThanOrEqual(GOLDEN_HI.absorptionEps)
    // 费率按动因不同（非平均分）
    expect(sectionRate).not.toBe(ihcRate)
    expect(Math.abs(sectionRate - GOLDEN_HI.sectionRate)).toBeLessThanOrEqual(GOLDEN_HI.sectionRate * GOLDEN_HI.tolerance)
    expect(Math.abs(ihcRate - GOLDEN_HI.ihcRate)).toBeLessThanOrEqual(GOLDEN_HI.ihcRate * GOLDEN_HI.tolerance)
  })

  it('间接主导下单张切片成本确定 = 手算 ¥100，间接按单一基准披露（CHAIN-05/09）', async () => {
    await request(app)
      .post('/api/v1/abc/cost-pools/auto-collect')
      .set('Authorization', `Bearer ${token}`)
      .send({ yearMonth: MONTH_HI })

    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const result = calculateSlideCostWithFee(db, {
      bomId: 'bom-hi',
      slideCount: 2,
      blockCount: 1,
      month: MONTH_HI,
    })

    expect(result.materialCost).toBe(GOLDEN_HI.materialCost)
    const slideDelta = Math.abs(result.costPerSlide - GOLDEN_HI.costPerSlide) / GOLDEN_HI.costPerSlide
    expect(slideDelta).toBeLessThanOrEqual(GOLDEN_HI.tolerance)
    expect(result.totalCost).toBe(GOLDEN_HI.totalCost)
    // CHAIN-09：间接费按单一披露基准 + 标注估算
    expect(result.indirectBasis).toBe('by_direct_cost')
    expect(result.indirectNote).toBeTruthy()
  })
})

// ============================================================================
// 拟真月度用例（L4-6，事实源 §7.7）—— 加固：多中心(含 case_count)、多 BOM、含材料、
// 跨多出库聚合动因量。验证引擎在更接近真实的结构下仍 ≤5% + 完全吸收。
// 受控月份 2026-08，3 中心，整除干净数；手算经独立交叉核。
// ============================================================================
const MONTH_SIM = '2026-08'
const SIM = {
  sourceTotal: 3000, // 人工 1700 + 设备 300 + 间接 1000
  pools: { sec: 750, ihc: 1500, dx: 750 }, // Σ=3000
  rates: { sec: 30, ihc: 25, dx: 50 }, // 750/25块, 1500/60张, 750/15例
  bomA: { totalCost: 290, costPerSlide: 72.5, materialCost: 80 }, // 材料80 + (30×2+25×4+50×1=210)
  bomB: { totalCost: 325, costPerSlide: 65, materialCost: 120 }, // 材料120 + (30×1+25×5+50×1=205)
  tolerance: 0.05,
  absorptionEps: 0.01,
}

function seedSimulatedMonth(db: any) {
  // 3 作业中心：切片(block)、免疫组化(slide)、诊断(case)
  db.prepare('DELETE FROM abc_activity_centers').run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status) VALUES ('ac-sim-sec','SIM_SEC','切片','block_count',20,'active')`).run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status) VALUES ('ac-sim-ihc','SIM_IHC','免疫组化','slide_count',40,'active')`).run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status) VALUES ('ac-sim-dx','SIM_DX','诊断','case_count',70,'active')`).run()

  // 人工（all，本月 20 样本）：SEC 10min×¥2×20=400、IHC 20min×¥2×20=800、DX 25min×¥1×20=500
  db.prepare('DELETE FROM standard_labor_times').run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id) VALUES ('lab-sim-sec','sim_sec','切片','all',10,2,0,10,'ac-sim-sec')`).run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id) VALUES ('lab-sim-ihc','sim_ihc','免疫组化','all',20,2,0,20,'ac-sim-ihc')`).run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id) VALUES ('lab-sim-dx','sim_dx','诊断','all',25,1,0,30,'ac-sim-dx')`).run()

  // 设备折旧：SEC 100、IHC 200
  db.prepare('DELETE FROM equipment_usage').run()
  db.prepare(`INSERT INTO equipment_usage (id, equipment_id, depreciation_cost, usage_minutes, usage_date, activity_center_id) VALUES ('eu-sim-sec','eq-sim-sec',100,60,'${MONTH_SIM}-10','ac-sim-sec')`).run()
  db.prepare(`INSERT INTO equipment_usage (id, equipment_id, depreciation_cost, usage_minutes, usage_date, activity_center_id) VALUES ('eu-sim-ihc','eq-sim-ihc',200,60,'${MONTH_SIM}-10','ac-sim-ihc')`).run()

  // 间接 1000
  db.prepare('DELETE FROM indirect_cost_allocations').run()
  db.prepare(`INSERT INTO indirect_cost_allocations (id, cost_center_id, year_month, total_amount, allocation_base_value, allocation_rate) VALUES ('ica-sim','cc-sim','${MONTH_SIM}',1000,20,50)`).run()

  // 物料（¥40/单位）
  db.prepare(`INSERT INTO material_categories (id, code, name, level) VALUES ('cat-sim','CSIM','拟真分类',1)`).run()
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price) VALUES ('mat-sim','MS-1','拟真物料','ml','cat-sim',40)`).run()

  // BOM-A：材料用量2(=¥80)，作业 SEC2/IHC4/DX1
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status) VALUES ('bom-sim-a','BOM-SIM-A','拟真HE','v1.0','he',1)`).run()
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES ('bi-sim-a','bom-sim-a','mat-sim',2,'ml')`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-sim-a1','bom-sim-a','ac-sim-sec',2,'块',0)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-sim-a2','bom-sim-a','ac-sim-ihc',4,'张',1)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-sim-a3','bom-sim-a','ac-sim-dx',1,'例',2)`).run()

  // BOM-B：材料用量3(=¥120)，作业 SEC1/IHC5/DX1
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status) VALUES ('bom-sim-b','BOM-SIM-B','拟真IHC','v1.0','ihc',1)`).run()
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES ('bi-sim-b','bom-sim-b','mat-sim',3,'ml')`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-sim-b1','bom-sim-b','ac-sim-sec',1,'块',0)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-sim-b2','bom-sim-b','ac-sim-ihc',5,'张',1)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-sim-b3','bom-sim-b','ac-sim-dx',1,'例',2)`).run()

  // 项目 + 本月一笔出库（20 样本，决定人工 totalSamples）
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status) VALUES ('proj-sim','PRJ-SIM','拟真项目','ihc','bom-sim-b',1)`).run()
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, created_at, sample_count) VALUES ('ob-sim','OB-SIM','bom','proj-sim',0,'admin','completed','${MONTH_SIM}-15 10:00:00',20)`).run()

  // 本月动因实际总量（跨 2 行聚合）：块 10+15=25、张 24+36=60、例 6+9=15
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, bom_id, project_id, sample_count, slide_count, block_count, case_count, cost_month, cost_status) VALUES ('oad-sim-1','ob-sim','bom-sim-a','proj-sim',8,24,10,6,'${MONTH_SIM}','costed')`).run()
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, bom_id, project_id, sample_count, slide_count, block_count, case_count, cost_month, cost_status) VALUES ('oad-sim-2','ob-sim','bom-sim-b','proj-sim',12,36,15,9,'${MONTH_SIM}','costed')`).run()
}

describe('ABC 拟真月度用例：多中心(含case_count)/多BOM/含材料仍 ≤5% + 完全吸收（L4-6，§7.7）', () => {
  let app: any
  let db: any
  let token: string
  let initializeDatabase: () => void

  beforeAll(async () => {
    ({ app, db, initializeDatabase } = await getApp())
    token = await loginAdmin(app)
    seedSimulatedMonth(db)
    await request(app)
      .post('/api/v1/abc/cost-pools/auto-collect')
      .set('Authorization', `Bearer ${token}`)
      .send({ yearMonth: MONTH_SIM })
  })

  afterAll(() => {
    initializeDatabase()
  })

  it('3 中心归集：Σ池=3000 完全吸收，费率按动因 30/25/50（CHAIN-04/06）', () => {
    const pools = db.prepare(
      `SELECT activity_center_id, driver_rate, total_cost FROM abc_cost_pools WHERE year_month = ?`,
    ).all(MONTH_SIM) as any[]
    expect(pools.length).toBe(3)
    const sumPools = pools.reduce((s, p) => s + Number(p.total_cost), 0)
    expect(Math.abs(sumPools - SIM.sourceTotal)).toBeLessThanOrEqual(SIM.absorptionEps)

    const rate = (id: string) => Number(pools.find(p => p.activity_center_id === id)?.driver_rate)
    expect(Math.abs(rate('ac-sim-sec') - SIM.rates.sec)).toBeLessThanOrEqual(SIM.rates.sec * SIM.tolerance)
    expect(Math.abs(rate('ac-sim-ihc') - SIM.rates.ihc)).toBeLessThanOrEqual(SIM.rates.ihc * SIM.tolerance)
    expect(Math.abs(rate('ac-sim-dx') - SIM.rates.dx)).toBeLessThanOrEqual(SIM.rates.dx * SIM.tolerance)
  })

  it('BOM-A 单张切片 ≤5%（材料80 + 作业210 = 290 / 4 = ¥72.5）', async () => {
    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const r = calculateSlideCostWithFee(db, { bomId: 'bom-sim-a', slideCount: 4, blockCount: 2, month: MONTH_SIM })
    expect(r.materialCost).toBe(SIM.bomA.materialCost)
    expect(Math.abs(r.costPerSlide - SIM.bomA.costPerSlide) / SIM.bomA.costPerSlide).toBeLessThanOrEqual(SIM.tolerance)
    expect(Math.abs(r.totalCost - SIM.bomA.totalCost) / SIM.bomA.totalCost).toBeLessThanOrEqual(SIM.tolerance)
  })

  it('BOM-B 单张切片 ≤5%（材料120 + 作业205 = 325 / 5 = ¥65）', async () => {
    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const r = calculateSlideCostWithFee(db, { bomId: 'bom-sim-b', slideCount: 5, blockCount: 1, month: MONTH_SIM })
    expect(r.materialCost).toBe(SIM.bomB.materialCost)
    expect(Math.abs(r.costPerSlide - SIM.bomB.costPerSlide) / SIM.bomB.costPerSlide).toBeLessThanOrEqual(SIM.tolerance)
    expect(Math.abs(r.totalCost - SIM.bomB.totalCost) / SIM.bomB.totalCost).toBeLessThanOrEqual(SIM.tolerance)
  })
})

// ============================================================================
// R1：多样本逐单分摊 × 完全吸收（残留正确性项①）
// 旧码 getDriverQuantity 对配了 link.quantity 的块/片中心直接返回「每样本配置量」、漏乘样本数 N，
// 致 N>1 出库逐单作业成本偏小、Σ分摊 < Σ池（欠吸收，差额进 warning）。本组钉死修复：
//   块/片逐单量 = 每样本配置量 × 样本数；单一出库吃满整池时 Σ分摊 == Σ池（CHAIN-06）。
// 受控池（直接 seed 已知费率）隔离 R1，不依赖 auto-collect。
// ============================================================================
const MONTH_R1 = '2026-09'
function seedR1Pools(db: any) {
  db.prepare('DELETE FROM abc_activity_centers').run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status) VALUES ('ac-r1-blk','R1_BLK','切片','block_count',10,'active')`).run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status) VALUES ('ac-r1-sld','R1_SLD','免疫组化','slide_count',20,'active')`).run()
  // 受控池：块中心 ¥10/块、池 ¥30（动因量 3 块）；片中心 ¥5/张、池 ¥30（动因量 6 张）。Σ池 = ¥60。
  db.prepare(`INSERT INTO abc_cost_pools (id, activity_center_id, year_month, total_cost, driver_quantity, driver_rate, source) VALUES ('p-r1-blk','ac-r1-blk',?,30,3,10,'auto_collect')`).run(MONTH_R1)
  db.prepare(`INSERT INTO abc_cost_pools (id, activity_center_id, year_month, total_cost, driver_quantity, driver_rate, source) VALUES ('p-r1-sld','ac-r1-sld',?,30,6,5,'auto_collect')`).run(MONTH_R1)
  // BOM：每样本 1 块 + 2 张（与受控池动因口径一致：3 样本 → 3 块、6 张，正好吃满整池）。
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status) VALUES ('bom-r1','BOM-R1','R1用例','v1.0','ihc',1)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-r1-blk','bom-r1','ac-r1-blk',1,'块',0)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-r1-sld','bom-r1','ac-r1-sld',2,'张',1)`).run()
}

describe('ABC R1：多样本逐单分摊按样本数缩放且完全吸收（CHAIN-06）', () => {
  let db: any
  let initializeDatabase: () => void

  beforeAll(async () => {
    ({ db, initializeDatabase } = await getApp())
    seedR1Pools(db)
  })
  afterAll(() => { initializeDatabase() })

  it('单样本基线：块 ¥10×1 + 片 ¥5×2 = ¥20（每样本量，不缩放）', async () => {
    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const r = calculateSlideCostWithFee(db, { bomId: 'bom-r1', slideCount: 1, blockCount: 1, sampleCount: 1, materialCost: 0, month: MONTH_R1 })
    expect(r.totalActivityCost).toBe(20)
    const blk = r.activityCosts.find((a: any) => a.activityCenterId === 'ac-r1-blk')
    const sld = r.activityCosts.find((a: any) => a.activityCenterId === 'ac-r1-sld')
    expect(blk.quantity).toBe(1) // 1 块/样本 × 1 样本
    expect(sld.quantity).toBe(2) // 2 张/样本 × 1 样本
  })

  it('3 样本：块 ¥10×3 + 片 ¥5×6 = ¥60，逐单量按样本数缩放（修复前会得 ¥20）', async () => {
    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const r = calculateSlideCostWithFee(db, { bomId: 'bom-r1', slideCount: 3, blockCount: 1, sampleCount: 3, materialCost: 0, month: MONTH_R1 })
    const blk = r.activityCosts.find((a: any) => a.activityCenterId === 'ac-r1-blk')
    const sld = r.activityCosts.find((a: any) => a.activityCenterId === 'ac-r1-sld')
    expect(blk.quantity).toBe(3) // 1 块/样本 × 3 样本
    expect(sld.quantity).toBe(6) // 2 张/样本 × 3 样本
    expect(r.totalActivityCost).toBe(60)
  })

  it('完全吸收：3 样本出库吃满整池，Σ逐单分摊 == Σ池 ¥60（CHAIN-06，修复前仅 1/3 欠吸收）', async () => {
    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const r = calculateSlideCostWithFee(db, { bomId: 'bom-r1', slideCount: 3, blockCount: 1, sampleCount: 3, materialCost: 0, month: MONTH_R1 })
    const sumPools = (db.prepare(`SELECT COALESCE(SUM(total_cost),0) as t FROM abc_cost_pools WHERE year_month = ?`).get(MONTH_R1) as any).t
    expect(sumPools).toBe(60)
    expect(Math.abs(r.totalActivityCost - sumPools)).toBeLessThanOrEqual(0.01)
  })
})

// ============================================================================
// R2：病例（case_count）动因按去重病例数计费率，跨多出库不重复计数（残留正确性项④）
// 一病例(CASE-R2)拆 2 蜡块 → 2 笔出库，各 case_count=1。
//   旧 SUM(case_count)=2 → 费率 = 池÷2（"每出库病例"，失真）。
//   新 COUNT(DISTINCT case_no)=1 → 费率 = 池÷1（"每病例"，正确）；逐单分摊按 1/组大小(½) → Σ=池（完全吸收）。
// ============================================================================
const MONTH_R2 = '2026-10'
function seedR2Month(db: any) {
  db.prepare('DELETE FROM abc_activity_centers').run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status) VALUES ('ac-r2-dx','R2_DX','诊断','case_count',10,'active')`).run()
  // 人工 → dx：10min × ¥10/min，project_type='all'（按本期总样本量 2 摊）→ 池直接成本 ¥200。
  db.prepare('DELETE FROM standard_labor_times').run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id) VALUES ('lab-r2-dx','r2_dx','诊断','all',10,10,0,10,'ac-r2-dx')`).run()
  db.prepare('DELETE FROM equipment_usage').run()
  db.prepare('DELETE FROM indirect_cost_allocations').run()
  // BOM + dx 作业关联（每样本 1 例）
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status) VALUES ('bom-r2','BOM-R2','R2用例','v1.0','ihc',1)`).run()
  db.prepare(`INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order) VALUES ('bal-r2-dx','bom-r2','ac-r2-dx',1,'例',0)`).run()
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status) VALUES ('proj-r2','PRJ-R2','R2项目','all','bom-r2',1)`).run()
  // 同一病例 CASE-R2 拆 2 笔出库（各 1 样本），本期总样本 = 2
  for (const n of [1, 2]) {
    db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, case_no, operator, status, created_at, sample_count) VALUES (?, ?, 'bom', 'proj-r2', 0, 'CASE-R2', 'admin', 'completed', '${MONTH_R2}-15 10:0${n}:00', 1)`).run(`ob-r2-${n}`, `OB-R2-${n}`)
    db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, bom_id, project_id, sample_count, slide_count, block_count, case_count, case_no, cost_month, cost_status) VALUES (?, ?, 'bom-r2','proj-r2',1,1,1,1,'CASE-R2','${MONTH_R2}','costed')`).run(`oad-r2-${n}`, `ob-r2-${n}`)
  }
}

describe('ABC R2：病例动因按去重计费率 + 跨多出库完全吸收（CHAIN-06）', () => {
  let app: any
  let db: any
  let token: string
  let initializeDatabase: () => void

  beforeAll(async () => {
    ({ app, db, initializeDatabase } = await getApp())
    token = await loginAdmin(app)
    seedR2Month(db)
    await request(app).post('/api/v1/abc/cost-pools/auto-collect').set('Authorization', `Bearer ${token}`).send({ yearMonth: MONTH_R2 })
  })
  afterAll(() => { initializeDatabase() })

  it('dx 池动因量 = 去重病例数 1（非 SUM=2），费率 = ¥200/例（修复前为 ¥100）', () => {
    const pool = db.prepare(`SELECT driver_quantity, driver_rate, total_cost FROM abc_cost_pools WHERE activity_center_id = 'ac-r2-dx' AND year_month = ?`).get(MONTH_R2) as any
    expect(Number(pool.driver_quantity)).toBe(1)
    expect(Number(pool.total_cost)).toBe(200)
    expect(Number(pool.driver_rate)).toBe(200)
  })

  it('逐单按 1/组大小(½)分摊，Σ两单 dx 分摊 == 池 ¥200（完全吸收）', async () => {
    const { calculateSlideCostWithFee } = await import('../../src/utils/cost-calculator.js')
    const alloc = (n: number) => {
      const r = calculateSlideCostWithFee(db, { bomId: 'bom-r2', slideCount: 1, blockCount: 1, sampleCount: 1, caseNo: 'CASE-R2', caseCount: 1, materialCost: 0, month: MONTH_R2 })
      return r.activityCosts.find((a: any) => a.activityCenterId === 'ac-r2-dx')?.totalCost || 0
    }
    const a1 = alloc(1)
    const a2 = alloc(2)
    expect(a1).toBe(100) // 200 × ½
    expect(a1 + a2).toBe(200) // Σ = 池，完全吸收
  })
})

// ============================================================================
// 重算口径回归（code-review 发现）：重算路径把快照写成 cost_status='recalculated'，
// 期间动因量分母 getCenterDriverQuantity 与病例组大小 countCostedCaseOutbounds 必须用
// NOT IN('pending_cost','cost_exception') 而非 'costed'——否则重算后分母塌缩为 0、费率失真、吸收破。
// ============================================================================
const MONTH_RC = '2026-12'
function seedRecalcMonth(db: any) {
  db.prepare('DELETE FROM abc_activity_centers').run()
  db.prepare(`INSERT INTO abc_activity_centers (id, code, name, cost_driver_type, sort_order, status) VALUES ('ac-rc','RC_SEC','切片','block_count',10,'active')`).run()
  db.prepare('DELETE FROM standard_labor_times').run()
  db.prepare(`INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, activity_center_id) VALUES ('lab-rc','rc_sec','切片','all',10,5,0,10,'ac-rc')`).run()
  db.prepare('DELETE FROM equipment_usage').run()
  db.prepare('DELETE FROM indirect_cost_allocations').run()
  db.prepare(`INSERT INTO projects (id, code, name, type, status) VALUES ('proj-rc','PRJ-RC','RC项目','all',1)`).run()
  // 本期总样本 4 → 人工池 = 4×10×5 = ¥200。快照状态为 'recalculated'（模拟重算后）。
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, created_at, sample_count) VALUES ('ob-rc','OB-RC','bom','proj-rc',0,'admin','completed','${MONTH_RC}-15 10:00:00',4)`).run()
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, project_id, sample_count, slide_count, block_count, cost_month, cost_status) VALUES ('oad-rc','ob-rc','proj-rc',4,0,8,'${MONTH_RC}','recalculated')`).run()
}

describe('ABC 重算口径回归：recalculated 快照仍计入动因量分母（吸收不塌缩）', () => {
  let app: any
  let db: any
  let token: string
  let initializeDatabase: () => void

  beforeAll(async () => {
    ({ app, db, initializeDatabase } = await getApp())
    token = await loginAdmin(app)
    seedRecalcMonth(db)
    await request(app).post('/api/v1/abc/cost-pools/auto-collect').set('Authorization', `Bearer ${token}`).send({ yearMonth: MONTH_RC })
  })
  afterAll(() => { initializeDatabase() })

  it('block 中心动因量 = recalculated 行的 block_count(8)（修复前因只认 costed 会塌缩为 0）', () => {
    const pool = db.prepare(`SELECT driver_quantity, driver_rate, total_cost FROM abc_cost_pools WHERE activity_center_id = 'ac-rc' AND year_month = ?`).get(MONTH_RC) as any
    expect(pool).toBeTruthy()
    expect(Number(pool.driver_quantity)).toBe(8)
    expect(Number(pool.total_cost)).toBe(200)
    expect(Number(pool.driver_rate)).toBe(25) // 200 / 8
  })
})
