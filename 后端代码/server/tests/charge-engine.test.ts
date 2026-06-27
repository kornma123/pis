/**
 * 收费引擎单测 —— 用真实目录(上海·申康病理新增81项)的价格逐条验证规则求值 + case 拆分。
 */
import { describe, it, expect } from 'vitest'
import {
  computeCharge, computeCaseSplit, classifyByName, buildCatalog,
  type ChargeCodeDef,
} from '../src/utils/charge-engine.js'

// 真实目录的 archetype 子集（价格取自 20260605 病理类项目收费代码-YZ.xlsx）
const DEFS: ChargeCodeDef[] = [
  { code: 'DIAG', name: '病理诊断费', unit: '次', category: '诊断',
    rule: { kind: 'tiered_increment', baseQty: 10, basePrice: 105, stepQty: 10, stepPrice: 42, capAddon: 84 } },
  { code: 'PROC_STD', name: '病理标本处理费(组织病理-常规)', unit: '每蜡块', category: '技术',
    rule: { kind: 'tiered_increment', baseQty: 3, basePrice: 36, stepQty: 1, stepPrice: 7, capAddon: 72 } },
  { code: 'PROC_CX', name: '病理标本处理费(组织病理-复杂)', unit: '每蜡块', category: '技术',
    rule: { kind: 'tiered_increment', baseQty: 5, basePrice: 72, stepQty: 1, stepPrice: 14, capAddon: 144 } },
  { code: 'CYTO', name: '病理标本处理费(细胞病理)', unit: '每玻片', category: '技术',
    rule: { kind: 'flat', unitPrice: 75 } },
  { code: 'COPY', name: '病理标本切片复制费', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 7 }, { from: 4, to: null, unitPrice: 12 }], capTotal: 165 } },
  { code: 'IHC', name: '病理样本免疫组织化学染色检查费(常规)', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 205 }, { from: 4, to: 12, unitPrice: 210 }, { from: 13, to: null, unitPrice: 105 }] } },
  { code: 'GROSS', name: '活检取材费(钳夹)', unit: '次', category: '取材',
    rule: { kind: 'flat', unitPrice: 113 } },
]
const CATALOG = buildCatalog(DEFS)
const r = (code: string) => DEFS.find((d) => d.code === code)!.rule

describe('收费引擎：flat', () => {
  it('细胞病理 ¥75/玻片 × 2 = 150', () => expect(computeCharge(r('CYTO'), 2)).toBe(150))
  it('qty=0 → 0', () => expect(computeCharge(r('CYTO'), 0)).toBe(0))
})

describe('收费引擎：tiered_increment（基础量+步进+封顶）', () => {
  it('诊断费 ≤10张 = 105', () => expect(computeCharge(r('DIAG'), 8)).toBe(105))
  it('诊断费 15张 = 105+42 = 147', () => expect(computeCharge(r('DIAG'), 15)).toBe(147))
  it('诊断费 25张 = 105+84(封顶) = 189', () => expect(computeCharge(r('DIAG'), 25)).toBe(189))
  it('诊断费 100张 = 封顶 189（不超）', () => expect(computeCharge(r('DIAG'), 100)).toBe(189))
  it('处理费常规 1蜡块 = 36；5蜡块 = 50；20蜡块 = 108(封顶)', () => {
    expect(computeCharge(r('PROC_STD'), 1)).toBe(36)
    expect(computeCharge(r('PROC_STD'), 5)).toBe(50)
    expect(computeCharge(r('PROC_STD'), 20)).toBe(108)
  })
  it('处理费复杂 5块=72；7块=72+28=100；封顶 72+144=216', () => {
    expect(computeCharge(r('PROC_CX'), 5)).toBe(72)
    expect(computeCharge(r('PROC_CX'), 7)).toBe(100)
    expect(computeCharge(r('PROC_CX'), 100)).toBe(216)
  })
})

describe('收费引擎：stepped（分段单价 + 总额封顶）', () => {
  it('IHC 4片 = 205×3 + 210×1 = 825', () => expect(computeCharge(r('IHC'), 4)).toBe(825))
  it('IHC 13片 = 205×3 + 210×9 + 105×1 = 2610', () => expect(computeCharge(r('IHC'), 13)).toBe(2610))
  it('切片复制 2片 = 14；5片 = 7×3+12×2 = 45；封顶 165', () => {
    expect(computeCharge(r('COPY'), 2)).toBe(14)
    expect(computeCharge(r('COPY'), 5)).toBe(45)
    expect(computeCharge(r('COPY'), 1000)).toBe(165)
  })
})

describe('收费引擎：computeCaseSplit（拆分技术/诊断/取材 → 占比）', () => {
  it('IHC case: 诊断(8张)¥105 + 处理费(1蜡块)¥36 + IHC(4片)¥825 → 技术861/诊断105/占比≈0.8913', () => {
    const split = computeCaseSplit(
      [{ code: 'DIAG', qty: 8 }, { code: 'PROC_STD', qty: 1 }, { code: 'IHC', qty: 4 }],
      CATALOG,
    )
    expect(split.byCategory.技术).toBe(861)
    expect(split.byCategory.诊断).toBe(105)
    expect(split.total).toBe(966)
    expect(split.techRatio).toBeCloseTo(0.8913, 4)
    expect(split.diagnosisRatio).toBeCloseTo(0.1087, 4)
  })

  it('实验室收入 = 技术占比 × 财务实收（实收¥900 × 861/966 = ¥802.17）', () => {
    const split = computeCaseSplit(
      [{ code: 'DIAG', qty: 8 }, { code: 'PROC_STD', qty: 1 }, { code: 'IHC', qty: 4 }],
      CATALOG,
    )
    expect(round2(900 * split.techRatio)).toBeCloseTo(802.17, 1)
  })

  it('含取材 case：取材归取材组（医师线），技术占比相应下降', () => {
    const split = computeCaseSplit(
      [{ code: 'GROSS', qty: 1 }, { code: 'PROC_STD', qty: 1 }, { code: 'DIAG', qty: 8 }],
      CATALOG,
    )
    expect(split.byCategory.取材).toBe(113)
    expect(split.byCategory.技术).toBe(36)
    expect(split.byCategory.诊断).toBe(105)
    expect(split.total).toBe(254)
  })

  it('未命中收费码 → matched=false，不计金额（不污染占比）', () => {
    const split = computeCaseSplit([{ code: 'UNKNOWN', qty: 5 }, { code: 'IHC', qty: 4 }], CATALOG)
    expect(split.resolved.find((x) => x.code === 'UNKNOWN')!.matched).toBe(false)
    expect(split.byCategory.技术).toBe(825)
  })
})

describe('收费引擎：classifyByName', () => {
  it('诊断费→诊断 / 取材费→取材 / 其余→技术', () => {
    expect(classifyByName('病理诊断费(10张以内)')).toBe('诊断')
    expect(classifyByName('活检取材费(钳夹)')).toBe('取材')
    expect(classifyByName('病理样本免疫组织化学染色检查费(常规)')).toBe('技术')
  })
})

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100 }
