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
/** 收入来源三态（看板诚实标注）：已对账(对账单 Σ(IN结算)，权威) / 估算(无账单，实收×占比) / 已修正(人工覆盖留痕)。 */
export type RevenueSource = 'statement' | 'estimated' | 'corrected'

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
  revenueSource: RevenueSource // 已对账(statement)/估算(estimated)/已修正(corrected)
  outRevenue?: number // 移出额（statement 路径才有）
  diagnosisRevenue?: number // 诊断桶（报告/现场/split 诊断份额）——我们的钱但非实验室工序（statement 路径才有）
  note?: string
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000

/** 单 case 实验室收入拆分（含完整度标注）。 */
export function computeCasePnl(input: CasePnlInput, catalog: Map<string, ChargeCodeDef>): CasePnl {
  const base = {
    caseNo: input.caseNo, partnerId: input.partnerId, partnerName: input.partnerName,
    serviceScope: input.serviceScope, serviceMonth: input.serviceMonth, netRevenue: r2(input.netRevenue),
    revenueSource: 'estimated' as RevenueSource, // 本函数=无账单估算路径；已对账走 statementCasePnl
  }
  // 据所有数量列(含冷冻/多重染色)映射出收费项；只要有任一收费项即可拆，否则(全 0 或无 LIS)诚实回退。
  // 改为以「是否产出收费项」为闸（原 6 基础列求和 >0），修复"有冷冻/多重但 6 基础列为 0 时被静默判全额"的口子。
  // 注：分子病理 NGS 是外购转销、独立渠道(ngs-pnl.ts)，不进此院内技术占比，故此处不含 molecular。
  const items = input.qty ? mapCaseToCharges(input.qty) : []
  const split = items.length > 0 ? computeCaseSplit(items, catalog) : null

  if (!split || split.total === 0) {
    // 无可计费数量 → 不可拆，暂按全额（诚实标注待校正）
    return { ...base, techRatio: 0, diagnosisRatio: 0, inScopeRatio: 1, labRevenue: r2(input.netRevenue), quality: 'no_quantities', note: '无可计费 LIS 数量，技术占比不可算，暂按全额待数据补全/校正' }
  }

  const techRatio = split.techRatio
  const diagRatio = split.diagnosisRatio
  const inScopeRatio = input.serviceScope === 'with_diagnosis' ? techRatio + diagRatio : techRatio
  // 完整度诚实标注：任一不确定因素 → partial_quantities（绝不静默）
  const heZero = (input.qty!.heSlideCount ?? 0) === 0
  const cytology = input.qty!.specimenType === 'cytology'
  const hasUnmatched = split.unmatchedCount > 0
  const notes: string[] = []
  if (heZero) notes.push('诊断切片数(HE)=0，技术/诊断分解未校正（院级收入总额仍可靠）')
  if (cytology) notes.push('细胞学处理费按玻片≈蜡块近似，待真实玻片数校正')
  if (hasUnmatched) notes.push(`${split.unmatchedCount} 个收费项未命中目录，占比被低估（检查目录是否完整）`)
  return {
    ...base,
    techRatio: r4(techRatio), diagnosisRatio: r4(diagRatio), inScopeRatio: r4(inScopeRatio),
    labRevenue: r2(input.netRevenue * inScopeRatio),
    quality: heZero || cytology || hasUnmatched ? 'partial_quantities' : 'ok',
    note: notes.length ? notes.join('；') : undefined,
  }
}

/**
 * 已对账（statement 权威）/已修正 路径的 case P&L：实验室收入 = 对账单 Σ(IN 结算)，**不走估算占比**。
 * netRevenue=该 case 全部结算(实收)；labRevenue=IN 部分；outRevenue=移出部分；inScopeRatio=lab/net（仅展示）。
 */
export function statementCasePnl(
  input: Omit<CasePnlInput, 'qty'> & { labRevenue: number; outRevenue?: number; diagnosisRevenue?: number },
  source: Extract<RevenueSource, 'statement' | 'corrected'> = 'statement',
): CasePnl {
  const net = r2(input.netRevenue)
  const lab = r2(input.labRevenue)
  return {
    caseNo: input.caseNo, partnerId: input.partnerId, partnerName: input.partnerName,
    serviceScope: input.serviceScope, serviceMonth: input.serviceMonth, netRevenue: net,
    techRatio: 0, diagnosisRatio: 0, inScopeRatio: net > 0 ? r4(lab / net) : 0,
    labRevenue: lab, outRevenue: r2(input.outRevenue ?? 0), diagnosisRevenue: r2(input.diagnosisRevenue ?? 0),
    quality: 'ok', revenueSource: source,
  }
}

export interface PartnerRevenueRollup {
  partnerId: string
  partnerName?: string
  caseCount: number
  netTotal: number // 财务实收合计
  labRevenueTotal: number // 实验室收入合计
  diagnosisRevenueTotal: number // 诊断桶合计（我们的钱但非实验室工序；net−lab 的其中一块，别静默藏在缺口里）
  qualityCounts: Record<RevenueQuality, number>
  sourceCounts: Record<RevenueSource, number> // 已对账/估算/已修正 case 数（看板诚实标注）
}

/** 院级汇总（按 partnerId 上卷）。 */
export function rollupPartnerRevenue(cases: CasePnl[]): PartnerRevenueRollup[] {
  const byPartner = new Map<string, PartnerRevenueRollup>()
  for (const c of cases) {
    let p = byPartner.get(c.partnerId)
    if (!p) {
      p = { partnerId: c.partnerId, partnerName: c.partnerName, caseCount: 0, netTotal: 0, labRevenueTotal: 0, diagnosisRevenueTotal: 0, qualityCounts: { ok: 0, partial_quantities: 0, no_quantities: 0 }, sourceCounts: { statement: 0, estimated: 0, corrected: 0 } }
      byPartner.set(c.partnerId, p)
    }
    p.caseCount++
    p.netTotal = r2(p.netTotal + c.netRevenue)
    p.labRevenueTotal = r2(p.labRevenueTotal + c.labRevenue)
    p.diagnosisRevenueTotal = r2(p.diagnosisRevenueTotal + (c.diagnosisRevenue ?? 0))
    p.qualityCounts[c.quality]++
    p.sourceCounts[c.revenueSource]++
  }
  return [...byPartner.values()]
}
