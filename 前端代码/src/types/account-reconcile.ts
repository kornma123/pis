// 账实核对（Phase 2 前端）类型 —— 对齐后端 account-reconcile-v1.1.ts 响应。

export type HmStatus = '待复核' | '复核完成' | '已关账'
export type MatchStatus = '正常' | '匹配偏低' | '先查' | '待对齐'
export type LineType = '免疫组化' | '特染'
export type VerdictReason =
  | '漏收，需补收'
  | '返工重做（不计费）'
  | '超期，免费做的'
  | '计费项目用错'
  | 'LIS 记录不全'
  | '核对无误'
export type FollowUp = 'supplement' | 'rework' | 'free' | 'external_fix' | 'data_fill' | 'settled'
export type SupplementStatus = '待补收' | '已补收' | '已放弃'

/** 6 认定原因唯一术语串（做页当 lint，勿改字面）。 */
export const VERDICT_REASONS: VerdictReason[] = [
  '漏收，需补收',
  '返工重做（不计费）',
  '超期，免费做的',
  '计费项目用错',
  'LIS 记录不全',
  '核对无误',
]

export interface HospitalMonth {
  id: string
  partnerId: string
  partnerName: string | null
  serviceMonth: string
  status: HmStatus
  matchRate: number
  matchStatus: MatchStatus | null
  statementReady: boolean
  lisReady: boolean
  diffCount: number
  pendingCount: number
  unmatchedCount: number
  confirmedLabRevenue: number | null
}

export interface OverviewBoard {
  total: number
  待复核: number
  复核完成: number
  已关账: number
  确认实收: number
}

export interface OverviewResp {
  list: HospitalMonth[]
  board: OverviewBoard
}

export interface ReconcileDiff {
  id: string
  caseNo: string
  lineType: LineType
  billCount: number
  lisCount: number
  delta: number
  amountImpact: number
  systemHint: string | null
  lowConfidence: boolean
  verdict: VerdictReason | null
  verdictReason: string | null
  verdictBy: string | null
  followUp: FollowUp | null
}

export interface UnmatchedCase {
  caseNo: string
  side: 'bill_only' | 'lis_only'
  note: string
}

export interface WorkbenchResp {
  hospitalMonth: HospitalMonth
  diffs: ReconcileDiff[]
  unmatched: UnmatchedCase[]
}

export interface ComputeResp {
  hospitalMonthId: string
  matchRate: number
  matchStatus: MatchStatus
  diffCount: number
  pendingCount: number
  unmatchedCount: number
  statementReady: boolean
  lisReady: boolean
}

export interface SupplementOrder {
  id: string
  partnerId: string
  serviceMonth: string
  sourceDiffId: string | null
  caseNo: string | null
  amount: number
  caseCount: number
  status: SupplementStatus
  collectedAt: string | null
  collectedMonth: string | null
  giveUpReason: string | null
  operator: string | null
}

export interface SupplementBoard {
  待补收金额: number
  已补收金额: number
  已放弃金额: number
  待补收数: number
  补收率: number
}

export interface SupplementResp {
  list: SupplementOrder[]
  board: SupplementBoard
}
