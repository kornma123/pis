import { describe, it, expect } from 'vitest'
import {
  resolveAttribution,
  usesStepScope,
  LINE_ATTRIBUTION,
  type BusinessLine,
  type AttributionMethod,
} from '../src/utils/revenue-attribution.js'

describe('revenue-attribution 预埋 seam（待对账单完善前的契约 + 零回归保证）', () => {
  it('未标注业务线一律回退 bill_ratio = 等价现状 computeCasePnl 路径（零回归）', () => {
    expect(resolveAttribution(null)).toBe<AttributionMethod>('bill_ratio')
    expect(resolveAttribution(undefined)).toBe<AttributionMethod>('bill_ratio')
    expect(resolveAttribution('unknown')).toBe<AttributionMethod>('bill_ratio')
  })

  it('账单占比线（A）：组织学/细胞/宫颈/冰冻/外院会诊', () => {
    const aLines: BusinessLine[] = ['histology', 'cytology', 'cervical_lbc', 'frozen', 'consultation']
    for (const l of aLines) {
      expect(resolveAttribution(l)).toBe('bill_ratio')
      expect(usesStepScope(resolveAttribution(l))).toBe(true)
    }
  })

  it('单项整笔（B）院内分子 / 外送转销（C）NGS·HPV-E6E7·FISH（暂定）', () => {
    expect(resolveAttribution('molecular_inhouse')).toBe<AttributionMethod>('standalone')
    expect(resolveAttribution('ngs_outsourced')).toBe<AttributionMethod>('resale')
    expect(resolveAttribution('hpv_e6e7')).toBe<AttributionMethod>('resale')
    expect(resolveAttribution('fish')).toBe<AttributionMethod>('resale')
  })

  it('只有方法 A 走步骤范围', () => {
    expect(usesStepScope('bill_ratio')).toBe(true)
    expect(usesStepScope('standalone')).toBe(false)
    expect(usesStepScope('resale')).toBe(false)
  })

  it('每条业务线都有归属方法（映射无遗漏）', () => {
    const lines = Object.keys(LINE_ATTRIBUTION) as BusinessLine[]
    for (const l of lines) expect(['bill_ratio', 'standalone', 'resale']).toContain(LINE_ATTRIBUTION[l])
  })
})
