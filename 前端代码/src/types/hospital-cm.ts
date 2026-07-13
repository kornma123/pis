/**
 * 院级贡献毛利（P0 内圈·标准成本口径）两层框架前端类型 —— 镜像后端 `hospital-pnl-v1.1.ts`。
 *
 * 消费的后端端点：
 *   GET /hospital-pnl/            → 第 2 层对照表（默认贡献降序·始终可读·影子）
 *   GET /hospital-pnl/health      → 第 1 层体检（趋势-only·校准态·始终可读·影子）
 *   GET /hospital-pnl/readiness   → 就绪谓词清单（校准视图渲染·始终可读）
 *   GET /hospital-pnl/full-health → 第 1 层**完整体检态**（覆盖倍数绝对判断·**就绪后才 200，否则 403**）
 */

/** 拆分口径认账水印（LEG-2·元素④）——镜像后端 caliber-ratification.ts。 */
export interface CaliberRatification {
  ratified: boolean
  state: 'UNRATIFIED' | 'RATIFIED'
  sourceTag: 'measured' | 'derived' | 'placeholder'
  basisVersion: string
  label: string
  note: string
  ratifiedAt: string | null
}

/** 就绪四条件键（穷举·闭合枚举）。 */
export type ReadinessConditionKey = 'foundation' | 'denominator' | 'history' | 'first_period'
export type ReadinessOwnerRole = 'tech' | 'business' | 'pm'

/** 就绪清单单条（元素⑦）。未满足且 due 空 → configError（红）；死线过期 → overdue（红·上豁免面板）。 */
export interface ReadinessCondition {
  key: ReadinessConditionKey
  label: string
  met: boolean
  owner: ReadinessOwnerRole
  due: string | null
  detail?: string
  configError?: boolean
  overdue?: boolean
}

export interface ReadinessFinding {
  type: 'missing_due' | 'overdue' | 'projected_ready_date_slipped'
  conditionKey: ReadinessConditionKey | null
  message: string
  from?: string | null
  to?: string | null
}

/** GET /readiness 的 data 层。 */
export interface Readiness {
  ready: boolean
  checklist: ReadinessCondition[]
  findings: ReadinessFinding[]
  asOf: string
  asOfSource: 'server'
  shadowNote?: string
  caliberRatification?: CaliberRatification
}

/** 逐月趋势点（同账户历史·元素③；caliber 供口径变更竖标·元素⑨）。 */
export interface TrendPoint {
  serviceMonth: string
  hospitalCm: number
  labRevenueInRate: number
  cmRate: number
  revenueCaseCount: number
  caliber: '完整' | '仅染色' | '混合'
}

/** 院级数据质量（元素⑩「观察中」判据）。 */
export interface HospitalCmQuality {
  coverage: number
  missingPriceRate: number
  starRatio: number
  lineCoverage: number
  needsTissueScopeRate: number
  stainPlaceholderShare: number
  needsData: boolean
}

/** 院级明细（对照表每行附带·口径/状态/诚实字段）。 */
export interface HospitalCmDetail {
  partnerId: string
  partnerName?: string | null
  hospitalCm: number
  labRevenueInRate: number
  cmRate: number
  revenueCaseCount: number
  diagnosisCaseCount: number
  nonIhcCaseCount: number
  crossMonthReuseCaseCount: number
  bucketA: number
  bucketB: number
  quality: HospitalCmQuality
  caliber: '完整' | '仅染色' | '混合'
  state: string
  confidence: 'high' | 'low'
  businessLineDefined: boolean
}

/** 第 2 层对照表行（GET / 的 enriched 元素）。 */
export interface ComparisonRow {
  partnerId: string
  partnerName?: string | null
  cm: number // 绝对贡献（默认排序键·降序）
  cmRate: number // 率（元素②·表里一列·非默认排序）
  fixedCoverageShare: number // 率旁并列：占全组固定成本覆盖份额（元素②）
  trend: number[] | null
  measurable: boolean // false = UNMEASURED（元素⑧·灰行）
  detail?: HospitalCmDetail | null
  trendPoints?: TrendPoint[] // 同账户历史（元素③/⑨）
}

/** GET /health 的 data 层（第 1 层体检·趋势-only 校准态）。 */
export interface PortfolioHealth {
  totalCm: number
  fixedPool: number
  coverageMultiple: number
  coverageMultipleTrendOnly: true
  capacityUtilization: number | null
  measurableAccountCount: number
  unmeasuredRevenueShare: number
  reopenAutomationQuestion: boolean
  revivalCap: number
  revivalUnmeasuredShareLine: number
  shadowMode: boolean
  gatesVerified: boolean
  disclaimer: string
  serviceMonth?: string | null
  fixedPoolProvided?: boolean
  shadowNote?: string
  caliberRatification?: CaliberRatification
}

/** GET /full-health 就绪时的 data 层（完整体检态·绝对判断·当前不可达）。 */
export interface FullPortfolioHealth extends PortfolioHealth {
  fullState: true
  readiness: Readiness
}
