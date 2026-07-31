// 按医院(客户)成本/盈利 —— 与后端 partner-pnl 路由返回结构一一对应。

import type { EvidenceState } from './hospital-cm'

/**
 * 拆分口径认账水印（止损执法点·LEG-2）——与后端 `caliber-ratification.ts` 的 CaliberRatification 对应。
 * 消费拆分结论（实验室收入 / 院级毛利）的对外输出随响应带；前端据 `ratified===false` 在与数字同视线处渲染水印。
 * ⚠️ 字段缺席时 **fail-closed**：按未认账显示水印（宁可多提示、不可漏提示）。
 */
export interface CaliberRatification {
  ratified: boolean
  state: 'UNRATIFIED' | 'RATIFIED'
  sourceTag: 'measured' | 'derived' | 'placeholder'
  basisVersion: string
  label: string
  note: string
  ratifiedAt: string | null
}

export interface PartnerPnl {
  partnerId: string
  partnerName?: string
  caseCount: number
  netRevenueTotal: number | null // 财务实收合计（LOC-015：证据不可信时为 null）
  labRevenueTotal: number | null // 实验室收入合计（LOC-015：证据不可信时为 null）
  diagnosisRevenueTotal: number | null // 诊断与报告合计（LOC-015：证据不可信时为 null）
  costTotal: number | null // ABC 成本合计（LOC-015：证据不可信时为 null）
  grossMargin: number | null // 毛利（LOC-015：证据不可信时为 null）
  marginRate: number | null // 毛利率（LOC-015：证据不可信时为 null）
  avgLabRevenuePerCase: number | null
  avgCostPerCase: number | null
  avgMarginPerCase: number | null
  qualityCounts: { ok: number; partial_quantities: number; no_quantities: number }
  sourceCounts: { statement: number; estimated: number; corrected: number } // 已对账/估算/已修正 case 数（P5）
  costMatched: boolean // 是否有已归集 ABC 成本
  costMonthAxis: 'service_month' | 'all' // 单月口径：'service_month'=成本已按服务月对齐（跨月耗材归入服务当月，与收入同月）；'all'=全量未分月
  benchmarkCorrected: boolean // 恒 false：benchmark 未做病种校正
  // NGS 外购转销（独立渠道）
  ngsRevenue: number | null
  ngsCost: number | null
  ngsMargin: number | null
  ngsOrderCount: number | null
  totalMargin: number | null // 院级总毛利（LOC-015：证据不可信时为 null）
  evidence?: EvidenceState // LOC-015：'unavailable' -> 不得显示 0/成功金额
}

export type RevenueQuality = 'ok' | 'partial_quantities' | 'no_quantities'
export type RevenueSource = 'statement' | 'estimated' | 'corrected'

export interface CasePnl {
  caseNo: string
  partnerId: string
  partnerName?: string
  serviceScope: 'technical_only' | 'with_diagnosis'
  serviceMonth?: string
  netRevenue: number | null
  techRatio: number
  diagnosisRatio: number
  inScopeRatio: number
  labRevenue: number | null
  quality: RevenueQuality
  revenueSource: RevenueSource // 已对账(statement)/估算(estimated)/已修正(corrected)
  outRevenue?: number | null
  note?: string
  costTotal: number | null
  grossMargin: number | null
  marginRate: number | null
  flagged: boolean // 负毛利
  evidence?: EvidenceState
}

export interface PnlTrendPoint {
  serviceMonth: string
  netRevenueTotal: number | null
  labRevenueTotal: number | null
  costTotal: number | null
  grossMargin: number | null
  caseCount: number | null
  evidence?: EvidenceState
}
