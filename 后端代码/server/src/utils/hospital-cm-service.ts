/**
 * 院级贡献毛利 —— DB 装载层（实现 P0 spec §10.A SQL 契约）。
 *
 * 红线（§10.A·§8）：
 *   · 收入分子 = `case_revenue.lab_revenue`（**绝不用 net_amount**），仅 revenue_source ∈ (statement,corrected)。
 *   · 月轴 = `case_revenue.service_month`（case_revenue 无 collected_month）。
 *   · 成本 join = LEFT JOIN lis_cases / lis_case_markers ON (partner_id, case_no)；operate_time 只做异常提示、不做主月轴。
 *   · **防 1:N 扇出双计**：一抗(桶B)/二抗(桶A) 按 lis_case_markers【行级】Σ；特染 special_stain_count、组织处理 block_count 是
 *     lis_cases【每例单行标量】，每 (partner_id,case_no) 只取一次——**先按 case 聚 marker、再与 lis_cases 单行标量相加**（此处用 JS 分组等价 CTE）。
 *   · 禁：outbound_abc_details · computeFullSlideCost · specialStainPerTestCost 的含 labor total · operate_time 当主月轴。
 *
 * 现状（§7·§10.F·诚实措辞）：schema initializer 具备这些表；导入三件套（对账单+工作量表+抗体清单）后，
 *   才能对指定院月产 P0 结果。签入 `data/coreone.db` 快照里这几张表是空的 → 无数据时返回空列表（不臆造）。
 */

import {
  buildLedgerIndex,
  normalizeAntibodyName,
  resolveAntibodyName,
  buildSynonymMap,
  type LedgerIndex,
  type LedgerRow,
} from './antibody-name-map.js'
import {
  computeCaseCm,
  makeWithheldCase,
  rollupHospitalCm,
  SECONDARY_PER_SLIDE_DEFAULT,
  type P0CaseInput,
  type P0CaseCm,
  type PriceResolver,
  type CaseCmParams,
  type HospitalCm,
} from './hospital-cm.js'

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes?: number }; all: (...a: unknown[]) => unknown[] }
}

// —— 台账索引 / 别名映射（与 antibody-cost-v1.1.ts 同款·DB 权威源）——
function buildDbLedgerIndex(db: DbLike): LedgerIndex {
  const rows = db
    .prepare('SELECT name, form, per_test_price, category FROM antibodies WHERE is_deleted = 0')
    .all() as Array<{ name: string; form: string | null; per_test_price: number | null; category: string | null }>
  const ledger: LedgerRow[] = rows.map((r) => ({ name: r.name, form: r.form, perTestPrice: r.per_test_price, category: r.category }))
  return buildLedgerIndex(ledger)
}

function buildSynonymMapFromDb(db: DbLike): Map<string, string> {
  const m = new Map<string, string>()
  try {
    const rows = db.prepare('SELECT lis_name, canonical_name FROM antibody_aliases WHERE status = 1').all() as Array<{ lis_name: string; canonical_name: string }>
    for (const r of rows) m.set(normalizeAntibodyName(r.lis_name), r.canonical_name)
  } catch {
    /* 表未建 → 仅靠规范化 */
  }
  return m
}

/** 二抗/显色每片约定价（桶A·纯①）：读 ihc_cost_params.secondary_per_slide（缺 → 默认 ¥15）。 */
function loadSecondaryPerSlide(db: DbLike): number {
  try {
    const row = db.prepare("SELECT value FROM ihc_cost_params WHERE param_key = 'secondary_per_slide'").get() as { value: number } | undefined
    const v = row ? Number(row.value) : NaN
    return Number.isFinite(v) && v > 0 ? v : SECONDARY_PER_SLIDE_DEFAULT
  } catch {
    return SECONDARY_PER_SLIDE_DEFAULT
  }
}

/**
 * 特染每片约定价（桶B·①*·**labor-free**）= 各盒 kit_price ÷ denom 的均值（denom=COALESCE(NULLIF(actual_yield,0),nominal_tests)）。
 * ⚠️ lis_cases 只给 special_stain_count 标量、不给具体盒 → 用**代表性均价**做 ①* 约定；**绝不读 labor_per_test**（§10.B）。
 * 无盒 → 0（不减特染成本）。返回是否占位（当前均无 actual_yield 校准 → 标 placeholder，供披露）。
 */
function loadStainPerSlide(db: DbLike): { perSlide: number; isPlaceholder: boolean } {
  try {
    const rows = db.prepare('SELECT kit_price, nominal_tests, actual_yield FROM special_stain_kits WHERE is_deleted = 0 AND status = 1').all() as Array<{
      kit_price: number
      nominal_tests: number
      actual_yield: number | null
    }>
    let sum = 0
    let n = 0
    let anyCalibrated = false
    for (const r of rows) {
      const denom = r.actual_yield && Number(r.actual_yield) > 0 ? Number(r.actual_yield) : Number(r.nominal_tests)
      if (denom > 0 && Number.isFinite(Number(r.kit_price))) {
        sum += Number(r.kit_price) / denom
        n += 1
        if (r.actual_yield && Number(r.actual_yield) > 0) anyCalibrated = true
      }
    }
    const perSlide = n > 0 ? Math.round((sum / n + Number.EPSILON) * 100) / 100 : 0
    return { perSlide, isPlaceholder: !anyCalibrated }
  } catch {
    return { perSlide: 0, isPlaceholder: true }
  }
}

/**
 * partner 级前处理默认标志（§10.C：代送院=false/全流程院=true）。
 * 现无该列/resolver（service_step_scope 仅预埋）→ 一律返回 null（未知）→ 引擎出「染色贡献毛利(不含前处理)」。
 * 未来建了封闭字段（如 partners.tissue_processing_default）即从此读；try/catch 前向兼容。
 */
function loadPartnerTissueDefault(_db: DbLike, _partnerId: string): boolean | null {
  return null
}

export interface LoadHospitalCmOpts {
  serviceMonth?: string
  partnerId?: string
  settled?: boolean // 判定所依据的月是否已关账（G2 闸）；缺省 undefined
}

interface RevenueRow {
  case_no: string
  partner_id: string | null
  partner_name: string | null
  lab_revenue: number | null
  revenue_source: string | null
  service_month: string | null
  special_stain_count: number | null
  block_count: number | null
  ihc_count: number | null
}

/**
 * 装载并计算每 case 贡献毛利（§10.A 契约）。
 * 加载 revenue_source∈(statement,corrected) 且 lab_revenue IS NOT NULL 的 case（含 lab_revenue=0 供诊断桶计数）；
 * 引擎按同源闸/准入闸分桶。marker 先按 (partner_id,case_no) 分组（防标量扇出）。
 */
export function loadHospitalCmCases(db: DbLike, opts: LoadHospitalCmOpts = {}): P0CaseCm[] {
  let where = "cr.lab_revenue IS NOT NULL AND cr.revenue_source IN ('statement','corrected')"
  const params: unknown[] = []
  if (opts.partnerId) { where += ' AND cr.partner_id = ?'; params.push(opts.partnerId) }
  if (opts.serviceMonth) { where += ' AND cr.service_month = ?'; params.push(opts.serviceMonth) }

  const revRows = db.prepare(`
    SELECT cr.case_no, cr.partner_id, p.name AS partner_name, cr.lab_revenue, cr.revenue_source, cr.service_month,
           lc.special_stain_count, lc.block_count, lc.ihc_count
    FROM case_revenue cr
    LEFT JOIN partners p ON p.id = cr.partner_id
    LEFT JOIN lis_cases lc ON lc.partner_id = cr.partner_id AND lc.case_no = cr.case_no
    WHERE ${where}
  `).all(...params) as RevenueRow[]

  if (revRows.length === 0) return []

  // marker 按 (partner_id, case_no) 分组（等价 CTE·防扇出）。markers 无 service_month，按 partner 过滤（给了 partnerId 时）。
  const markerKey = (pid: string | null, caseNo: string): string => `${pid ?? ''}||${caseNo}`
  const markersByCase = new Map<string, Array<{ markerName: string; adviceType: string | null }>>()
  {
    let mWhere = '1=1'
    const mParams: unknown[] = []
    if (opts.partnerId) { mWhere += ' AND partner_id = ?'; mParams.push(opts.partnerId) }
    const mRows = db.prepare(`SELECT case_no, partner_id, marker_name, advice_type FROM lis_case_markers WHERE ${mWhere}`).all(...mParams) as Array<{
      case_no: string
      partner_id: string | null
      marker_name: string
      advice_type: string | null
    }>
    for (const m of mRows) {
      const k = markerKey(m.partner_id, m.case_no)
      const arr = markersByCase.get(k) ?? []
      arr.push({ markerName: m.marker_name, adviceType: m.advice_type })
      markersByCase.set(k, arr)
    }
  }

  // 价查询器 + 参数（一次构建·全 case 复用）
  const index = buildDbLedgerIndex(db)
  const synonym = buildSynonymMapFromDb(db)
  const resolvePrice: PriceResolver = (name) => {
    const r = resolveAntibodyName(name, index, synonym)
    return { perTestPrice: r.perTestPrice }
  }
  const secondaryPerSlide = loadSecondaryPerSlide(db)
  const stain = loadStainPerSlide(db)
  const params2: CaseCmParams = { secondaryPerSlide, stainPerSlide: stain.perSlide, stainIsPlaceholder: stain.isPlaceholder }

  // §10.E 跨月复用检测（HIGH·防双计）：case_no 在 case_revenue 跨多个 service_month 复用（lis_cases 键无月·ON CONFLICT 覆盖）
  //   → 同一份 marker/标量会被多月各计一次。命中者【禁输出贡献毛利·标 cross_month_reuse】，不进任何成本上卷（诚实挡）。
  const collisionKeys = loadCrossMonthReuseKeys(db, opts.partnerId)

  return revRows.map((r) => {
    const markers = markersByCase.get(markerKey(r.partner_id, r.case_no)) ?? []
    const input: P0CaseInput = {
      caseNo: r.case_no,
      partnerId: r.partner_id ?? '',
      partnerName: r.partner_name,
      serviceMonth: r.service_month,
      labRevenue: Number(r.lab_revenue) || 0,
      revenueSource: r.revenue_source,
      markers,
      specialStainCount: Number(r.special_stain_count) || 0,
      blockCount: Number(r.block_count) || 0,
      ihcCount: Number(r.ihc_count) || 0,
      tissueProcessing: loadPartnerTissueDefault(db, r.partner_id ?? ''),
    }
    if (collisionKeys.has(markerKey(r.partner_id, r.case_no))) return makeWithheldCase(input)
    return computeCaseCm(input, resolvePrice, params2)
  })
}

/**
 * §10.E 跨月复用键集：`GROUP BY partner_id,case_no HAVING COUNT(DISTINCT service_month)>1`。
 * 键 = `partner_id||case_no`（与 markerKey 同格式）。仅统计准入的 case（lab_revenue NOT NULL·revenue_source∈statement/corrected）。
 */
function loadCrossMonthReuseKeys(db: DbLike, partnerId?: string): Set<string> {
  const keys = new Set<string>()
  let where = "lab_revenue IS NOT NULL AND revenue_source IN ('statement','corrected')"
  const params: unknown[] = []
  if (partnerId) { where += ' AND partner_id = ?'; params.push(partnerId) }
  const rows = db.prepare(`
    SELECT partner_id, case_no FROM case_revenue
    WHERE ${where}
    GROUP BY partner_id, case_no
    HAVING COUNT(DISTINCT service_month) > 1
  `).all(...params) as Array<{ partner_id: string | null; case_no: string }>
  for (const r of rows) keys.add(`${r.partner_id ?? ''}||${r.case_no}`)
  return keys
}

/** 按 partner 上卷院级贡献毛利（每 partner 一行·同月）。 */
export function buildHospitalCmByPartner(db: DbLike, opts: LoadHospitalCmOpts = {}): HospitalCm[] {
  const cases = loadHospitalCmCases(db, opts)
  const byPartner = new Map<string, P0CaseCm[]>()
  const names = new Map<string, string | null>()
  // partner 名从 revenue 行带回来不方便（cases 已丢名）→ 再查一次 partners 名（少量·院数有限）
  for (const c of cases) {
    const arr = byPartner.get(c.partnerId) ?? []
    arr.push(c)
    byPartner.set(c.partnerId, arr)
  }
  try {
    const rows = db.prepare('SELECT id, name FROM partners').all() as Array<{ id: string; name: string | null }>
    for (const r of rows) names.set(r.id, r.name)
  } catch {
    /* ignore */
  }
  const out: HospitalCm[] = []
  for (const [pid, arr] of byPartner) {
    out.push(rollupHospitalCm(arr, { partnerName: names.get(pid) ?? null, serviceMonth: opts.serviceMonth ?? null, settled: opts.settled }))
  }
  return out
}

export interface HospitalCmTrendPoint {
  serviceMonth: string
  hospitalCm: number
  labRevenueInRate: number
  cmRate: number
  revenueCaseCount: number
  /** 该月口径（§三.9·LEG-3）：跨月口径变更（仅染色→完整/混合）在趋势线上要标竖线，否则口径切换被读成业务波动。 */
  caliber: '完整' | '仅染色' | '混合'
}

/** 某院月度趋势（按 service_month 时序·同账户历史·供第 2 层对照表的 trend 列）。 */
export function buildHospitalCmTrend(db: DbLike, partnerId: string): HospitalCmTrendPoint[] {
  const cases = loadHospitalCmCases(db, { partnerId })
  const byMonth = new Map<string, P0CaseCm[]>()
  for (const c of cases) {
    const m = c.serviceMonth
    if (!m) continue
    const arr = byMonth.get(m) ?? []
    arr.push(c)
    byMonth.set(m, arr)
  }
  const points: HospitalCmTrendPoint[] = []
  for (const [m, arr] of byMonth) {
    const h = rollupHospitalCm(arr, { serviceMonth: m })
    points.push({ serviceMonth: m, hospitalCm: h.hospitalCm, labRevenueInRate: h.labRevenueInRate, cmRate: h.cmRate, revenueCaseCount: h.revenueCaseCount, caliber: h.caliber })
  }
  return points.sort((a, b) => a.serviceMonth.localeCompare(b.serviceMonth))
}

/**
 * **批量**院月趋势（一次装载·避免对照表逐院 N+1 重建价格账本/同义词索引）。
 * 与 `buildHospitalCmTrend(db, pid)` **逐点等价**（同一 loadHospitalCmCases→rollupHospitalCm 路径），
 * 但索引/同义词只建一次、case+marker 只全扫一次 → 对照表 N 家医院一次成型（而非 N 次重建）。
 * 返回 Map<partnerId, 时序（升序）>。
 */
export function buildHospitalCmTrendByPartner(db: DbLike): Map<string, HospitalCmTrendPoint[]> {
  const cases = loadHospitalCmCases(db, {}) // 全院全月一次装载（索引/同义词建一次）
  const byPartnerMonth = new Map<string, Map<string, P0CaseCm[]>>()
  for (const c of cases) {
    if (!c.serviceMonth) continue
    const months = byPartnerMonth.get(c.partnerId) ?? new Map<string, P0CaseCm[]>()
    const arr = months.get(c.serviceMonth) ?? []
    arr.push(c)
    months.set(c.serviceMonth, arr)
    byPartnerMonth.set(c.partnerId, months)
  }
  const out = new Map<string, HospitalCmTrendPoint[]>()
  for (const [pid, months] of byPartnerMonth) {
    const points: HospitalCmTrendPoint[] = []
    for (const [m, arr] of months) {
      const h = rollupHospitalCm(arr, { serviceMonth: m })
      points.push({ serviceMonth: m, hospitalCm: h.hospitalCm, labRevenueInRate: h.labRevenueInRate, cmRate: h.cmRate, revenueCaseCount: h.revenueCaseCount, caliber: h.caliber })
    }
    points.sort((a, b) => a.serviceMonth.localeCompare(b.serviceMonth))
    out.set(pid, points)
  }
  return out
}
