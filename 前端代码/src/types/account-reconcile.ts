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
/** 补收单独立签发（SoD 人闸）复核态：pending_review=待他人签发 / approved=已签发·可收款。 */
export type ReviewStatus = 'pending_review' | 'approved'

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

/** LOC-005 权威四元组绑定：院 + 月 + statement 代 + 对账代。所有读/写调用必须携带。 */
export interface ReconcileBinding {
  partnerId: string
  settlementMonth: string
  statementGenerationId: string
  reconcileGenerationId: string
}

/** GET /board 的每院条目：HospitalMonth 展示字段 + 代次绑定（未计算的院 id/status 为 null）。 */
export interface BoardItem {
  id: string | null
  partnerId: string
  partnerName: string | null
  serviceMonth: string
  status: HmStatus | null
  matchRate: number | null
  matchStatus: MatchStatus | null
  statementReady: boolean
  lisReady: boolean
  diffCount: number
  pendingCount: number
  unmatchedCount: number
  confirmedLabRevenue: number | null
  hospitalMonthId: string | null
  statementGenerationId: string | null
  statementBatchStatus: string | null
  reconcileGenerationId: string | null
  /** 当前对账代自身绑定的 statement 代；与 statementGenerationId 不等 = 账单已更新、重算需铸新对账代。 */
  reconcileStatementGenerationId: string | null
  generationStatus: 'pending' | 'complete' | 'closed' | null
}

export interface BoardResp {
  settlementMonth: string
  items: BoardItem[]
  board: OverviewBoard
}

/** compute / workbench 返回的 snapshot（readAccountReconciliation 形状）。 */
export interface ReconcileSnapshot {
  partnerId: string
  settlementMonth: string
  statementGenerationId: string
  reconcileGenerationId: string
  hospitalMonthId: string
  status: 'pending' | 'complete' | 'closed'
  completedAt: string | null
  completedBy: string | null
  closedAt: string | null
  closedBy: string | null
  confirmedLabRevenue: number | null
  statementArtifactHash: string
  result: {
    matchRate: number
    matchStatus: MatchStatus
    diffs: unknown[]
    unmatched: UnmatchedCase[]
  }
  caseHints: Record<string, CaseHint[]>
}

export type ComputeResp = ReconcileSnapshot

export interface OverviewBoard {
  total: number
  待复核: number
  复核完成: number
  已关账: number
  补收实收: number
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

export interface CaseHint {
  hintType: '疑似返工' | '多病灶'
  markerName: string
  waxNo: string | null
  occurrences: number
}

export interface WorkbenchResp {
  snapshot: ReconcileSnapshot
  diffs: ReconcileDiff[]
  caseHints: Record<string, CaseHint[]>
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
  collectedRevenue: number | null
  giveUpReason: string | null
  operator: string | null
  /** 独立签发人闸（SoD）：认定即提交 pending_review，须他人 approve 后方可收款。 */
  reviewStatus: ReviewStatus
  submittedBy: string | null
  reviewedBy: string | null
  reviewedAt: string | null
}

export interface SupplementBoard {
  待补收金额: number
  已补收金额: number
  已放弃金额: number
  已补收实收: number
  待补收数: number
  待签发数: number
  补收率: number
}

export interface SupplementResp {
  list: SupplementOrder[]
  board: SupplementBoard
}
