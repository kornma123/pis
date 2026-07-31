/**
 * 院级 P&L 装配（W5 完整 = 收入 − 成本）。从 DB 原始层全量重算（增量纠错架构：派生可重跑）。
 *
 * 收入侧：case_revenue 实收 + lis_cases 数量 + partner service_scope → computeCasePnl（独立，不碰成本引擎）。
 * 成本侧：outbound_abc_details 既有 ABC 成本，按 partner_id 上卷（W6 已回填）。
 * 院级毛利 = Σ实验室收入 − Σ成本。完整度沿用 quality 计数（HE=0/无数量 标注未校正）。
 *
 * LOC-015：金额（net_amount/lab_revenue/out_revenue/diagnosis_revenue/NGS 聚合）与
 * LIS 计数（he/block/ihc/special/eber/pdl1）一律经 evidence-fact 严格读取；
 * 不可信事实 -> case 扣留、院行带 `evidenceUnavailable`，API 层不得发布 0/成功金额。
 */

import { computeCasePnl, statementCasePnl, rollupPartnerRevenue, type CasePnl, type CasePnlInput, type RevenueQuality, type RevenueSource } from './partner-pnl.js'
import { getPartnerCostRollup, getCaseCostRollup, getPartnerCostByMonth, caseCostKey } from './abc-partner-link.js'
import { loadChargeCatalog } from './charge-catalog.js'
import type { ChargeCodeDef } from './charge-engine.js'
import type { ServiceScope } from './partner-upsert.js'
import type { LisCaseQty, SpecimenType } from './case-charge-mapping.js'
import {
  readEvidenceAmount,
  readEvidenceCount,
  type EvidenceIssue,
} from './evidence-fact.js'

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes?: number }; all: (...a: unknown[]) => unknown[] }
}

const VALID_SPECIMEN: SpecimenType[] = ['tissue', 'tissue_complex', 'cytology']
/** DB 值校验：非法/NULL 的 specimen_type 显式归一为 'tissue'（默认），不静默把垃圾值当组织 */
function normalizeSpecimen(v: string | null): SpecimenType {
  return VALID_SPECIMEN.includes(v as SpecimenType) ? (v as SpecimenType) : 'tissue'
}

interface RevenueRow {
  case_no: string
  partner_id: string
  partner_name: string | null
  service_scope: string | null
  net_amount: number
  lab_revenue: number | null // 非 NULL = 配置驱动已对账（Σ(IN结算)，权威）
  out_revenue: number | null
  diagnosis_revenue: number | null // 诊断桶（报告/现场/split 诊断份额）
  revenue_source: string | null
  service_month: string | null
  he_slide_count: number | null
  block_count: number | null
  ihc_count: number | null
  special_stain_count: number | null
  eber_count: number | null
  pdl1_count: number | null
  specimen_type: string | null
}

/** 因证据不可信被扣留的 case（不参与任何 P&L 发布）。 */
export interface WithheldEvidenceCase {
  caseNo: string
  partnerId: string
  serviceMonth: string | null
  issues: EvidenceIssue[]
}

export interface CasePnlEvidenceResult {
  clean: CasePnl[]
  withheld: WithheldEvidenceCase[]
}

/** 院级行附加具名证据状态：有扣留 case / NGS 聚合不可信时不得发布为成功金额。 */
export interface PartnerPnlWithEvidence extends PartnerPnl {
  evidenceUnavailable?: { caseCount: number; issues: EvidenceIssue[] }
}

export interface PnlTrendPointWithEvidence extends PnlTrendPoint {
  evidenceUnavailable?: { caseCount: number; issues: EvidenceIssue[] }
}

function amountIssues(r: RevenueRow, fields: Array<{ name: keyof RevenueRow; column: string }>): EvidenceIssue[] {
  const issues: EvidenceIssue[] = []
  for (const { name, column } of fields) {
    const fact = readEvidenceAmount(r[name], { scale: 4 })
    if (fact.status === 'unavailable') {
      issues.push({ caseNo: r.case_no, field: column, reason: fact.reason })
    }
  }
  return issues
}

function countIssues(r: RevenueRow, columns: Array<{ name: keyof RevenueRow; column: string }>): EvidenceIssue[] {
  const issues: EvidenceIssue[] = []
  for (const { name, column } of columns) {
    const fact = readEvidenceCount(r[name])
    if (fact.status === 'unavailable') {
      issues.push({ caseNo: r.case_no, field: column, reason: fact.reason })
    }
  }
  return issues
}

const COUNT_COLUMNS: Array<{ name: keyof RevenueRow; column: string }> = [
  { name: 'he_slide_count', column: 'he_slide_count' },
  { name: 'block_count', column: 'block_count' },
  { name: 'ihc_count', column: 'ihc_count' },
  { name: 'special_stain_count', column: 'special_stain_count' },
  { name: 'eber_count', column: 'eber_count' },
  { name: 'pdl1_count', column: 'pdl1_count' },
]

/** 兼容入口：只返回干净 case（污染 case 由 loadCasePnlEvidence 扣留并具名）。 */
export function loadCasePnls(db: DbLike, catalog: Map<string, ChargeCodeDef>, opts: { serviceMonth?: string; partnerId?: string } = {}): CasePnl[] {
  return loadCasePnlEvidence(db, catalog, opts).clean
}

/**
 * 逐 case 收入拆分（join case_revenue + lis_cases + partner）。
 * LOC-015：金额与计数严格读取；任一事实不可信 -> 该 case 扣留，绝不 `Number(x) || 0` 折零发布。
 */
export function loadCasePnlEvidence(db: DbLike, catalog: Map<string, ChargeCodeDef>, opts: { serviceMonth?: string; partnerId?: string } = {}): CasePnlEvidenceResult {
  let where = '1=1'
  const params: unknown[] = []
  if (opts.serviceMonth) { where += ' AND cr.service_month = ?'; params.push(opts.serviceMonth) }
  if (opts.partnerId) { where += ' AND cr.partner_id = ?'; params.push(opts.partnerId) }
  const rows = db.prepare(`
    SELECT cr.case_no, cr.partner_id, cr.net_amount, cr.lab_revenue, cr.out_revenue, cr.diagnosis_revenue, cr.revenue_source, cr.service_month,
           p.name AS partner_name, p.service_scope,
           lc.he_slide_count, lc.block_count, lc.ihc_count, lc.special_stain_count, lc.eber_count, lc.pdl1_count, lc.specimen_type
    FROM case_revenue cr
    LEFT JOIN partners p ON p.id = cr.partner_id
    LEFT JOIN lis_cases lc ON lc.partner_id = cr.partner_id AND lc.case_no = cr.case_no
    WHERE ${where}
  `).all(...params) as RevenueRow[]

  const clean: CasePnl[] = []
  const withheld: WithheldEvidenceCase[] = []
  for (const r of rows) {
    // 已对账（配置驱动 /commit 落库了 lab_revenue）→ 用对账单 Σ(IN结算) 权威值，不走估算占比。
    if (r.lab_revenue != null) {
      const issues = amountIssues(r, [
        { name: 'net_amount', column: 'net_amount' },
        { name: 'lab_revenue', column: 'lab_revenue' },
        { name: 'out_revenue', column: 'out_revenue' },
        { name: 'diagnosis_revenue', column: 'diagnosis_revenue' },
      ])
      if (issues.length > 0) {
        withheld.push({ caseNo: r.case_no, partnerId: r.partner_id, serviceMonth: r.service_month ?? null, issues })
        continue
      }
      const src = (r.revenue_source === 'corrected' ? 'corrected' : 'statement') as Extract<RevenueSource, 'statement' | 'corrected'>
      clean.push(statementCasePnl({
        caseNo: r.case_no, partnerId: r.partner_id, partnerName: r.partner_name || undefined,
        serviceScope: (r.service_scope as ServiceScope) || 'technical_only',
        netRevenue: r.net_amount as number, serviceMonth: r.service_month || undefined,
        labRevenue: r.lab_revenue as number, outRevenue: r.out_revenue as number,
        diagnosisRevenue: r.diagnosis_revenue as number,
      }, src))
      continue
    }
    const netIssue = amountIssues(r, [{ name: 'net_amount', column: 'net_amount' }])
    if (netIssue.length > 0) {
      withheld.push({ caseNo: r.case_no, partnerId: r.partner_id, serviceMonth: r.service_month ?? null, issues: netIssue })
      continue
    }
    const hasLis = r.he_slide_count != null || r.block_count != null
    if (hasLis) {
      const issues = countIssues(r, COUNT_COLUMNS)
      if (issues.length > 0) {
        withheld.push({ caseNo: r.case_no, partnerId: r.partner_id, serviceMonth: r.service_month ?? null, issues })
        continue
      }
    }
    const qty: LisCaseQty | null = hasLis
      ? {
          heSlideCount: r.he_slide_count as number, blockCount: r.block_count as number,
          ihcCount: r.ihc_count as number, specialStainCount: r.special_stain_count as number,
          eberCount: r.eber_count as number, pdl1Count: r.pdl1_count as number,
          specimenType: normalizeSpecimen(r.specimen_type),
        }
      : null
    const input: CasePnlInput = {
      caseNo: r.case_no, partnerId: r.partner_id, partnerName: r.partner_name || undefined,
      serviceScope: (r.service_scope as ServiceScope) || 'technical_only',
      netRevenue: r.net_amount as number, serviceMonth: r.service_month || undefined, qty,
    }
    clean.push(computeCasePnl(input, catalog))
  }
  return { clean, withheld }
}

/** case 级毛利下钻（收入 − 该 case 成本）。供 CM 筛查（flagged=负毛利）。 */
export interface CasePnlWithCost extends CasePnl {
  costTotal: number
  grossMargin: number
  marginRate: number
  flagged: boolean // 负毛利
}

/** 兼容入口：只返回干净 case 级 P&L。 */
export function loadCasePnlsWithCost(db: DbLike, opts: { serviceMonth?: string; partnerId?: string } = {}): CasePnlWithCost[] {
  return loadCasePnlsWithCostEvidence(db, opts).rows
}

/** case 级 P&L：在收入拆分上挂 ABC per-case 成本，同时返回被扣留 case。 */
export function loadCasePnlsWithCostEvidence(db: DbLike, opts: { serviceMonth?: string; partnerId?: string } = {}): {
  rows: CasePnlWithCost[]
  withheld: WithheldEvidenceCase[]
} {
  const catalog = loadChargeCatalog(db)
  const { clean, withheld } = loadCasePnlEvidence(db, catalog, opts)
  const costMap = getCaseCostRollup(db, { serviceMonth: opts.serviceMonth })
  const rows = clean.map((c) => {
    const costTotal = costMap.get(caseCostKey(c.partnerId, c.caseNo)) || 0 // T1.5 复合键：不取他院同号成本
    const grossMargin = r2(c.labRevenue - costTotal)
    return { ...c, costTotal, grossMargin, marginRate: c.labRevenue > 0 ? r4(grossMargin / c.labRevenue) : 0, flagged: grossMargin < 0 }
  })
  return { rows, withheld }
}

export interface PartnerPnl {
  partnerId: string
  partnerName?: string | null
  caseCount: number
  netRevenueTotal: number // 财务实收合计
  labRevenueTotal: number // 实验室收入合计
  diagnosisRevenueTotal: number // 诊断桶合计（我们的钱但非实验室工序，不进毛利分子）
  costTotal: number // ABC 成本合计（按医院上卷）
  grossMargin: number // 毛利 = 实验室收入 − 成本
  marginRate: number // 毛利率 = grossMargin / labRevenue
  avgLabRevenuePerCase: number // benchmark（原始·未病种校正）
  avgCostPerCase: number
  avgMarginPerCase: number
  qualityCounts: Record<RevenueQuality, number>
  sourceCounts: Record<RevenueSource, number> // 已对账(statement)/估算(estimated)/已修正(corrected) case 数
  costMatched: boolean // 该院是否有已归集的 ABC 成本（否=成本未接通，毛利仅供参考）
  costMonthAxis: 'service_month' | 'all' // 单月口径标注：'service_month'=成本已按服务月对齐到收入同月（单月视图）；'all'=全量未分月（与 trend 的双轴透明一致）
  benchmarkCorrected: false // 恒 false：v1 benchmark 未做病种校正（UI 必标注）
  // —— NGS 外购转销（独立渠道，非 LIS/对账单；外包成本独立于 ABC）——
  ngsRevenue: number // NGS 售价合计（已核成本单）
  ngsCost: number // NGS 外包成本合计（协议价，已核单）
  ngsMargin: number // NGS 毛利 = 售价 − 外包成本（仅已核成本单）
  ngsOrderCount: number // 已核成本的 NGS 单数
  ngsUnconfirmedRevenue: number // T3 未核外包成本单的售价合计（单列，不进毛利）
  ngsUnconfirmedCount: number // T3 未核外包成本的 NGS 单数（需补成本）
  totalMargin: number // 院级总毛利 = 院内技术毛利(grossMargin) + NGS 已核毛利(ngsMargin)；未核单不计入
}

interface NgsPartnerAgg {
  partnerName: string; revenue: number; cost: number; margin: number; orderCount: number
  // T3：未核外包成本（cost_confirmed=0）单独计，不进 revenue/cost/margin，避免按 0 成本把毛利高估为售价污染院级利润。
  unconfirmedRevenue: number; unconfirmedCount: number
  // LOC-015：任一 NGS 聚合事实不可信 -> 具名 unavailable（API 层 null 发布）
  evidenceUnavailable?: { issues: EvidenceIssue[] }
}

/** 按 partner_id 上卷 NGS 外购转销（SQL SUM 聚合，避免装载全部订单）。已核成本(cost_confirmed=1)进正常毛利；未核单单列。 */
export function loadNgsByPartner(db: DbLike, opts: { serviceMonth?: string; partnerId?: string } = {}): Map<string, NgsPartnerAgg> {
  let where = '1=1'
  const params: unknown[] = []
  if (opts.serviceMonth) { where += ' AND no.order_month = ?'; params.push(opts.serviceMonth) }
  if (opts.partnerId) { where += ' AND no.partner_id = ?'; params.push(opts.partnerId) }
  const rows = db.prepare(`
    SELECT no.partner_id AS pid, COALESCE(p.name, no.partner_name) AS pname,
           SUM(CASE WHEN no.cost_confirmed = 1 THEN 1 ELSE 0 END) AS n,
           SUM(CASE WHEN no.cost_confirmed = 1 THEN no.sell_price ELSE 0 END) AS rev,
           SUM(CASE WHEN no.cost_confirmed = 1 THEN no.outsource_cost ELSE 0 END) AS cost,
           SUM(CASE WHEN no.cost_confirmed = 1 THEN no.margin ELSE 0 END) AS margin,
           SUM(CASE WHEN no.cost_confirmed = 0 THEN 1 ELSE 0 END) AS uN,
           SUM(CASE WHEN no.cost_confirmed = 0 THEN no.sell_price ELSE 0 END) AS uRev
    FROM ngs_orders no LEFT JOIN partners p ON p.id = no.partner_id
    WHERE ${where} GROUP BY no.partner_id
  `).all(...params) as Array<{ pid: string; pname: string; n: number; rev: number; cost: number; margin: number; uN: number; uRev: number }>
  const map = new Map<string, NgsPartnerAgg>()
  for (const r of rows) {
    if (!r.pid) continue
    const issues: EvidenceIssue[] = []
    const moneyFields: Array<[keyof typeof r, string]> = [
      ['rev', 'ngs_revenue'], ['cost', 'ngs_cost'], ['margin', 'ngs_margin'], ['uRev', 'ngs_unconfirmed_revenue'],
    ]
    for (const [key, field] of moneyFields) {
      const fact = readEvidenceAmount(r[key], { scale: 4 })
      if (fact.status === 'unavailable') issues.push({ field, reason: fact.reason })
    }
    for (const [key, field] of [['n', 'ngs_order_count'], ['uN', 'ngs_unconfirmed_count']] as Array<[keyof typeof r, string]>) {
      const fact = readEvidenceCount(r[key])
      if (fact.status === 'unavailable') issues.push({ field, reason: fact.reason })
    }
    map.set(r.pid, {
      partnerName: r.pname,
      revenue: r2(Number(r.rev) || 0), cost: r2(Number(r.cost) || 0), margin: r2(Number(r.margin) || 0), orderCount: Number(r.n) || 0,
      unconfirmedRevenue: r2(Number(r.uRev) || 0), unconfirmedCount: Number(r.uN) || 0,
      ...(issues.length > 0 ? { evidenceUnavailable: { issues } } : {}),
    })
  }
  return map
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000

/** 院级 P&L = 收入上卷 − 成本上卷；污染 case/NGS 聚合 -> 院行带 evidenceUnavailable。 */
export function buildPartnerPnl(db: DbLike, opts: { serviceMonth?: string; partnerId?: string } = {}): PartnerPnlWithEvidence[] {
  const catalog = loadChargeCatalog(db)
  const { clean, withheld } = loadCasePnlEvidence(db, catalog, opts)
  const revenue = rollupPartnerRevenue(clean)
  // 单月视图：成本经 case_no 关联 case_revenue.service_month 对齐到服务月（与收入同轴），避免跨月 case 单月毛利错期。
  const costMonthAxis: 'service_month' | 'all' = opts.serviceMonth ? 'service_month' : 'all'
  const costMap = getPartnerCostRollup(db, { serviceMonth: opts.serviceMonth })
  const ngsMap = loadNgsByPartner(db, opts)
  const withheldByPartner = new Map<string, WithheldEvidenceCase[]>()
  for (const w of withheld) {
    if (opts.serviceMonth && w.serviceMonth !== opts.serviceMonth) continue
    const arr = withheldByPartner.get(w.partnerId) ?? []
    arr.push(w)
    withheldByPartner.set(w.partnerId, arr)
  }

  const rows: PartnerPnlWithEvidence[] = revenue.map((rev) => {
    const cost = costMap.get(rev.partnerId)
    const costTotal = cost?.costTotal || 0
    const grossMargin = r2(rev.labRevenueTotal - costTotal)
    const ngs = ngsMap.get(rev.partnerId)
    const ngsMargin = ngs?.margin || 0
    const n = rev.caseCount || 1
    const row: PartnerPnlWithEvidence = {
      partnerId: rev.partnerId,
      partnerName: rev.partnerName,
      caseCount: rev.caseCount,
      netRevenueTotal: rev.netTotal,
      labRevenueTotal: rev.labRevenueTotal,
      diagnosisRevenueTotal: rev.diagnosisRevenueTotal,
      costTotal,
      grossMargin,
      marginRate: rev.labRevenueTotal > 0 ? r4(grossMargin / rev.labRevenueTotal) : 0,
      avgLabRevenuePerCase: r2(rev.labRevenueTotal / n),
      avgCostPerCase: r2(costTotal / n),
      avgMarginPerCase: r2(grossMargin / n),
      qualityCounts: rev.qualityCounts,
      sourceCounts: rev.sourceCounts,
      costMatched: !!cost,
      costMonthAxis,
      benchmarkCorrected: false,
      ngsRevenue: ngs?.revenue || 0,
      ngsCost: ngs?.cost || 0,
      ngsMargin,
      ngsOrderCount: ngs?.orderCount || 0,
      ngsUnconfirmedRevenue: ngs?.unconfirmedRevenue || 0,
      ngsUnconfirmedCount: ngs?.unconfirmedCount || 0,
      totalMargin: r2(grossMargin + ngsMargin),
    }
    const wh = withheldByPartner.get(rev.partnerId)
    const ngsEv = ngs?.evidenceUnavailable
    const issues = [...(wh?.flatMap((w) => w.issues) ?? []), ...(ngsEv?.issues ?? [])]
    if (issues.length > 0) {
      row.evidenceUnavailable = { caseCount: wh?.length ?? 0, issues }
    }
    return row
  })

  // 只有被扣留 case（无干净收入）的医院：仍必须出现，且行级 evidence unavailable
  const seen = new Set(rows.map((r) => r.partnerId))
  for (const [pid, wh] of withheldByPartner) {
    if (seen.has(pid)) continue
    rows.push({
      partnerId: pid,
      partnerName: null,
      caseCount: 0,
      netRevenueTotal: 0, labRevenueTotal: 0, diagnosisRevenueTotal: 0, costTotal: 0, grossMargin: 0, marginRate: 0,
      avgLabRevenuePerCase: 0, avgCostPerCase: 0, avgMarginPerCase: 0,
      qualityCounts: { ok: 0, partial_quantities: 0, no_quantities: 0 },
      sourceCounts: { statement: 0, estimated: 0, corrected: 0 },
      costMatched: false, costMonthAxis, benchmarkCorrected: false,
      ngsRevenue: 0, ngsCost: 0, ngsMargin: 0, ngsOrderCount: 0,
      ngsUnconfirmedRevenue: 0, ngsUnconfirmedCount: 0,
      totalMargin: 0,
      evidenceUnavailable: { caseCount: wh.length, issues: wh.flatMap((w) => w.issues) },
    })
    seen.add(pid)
  }

  // NGS-only 医院（有 NGS 外购转销但本期无院内 case_revenue）→ 补行，避免漏掉纯转销客户
  for (const [pid, ngs] of ngsMap) {
    if (seen.has(pid)) continue
    const row: PartnerPnlWithEvidence = {
      partnerId: pid, partnerName: ngs.partnerName, caseCount: 0,
      netRevenueTotal: 0, labRevenueTotal: 0, diagnosisRevenueTotal: 0, costTotal: 0, grossMargin: 0, marginRate: 0,
      avgLabRevenuePerCase: 0, avgCostPerCase: 0, avgMarginPerCase: 0,
      qualityCounts: { ok: 0, partial_quantities: 0, no_quantities: 0 },
      sourceCounts: { statement: 0, estimated: 0, corrected: 0 },
      costMatched: false, costMonthAxis, benchmarkCorrected: false,
      ngsRevenue: ngs.revenue, ngsCost: ngs.cost, ngsMargin: ngs.margin, ngsOrderCount: ngs.orderCount,
      ngsUnconfirmedRevenue: ngs.unconfirmedRevenue, ngsUnconfirmedCount: ngs.unconfirmedCount,
      totalMargin: ngs.margin,
    }
    if (ngs.evidenceUnavailable) {
      row.evidenceUnavailable = { caseCount: 0, issues: ngs.evidenceUnavailable.issues }
    }
    rows.push(row)
  }
  return rows
}

export interface PnlTrendPoint {
  serviceMonth: string
  netRevenueTotal: number
  labRevenueTotal: number
  costTotal: number
  grossMargin: number
  caseCount: number
}

/**
 * 某医院的月度趋势（按 service_month 时序）。单次装载目录+收入+成本。
 * 成本按【cost_month】归集（getPartnerCostByMonth），避免按 case lifetime 把同一份成本串到每个收入月重复计。
 */
export function buildPartnerTrend(db: DbLike, partnerId: string): PnlTrendPointWithEvidence[] {
  const catalog = loadChargeCatalog(db) // 一次
  const { clean, withheld } = loadCasePnlEvidence(db, catalog, { partnerId }) // 一次（全月份）
  const costByMonth = getPartnerCostByMonth(db, partnerId) // 一次（按成本月）
  const byMonth = new Map<string, PnlTrendPoint>()
  const ensure = (m: string) => {
    let p = byMonth.get(m)
    if (!p) { p = { serviceMonth: m, netRevenueTotal: 0, labRevenueTotal: 0, costTotal: 0, grossMargin: 0, caseCount: 0 }; byMonth.set(m, p) }
    return p
  }
  for (const c of clean) {
    if (!c.serviceMonth) continue
    const p = ensure(c.serviceMonth)
    p.netRevenueTotal = r2(p.netRevenueTotal + c.netRevenue)
    p.labRevenueTotal = r2(p.labRevenueTotal + c.labRevenue)
    p.caseCount++
  }
  // 成本归到自己的成本月（即使该月暂无收入也呈现，便于发现成本/收入错期）
  for (const [m, cost] of costByMonth) ensure(m).costTotal = cost
  const withheldByMonth = new Map<string, WithheldEvidenceCase[]>()
  for (const w of withheld) {
    if (!w.serviceMonth) continue
    const arr = withheldByMonth.get(w.serviceMonth) ?? []
    arr.push(w)
    withheldByMonth.set(w.serviceMonth, arr)
  }
  const months = new Set([...byMonth.keys(), ...withheldByMonth.keys()])
  const points: PnlTrendPointWithEvidence[] = []
  for (const m of months) {
    const p = byMonth.get(m) ?? ensure(m)
    p.grossMargin = r2(p.labRevenueTotal - p.costTotal)
    const point: PnlTrendPointWithEvidence = { ...p }
    const wh = withheldByMonth.get(m)
    if (wh && wh.length > 0) {
      point.evidenceUnavailable = { caseCount: wh.length, issues: wh.flatMap((w) => w.issues) }
    }
    points.push(point)
  }
  return points.sort((a, b) => a.serviceMonth.localeCompare(b.serviceMonth))
}
