import { describe, it, expect } from 'vitest'
import {
  calculateTieredCost,
  calculateFeeAmountFromStandard,
  getDriverRate,
  calculateSlideCostWithFee,
} from './cost-calculator.js'

// ===== calculateTieredCost =====

describe('calculateTieredCost', () => {
  it('无阶梯规则时返回 0', () => {
    expect(calculateTieredCost(5, [])).toBe(0)
  })

  it('单一价格，无封顶', () => {
    const tiers = [{ unitPrice: 100 }]
    expect(calculateTieredCost(5, tiers)).toBe(500)
  })

  it('IHC 阶梯：前3项205元，第4-12项210元，第13+项105元', () => {
    const tiers = [
      { maxQuantity: 3, unitPrice: 205 },
      { maxQuantity: 12, unitPrice: 210 },
      { unitPrice: 105 },
    ]
    // 5 项 = 3×205 + 2×210 = 615 + 420 = 1035
    expect(calculateTieredCost(5, tiers)).toBe(1035)
    // 15 项 = 3×205 + 9×210 + 3×105 = 615 + 1890 + 315 = 2820
    expect(calculateTieredCost(15, tiers)).toBe(2820)
  })

  it('诊断费阶梯：前10张105元，11-20张147元，21+张189元', () => {
    const tiers = [
      { maxQuantity: 10, unitPrice: 105 },
      { maxQuantity: 20, unitPrice: 147 },
      { unitPrice: 189 },
    ]
    expect(calculateTieredCost(5, tiers)).toBe(525)
    expect(calculateTieredCost(15, tiers)).toBe(1785)
    expect(calculateTieredCost(25, tiers)).toBe(3465)
  })

  it('FISH 封顶：每探针1200元，封顶3600元', () => {
    const tiers = [{ unitPrice: 1200 }]
    expect(calculateTieredCost(2, tiers, 3600)).toBe(2400)
    expect(calculateTieredCost(3, tiers, 3600)).toBe(3600)
    expect(calculateTieredCost(4, tiers, 3600)).toBe(3600) // 封顶
  })

  it('数量为 0 时返回 0', () => {
    expect(calculateTieredCost(0, [{ unitPrice: 100 }])).toBe(0)
  })

  it('数量为 1 时返回基础价格', () => {
    expect(calculateTieredCost(1, [{ unitPrice: 100 }])).toBe(100)
  })

  it('数量恰好等于阶梯边界', () => {
    const tiers = [
      { maxQuantity: 3, unitPrice: 205 },
      { maxQuantity: 12, unitPrice: 210 },
      { unitPrice: 105 },
    ]
    // 恰好 3 项：3×205 = 615
    expect(calculateTieredCost(3, tiers)).toBe(615)
    // 恰好 12 项：3×205 + 9×210 = 615 + 1890 = 2505
    expect(calculateTieredCost(12, tiers)).toBe(2505)
  })

  it('封顶金额小于实际成本时生效', () => {
    const tiers = [{ unitPrice: 100 }]
    expect(calculateTieredCost(5, tiers, 400)).toBe(400)
  })

  it('封顶金额大于实际成本时不生效', () => {
    const tiers = [{ unitPrice: 100 }]
    expect(calculateTieredCost(5, tiers, 600)).toBe(500)
  })
})

// ===== calculateFeeAmountFromStandard =====

describe('calculateFeeAmountFromStandard', () => {
  it('无阶梯规则，基础价格 × 数量', () => {
    const standard = { base_price: 100, tier_rules: null, cap_amount: null }
    expect(calculateFeeAmountFromStandard(standard, 5)).toBe(500)
  })

  it('有阶梯规则', () => {
    const standard = {
      base_price: 205,
      tier_rules: JSON.stringify([
        { maxQuantity: 3, unitPrice: 205 },
        { maxQuantity: 12, unitPrice: 210 },
        { unitPrice: 105 },
      ]),
      cap_amount: null,
    }
    expect(calculateFeeAmountFromStandard(standard, 5)).toBe(1035)
  })

  it('有阶梯规则 + 封顶', () => {
    const standard = {
      base_price: 1200,
      tier_rules: JSON.stringify([{ unitPrice: 1200 }]),
      cap_amount: 3600,
    }
    // 4 × 1200 = 4800，封顶 3600
    expect(calculateFeeAmountFromStandard(standard, 4)).toBe(3600)
    // 2 × 1200 = 2400，未达封顶
    expect(calculateFeeAmountFromStandard(standard, 2)).toBe(2400)
  })

  it('无阶梯规则时 cap_amount 不生效（仅基础价格 × 数量）', () => {
    const standard = {
      base_price: 1200,
      tier_rules: null,
      cap_amount: 3600,
    }
    // 无阶梯规则，cap 不生效：1200 × 4 = 4800
    expect(calculateFeeAmountFromStandard(standard, 4)).toBe(4800)
  })

  it('数量为 0 时返回 0', () => {
    const standard = { base_price: 100, tier_rules: null, cap_amount: null }
    expect(calculateFeeAmountFromStandard(standard, 0)).toBe(0)
  })

  it('数量为 1 时返回基础价格', () => {
    const standard = { base_price: 100, tier_rules: null, cap_amount: null }
    expect(calculateFeeAmountFromStandard(standard, 1)).toBe(100)
  })

  it('tier_rules JSON 解析失败时使用基础价格', () => {
    const standard = { base_price: 100, tier_rules: 'invalid json', cap_amount: null }
    expect(calculateFeeAmountFromStandard(standard, 5)).toBe(500)
  })

  it('数量为负数时返回 0', () => {
    const standard = { base_price: 100, tier_rules: null, cap_amount: null }
    expect(calculateFeeAmountFromStandard(standard, -1)).toBe(0)
  })

  it('feeStandard 为 null 时返回 0', () => {
    expect(calculateFeeAmountFromStandard(null as any, 5)).toBe(0)
  })
})

// ===== getDriverRate — 三级降级策略 =====

/**
 * 创建 getDriverRate 专用的 mock DB
 * 按 (activityCenterId, year_month) 返回 driver_rate
 */
function createDriverRateMockDb(pools: Array<{ activity_center_id: string; year_month: string; driver_rate: number }>) {
  return {
    prepare(sql: string) {
      return {
        get(...params: any[]) {
          if (sql.includes('FROM abc_cost_pools')) {
            const [acId, month] = params
            return pools.find(p => p.activity_center_id === acId && p.year_month === month) || null
          }
          // 第三级降级：BOM 平均标准成本
          if (sql.includes('FROM boms b')) {
            const [acId] = params
            // 模拟返回 null（无关联 BOM）
            if (acId === 'no-bom') return null
            // 模拟返回平均费率
            return { avg_rate: 50 }
          }
          return null
        },
      }
    },
  }
}

describe('getDriverRate', () => {
  it('优先使用当月成本池费率', () => {
    const db = createDriverRateMockDb([
      { activity_center_id: 'ac-1', year_month: '2026-06', driver_rate: 120 },
    ])
    expect(getDriverRate(db, 'ac-1', '2026-06')).toBe(120)
  })

  it('当月无数据时降级到上月', () => {
    const db = createDriverRateMockDb([
      { activity_center_id: 'ac-1', year_month: '2026-05', driver_rate: 95 },
    ])
    expect(getDriverRate(db, 'ac-1', '2026-06')).toBe(95)
  })

  it('当月和上月均无数据时降级到 BOM 平均标准成本', () => {
    const db = createDriverRateMockDb([])
    // 使用默认 acId 会返回 { avg_rate: 50 }
    expect(getDriverRate(db, 'ac-1', '2026-06')).toBe(50)
  })

  it('三级均无数据时返回 0', () => {
    const db = createDriverRateMockDb([])
    // 'no-bom' 会返回 null
    expect(getDriverRate(db, 'no-bom', '2026-06')).toBe(0)
  })

  it('当月费率 ≤ 0 时降级到上月', () => {
    const db = createDriverRateMockDb([
      { activity_center_id: 'ac-1', year_month: '2026-06', driver_rate: 0 },
      { activity_center_id: 'ac-1', year_month: '2026-05', driver_rate: 88 },
    ])
    expect(getDriverRate(db, 'ac-1', '2026-06')).toBe(88)
  })

  it('跨年月份降级正确（1月 → 12月/上年）', () => {
    const db = createDriverRateMockDb([
      { activity_center_id: 'ac-1', year_month: '2025-12', driver_rate: 77 },
    ])
    expect(getDriverRate(db, 'ac-1', '2026-01')).toBe(77)
  })
})

// ===== calculateSlideCostWithFee =====

/**
 * 创建 calculateSlideCostWithFee 专用的 mock DB
 * 需要模拟：bom_items, batches, bom_activity_links, abc_cost_pools, boms, fee_standards
 */
function createSlideCostMockDb(options: {
  bomItems?: Array<{ material_id: string; usage_per_sample: number; price: number }>
  batches?: Array<{ material_id: string; weighted_price: number }>
  activityLinks?: Array<{
    activity_center_id: string
    activity_center_name: string
    activity_center_code: string
    cost_driver_type?: string
    driver_quantity?: number
    sort_order?: number
  }>
  costPools?: Array<{ activity_center_id: string; year_month: string; driver_rate: number; total_cost?: number; driver_quantity?: number }>
  bom?: { fee_standard_id?: string | null; fee_category?: string | null }
  feeStandard?: { base_price: number; tier_rules: string | null; cap_amount: number | null } | null
}) {
  const {
    bomItems = [],
    batches = [],
    activityLinks = [],
    costPools = [],
    bom = {},
    feeStandard = null,
  } = options

  return {
    prepare(sql: string) {
      return {
        all(...params: any[]) {
          // bom_items 查询
          if (sql.includes('FROM bom_items bi')) {
            return bomItems.map(item => ({
              ...item,
              material_id: item.material_id,
            }))
          }
          // batches 加权平均价查询
          if (sql.includes('FROM batches')) {
            return batches.map(b => ({
              material_id: b.material_id,
              weighted_price: b.weighted_price,
            }))
          }
          // bom_activity_links 查询（L2-6 统一表名，原 abc_bom_activity_links 兼容分支已删）
          if (sql.includes('FROM bom_activity_links l')) {
            return activityLinks
          }
          return []
        },
        get(...params: any[]) {
          // abc_cost_pools 查询
          if (sql.includes('FROM abc_cost_pools')) {
            const [acId, month] = params
            return costPools.find(p => p.activity_center_id === acId && p.year_month === month) || null
          }
          // boms 查询（收费标准关联）
          if (sql.includes('FROM boms WHERE id = ? AND is_deleted')) {
            const [bomId] = params
            return bom ? { id: bomId, ...bom } : null
          }
          // fee_standards 查询
          if (sql.includes('FROM fee_standards WHERE id = ?')) {
            return feeStandard || null
          }
          return null
        },
      }
    },
  }
}

describe('calculateSlideCostWithFee', () => {
  it('基础切片成本 + 收费匹配 + 利润计算', () => {
    const db = createSlideCostMockDb({
      bomItems: [
        { material_id: 'mat-1', usage_per_sample: 2, price: 50 },
      ],
      batches: [
        { material_id: 'mat-1', weighted_price: 45 },
      ],
      activityLinks: [
        {
          activity_center_id: 'ac-stain',
          activity_center_name: '染色中心',
          activity_center_code: 'stain_count',
        },
      ],
      costPools: [
        { activity_center_id: 'ac-stain', year_month: '2026-06', driver_rate: 30 },
      ],
      bom: { fee_standard_id: 'fs-1', fee_category: 'ihc' },
      feeStandard: {
        base_price: 205,
        tier_rules: null,
        cap_amount: null,
      },
    })

    const result = calculateSlideCostWithFee(db, {
      bomId: 'bom-1',
      slideCount: 3,
      blockCount: 1,
      month: '2026-06',
    })

    // 材料成本 = 45 × 2 = 90（加权平均价 × 用量）
    expect(result.materialCost).toBe(90)
    // 活动成本 = 30 × 1（stain_count 动因）= 30
    expect(result.totalActivityCost).toBe(30)
    // 总成本 = 90 + 30 = 120
    expect(result.totalCost).toBe(120)
    // 收费 = 205 × 3 = 615
    expect(result.feeAmount).toBe(615)
    // 利润 = 615 - 120 = 495
    expect(result.profit).toBe(495)
    // 利润率 = 495 / 615 ≈ 0.8049
    expect(result.profitRate).toBeCloseTo(0.8049, 3)
  })

  it('无收费标准关联时 feeAmount 为 0', () => {
    const db = createSlideCostMockDb({
      bomItems: [
        { material_id: 'mat-1', usage_per_sample: 1, price: 100 },
      ],
      batches: [],
      activityLinks: [],
      costPools: [],
      bom: { fee_standard_id: null, fee_category: null },
      feeStandard: null,
    })

    const result = calculateSlideCostWithFee(db, {
      bomId: 'bom-1',
      slideCount: 1,
      blockCount: 1,
      month: '2026-06',
    })

    expect(result.feeAmount).toBe(0)
    expect(result.feeStandardId).toBeNull()
    expect(result.feeCategory).toBeNull()
    // 利润 = 0 - 成本（负数）
    expect(result.profit).toBeLessThanOrEqual(0)
    expect(result.profitRate).toBe(0) // feeAmount=0 时利润率为 0
  })

  it('无作业中心时仅有材料成本', () => {
    const db = createSlideCostMockDb({
      bomItems: [
        { material_id: 'mat-1', usage_per_sample: 1, price: 80 },
      ],
      batches: [],
      activityLinks: [],
      costPools: [],
      bom: {},
      feeStandard: null,
    })

    const result = calculateSlideCostWithFee(db, {
      bomId: 'bom-1',
      slideCount: 1,
      blockCount: 1,
      month: '2026-06',
    })

    expect(result.materialCost).toBe(80)
    expect(result.totalActivityCost).toBe(0)
    expect(result.totalCost).toBe(80)
    expect(result.activityCosts).toHaveLength(0)
  })

  it('使用提供的 materialCost 而非从 BOM 计算', () => {
    const db = createSlideCostMockDb({
      bomItems: [
        { material_id: 'mat-1', usage_per_sample: 1, price: 80 },
      ],
      batches: [],
      activityLinks: [],
      costPools: [],
      bom: {},
      feeStandard: null,
    })

    const result = calculateSlideCostWithFee(db, {
      bomId: 'bom-1',
      slideCount: 1,
      blockCount: 1,
      month: '2026-06',
      materialCost: 500,
    })

    // 使用提供的 materialCost，而非 BOM 计算的 80
    expect(result.materialCost).toBe(500)
    expect(result.totalCost).toBe(500)
  })

  it('多作业中心累加成本', () => {
    const db = createSlideCostMockDb({
      bomItems: [],
      batches: [],
      activityLinks: [
        {
          activity_center_id: 'ac-cut',
          activity_center_name: '切片中心',
          activity_center_code: 'SECTION',
          cost_driver_type: 'block_count', // L3-2：动因量按 cost_driver_type 判定（非中心 code）
        },
        {
          activity_center_id: 'ac-stain',
          activity_center_name: '染色中心',
          activity_center_code: 'STAIN',
          cost_driver_type: 'stain_count', // 非 block/slide → 回退 1
        },
      ],
      costPools: [
        { activity_center_id: 'ac-cut', year_month: '2026-06', driver_rate: 15 },
        { activity_center_id: 'ac-stain', year_month: '2026-06', driver_rate: 25 },
      ],
      bom: {},
      feeStandard: null,
    })

    const result = calculateSlideCostWithFee(db, {
      bomId: 'bom-1',
      slideCount: 1,
      blockCount: 3,
      month: '2026-06',
    })

    // 切片中心：15 × 3（block_count 动因）= 45
    // 染色中心：25 × 1（stain_count 动因）= 25
    expect(result.totalActivityCost).toBe(70)
    expect(result.activityCosts).toHaveLength(2)
  })
})
