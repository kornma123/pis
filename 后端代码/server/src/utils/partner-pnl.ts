/**
 * 院级收入/盈利（W5，收入侧）—— 纯函数，从原始层(case_revenue 实收 + lis_cases 数量 + partner service_scope)
 * 全量重算每 case 实验室收入 + 院级汇总。**不碰成本引擎 cost-calculator**（红线，收入独立算）。
 *
 * 实验室收入 = 财务实收 × 在范围组分占比：
 *  - technical_only：仅技术占比（诊断由医院自己病理医师做，不归实验室）。
 *  - with_diagnosis：技术+诊断占比（本中心既做技术又出报告 → 通常≈全额，因 LIS 数量列不驱动取材组分）。
 *
 * 完整度诚实标注（增量纠错架构）：无数量→不可拆(暂全额待校正)；HE切片=0→诊断组分缺、分解未校正。
 */

import { computeCaseSplit } from './charge-engine.js'
import { mapCaseToCharges, type LisCaseQty } from './case-charge-mapping.js'
import type { ServiceScope } from './partner-upsert.js'
import type { ChargeCodeDef } from './charge-engine.js'

export type RevenueQuality = 'ok' | 'partial_quantities' | 'no_quantities'

export interface CasePnlInput {
  caseNo: string
  partnerId: string
  partnerName?: string
  serviceScope: ServiceScope
  netRevenue: number // 实收（开单金额）
  serviceMonth?: string
  qty?: LisCaseQty | null // LIS 数量；缺失=有实收无 LIS
}

export interface CasePnl {
  caseNo: string
  partnerId: string
  partnerName?: string
  serviceScope: ServiceScope
  serviceMonth?: string
  netRevenue: number
  techRatio: number
  diagnosisRatio: number
  inScopeRatio: number
  labRevenue: number // 拆给实验室的收入
  quality: RevenueQuality
  note?: string
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000
const qtySum = (q?: LisCaseQty | null) =>
  q ? q.heSlideCount + q.blockCount + q.ihcCount + q.specialStainCount + q.eberCount + q.pdl1Count : 0

/** 单 case 实验室收入拆分（含完整度标注）。 */
export function computeCasePnl(input: CasePnlInput, catalog: Map<string, ChargeCodeDef>): CasePnl {
  const base = {
    caseNo: input.caseNo, partnerId: input.partnerId, partnerName: input.partnerName,
    serviceScope: input.serviceScope, serviceMonth: input.serviceMonth, netRevenue: r2(input.netRevenue),
  }
  const split = qtySum(input.qty) > 0 ? computeCaseSplit(mapCaseToCharges(input.qty!), catalog) : null

  if (!split || split.total === 0) {
    // 无可计费数量 → 不可拆，暂按全额（诚实标注待校正）
    return { ...base, techRatio: 0, diagnosisRatio: 0, inScopeRatio: 1, labRevenue: r2(input.netRevenue), quality: 'no_quantities', note: '无可计费 LIS 数量，技术占比不可算，暂按全额待数据补全/校正' }
  }

  const techRatio = split.techRatio
  const diagRatio = split.diagnosisRatio
  const inScopeRatio = input.serviceScope === 'with_diagnosis' ? techRatio + diagRatio : techRatio
  const heZero = (input.qty!.heSlideCount ?? 0) === 0
  return {
    ...base,
    techRatio: r4(techRatio), diagnosisRatio: r4(diagRatio), inScopeRatio: r4(inScopeRatio),
    labRevenue: r2(input.netRevenue * inScopeRatio),
    quality: heZero ? 'partial_quantities' : 'ok',
    note: heZero ? '诊断切片数(HE)=0，技术/诊断分解未校正（院级收入总额仍可靠）' : undefined,
  }
}

export interface PartnerRevenueRollup {
  partnerId: string
  partnerName?: string
  caseCount: number
  netTotal: number // 财务实收合计
  labRevenueTotal: number // 实验室收入合计
  qualityCounts: Record<RevenueQuality, number>
}

/** 院级汇总（按 partnerId 上卷）。 */
export function rollupPartnerRevenue(cases: CasePnl[]): PartnerRevenueRollup[] {
  const byPartner = new Map<string, PartnerRevenueRollup>()
  for (const c of cases) {
    let p = byPartner.get(c.partnerId)
    if (!p) {
      p = { partnerId: c.partnerId, partnerName: c.partnerName, caseCount: 0, netTotal: 0, labRevenueTotal: 0, qualityCounts: { ok: 0, partial_quantities: 0, no_quantities: 0 } }
      byPartner.set(c.partnerId, p)
    }
    p.caseCount++
    p.netTotal = r2(p.netTotal + c.netRevenue)
    p.labRevenueTotal = r2(p.labRevenueTotal + c.labRevenue)
    p.qualityCounts[c.quality]++
  }
  return [...byPartner.values()]
}
