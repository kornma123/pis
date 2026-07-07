/**
 * P0 院级贡献毛利引擎 · 手核 golden（纯口径·无 DB）。
 *
 * 被测 = `hospital-cm.ts`（新独立 lane）。断言全部为**手核值**（见每块注释的逐步算式）。
 * 必测两类 case（P0 spec §10.C 验收前置·缺一则同源漏洞静默上线）：
 *   ① 代送加做（lab_revenue>0 + 有 marker·partner tissue=false）→ 减染色、**不减前处理**；
 *   ② 代阅片（lab_revenue=0 + 有 marker）→ **有 marker 也不减任何成本**（Q4/ADR-002 回归守卫）。
 * CI 硬断言：labor/equipment 永不进（§3 白名单）——结构上 P0CaseCm 无此字段，且 avoidable == 桶A+桶B。
 */
import { describe, it, expect } from 'vitest'
import {
  computeCaseCm,
  makeWithheldCase,
  rollupHospitalCm,
  type P0CaseInput,
  type PriceResolver,
  type CaseCmParams,
  CM_TARGET,
  CM_THRESHOLDS,
} from '../src/utils/hospital-cm.js'

// 台账约定价（注入·保持纯函数可测）：CK7=¥5、Ki-67=¥8、PD-1=缺价
const PRICES: Record<string, number | null> = { CK7: 5, 'Ki-67': 8, 'PD-1': null }
const resolvePrice: PriceResolver = (name) => ({ perTestPrice: PRICES[name] ?? null })
// 特染 Masson：kit_price ¥318 ÷ nominal_tests 50 = ¥6.36/片（labor-free）
const PARAMS: CaseCmParams = { secondaryPerSlide: 15, stainPerSlide: 6.36, tissueMaterialPerBlock: 7 }

const AB = (name: string) => ({ markerName: name, adviceType: 'Y000001' })
const WHITE = { markerName: '白片', adviceType: 'Y000007' } // 非真抗体码 → 不计价

// —— 四类 case fixture ——
const C1: P0CaseInput = {
  // 全流程院（ACC-A）：2 蜡块·CK7/Ki-67/CK7 三片·1 片 Masson 特染·tissue=true
  caseNo: 'A-001', partnerId: 'ACC-A', serviceMonth: '2026-03', labRevenue: 200, revenueSource: 'statement',
  markers: [AB('CK7'), AB('Ki-67'), AB('CK7')], specialStainCount: 1, blockCount: 2, ihcCount: 3, tissueProcessing: true,
}
const C2: P0CaseInput = {
  // 代送加做院（ACC-B·tissue=false）：CK7/PD-1 两片（PD-1 缺价）·无特染
  caseNo: 'B-001', partnerId: 'ACC-B', serviceMonth: '2026-03', labRevenue: 120, revenueSource: 'statement',
  markers: [AB('CK7'), AB('PD-1')], specialStainCount: 0, blockCount: 1, ihcCount: 2, tissueProcessing: false,
}
const C3: P0CaseInput = {
  // 代阅片（ACC-B·lab_revenue=0·有 marker）：Q4 守卫——有 marker 也不减
  caseNo: 'B-002', partnerId: 'ACC-B', serviceMonth: '2026-03', labRevenue: 0, revenueSource: 'statement',
  markers: [AB('CK7')], specialStainCount: 0, blockCount: 1, ihcCount: 1, tissueProcessing: false,
}
const C4: P0CaseInput = {
  // 非IHC线（ACC-A·lab_revenue>0·无真抗体 marker，只白片）：出率外·成本未建模
  caseNo: 'A-002', partnerId: 'ACC-A', serviceMonth: '2026-03', labRevenue: 50, revenueSource: 'statement',
  markers: [WHITE], specialStainCount: 0, blockCount: 1, ihcCount: 0, tissueProcessing: true,
}

describe('P0 贡献毛利引擎 · 单 case（手核）', () => {
  it('C1 全流程（含前处理）：桶A=45 桶B=38.36 CM=116.64', () => {
    const r = computeCaseCm(C1, resolvePrice, PARAMS)
    // 桶A = 3片 × ¥15 = 45；桶B = 一抗(5+8+5=18) + 特染(1×6.36) + 组织处理(2块×7=14) = 38.36
    expect(r.bucket).toBe('staining')
    expect(r.caliber).toBe('完整')
    expect(r.billableSlides).toBe(3)
    expect(r.bucketA).toBe(45)
    expect(r.bucketB).toBe(38.36)
    expect(r.avoidableCost).toBe(83.36)
    expect(r.cm).toBe(116.64) // 200 − 83.36
    expect(r.missingPriceSlides).toBe(0)
    expect(r.starRatio).toBe(0.4602) // 38.36 / 83.36
    expect(r.needsTissueScope).toBe(false)
  })

  it('C2 代送加做（tissue=false）：减染色不减前处理 + 缺价 PD-1 不进桶B', () => {
    const r = computeCaseCm(C2, resolvePrice, PARAMS)
    // 桶A = 2片 × ¥15 = 30；桶B = 一抗仅 CK7(5)（PD-1 缺价跳过）+ 特染0 + 组织处理0(tissue=false) = 5
    expect(r.bucket).toBe('staining')
    expect(r.caliber).toBe('仅染色') // 代送加做不含前处理
    expect(r.bucketA).toBe(30)
    expect(r.bucketB).toBe(5)
    expect(r.avoidableCost).toBe(35)
    expect(r.cm).toBe(85) // 120 − 35
    expect(r.missingPriceSlides).toBe(1) // PD-1 缺价
    expect(r.needsTissueScope).toBe(true)
  })

  it('C3 代阅片（lab_revenue=0·有 marker）：Q4 守卫——不减任何成本、归诊断桶', () => {
    const r = computeCaseCm(C3, resolvePrice, PARAMS)
    expect(r.bucket).toBe('diagnosis')
    expect(r.avoidableCost).toBe(0)
    expect(r.bucketA).toBe(0)
    expect(r.bucketB).toBe(0)
    expect(r.cm).toBe(0)
  })

  it('C4 非IHC线（lab_revenue>0·无真抗体 marker）：出率外·成本未建模', () => {
    const r = computeCaseCm(C4, resolvePrice, PARAMS)
    expect(r.bucket).toBe('non_ihc')
    expect(r.avoidableCost).toBe(0)
    expect(r.cm).toBe(0)
    expect(r.billableSlides).toBe(0) // 白片不计价
  })
})

describe('CI 硬断言 · labor/equipment 永不进（§3 白名单·ADR-004）', () => {
  it('P0CaseCm 结构上无 labor/equipment 字段', () => {
    const r = computeCaseCm(C1, resolvePrice, PARAMS)
    expect(Object.keys(r)).not.toContain('labor')
    expect(Object.keys(r)).not.toContain('equipment')
    expect(Object.keys(r)).not.toContain('laborPerSlide')
    expect(Object.keys(r)).not.toContain('equipmentPerSlide')
  })
  it('可避免成本恒 == 桶A+桶B（无第三成本项混入）', () => {
    for (const c of [C1, C2]) {
      const r = computeCaseCm(c, resolvePrice, PARAMS)
      expect(r.avoidableCost).toBe(Math.round((r.bucketA + r.bucketB + Number.EPSILON) * 100) / 100)
    }
  })
})

describe('院级上卷（手核）', () => {
  it('ACC-A：CM=116.64 率=0.5832 每片=38.88 非IHC实收=50 率覆盖=0.80', () => {
    const cases = [C1, C4].map((c) => computeCaseCm(c, resolvePrice, PARAMS))
    const h = rollupHospitalCm(cases, { partnerName: '和睦家系', serviceMonth: '2026-03', settled: true })
    expect(h.hospitalCm).toBe(116.64)
    expect(h.labRevenueInRate).toBe(200)
    expect(h.cmRate).toBe(0.5832) // 116.64/200
    expect(h.cmPerSlide).toBe(38.88) // 116.64/3
    expect(h.revenueCaseCount).toBe(1)
    expect(h.nonIhcRevenue).toBe(50)
    expect(h.nonIhcCaseCount).toBe(1)
    expect(h.quality.lineCoverage).toBe(0.8) // 200/(200+50)
    expect(h.caliber).toBe('完整')
    expect(h.state).toBe('经营线未定·仅供观察') // CM_TARGET=null → G-1
    expect(h.businessLineDefined).toBe(false)
  })

  it('ACC-B：CM=85 率=0.7083 诊断桶=1 缺价率=0.5→needsData', () => {
    const cases = [C2, C3].map((c) => computeCaseCm(c, resolvePrice, PARAMS))
    const h = rollupHospitalCm(cases, { partnerName: '东安县医院', serviceMonth: '2026-03', settled: true })
    expect(h.hospitalCm).toBe(85)
    expect(h.labRevenueInRate).toBe(120)
    expect(h.cmRate).toBe(0.7083) // 85/120
    expect(h.revenueCaseCount).toBe(1)
    expect(h.diagnosisCaseCount).toBe(1) // C3 代阅片
    expect(h.quality.missingPriceRate).toBe(0.5) // 1 缺价 / 2 真抗体行
    expect(h.quality.needsData).toBe(true)
    expect(h.confidence).toBe('low') // 缺价率高
  })
})

describe('独立复核修复（对抗面板 wf_9e39b91b confirmed）', () => {
  it('§10.D coverage 读 ihc_count（非恒真近似）：特染-only 有物理 IHC 片但零 marker → 覆盖缺口', () => {
    // 有 special_stain 信号（进 staining）、零真抗体 marker、ihc_count=8（做了 8 片 IHC 却无 marker 明细）
    const stainOnly: P0CaseInput = {
      caseNo: 'X-1', partnerId: 'ACC-X', serviceMonth: '2026-03', labRevenue: 500, revenueSource: 'statement',
      markers: [], specialStainCount: 1, blockCount: 1, ihcCount: 8, tissueProcessing: false,
    }
    const r = computeCaseCm(stainOnly, resolvePrice, PARAMS)
    expect(r.bucket).toBe('staining') // 有 special_stain 信号
    expect(r.ihcCount).toBe(8)
    const h = rollupHospitalCm([r], { settled: true })
    expect(h.quality.coverage).toBe(0) // 未覆盖（ihc_count>0 但零 marker）——不再恒 1.0
    expect(h.quality.coverage).toBeLessThan(CM_THRESHOLDS.MIN_COVERAGE)
    expect(h.quality.needsData).toBe(true) // 覆盖率闸真触发
  })

  it('§10.E 跨月复用 → makeWithheldCase 禁输出（不进任何成本上卷·标 cross_month_reuse）', () => {
    const withheld = makeWithheldCase(C2)
    expect(withheld.bucket).toBe('cross_month_reuse')
    expect(withheld.cm).toBe(0)
    expect(withheld.avoidableCost).toBe(0)
    // 与一个正常 staining case 一起上卷：跨月复用不双计进 hospitalCm
    const h = rollupHospitalCm([computeCaseCm(C1, resolvePrice, PARAMS), withheld], { settled: true })
    expect(h.hospitalCm).toBe(116.64) // 仅 C1·withheld 不进
    expect(h.crossMonthReuseCaseCount).toBe(1)
    expect(h.revenueCaseCount).toBe(1)
  })

  it('§10.B M4 特染占位价披露：placeholder → stainPlaceholderShare 计入 + 超阈触发 needsData', () => {
    const placeholderCase: P0CaseInput = {
      caseNo: 'P-1', partnerId: 'ACC-P', serviceMonth: '2026-03', labRevenue: 200, revenueSource: 'statement',
      markers: [AB('CK7')], specialStainCount: 2, blockCount: 1, ihcCount: 1, tissueProcessing: false,
    }
    const r = computeCaseCm(placeholderCase, resolvePrice, { ...PARAMS, stainIsPlaceholder: true })
    expect(r.specialStainSlides).toBe(2)
    expect(r.placeholderStainSlides).toBe(2)
    const h = rollupHospitalCm([r], { settled: true })
    expect(h.quality.stainPlaceholderShare).toBe(1) // 2/2 全占位
    expect(h.quality.needsData).toBe(true) // > MAX_STAIN_PLACEHOLDER_RATE 0.5
  })
})

describe('G-1 经营线未定（CM_TARGET 未拍板·§5 降级规矩）', () => {
  it('CM_TARGET 恒 null → 状态恒经营线未定·仅供观察（数字照出·不驱动强判定）', () => {
    expect(CM_TARGET).toBeNull()
    const cases = [C1, C2].map((c) => computeCaseCm(c, resolvePrice, PARAMS))
    const h = rollupHospitalCm(cases, { settled: true })
    expect(h.state).toBe('经营线未定·仅供观察')
    // 数字照出（不因经营线未定而藏数）
    expect(h.hospitalCm).toBeGreaterThan(0)
    expect(h.cmRate).toBeGreaterThan(0)
  })
})
