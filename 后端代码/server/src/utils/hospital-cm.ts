/**
 * 院级贡献毛利（标准成本口径）—— P0 内圈的**新独立 lane**（纯口径函数，无 DB 依赖，可被路由 + 测试共享）。
 *
 * 权威依据（框死·违反即 bug）：
 *   · `docs/COREONE-成本口径-P0内圈-院级贡献毛利-绝对最小业务逻辑-2026-07-04.md`（§2 公式 / §3 白名单 / §4 不变量 / §5 状态真值表 / §10 工程契约）
 *   · `/CONTEXT.md`（术语：贡献毛利、实收 lab_revenue、可避免材料、① 与 ①* 估值、桶A桶B、同源不变量）
 *   · ADR-001（月轴 service_month）/ ADR-002（染色成本同源锁 lab_revenue>0）/ ADR-004（率仅 IHC 线）/ ADR-006（行动清单非记分牌）
 *
 * 诚实措辞（红线·CONTEXT.md）：本 lane 产出 **贡献毛利（标准成本口径）** —— 实收与片数是真值(①)，
 *   可避免成本是**约定标准成本**(①/①*·非实测消耗)。**全文不得称"真实成本/真数/利润/盈利/亏损"。**
 *
 * 与现有代码的边界（P0 spec §8·红队已核）：
 *   · P0 是新的直算 lane：case_revenue + lis_case_markers/lis_cases + 约定价 → 贡献毛利。
 *   · **不复用** `partner-pnl-service` 的 `grossMargin`（= 收入 − ABC 全成本，中圈 lane），与它并存、不改它。
 *   · **绝不引入** 工时/设备/房租/在编人力/对照片（②，中圈 ABC）——结构上此文件不存在 labor/equipment 字段。
 *   · **绝不复用** `computeFullSlideCost` 整包（它含 laborPerSlide/equipmentPerSlide）。只取一抗价 + 二抗 + 特染材料。
 */

// ────────────────────────────────────────────────────────────────────────────
// 具名常量（P0 spec §5/§10.B·值待 PM 校准，先给保守默认；改常量 = 显式立法动作，drift-guard 测试守）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 院级贡献毛利业务公式版本。
 *
 * 这不是 readiness 探针版本：任何会改变 `computeCaseCm`、`rollupHospitalCm`
 * 或成本装载语义的变更，都必须显式 bump 本版本，并让历史周期证据绑定该值。
 */
export const HOSPITAL_CM_FORMULA_VERSION = '2026-07-21.a' as const

/** 真抗体申请类型白名单（§10.B）。一行 = 一片一抗（不去重）；Y000006 HE深切重切 / Y000007 白片 / 其它码不计。
 *  与 `reconcile-account.ts` 的 ANTIBODY_ADVICE 同源（Y000001/Y000003）。 */
export const P0_ANTIBODY_ADVICE_TYPES = new Set(['Y000001', 'Y000003'])

/** 二抗/显色每片约定价（桶A·纯①）。台账真价 ¥15（ihc_cost_params.secondary_per_slide，14~16）。DB 缺则回退此默认。 */
export const SECONDARY_PER_SLIDE_DEFAULT = 15

/**
 * 组织处理耗材每蜡块约定价（桶B·①*）。
 * PM 拍板（2026-07-06·D①）：首版即含；由康湾真实结转成本台账校准 = **¥7/蜡块**
 *   （BOM 首估 ¥3 把切片刀/载玻片/石蜡摊太薄；实台账羽毛切片刀¥442/盒·载玻片¥66·石蜡¥40.96·固定液¥55 → ¥6-8/块）。
 * ①* = 约定标准价（非实测消耗）。**仅当** 工序集 tissue_processing===true（本院执行该工序）才计入（同源不变量①）。
 * 见记忆 coreone-cm-target-attempt-real-data / P0 spec §2·§7·§10.B。
 */
export const P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK = 7

/**
 * 数据质量/稳健层阈值（§5·保守默认·待 PM 校准·被 ADR-007 首月 golden 兜底）。
 * 改任一值 = 显式立法（drift-guard 测试锁死）。
 */
export const CM_THRESHOLDS = {
  MAX_MISSING_PRICE_RATE: 0.10, // 缺价暴露率上限
  MAX_STAR_RATE: 0.60, // ①*估值占比上限（超 → 需校准约定价）
  MIN_COVERAGE: 0.85, // 覆盖率下限
  MIN_LINE_COVERAGE: 0.70, // P0率覆盖技术收入占比下限（超低 → 率≠全院毛利，显式标）
  MAX_UNSCOPED: 0.15, // needs_tissue_scope 占比上限（仅判完整口径）
  MAX_STAIN_PLACEHOLDER_RATE: 0.50, // 特染占位价片数占比上限（§10.B M4·超 → 需校准约定价(特染)，勿静默出数）
  MIN_CASES_FOR_VERDICT: 20, // 出去留判定的最小有效 case 数
  PERSIST_MONTHS: 3, // 停止候选的连续/多数已结算月数
} as const

/**
 * 经营红线（G-1 闸·§5 降级规矩）：`CM_TARGET` / `CM_MARGIN_FOR_VARLABOR` 是经营红线。
 * **PM 正式拍板前恒为 null** → 命中 G-1 → 状态 `经营线未定·仅供观察`：数字照出+可排序，**不驱动强判定**（可留/停止候选/需谈价）。
 * 解锁路径（不凭空定数·ADR-005/ADR-007）：首个真实已关账 golden 院月落地后，看实际分布定初始档，PM 签字才解锁。
 * ⚠️ 四轮外审收敛：CM_TARGET 拍不了一个绝对单值（全流程 CM 是随 case-mix 的带 65%-87%），
 *    这两个常量最终服务的是**处方层目标报价**（底线+谈判余量），**不再作检测触发器**（见 portfolio-health.ts）。
 */
export const CM_TARGET: number | null = null
export const CM_MARGIN_FOR_VARLABOR: number | null = null

// ────────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────────

/** lis_case_markers 行（逐切片一抗明细）。 */
export interface P0MarkerRow {
  markerName: string
  adviceType: string | null
}

/** 单 case P0 输入（收入 + LIS 明细 + 工序集）。 */
export interface P0CaseInput {
  caseNo: string
  partnerId: string
  partnerName?: string | null
  serviceMonth?: string | null
  labRevenue: number // case_revenue.lab_revenue（=Σ IN 结算·实收·绝不用 net_amount）
  revenueSource: string | null // 仅 statement/corrected 计入（准入在 service 层已过滤，此处仅透传）
  markers: P0MarkerRow[] // lis_case_markers 行（一行一片一抗）
  specialStainCount: number // lis_cases.special_stain_count（每例单行标量）
  blockCount: number // lis_cases.block_count（每例单行标量）
  ihcCount: number // lis_cases.ihc_count（reconcile 权威物理片数·一致性校验用）
  tissueProcessing: boolean | null // 工序集前处理：true=本院做/false=代送加做未做/null=未知（partner 默认或 case 覆盖）
  hasVoidLine?: boolean // 部分冲红标记（case_revenue_lines 有负 net_amount 行·可选，缺则 undefined）
}

/** 单 case 价查询（注入·保持纯函数可测）。返回一抗每片约定价（缺价 → null，不进桶B）。 */
export type PriceResolver = (markerName: string) => { perTestPrice: number | null }

/**
 * case 归桶（§4⑧/§10.C 准入闸）：
 *  · staining          = labRevenue>0 且有 IHC 材料信号（真抗体 marker 或 special_stain>0）→ 进染色贡献毛利
 *  · diagnosis         = labRevenue<=0 但有 marker（代阅片/纯诊断·医院自己染）→ 移出、不减任何成本、计"诊断桶 case 数"
 *  · non_ihc           = labRevenue>0 但无 IHC 材料信号（细胞/冰冻/宫颈/缺marker）→ 出率外·成本未建模·单列收入
 *  · excluded          = labRevenue<=0 且无 marker（全额冲红/无技术无信号）→ 计"作废/移出" 桶
 *  · cross_month_reuse = 跨月身份异常（#163 阶段2 收窄：仅当跨月身份夹 NULL/非法月份行、无法安全归因）→ **禁输出贡献毛利**、
 *      标"跨月身份异常·需清理"，不进任何成本上卷。合法跨月（多月均合法）不再整例扣留：成本按各月 lab_revenue
 *      占比分摊（DEC-163-ROUND-001=C·见 allocateCrossMonthCostByLabRevenue）。
 */
export type CaseBucket = 'staining' | 'diagnosis' | 'non_ihc' | 'excluded' | 'cross_month_reuse'

/** 口径：完整（含组织处理）| 仅染色（不含前处理·tissue 未知或未做）。 */
export type CmCaliber = '完整' | '仅染色'

/** 单 case 贡献毛利结果。**结构上无 labor / equipment 字段 = §3 白名单外一律不进的编译期保证。** */
export interface P0CaseCm {
  caseNo: string
  partnerId: string
  serviceMonth?: string | null
  labRevenue: number
  bucketA: number // 二抗显色（纯①）= billableSlides × secondary_per_slide
  bucketB: number // ①*估材料 = Σ一抗约定价(有价行) + special_stain × 特染每片 + 组织处理(仅 tissue=true)
  avoidableCost: number // 桶A + 桶B（可避免材料成本）
  cm: number // 贡献毛利(标准成本口径) = labRevenue − avoidableCost
  billableSlides: number // 一抗计价片数（真抗体 marker 行数·不去重）
  missingPriceSlides: number // 缺价暴露片数（per_test_price 查无·不进桶B合计）
  ihcCount: number // lis_cases.ihc_count（reconcile 权威物理片数·§10.D coverage 计算用）
  specialStainSlides: number // 特染片数（special_stain_count·仅 staining 计）
  placeholderStainSlides: number // 特染中用占位价（无 actual_yield 校准）的片数（§10.B M4 披露用）
  starRatio: number // ①*估值占比 = bucketB / (bucketA+bucketB)
  bucket: CaseBucket
  caliber: CmCaliber
  needsTissueScope: boolean // staining 但 tissue_processing 未知 → 仅染色口径 + 标注
  hasVoidLine?: boolean // 部分冲红（含冲红调整·无双计·负行已在 lab_revenue 净额里扣过）
}

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const r4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000

/** 该 marker 行是否为真抗体计价行（advice_type ∈ 白名单）。 */
export function isBillableAntibodyRow(row: P0MarkerRow): boolean {
  return row.adviceType != null && P0_ANTIBODY_ADVICE_TYPES.has(row.adviceType)
}

// ────────────────────────────────────────────────────────────────────────────
// 单 case 计算（§2 公式·①/①* 分桶·同源闸·准入闸）
// ────────────────────────────────────────────────────────────────────────────

export interface CaseCmParams {
  secondaryPerSlide?: number // 桶A 每片二抗显色（缺 → SECONDARY_PER_SLIDE_DEFAULT）
  stainPerSlide?: number // 特染每片约定价（kit_price/denom·labor-free·缺 → 0，即无特染定价则不减）
  stainIsPlaceholder?: boolean // 特染每片价是否占位（无 actual_yield 校准·§10.B M4 → 计 placeholderStainSlides 披露）
  tissueMaterialPerBlock?: number // 组织处理每蜡块约定价（缺 → P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK）
}

/**
 * 单 case 贡献毛利。同源闸 + 准入闸 + ①/①* 分桶。
 *
 * ⚠️ 桶A（二抗显色）按**每片一抗都发生** → 用 billableSlides（含缺价行·二抗显色与一抗是否缺价无关）；
 *    桶B（一抗约定价）**只累加有价行**，缺价行只进 missingPriceSlides（§2 line 46）。
 * ⚠️ 组织处理**仅当** tissueProcessing===true 才计入（同源不变量①：代送加做 case 不减未由本院执行的前处理）。
 */
export function computeCaseCm(input: P0CaseInput, resolvePrice: PriceResolver, params: CaseCmParams = {}): P0CaseCm {
  const secondaryPerSlide = params.secondaryPerSlide ?? SECONDARY_PER_SLIDE_DEFAULT
  const stainPerSlide = params.stainPerSlide ?? 0
  const tissueMaterialPerBlock = params.tissueMaterialPerBlock ?? P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK
  const labRevenue = Number(input.labRevenue) || 0

  const antibodyRows = input.markers.filter(isBillableAntibodyRow)
  const billableSlides = antibodyRows.length
  const specialStainCount = Math.max(0, Number(input.specialStainCount) || 0)
  const blockCount = Math.max(0, Number(input.blockCount) || 0)
  const hasStainSignal = billableSlides > 0 || specialStainCount > 0

  const ihcCount = Math.max(0, Number(input.ihcCount) || 0)
  const zero: Omit<P0CaseCm, 'bucket' | 'caliber'> = {
    caseNo: input.caseNo,
    partnerId: input.partnerId,
    serviceMonth: input.serviceMonth ?? null,
    labRevenue: r2(labRevenue),
    bucketA: 0,
    bucketB: 0,
    avoidableCost: 0,
    cm: 0,
    billableSlides,
    missingPriceSlides: 0,
    ihcCount,
    specialStainSlides: 0,
    placeholderStainSlides: 0,
    starRatio: 0,
    needsTissueScope: false,
    hasVoidLine: input.hasVoidLine,
  }

  // —— 同源闸（ADR-002·最关键）：染色成本只在 lab_revenue > 0 时扣 ——
  if (labRevenue <= 0) {
    // 甲真乙假（有 marker 但 lab_revenue=0）= 代阅片/纯诊断（医院自己染，只送片来我们出报告）→ 诊断桶，不减任何成本
    // 甲假乙假（无 marker + lab_revenue<=0）= 全额冲红/无技术无信号 → excluded
    return { ...zero, bucket: hasStainSignal ? 'diagnosis' : 'excluded', caliber: '仅染色', cm: 0, avoidableCost: 0 }
  }

  // labRevenue > 0：
  // 乙真甲假（有技术实收但无 IHC 材料信号）= 非IHC线（细胞/冰冻/宫颈/缺marker）→ 出率外·成本未建模·单列收入
  if (!hasStainSignal) {
    return { ...zero, bucket: 'non_ihc', caliber: '仅染色', cm: 0, avoidableCost: 0 }
  }

  // 甲 AND 乙 = 我们染的 → 出染色贡献毛利
  // 桶A（纯①）：每片二抗显色（含缺价一抗行——二抗是否发生与一抗缺价无关）
  const bucketA = r2(billableSlides * secondaryPerSlide)

  // 桶B（①*）：一抗约定价（仅有价行）+ 特染 + 组织处理
  let primaryTotal = 0
  let missingPriceSlides = 0
  for (const row of antibodyRows) {
    const price = resolvePrice(row.markerName)?.perTestPrice
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      primaryTotal += price
    } else {
      missingPriceSlides += 1 // 缺价行不进桶B合计，只累加缺价暴露片数
    }
  }
  const stainTotal = specialStainCount * stainPerSlide

  // 组织处理：仅当封闭参数已定（>0）且 tissueProcessing===true 才计入（§2 line 40）
  const tissueIncluded = input.tissueProcessing === true && tissueMaterialPerBlock > 0
  const tissueTotal = tissueIncluded ? blockCount * tissueMaterialPerBlock : 0
  const needsTissueScope = input.tissueProcessing !== true // 未知/false → 仅染色口径 + 标注（false 是代送加做正常态，仍标口径）

  const bucketB = r2(primaryTotal + stainTotal + tissueTotal)
  const avoidableCost = r2(bucketA + bucketB)
  const cm = r2(labRevenue - avoidableCost)
  const denom = bucketA + bucketB
  const starRatio = denom > 0 ? r4(bucketB / denom) : 0

  return {
    ...zero,
    bucketA,
    bucketB,
    avoidableCost,
    cm,
    missingPriceSlides,
    specialStainSlides: specialStainCount,
    placeholderStainSlides: params.stainIsPlaceholder && specialStainCount > 0 ? specialStainCount : 0,
    starRatio,
    bucket: 'staining',
    caliber: tissueIncluded ? '完整' : '仅染色',
    needsTissueScope,
  }
}

/**
 * §10.E 跨月身份异常禁输出：跨月身份夹 NULL/非法月份行（#163 阶段2 收窄后的兜底）→ 无法安全归因
 *   → **禁输出贡献毛利**、标 `cross_month_reuse`，不进任何成本上卷（诚实挡·非静默错配）。由 service 层检测后调用。
 *   合法跨月（多月均合法）不走这里——按 allocateCrossMonthCostByLabRevenue 分摊。
 */
export function makeWithheldCase(input: P0CaseInput): P0CaseCm {
  return {
    caseNo: input.caseNo,
    partnerId: input.partnerId,
    serviceMonth: input.serviceMonth ?? null,
    labRevenue: r2(Number(input.labRevenue) || 0),
    bucketA: 0,
    bucketB: 0,
    avoidableCost: 0,
    cm: 0,
    billableSlides: input.markers.filter(isBillableAntibodyRow).length,
    missingPriceSlides: 0,
    ihcCount: Math.max(0, Number(input.ihcCount) || 0),
    specialStainSlides: 0,
    placeholderStainSlides: 0,
    starRatio: 0,
    bucket: 'cross_month_reuse',
    caliber: '仅染色',
    needsTissueScope: false,
    hasVoidLine: input.hasVoidLine,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 跨月分摊（#163 阶段2；DEC-163-ROUND-001=C：按各月收入占比使用最大余数法分摊）
// ────────────────────────────────────────────────────────────────────────────

/** 跨月分摊输入月（仅合格月：service_month 合法且 lab_revenue>0·同源闸 ADR-002）。 */
export interface CrossMonthAllocationMonth {
  serviceMonth: string
  labRevenue: number
}

/** 跨月分摊输出月：整例可避免成本按 lab_revenue 占比拆到该月（分桶守恒）。 */
export interface CrossMonthAllocatedShare {
  serviceMonth: string
  bucketA: number
  bucketB: number
  avoidableCost: number
}

/**
 * 把整例可避免成本按各合格月 lab_revenue 占比分摊到月（DEC-163-ROUND-001=C）。
 *
 * 铁律：
 *   · 权重 = 该月 labRevenue / Σ合格月 labRevenue（**只读 lab_revenue**，绝不读 net_amount/gross_amount）；
 *   · bucketA / bucketB 分别以分为最小单位使用最大余数法，**精确守恒**（Σ 分摊 = 整例原值）；
 *     avoidableCost_m = r2(bucketA_m + bucketB_m)——与单例 `avoidableCost == r2(bucketA + bucketB)` 不变量同源；
 *   · 物理由度（片数/缺价片数）不拆：每月行保留整例值（成本事实只有一份，钱是跨月结算的）。
 *
 *   · 每个桶先取各月精确份额的整数分，剩余分按小数余数降序逐分分配；余数并列取最早 service_month；
 *   · avoidableCost 只等于该月 bucketA + bucketB，不建立第三套尾差；输入顺序不得改变结果。
 *
 * 前置（调用方保证，不在此重复判）：eligibleMonths 非空、每月 labRevenue>0、serviceMonth 合法且月内唯一。
 * 全零/负分母、退款/冲销等无业务答案的情形**不在此发明**——service 层的收窄守卫已先行拦截或绕行。
 */
export function allocateCrossMonthCostByLabRevenue(
  original: Pick<P0CaseCm, 'bucketA' | 'bucketB' | 'avoidableCost'>,
  eligibleMonths: CrossMonthAllocationMonth[],
): CrossMonthAllocatedShare[] {
  const fail = (): never => {
    const error = new Error('跨月成本分摊输入不可安全计算') as Error & { code: string }
    error.code = 'HOSPITAL_CM_CROSS_MONTH_ALLOCATION_INVALID'
    throw error
  }
  if (eligibleMonths.length === 0) return []
  const months = [...eligibleMonths].sort((left, right) => left.serviceMonth.localeCompare(right.serviceMonth))
  const monthKeys = new Set<string>()
  let totalLab = 0
  for (const month of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month.serviceMonth)
      || monthKeys.has(month.serviceMonth)
      || typeof month.labRevenue !== 'number'
      || !Number.isFinite(month.labRevenue)
      || month.labRevenue <= 0) fail()
    monthKeys.add(month.serviceMonth)
    totalLab += month.labRevenue
    if (!Number.isFinite(totalLab)) fail()
  }
  if (totalLab <= 0) fail()

  const toCents = (value: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fail()
    const cents = Math.round(value * 100)
    if (!Number.isSafeInteger(cents) || Math.abs(value - cents / 100) > 1e-9) return fail()
    return cents
  }
  const bucketCents = {
    bucketA: toCents(original.bucketA),
    bucketB: toCents(original.bucketB),
  }
  if (toCents(original.avoidableCost) !== bucketCents.bucketA + bucketCents.bucketB) fail()

  const allocatedByBucket = (totalCents: number): number[] => {
    const exact = months.map((month) => totalCents * (month.labRevenue / totalLab))
    if (exact.some((value) => !Number.isFinite(value) || value < 0)) return fail()
    const cents = exact.map((value) => Math.floor(value))
    const remaining = totalCents - cents.reduce((sum, value) => sum + value, 0)
    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > months.length) return fail()
    const ranked = exact
      .map((value, index) => ({ index, remainder: value - cents[index], serviceMonth: months[index].serviceMonth }))
      .sort((left, right) => right.remainder - left.remainder || left.serviceMonth.localeCompare(right.serviceMonth))
    for (let index = 0; index < remaining; index += 1) cents[ranked[index].index] += 1
    return cents
  }
  const bucketA = allocatedByBucket(bucketCents.bucketA)
  const bucketB = allocatedByBucket(bucketCents.bucketB)
  return months.map((month, index) => ({
    serviceMonth: month.serviceMonth,
    bucketA: bucketA[index] / 100,
    bucketB: bucketB[index] / 100,
    avoidableCost: (bucketA[index] + bucketB[index]) / 100,
  }))
}

// ────────────────────────────────────────────────────────────────────────────
// 院级上卷（§2 line 48 / §5 输出 / §10.D 分母定义）
// ────────────────────────────────────────────────────────────────────────────

/** 状态真值表输出词（§5）。CM_TARGET=null 时恒 `经营线未定·仅供观察`。 */
export type CmState = '经营线未定·仅供观察' | '需补数据' | '观察中·样本不足' | '暂态·待结算' | '可判定'

export interface HospitalCmDataQuality {
  coverage: number
  missingPriceRate: number
  starRatio: number
  lineCoverage: number // P0率覆盖技术收入占比
  needsTissueScopeRate: number
  stainPlaceholderShare: number // 特染占位价片数占比（§10.B M4·占位特染价勿与真台账价同级藏进桶B）
  needsData: boolean // 任一质量指标越阈 → true（先于经营判定）
}

export interface HospitalCm {
  partnerId: string
  partnerName?: string | null
  serviceMonth?: string | null
  // —— 主口径 ——
  hospitalCm: number // 院级贡献毛利(标准成本口径) = Σ_staining case cm
  labRevenueInRate: number // 进率的 IHC 线实收 = Σ_staining case lab_revenue
  cmRate: number // 贡献毛利率（跨院对比主指标·不变量④）= hospitalCm / labRevenueInRate
  cmPerSlide: number // 每片贡献毛利（跨院辅·case-mix 中性）= hospitalCm / Σ billableSlides
  cmPerCase: number // 每例贡献毛利（⚠️仅同院趋势·跨院禁用·case-mix 敏感）
  // —— 计数（§10.D）——
  revenueCaseCount: number // 进率的 case 数（staining·lab_revenue>0）
  diagnosisCaseCount: number // 诊断桶（代阅片·lab_revenue=0 有 marker）
  nonIhcRevenue: number // 非IHC线实收（细胞/冰冻/宫颈/缺marker·成本未建模）
  nonIhcCaseCount: number
  voidCaseCount: number // 作废/移出（lab_revenue<=0 无 marker）
  crossMonthReuseCaseCount: number // 跨月复用 case_no（§10.E·禁输出·需实例键）——不进任何成本上卷
  billableSlides: number
  // —— 桶 + 三诚实字段（§4③）——
  bucketA: number
  bucketB: number
  quality: HospitalCmDataQuality
  caliber: '完整' | '仅染色' | '混合'
  // —— 状态（§5·G-1 优先）——
  state: CmState
  confidence: 'high' | 'low'
  businessLineDefined: boolean // CM_TARGET 是否已拍板（false → G-1）
}

/** 院级上卷 + 状态真值表。只吃 computeCaseCm 的结果（分桶已定）。 */
export function rollupHospitalCm(
  cases: P0CaseCm[],
  opts: { partnerName?: string | null; serviceMonth?: string | null; settled?: boolean } = {},
): HospitalCm {
  const staining = cases.filter((c) => c.bucket === 'staining')
  const diagnosis = cases.filter((c) => c.bucket === 'diagnosis')
  const nonIhc = cases.filter((c) => c.bucket === 'non_ihc')
  const voids = cases.filter((c) => c.bucket === 'excluded')
  const crossMonthReuse = cases.filter((c) => c.bucket === 'cross_month_reuse') // §10.E 禁输出·不进任何成本上卷

  const hospitalCm = r2(staining.reduce((s, c) => s + c.cm, 0))
  const labRevenueInRate = r2(staining.reduce((s, c) => s + c.labRevenue, 0))
  const bucketA = r2(staining.reduce((s, c) => s + c.bucketA, 0))
  const bucketB = r2(staining.reduce((s, c) => s + c.bucketB, 0))
  const billableSlides = staining.reduce((s, c) => s + c.billableSlides, 0)
  const totalAntibodyRows = billableSlides // billableSlides 已含缺价行（缺价行仍是真抗体 marker 行）
  const missingSlides = staining.reduce((s, c) => s + c.missingPriceSlides, 0)
  const nonIhcRevenue = r2(nonIhc.reduce((s, c) => s + c.labRevenue, 0))

  const revenueCaseCount = staining.length
  const denomBucket = bucketA + bucketB
  const starRatio = denomBucket > 0 ? r4(bucketB / denomBucket) : 0
  const missingPriceRate = totalAntibodyRows > 0 ? r4(missingSlides / totalAntibodyRows) : 0
  // coverage（§10.D）：有真抗体 marker 或 ihc_count=0 的 case / revenue_case_count。
  //   读 ihc_count（非 bucketA===0 近似）→ 抓"LIS 记了物理 IHC 片(ihc_count>0)却零 marker 明细"的真覆盖缺口。
  const covered = staining.filter((c) => c.billableSlides > 0 || c.ihcCount === 0).length
  const coverage = revenueCaseCount > 0 ? r4(covered / revenueCaseCount) : 0
  const lineCoverage = labRevenueInRate + nonIhcRevenue > 0 ? r4(labRevenueInRate / (labRevenueInRate + nonIhcRevenue)) : 1
  const needsTissueScopeRate = revenueCaseCount > 0 ? r4(staining.filter((c) => c.needsTissueScope).length / revenueCaseCount) : 0
  const totalStainSlides = staining.reduce((s, c) => s + c.specialStainSlides, 0)
  const placeholderStainSlides = staining.reduce((s, c) => s + c.placeholderStainSlides, 0)
  const stainPlaceholderShare = totalStainSlides > 0 ? r4(placeholderStainSlides / totalStainSlides) : 0

  const needsData =
    missingPriceRate > CM_THRESHOLDS.MAX_MISSING_PRICE_RATE ||
    starRatio > CM_THRESHOLDS.MAX_STAR_RATE ||
    coverage < CM_THRESHOLDS.MIN_COVERAGE ||
    lineCoverage < CM_THRESHOLDS.MIN_LINE_COVERAGE ||
    stainPlaceholderShare > CM_THRESHOLDS.MAX_STAIN_PLACEHOLDER_RATE

  const quality: HospitalCmDataQuality = { coverage, missingPriceRate, starRatio, lineCoverage, needsTissueScopeRate, stainPlaceholderShare, needsData }

  // 口径混合判定
  const calibers = new Set(staining.map((c) => c.caliber))
  const caliber: HospitalCm['caliber'] = calibers.size === 0 ? '仅染色' : calibers.size > 1 ? '混合' : [...calibers][0]

  // 状态真值表（§5·判定顺序 G-1 → G0 → G1 → G2）
  const businessLineDefined = CM_TARGET != null
  let state: CmState
  if (!businessLineDefined) {
    state = '经营线未定·仅供观察' // G-1：数字照出+可排序，不驱动强判定
  } else if (needsData) {
    state = '需补数据'
  } else if (revenueCaseCount < CM_THRESHOLDS.MIN_CASES_FOR_VERDICT) {
    state = '观察中·样本不足'
  } else if (opts.settled === false) {
    state = '暂态·待结算'
  } else {
    state = '可判定'
  }

  // 置信（§5 line 109）：低质量 → 低置信（即便同为"经营线未定"也须可见）
  const confidence: 'high' | 'low' =
    coverage >= 0.95 && missingPriceRate <= 0.05 && starRatio <= 0.30 ? 'high' : 'low'

  return {
    partnerId: cases[0]?.partnerId ?? '',
    partnerName: opts.partnerName ?? null,
    serviceMonth: opts.serviceMonth ?? null,
    hospitalCm,
    labRevenueInRate,
    cmRate: labRevenueInRate > 0 ? r4(hospitalCm / labRevenueInRate) : 0,
    cmPerSlide: billableSlides > 0 ? r2(hospitalCm / billableSlides) : 0,
    cmPerCase: revenueCaseCount > 0 ? r2(hospitalCm / revenueCaseCount) : 0,
    revenueCaseCount,
    diagnosisCaseCount: diagnosis.length,
    nonIhcRevenue,
    nonIhcCaseCount: nonIhc.length,
    voidCaseCount: voids.length,
    crossMonthReuseCaseCount: crossMonthReuse.length,
    billableSlides,
    bucketA,
    bucketB,
    quality,
    caliber,
    state,
    confidence,
    businessLineDefined,
  }
}

/**
 * 公式行为制品：用规范正反例同时执行单例计算与院级上卷。
 * readiness 常量门对该结果做签名，因此即使开发者忘记 bump 公式版本，行为变化也会让旧证据自动失效。
 * 这里不使用数据库或测试 fixture，也不代表真实业务周期，只是可重复的代码语义指纹。
 */
export function currentHospitalCmFormulaBehaviorArtifact(): Record<string, unknown> {
  const staining = computeCaseCm({
    caseNo: 'BEHAVIOR-STAINING',
    partnerId: 'BEHAVIOR-PARTNER',
    serviceMonth: '2000-01',
    labRevenue: 1000,
    revenueSource: 'statement',
    markers: [
      { markerName: 'KNOWN', adviceType: 'Y000001' },
      { markerName: 'MISSING', adviceType: 'Y000003' },
      { markerName: 'NOT-BILLABLE', adviceType: 'Y000007' },
    ],
    specialStainCount: 2,
    blockCount: 3,
    ihcCount: 2,
    tissueProcessing: true,
  }, (markerName) => ({ perTestPrice: markerName === 'KNOWN' ? 100 : null }), {
    secondaryPerSlide: 15,
    stainPerSlide: 8,
    tissueMaterialPerBlock: 7,
  })
  const diagnosis = computeCaseCm({
    caseNo: 'BEHAVIOR-DIAGNOSIS',
    partnerId: 'BEHAVIOR-PARTNER',
    serviceMonth: '2000-01',
    labRevenue: 0,
    revenueSource: 'statement',
    markers: [{ markerName: 'KNOWN', adviceType: 'Y000001' }],
    specialStainCount: 0,
    blockCount: 0,
    ihcCount: 1,
    tissueProcessing: false,
  }, () => ({ perTestPrice: 100 }))
  const nonIhc = computeCaseCm({
    caseNo: 'BEHAVIOR-NON-IHC',
    partnerId: 'BEHAVIOR-PARTNER',
    serviceMonth: '2000-01',
    labRevenue: 250,
    revenueSource: 'corrected',
    markers: [],
    specialStainCount: 0,
    blockCount: 1,
    ihcCount: 0,
    tissueProcessing: null,
  }, () => ({ perTestPrice: null }))
  const rollup = rollupHospitalCm([staining, diagnosis, nonIhc], {
    partnerName: 'BEHAVIOR-PARTNER',
    serviceMonth: '2000-01',
    settled: true,
  })
  // DEC-163=C 规范例：逐 bucket 最大余数法；该例能区分旧“权重最大月回填”实现。
  const crossMonthShares = allocateCrossMonthCostByLabRevenue(
    { bucketA: 0.02, bucketB: 0.01, avoidableCost: 0.03 },
    [
      { serviceMonth: '2000-01', labRevenue: 40 },
      { serviceMonth: '2000-02', labRevenue: 35 },
      { serviceMonth: '2000-03', labRevenue: 25 },
    ],
  )

  return {
    cases: [staining, diagnosis, nonIhc].map((item) => ({
      bucket: item.bucket,
      caliber: item.caliber,
      labRevenue: item.labRevenue,
      bucketA: item.bucketA,
      bucketB: item.bucketB,
      avoidableCost: item.avoidableCost,
      cm: item.cm,
      billableSlides: item.billableSlides,
      missingPriceSlides: item.missingPriceSlides,
      specialStainSlides: item.specialStainSlides,
      needsTissueScope: item.needsTissueScope,
    })),
    rollup: {
      hospitalCm: rollup.hospitalCm,
      labRevenueInRate: rollup.labRevenueInRate,
      cmRate: rollup.cmRate,
      cmPerSlide: rollup.cmPerSlide,
      cmPerCase: rollup.cmPerCase,
      revenueCaseCount: rollup.revenueCaseCount,
      diagnosisCaseCount: rollup.diagnosisCaseCount,
      nonIhcRevenue: rollup.nonIhcRevenue,
      nonIhcCaseCount: rollup.nonIhcCaseCount,
      billableSlides: rollup.billableSlides,
      bucketA: rollup.bucketA,
      bucketB: rollup.bucketB,
      quality: rollup.quality,
      caliber: rollup.caliber,
      state: rollup.state,
      confidence: rollup.confidence,
      businessLineDefined: rollup.businessLineDefined,
    },
    crossMonthAllocation: {
      original: { bucketA: 0.02, bucketB: 0.01, avoidableCost: 0.03 },
      shares: crossMonthShares,
    },
  }
}
