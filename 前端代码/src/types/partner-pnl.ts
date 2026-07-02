// 按医院(客户)成本/盈利 —— 与后端 partner-pnl 路由返回结构一一对应。

export interface PartnerPnl {
  partnerId: string
  partnerName?: string
  caseCount: number
  netRevenueTotal: number // 财务实收合计
  labRevenueTotal: number // 实验室收入合计
  diagnosisRevenueTotal: number // 诊断与报告合计（我们的钱但非实验室工序；只展示，不进毛利）
  costTotal: number // ABC 成本合计（按医院上卷）
  grossMargin: number // 毛利 = 实验室收入 − 成本
  marginRate: number // 毛利率
  avgLabRevenuePerCase: number
  avgCostPerCase: number
  avgMarginPerCase: number
  qualityCounts: { ok: number; partial_quantities: number; no_quantities: number }
  sourceCounts: { statement: number; estimated: number; corrected: number } // 已对账/估算/已修正 case 数（P5）
  costMatched: boolean // 是否有已归集 ABC 成本
  costMonthAxis: 'service_month' | 'all' // 单月口径：'service_month'=成本已按服务月对齐（跨月耗材归入服务当月，与收入同月）；'all'=全量未分月
  benchmarkCorrected: boolean // 恒 false：benchmark 未做病种校正
  // NGS 外购转销（独立渠道）
  ngsRevenue: number
  ngsCost: number
  ngsMargin: number
  ngsOrderCount: number
  totalMargin: number // 院级总毛利 = 院内技术毛利 + NGS 毛利
}

export type RevenueQuality = 'ok' | 'partial_quantities' | 'no_quantities'
export type RevenueSource = 'statement' | 'estimated' | 'corrected'

export interface CasePnl {
  caseNo: string
  partnerId: string
  partnerName?: string
  serviceScope: 'technical_only' | 'with_diagnosis'
  serviceMonth?: string
  netRevenue: number
  techRatio: number
  diagnosisRatio: number
  inScopeRatio: number
  labRevenue: number
  quality: RevenueQuality
  revenueSource: RevenueSource // 已对账(statement)/估算(estimated)/已修正(corrected)
  outRevenue?: number
  note?: string
  costTotal: number
  grossMargin: number
  marginRate: number
  flagged: boolean // 负毛利
}

export interface PnlTrendPoint {
  serviceMonth: string
  netRevenueTotal: number
  labRevenueTotal: number
  costTotal: number
  grossMargin: number
  caseCount: number
}
