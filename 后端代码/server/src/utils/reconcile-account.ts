/**
 * 账实核对引擎 —— 纯口径函数（Phase 1，无 DB 依赖，可被路由 + 测试共享）。
 *
 * 设计基线 §1.4/§1.6：
 *  · 差异 = 账单片数 vs LIS 物理片数（纯计数，不依赖成本价）。
 *  · 前提：院名对齐 + 病理号匹配率达标。≥95 正常 / 80–95 匹配偏低(仅参考) / <80 先查(不出差异结论)；一边为空=待对齐。
 *  · 未匹配病例永远单列「算不了」，不混进差异结论。
 *  · 系统初判（线索非定论，财务终判）：账单>实际=疑似计费项目用错；实际>账单=疑似漏收需补收；相等=不出差异。
 *  · 6 认定原因（唯一术语串）→ 下家路由；补收 gate 只对「漏收，需补收」。
 *  · 差异定义按线不同：本轮只做**按数量收费的线（免疫组化/特染）**；组织学捆绑码另定义（未决 B1，不在本轮）。
 *    ⚠️ 数据质量：账单收费项文本分类（免疫组化/特染）依赖关键词；特染混进免疫组化的清洗见未决 A4。
 */

export type LineType = '免疫组化' | '特染'
export type MatchStatus = '正常' | '匹配偏低' | '先查' | '待对齐'
export type SystemHint = '疑似漏收，需补收' | '疑似计费项目用错'

/** 6 认定原因 —— 唯一术语串（做页/写码前当 lint，勿改字面）。 */
export const VERDICT_REASONS = [
  '漏收，需补收',
  '返工重做（不计费）',
  '超期，免费做的',
  '计费项目用错',
  'LIS 记录不全',
  '核对无误',
] as const
export type VerdictReason = (typeof VERDICT_REASONS)[number]

/** 认定原因 → 下家（②认定后分流的 3 大去向 + 指标桶 + 了结）。 */
export type FollowUp = 'supplement' | 'rework' | 'free' | 'external_fix' | 'data_fill' | 'settled'
const FOLLOW_UP_MAP: Record<VerdictReason, FollowUp> = {
  '漏收，需补收': 'supplement', // → 补收追踪（③）驱动补收
  '返工重做（不计费）': 'rework', // 计入「返工」指标
  '超期，免费做的': 'free', // 计入「免费诊断」指标
  '计费项目用错': 'external_fix', // → 待外部更正（回原收费系统改）
  'LIS 记录不全': 'data_fill', // → 待补数据
  '核对无误': 'settled', // 了结
}

export function verdictFollowUp(reason: VerdictReason): FollowUp {
  return FOLLOW_UP_MAP[reason]
}

/** 补收 gate：只有「漏收，需补收」驱动补收（返工/超期收不回、不驱动）。 */
export function drivesSupplement(reason: VerdictReason): boolean {
  return reason === '漏收，需补收'
}

export interface MatchThresholds {
  normal: number // ≥ → 正常
  low: number // ≥ → 匹配偏低；否则先查
}
export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = { normal: 0.95, low: 0.8 }

export interface CaseCounts {
  ihc: number // 免疫组化片数
  ss: number // 特染片数
}
export interface BillCase extends CaseCounts {
  caseNo: string
  ihcUnitPrice?: number // 账单免疫组化单价（估 ¥影响用）
  ssUnitPrice?: number // 账单特染单价
}
export interface LisCase extends CaseCounts {
  caseNo: string
}

export interface ReconcileDiff {
  caseNo: string
  lineType: LineType
  billCount: number
  lisCount: number
  delta: number // 账单 - 实际(LIS)
  amountImpact: number // |delta| × 账单单价（¥影响，估）
  systemHint: SystemHint
  lowConfidence: boolean // 匹配偏低（仅参考）
}
export interface UnmatchedCase {
  caseNo: string
  side: 'bill_only' | 'lis_only'
  note: string
}
export interface ReconcileResult {
  matchRate: number
  matchStatus: MatchStatus
  billCaseCount: number
  lisCaseCount: number
  matchedCaseCount: number
  emitDiffs: boolean // false when 先查/待对齐（不出差异结论）
  diffs: ReconcileDiff[]
  unmatched: UnmatchedCase[]
}

// —— 收费项文本分类（账单侧）——
const IHC_KEYWORDS = ['免疫组化', '免疫组织化学']
const SS_KEYWORDS = [
  '特殊染色', '特染', 'masson', '网状', '网织', '嗜银', '银染', '抗酸', 'pas', '过碘酸', '六胺银', 'gms',
  '刚果红', '普鲁士蓝', '甲苯胺蓝', 'ab-pas', '阿辛蓝', 'warthin', 'w-s', 'gomori',
]

/** 账单收费项 → 线（免疫组化/特染）；组织学/诊断等 → null（本轮不核）。 */
export function classifyChargeItem(item: string): LineType | null {
  const s = (item || '').toLowerCase()
  if (IHC_KEYWORDS.some((k) => s.includes(k.toLowerCase()))) return '免疫组化'
  if (SS_KEYWORDS.some((k) => s.includes(k))) return '特染'
  return null
}

/** 匹配率 → 院级状态。一边为空 → 待对齐（院名/数据没对上，不出差异）。 */
export function computeMatchStatus(rate: number, t: MatchThresholds = DEFAULT_MATCH_THRESHOLDS, hasBoth = true): MatchStatus {
  if (!hasBoth) return '待对齐'
  if (rate >= t.normal) return '正常'
  if (rate >= t.low) return '匹配偏低'
  return '先查'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function indexCases<T extends CaseCounts & { caseNo: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>()
  for (const r of rows) {
    const prev = m.get(r.caseNo)
    if (prev) {
      // 同 case 多行 → 计数累加（单价保留首见）
      prev.ihc += r.ihc
      prev.ss += r.ss
    } else {
      m.set(r.caseNo, { ...r })
    }
  }
  return m
}

/**
 * 账实核对：账单片数 vs LIS 物理片数（免疫组化 + 特染，各线独立）。
 * 先算匹配率定院级状态；正常/偏低才出差异，先查/待对齐只列未匹配、不出结论。
 */
export function computeReconcile(
  bills: BillCase[],
  lis: LisCase[],
  opts: { thresholds?: MatchThresholds } = {},
): ReconcileResult {
  const t = opts.thresholds ?? DEFAULT_MATCH_THRESHOLDS
  const billMap = indexCases(bills)
  const lisMap = indexCases(lis)

  const billCases = [...billMap.keys()]
  const lisCases = [...lisMap.keys()]
  const matched = billCases.filter((c) => lisMap.has(c))
  const union = new Set([...billCases, ...lisCases])
  const matchRate = union.size ? matched.length / union.size : 0
  const hasBoth = billCases.length > 0 && lisCases.length > 0
  const matchStatus = computeMatchStatus(matchRate, t, hasBoth)
  const emitDiffs = matchStatus === '正常' || matchStatus === '匹配偏低'
  const lowConfidence = matchStatus === '匹配偏低'

  const diffs: ReconcileDiff[] = []
  if (emitDiffs) {
    for (const caseNo of matched) {
      const b = billMap.get(caseNo)!
      const l = lisMap.get(caseNo)!
      const lines: Array<[LineType, number, number, number | undefined]> = [
        ['免疫组化', b.ihc, l.ihc, b.ihcUnitPrice],
        ['特染', b.ss, l.ss, b.ssUnitPrice],
      ]
      for (const [lineType, billCount, lisCount, price] of lines) {
        const delta = billCount - lisCount
        if (delta === 0) continue // 相等 → 不出差异
        diffs.push({
          caseNo,
          lineType,
          billCount,
          lisCount,
          delta,
          amountImpact: round2(Math.abs(delta) * (price ?? 0)),
          systemHint: delta > 0 ? '疑似计费项目用错' : '疑似漏收，需补收',
          lowConfidence,
        })
      }
    }
  }

  const unmatched: UnmatchedCase[] = []
  for (const c of billCases) {
    if (!lisMap.has(c)) unmatched.push({ caseNo: c, side: 'bill_only', note: '账单有、LIS 无记录——算不了（可能 LIS 漏记或跨月）' })
  }
  for (const c of lisCases) {
    if (!billMap.has(c)) unmatched.push({ caseNo: c, side: 'lis_only', note: '实际做了、账单无记录——疑似漏收，单列待查' })
  }

  return {
    matchRate,
    matchStatus,
    billCaseCount: billCases.length,
    lisCaseCount: lisCases.length,
    matchedCaseCount: matched.length,
    emitDiffs,
    diffs,
    unmatched,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 逐抗体细粒度初判（返工/多病灶）—— 附加线索层，与计数级差异引擎正交。
//   数据源 = lis_case_markers（每例每抗体逐切片行，含 marker_name/wax_no/advice_type）。
//   线索非定论·财务终判：**不改差异计数(delta)/systemHint/认定/补收 gate/golden**。
// ─────────────────────────────────────────────────────────────────────────────

export interface MarkerRow {
  markerName: string
  waxNo: string | null
  sectionNo?: string | null
  adviceType?: string | null
}
export type CaseHintType = '疑似返工' | '多病灶'
export interface CaseHint {
  hintType: CaseHintType
  markerName: string
  waxNo?: string // 返工：出现重复的蜡块
  waxNos?: string[] // 多病灶：跨的蜡块
  occurrences: number // 返工=该蜡块该抗体的 distinct 切片数；多病灶=蜡块数
}

// 真抗体申请类型（白名单，与病例详情页 lis-cases-v1.1 classifier 一致）：Y000001/Y000003。
//   其它已知码 Y000006(HE深切重切)/Y000007(白片) + 未文档化码 → 保守判「非抗体」（避免误报返工）。
const ANTIBODY_ADVICE = new Set(['Y000001', 'Y000003'])
const PROCESS_LABEL_RE = /白片|重切|深切/

/**
 * 是否真抗体染色行（剔除白片/重切/HE 等工序标签）。
 * 有申请类型 → 只认白名单（未知码保守=非抗体，与详情页口径一致）；无申请类型 → 退回名字判。
 */
export function isRealAntibodyMarker(m: MarkerRow): boolean {
  const name = (m.markerName || '').trim()
  if (!name) return false
  const advice = (m.adviceType || '').trim()
  if (advice) return ANTIBODY_ADVICE.has(advice)
  if (PROCESS_LABEL_RE.test(name)) return false
  if (/^he$/i.test(name)) return false
  return true
}

/**
 * 逐抗体细粒度初判：
 *  · 同蜡块 + 同抗体 ≥2 **张切片** → **疑似返工**（第一次没染好重做，不该多收）。
 *  · 同抗体跨 ≥2 个蜡块 → **多病灶**（各收各钱，正常·安抚线索：别误判成漏收/返工）。
 * 只对真抗体判；缺蜡块号的行跳过。**按 distinct 切片号计次**（防重复行/同片多行误判返工）；缺切片号则逐行计。
 */
export function classifyCaseHints(markers: MarkerRow[]): CaseHint[] {
  const real = markers.filter(isRealAntibodyMarker).filter((m) => (m.waxNo || '').trim())
  const byMarker = new Map<string, Map<string, Set<string>>>() // markerName -> waxNo -> Set<sectionNo>
  let anon = 0
  for (const m of real) {
    const name = m.markerName.trim()
    const wax = (m.waxNo as string).trim()
    const sec = (m.sectionNo || '').trim() || `__a${anon++}` // 缺切片号 → 视为独立一片（逐行计）
    const blocks = byMarker.get(name) ?? new Map<string, Set<string>>()
    const secs = blocks.get(wax) ?? new Set<string>()
    secs.add(sec)
    blocks.set(wax, secs)
    byMarker.set(name, blocks)
  }
  const hints: CaseHint[] = []
  for (const [markerName, blocks] of byMarker) {
    for (const [wax, secs] of blocks) {
      if (secs.size >= 2) hints.push({ hintType: '疑似返工', markerName, waxNo: wax, occurrences: secs.size })
    }
    if (blocks.size >= 2) {
      hints.push({ hintType: '多病灶', markerName, waxNos: [...blocks.keys()], occurrences: blocks.size })
    }
  }
  return hints
}
