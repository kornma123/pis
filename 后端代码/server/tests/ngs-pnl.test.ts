/**
 * NGS 外购转销 P&L 纯函数单测 —— 售价/外包成本/毛利 + 按医院上卷 + 亏本单暴露。
 * 业务：NGS 外包第三方，收入(售价)/成本(协议价=外包成本)走独立渠道；毛利=售价−外包成本。
 */
import { describe, it, expect } from 'vitest'
import { aggregateNgsOrders, normalizeNgsOrder, type NgsOrderRaw } from '../src/utils/ngs-pnl.js'

describe('ngs-pnl：normalizeNgsOrder', () => {
  it('毛利=售价−外包成本；容忍 ¥/千分位/中文表头', () => {
    const o = normalizeNgsOrder({ 送检医院: '上海和睦家医院', 产品名称: '结直肠癌套餐', 售价: '¥8,500', 外包成本: 1350, 计费时间: '2026-06-03' })
    expect(o.sellPrice).toBe(8500)
    expect(o.outsourceCost).toBe(1350)
    expect(o.margin).toBe(7150)
    expect(o.orderMonth).toBe('2026-06')
  })
  it('协议价/销售价 别名识别', () => {
    const o = normalizeNgsOrder({ 送检医院: 'A', 产品名称: 'X', 销售价: 5000, 协议价: 950 })
    expect(o.sellPrice).toBe(5000)
    expect(o.outsourceCost).toBe(950)
    expect(o.margin).toBe(4050)
  })
})

describe('ngs-pnl：aggregateNgsOrders（逐单 + 院级上卷 + 汇总）', () => {
  const rows: NgsOrderRaw[] = [
    { 送检医院: '甲医院', 产品名称: '结直肠119', 售价: 8500, 外包成本: 1350, 月份: '2026-06' },
    { 送检医院: '甲医院', 产品名称: '胃112', 售价: 8500, 外包成本: 1350, 月份: '2026-06' },
    { 送检医院: '乙医院', 产品名称: '甲状腺核心15', 售价: 4500, 外包成本: 850, 月份: '2026-06' },
    { 序号: '小计', 送检医院: '', 产品名称: '' }, // 噪声行应跳过
  ]
  const agg = aggregateNgsOrders(rows)

  it('跳过非订单行', () => {
    expect(agg.summary.orderCount).toBe(3)
    expect(agg.summary.skippedRows).toBe(1)
  })
  it('甲医院上卷：2 单 收入17000 / 外包成本2700 / 毛利14300', () => {
    const a = agg.partners.find((p) => p.partnerName === '甲医院')!
    expect(a.orderCount).toBe(2)
    expect(a.revenueTotal).toBe(17000)
    expect(a.costTotal).toBe(2700)
    expect(a.marginTotal).toBe(14300)
  })
  it('汇总：收入21500 / 外包成本3550 / 毛利17950 / 毛利率≈0.8349', () => {
    expect(agg.summary.revenueTotal).toBe(21500)
    expect(agg.summary.costTotal).toBe(3550)
    expect(agg.summary.marginTotal).toBe(17950)
    expect(agg.summary.marginRate).toBeCloseTo(0.8349, 4)
  })
  it('亏本单（售价<外包成本）→ negativeMarginCount 暴露不静默', () => {
    const a2 = aggregateNgsOrders([{ 送检医院: 'C', 产品名称: 'X', 售价: 100, 外包成本: 1350 }])
    expect(a2.summary.negativeMarginCount).toBe(1)
    expect(a2.orders[0].margin).toBe(-1250)
  })

  it('数据质量计数：缺外包成本/缺售价/缺键(订单号或产品名) 显式暴露（Codex 审查项）', () => {
    const a = aggregateNgsOrders([
      { 送检医院: 'A', 产品名称: 'X', 售价: 8500 }, // 缺外包成本 + 缺订单号
      { 送检医院: 'B', 订单号: 'N2', 产品名称: 'Y', 外包成本: 1350 }, // 缺售价
      { 送检医院: 'C', 订单号: 'N3', 售价: 5000, 外包成本: 950 }, // 缺产品名
    ])
    expect(a.summary.missingCostCount).toBe(1)
    expect(a.summary.missingPriceCount).toBe(1)
    expect(a.summary.missingKeyCount).toBe(2) // 第1单无订单号、第3单无产品名
  })
})
