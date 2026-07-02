/**
 * 院级 P&L 装配（W5 完整 = 收入 − 成本）。从 DB 原始层全量重算（增量纠错架构：派生可重跑）。
 *
 * 收入侧：case_revenue 实收 + lis_cases 数量 + partner service_scope → computeCasePnl（独立，不碰成本引擎）。
 * 成本侧：outbound_abc_details 既有 ABC 成本，按 partner_id 上卷（W6 已回填）。
 * 院级毛利 = Σ实验室收入 − Σ成本。完整度沿用 quality 计数（HE=0/无数量 标注未校正）。
 */

import { computeCasePnl, statementCasePnl, rollupPartnerRevenue, type CasePnl, type CasePnlInput, type RevenueQuality, type RevenueSource } from './partner-pnl.js'
import { getPartnerCostRollup, getCaseCostRollup, getPartnerCostByMonth, caseCostKey } from './abc-partner-link.js'
import { loadChargeCatalog } from './charge-catalog.js'
import type { ChargeCodeDef } from './charge-engine.js'
import type { ServiceScope } from './partner-upsert.js'
import type { LisCaseQty, SpecimenType } from './case-charge-mapping.js'

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

/** 逐 case 收入拆分（join case_revenue + lis_cases + partner）。 */
export function loadCasePnls(db: DbLike, catalog: Map<string, ChargeCodeDef>, opts: { serviceMonth?: string; partnerId?: string } = {}): CasePnl[] {
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

  return rows.map((r) => {
    // 已对账（配置驱动 /commit 落库了 lab_revenue）→ 用对账单 Σ(IN结算) 权威值，不走估算占比。
    if (r.lab_revenue != null) {
      const src = (r.revenue_source === 'corrected' ? 'corrected' : 'statement') as Extract<RevenueSource, 'statement' | 'corrected'>
      return statementCasePnl({
        caseNo: r.case_no, partnerId: r.partner_id, partnerName: r.partner_name || undefined,
        serviceScope: (r.service_scope as ServiceScope) || 'technical_only',
        netRevenue: Number(r.net_amount) || 0, serviceMonth: r.service_month || undefined,
        labRevenue: Number(r.lab_revenue) || 0, outRevenue: Number(r.out_revenue) || 0,
        diagnosisRevenue: Number(r.diagnosis_revenue) || 0,
      }, src)
    }
    const hasLis = r.he_slide_count != null || r.block_count != null
    const qty: LisCaseQty | null = hasLis
      ? {
          heSlideCount: Number(r.he_slide_count) || 0, blockCount: Number(r.block_count) || 0,
          ihcCount: Number(r.ihc_count) || 0, specialStainCount: Number(r.special_stain_count) || 0,
          eberCount: Number(r.eber_count) || 0, pdl1Count: Number(r.pdl1_count) || 0,
          specimenType: normalizeSpecimen(r.specimen_type),
        }
      : null
    const input: CasePnlInput = {
      caseNo: r.case_no, partnerId: r.partner_id, partnerName: r.partner_name || undefined,
      serviceScope: (r.service_scope as ServiceScope) || 'technical_only',
      netRevenue: Number(r.net_amount) || 0, serviceMonth: r.service_month || undefined, qty,
    }
    return computeCasePnl(input, catalog)
  })
}

/** case 级毛利下钻（收入 − 该 case 成本）。供 CM 筛查（flagged=负毛利）。 */
export interface CasePnlWithCost extends CasePnl {
  costTotal: number
  grossMargin: number
  marginRate: number
  flagged: boolean // 负毛利
}

/** case 级 P&L：在收入拆分上挂 ABC per-case 成本。 */
export function loadCasePnlsWithCost(db: DbLike, opts: { serviceMonth?: string; partnerId?: string } = {}): CasePnlWithCost[] {
  const catalog = loadChargeCatalog(db)
  const cases = loadCasePnls(db, catalog, opts)
  const costMap = getCaseCostRollup(db, { serviceMonth: opts.serviceMonth })
  return cases.map((c) => {
    const costTotal = costMap.get(caseCostKey(c.partnerId, c.caseNo)) || 0 // T1.5 复合键：不取他院同号成本
    const grossMargin = r2(c.labRevenue - costTotal)
    return { ...c, costTotal, grossMargin, marginRate: c.labRevenue > 0 ? r4(grossMargin / c.labRevenue) : 0, flagged: grossMargin < 0 }
  })
}

export interface PartnerPnl {
  partnerId: string
  partnerName?: string
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
    map.set(r.pid, {
      partnerName: r.pname, revenue: r2(Number(r.rev) || 0), cost: r2(Number(r.cost) || 0), margin: r2(Number(r.margin) || 0), orderCount: Number(r.n) || 0,
      unconfirmedRevenue: r2(Number(r.uRev) || 0), unconfirmedCount: Number(r.uN) || 0,
    })
  }
  return map
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000

/** 院级 P&L = 收入上卷 − 成本上卷。 */
export function buildPartnerPnl(db: DbLike, opts: { serviceMonth?: string; partnerId?: string } = {}): PartnerPnl[] {
  const catalog = loadChargeCatalog(db)
  const cases = loadCasePnls(db, catalog, opts)
  const revenue = rollupPartnerRevenue(cases)
  // 单月视图：成本经 case_no 关联 case_revenue.service_month 对齐到服务月（与收入同轴），避免跨月 case 单月毛利错期。
  const costMonthAxis: 'service_month' | 'all' = opts.serviceMonth ? 'service_month' : 'all'
  const costMap = getPartnerCostRollup(db, { serviceMonth: opts.serviceMonth })
  const ngsMap = loadNgsByPartner(db, opts)

  const rows: PartnerPnl[] = revenue.map((rev) => {
    const cost = costMap.get(rev.partnerId)
    const costTotal = cost?.costTotal || 0
    const grossMargin = r2(rev.labRevenueTotal - costTotal)
    const ngs = ngsMap.get(rev.partnerId)
    const ngsMargin = ngs?.margin || 0
    const n = rev.caseCount || 1
    return {
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
  })

  // NGS-only 医院（有 NGS 外购转销但本期无院内 case_revenue）→ 补行，避免漏掉纯转销客户
  const seen = new Set(rows.map((r) => r.partnerId))
  for (const [pid, ngs] of ngsMap) {
    if (seen.has(pid)) continue
    rows.push({
      partnerId: pid, partnerName: ngs.partnerName, caseCount: 0,
      netRevenueTotal: 0, labRevenueTotal: 0, diagnosisRevenueTotal: 0, costTotal: 0, grossMargin: 0, marginRate: 0,
      avgLabRevenuePerCase: 0, avgCostPerCase: 0, avgMarginPerCase: 0,
      qualityCounts: { ok: 0, partial_quantities: 0, no_quantities: 0 },
      sourceCounts: { statement: 0, estimated: 0, corrected: 0 },
      costMatched: false, costMonthAxis, benchmarkCorrected: false,
      ngsRevenue: ngs.revenue, ngsCost: ngs.cost, ngsMargin: ngs.margin, ngsOrderCount: ngs.orderCount,
      ngsUnconfirmedRevenue: ngs.unconfirmedRevenue, ngsUnconfirmedCount: ngs.unconfirmedCount,
      totalMargin: ngs.margin,
    })
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
export function buildPartnerTrend(db: DbLike, partnerId: string): PnlTrendPoint[] {
  const catalog = loadChargeCatalog(db) // 一次
  const cases = loadCasePnls(db, catalog, { partnerId }) // 一次（全月份）
  const costByMonth = getPartnerCostByMonth(db, partnerId) // 一次（按成本月）
  const byMonth = new Map<string, PnlTrendPoint>()
  const ensure = (m: string) => {
    let p = byMonth.get(m)
    if (!p) { p = { serviceMonth: m, netRevenueTotal: 0, labRevenueTotal: 0, costTotal: 0, grossMargin: 0, caseCount: 0 }; byMonth.set(m, p) }
    return p
  }
  for (const c of cases) {
    if (!c.serviceMonth) continue
    const p = ensure(c.serviceMonth)
    p.netRevenueTotal = r2(p.netRevenueTotal + c.netRevenue)
    p.labRevenueTotal = r2(p.labRevenueTotal + c.labRevenue)
    p.caseCount++
  }
  // 成本归到自己的成本月（即使该月暂无收入也呈现，便于发现成本/收入错期）
  for (const [m, cost] of costByMonth) ensure(m).costTotal = cost
  const points = [...byMonth.values()].sort((a, b) => a.serviceMonth.localeCompare(b.serviceMonth))
  points.forEach((p) => { p.grossMargin = r2(p.labRevenueTotal - p.costTotal) })
  return points
}
