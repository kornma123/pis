import { describe, it, expect } from 'vitest'
import {
  straightLineDepreciation,
  usageDepreciation,
  computeDepreciation,
} from './depreciation.js'

describe('depreciation utils (P1-08 设备折旧计算)', () => {
  describe('straightLineDepreciation', () => {
    it('按天均摊可折旧基数（原值-残值）', () => {
      // (10000 - 1000) / (5 * 365) = 4.93151.../天 → 30 天
      const result = straightLineDepreciation({
        originalCost: 10000,
        salvageValue: 1000,
        usefulLifeYears: 5,
        daysUsed: 30,
        daysPerYear: 365,
      })
      // 9000 / 1825 * 30 = 147.945... → 147.95
      expect(result).toBe(147.95)
    })

    it('残值默认为 0', () => {
      // 3650 / (1 * 365) = 10/天 → 1 天 = 10
      const result = straightLineDepreciation({
        originalCost: 3650,
        usefulLifeYears: 1,
        daysUsed: 1,
      })
      expect(result).toBe(10)
    })

    it('使用天数超过寿命时封顶为可折旧基数', () => {
      const result = straightLineDepreciation({
        originalCost: 1000,
        salvageValue: 100,
        usefulLifeYears: 1,
        daysUsed: 999999,
        daysPerYear: 365,
      })
      expect(result).toBe(900) // 1000 - 100
    })

    it('残值大于等于原值时折旧为 0', () => {
      const result = straightLineDepreciation({
        originalCost: 1000,
        salvageValue: 1200,
        usefulLifeYears: 5,
        daysUsed: 30,
      })
      expect(result).toBe(0)
    })

    it('使用天数为 0 时折旧为 0', () => {
      const result = straightLineDepreciation({
        originalCost: 10000,
        usefulLifeYears: 5,
        daysUsed: 0,
      })
      expect(result).toBe(0)
    })

    it('非法 usefulLifeYears 抛错', () => {
      expect(() =>
        straightLineDepreciation({ originalCost: 1000, usefulLifeYears: 0, daysUsed: 10 }),
      ).toThrow(/usefulLifeYears/)
    })

    it('负的 originalCost 抛错', () => {
      expect(() =>
        straightLineDepreciation({ originalCost: -1, usefulLifeYears: 5, daysUsed: 10 }),
      ).toThrow(/originalCost/)
    })
  })

  describe('usageDepreciation', () => {
    it('按使用量摊销（BOM 语义：分钟/样本 × 样本量）', () => {
      // 原值 100000，残值 0，总产能 200000 分钟
      // 每分钟 0.5；用量 = 10 分钟/样本 × 50 样本 = 500 分钟 → 250
      const result = usageDepreciation({
        originalCost: 100000,
        totalCapacityUnits: 200000,
        unitsUsed: 10 * 50,
      })
      expect(result).toBe(250)
    })

    it('残值参与计算', () => {
      // (10000 - 2000) / 8000 = 1/单位；用量 1234 → 1234
      const result = usageDepreciation({
        originalCost: 10000,
        salvageValue: 2000,
        totalCapacityUnits: 8000,
        unitsUsed: 1234,
      })
      expect(result).toBe(1234)
    })

    it('使用量超过总产能时封顶为可折旧基数', () => {
      const result = usageDepreciation({
        originalCost: 5000,
        salvageValue: 500,
        totalCapacityUnits: 1000,
        unitsUsed: 999999,
      })
      expect(result).toBe(4500)
    })

    it('使用量为 0 时折旧为 0', () => {
      const result = usageDepreciation({
        originalCost: 100000,
        totalCapacityUnits: 200000,
        unitsUsed: 0,
      })
      expect(result).toBe(0)
    })

    it('非法 totalCapacityUnits 抛错', () => {
      expect(() =>
        usageDepreciation({ originalCost: 1000, totalCapacityUnits: 0, unitsUsed: 10 }),
      ).toThrow(/totalCapacityUnits/)
    })

    it('结果四舍五入到分', () => {
      // (1000 - 0) / 3 = 333.333... /单位；用量 1 → 333.33
      const result = usageDepreciation({
        originalCost: 1000,
        totalCapacityUnits: 3,
        unitsUsed: 1,
      })
      expect(result).toBe(333.33)
    })
  })

  describe('computeDepreciation 分派', () => {
    it('straight-line 分派到直线法', () => {
      const viaDispatch = computeDepreciation('straight-line', {
        originalCost: 3650,
        usefulLifeYears: 1,
        daysUsed: 1,
      })
      expect(viaDispatch).toBe(10)
    })

    it('usage 分派到工作量法', () => {
      const viaDispatch = computeDepreciation('usage', {
        originalCost: 100000,
        totalCapacityUnits: 200000,
        unitsUsed: 500,
      })
      expect(viaDispatch).toBe(250)
    })

    it('未知 method 抛错', () => {
      expect(() =>
        // @ts-expect-error 故意传非法 method
        computeDepreciation('declining-balance', { originalCost: 1000 }),
      ).toThrow(/Unknown depreciation method/)
    })
  })
})
