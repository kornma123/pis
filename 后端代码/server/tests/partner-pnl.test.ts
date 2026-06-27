/**
 * partner-pnl（W5 收入侧）单测 —— 用真实和睦家 case 验证实验室收入拆分 + 完整度标注 + 院级汇总。
 * 红线：纯函数，不碰成本引擎。
 */
import { describe, it, expect } from 'vitest'
import { computeCasePnl, rollupPartnerRevenue, type CasePnlInput } from '../src/utils/partner-pnl.js'
import { buildSeedCatalog } from '../src/utils/charge-catalog.js'
import type { LisCaseQty } from '../src/utils/case-charge-mapping.js'

const CAT = buildSeedCatalog()
const qty = (o: Partial<LisCaseQty>): LisCaseQty => ({ heSlideCount: 0, blockCount: 0, ihcCount: 0, specialStainCount: 0, eberCount: 0, pdl1Count: 0, ...o })

describe('computeCasePnl：实验室收入 = 实收 × 在范围组分占比', () => {
  // S26-02725: 实收2100；LIS HE5/蜡块5/IHC2 → 诊断¥105 + 处理¥50 + IHC¥410 = 技术460/诊断105/总565
  const s2725: CasePnlInput = { caseNo: 'S26-02725', partnerId: 'P1', serviceScope: 'with_diagnosis', netRevenue: 2100, qty: qty({ heSlideCount: 5, blockCount: 5, ihcCount: 2 }) }

  it('with_diagnosis：取 技术+诊断 = 全额（本中心既做技术又出报告）→ labRevenue 2100', () => {
    const r = computeCasePnl(s2725, CAT)
    expect(r.techRatio).toBe(0.8142)
    expect(r.diagnosisRatio).toBe(0.1858)
    expect(r.inScopeRatio).toBe(1)
    expect(r.labRevenue).toBe(2100)
    expect(r.quality).toBe('ok')
  })

  it('technical_only 同 case：只取技术占比 → labRevenue 2100×460/565 ≈ 1709.73', () => {
    const r = computeCasePnl({ ...s2725, serviceScope: 'technical_only' }, CAT)
    expect(r.inScopeRatio).toBe(0.8142)
    expect(r.labRevenue).toBe(1709.73)
    expect(r.quality).toBe('ok')
  })

  it('HE切片=0（常规活检）→ partial_quantities：with_diagnosis 仍全额，但标注分解未校正', () => {
    const r = computeCasePnl({ caseNo: 'S26-02739', partnerId: 'P1', serviceScope: 'with_diagnosis', netRevenue: 152, qty: qty({ blockCount: 1 }) }, CAT)
    expect(r.quality).toBe('partial_quantities')
    expect(r.labRevenue).toBe(152) // 处理费技术占比 1.0
    expect(r.note).toMatch(/未校正/)
  })

  it('无任何数量（有实收无LIS）→ no_quantities：暂全额待校正', () => {
    const r = computeCasePnl({ caseNo: 'X', partnerId: 'P1', serviceScope: 'technical_only', netRevenue: 300, qty: null }, CAT)
    expect(r.quality).toBe('no_quantities')
    expect(r.labRevenue).toBe(300)
    expect(r.inScopeRatio).toBe(1)
  })
})

describe('rollupPartnerRevenue：院级上卷 + 完整度计数', () => {
  it('和睦家 3 case → 实收/实验室收入合计 + qualityCounts', () => {
    const cases = [
      computeCasePnl({ caseNo: 'S26-02725', partnerId: 'P1', partnerName: '上海和睦家医院', serviceScope: 'with_diagnosis', netRevenue: 2100, qty: qty({ heSlideCount: 5, blockCount: 5, ihcCount: 2 }) }, CAT),
      computeCasePnl({ caseNo: 'S26-02739', partnerId: 'P1', partnerName: '上海和睦家医院', serviceScope: 'with_diagnosis', netRevenue: 152, qty: qty({ blockCount: 1 }) }, CAT),
      computeCasePnl({ caseNo: 'S26-02646', partnerId: 'P1', partnerName: '上海和睦家医院', serviceScope: 'with_diagnosis', netRevenue: 282, qty: null }, CAT),
    ]
    const [p] = rollupPartnerRevenue(cases)
    expect(p.caseCount).toBe(3)
    expect(p.netTotal).toBe(2534) // 2100+152+282
    expect(p.labRevenueTotal).toBe(2534) // with_diagnosis 全额
    expect(p.qualityCounts).toEqual({ ok: 1, partial_quantities: 1, no_quantities: 1 })
  })
})
