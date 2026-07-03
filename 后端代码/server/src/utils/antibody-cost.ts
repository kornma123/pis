/**
 * 逐抗体成本 —— 纯口径函数（Phase 0 成本地基，无 DB 依赖，可被路由 + 测试共享）。
 *
 * 设计基线 §1.3 红线：
 *  · 必须逐抗体（台账真价 ¥0.29~99.82，差约 344 倍；原液/即用差 6 倍）——不能用一个均价。
 *  · 每片一抗成本 = 台账「每人份价（已换算）」直接取，**勿再除换算率**（曾除重致数字离谱的坑）。
 *  · 「算全」= 一抗真价 + 二抗/显色 + 工时(G2 估) + 设备(G2 估)。工时/设备是成本 band 里最弱的一半（未决 B4，
 *    待康湾真实工资/折旧/房租校准）——始终以 `laborEquipmentSource='G2估'` 透明标注，不冒充精确。
 *  · 完整度分档：精算（有台账真价）↔ 粗估（缺价 → 降级全院均价、行级标「成本缺价·毛利待定」）。
 */
import { ANTIBODY_LEDGER_SEED, type AntibodyLedgerDef } from './antibody-catalog.js'

export interface AntibodyCostInput {
  name?: string
  form?: string | null // 原液 | 即用
  perTestPrice?: number | null // 每人份价（已换算）—— 每片一抗成本直接取此列
  category?: string | null
}

/** 每片「算全」的估算参数（二抗/显色真价 + 工时/设备 G2 估）。 */
export interface IhcCostParams {
  secondaryPerSlide: number // 二抗/显色 共享（上机二抗测试条 ~¥15/片，台账真价 14~16）
  laborPerSlide: number // 工时（缺省 G2 估·弱锚·待校准 B4；真实工资校准后可翻牌）
  equipmentPerSlide: number // 设备折旧（缺省 G2 估·弱锚·待校准 B4）
  // ── B4 诚实透出用可选元数据（不影响数值，只决定 laborEquipmentSource 如实标注）──
  //   缺省（undefined/false）= 仍视为 G2 估弱锚；真实数据校准写回后置 true → 翻牌「已校准」。
  laborCalibrated?: boolean
  equipmentCalibrated?: boolean
}

/**
 * 工时/设备校准状态（B4 诚实透出）。弱锚只有工时/设备两半——
 *  · 'G2估'   ：两半都还是 G2 估占位（默认）。
 *  · '部分校准'：只有一半用真实数据校准过。
 *  · '已校准' ：两半都用康湾真实工资/折旧校准过。
 * 与「精算/粗估」正交：后者只看一抗有没有台账真价，前者只讲工时/设备这半有多牢。
 */
export type CalibrationState = 'G2估' | '部分校准' | '已校准'

/**
 * 默认 G2 估参数（占位·待康湾真实工资/折旧校准 B4）：
 *  · secondaryPerSlide=15：台账「上机用二抗测试条」~¥15/片（真价锚）。
 *  · laborPerSlide=8 / equipmentPerSlide=3：G2 估占位，明确弱锚——`ihc_cost_params` 表可配、UI 应显示「G2 估·待校准」。
 */
export const DEFAULT_IHC_COST_PARAMS: IhcCostParams = {
  secondaryPerSlide: 15,
  laborPerSlide: 8,
  equipmentPerSlide: 3,
}

export type Completeness = '精算' | '粗估'

export interface SlideCostBreakdown {
  primary: number // 一抗
  secondary: number // 二抗/显色
  labor: number // 工时（G2 估）
  equipment: number // 设备（G2 估）
  total: number
  completeness: Completeness
  laborEquipmentSource: CalibrationState // 工时/设备校准状态（诚实透出 B4，随参数元数据派生；不影响精算/粗估——那只看一抗真价）
  note?: string // 粗估时行级标注
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

// 收入侧 statement-revenue.ts 的 round2 忠实复刻（+Number.EPSILON），保证 B3 band 金额与活公式逐分一致、不漂移。
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * 判定单个「算全」参数是否已脱离 G2 估弱锚（被真实数据校准）。
 * 判据（诚实、保守）：置信含「已校准」/「精算」/「台账真价」→ 已校准；
 *   缺省 / 来源含 G2估 / 置信含粗估 → 未校准（宁可标弱，不冒充精确）。
 */
export function isParamCalibrated(meta?: { source?: string | null; confidence?: string | null }): boolean {
  if (!meta) return false
  const src = String(meta.source ?? '')
  const conf = String(meta.confidence ?? '')
  // 明确弱锚信号 → 未校准（优先判定，宁可标弱）
  if (src.includes('G2') || conf.includes('粗估')) return false
  // 明确已离开弱锚的信号（校准/实测/台账真价）
  if (conf.includes('已校准') || conf.includes('精算') || conf.includes('台账真价')) return true
  if (src.includes('校准') || src.includes('实测')) return true
  // 其余（含缺省、裸「手工」）保守视为未校准——不因一次手工微调就冒充「已校准」
  return false
}

/** 由工时/设备两半的校准布尔派生整体校准状态（B4 诚实透出）。 */
export function deriveCalibrationState(laborCalibrated: boolean, equipmentCalibrated: boolean): CalibrationState {
  if (laborCalibrated && equipmentCalibrated) return '已校准'
  if (laborCalibrated || equipmentCalibrated) return '部分校准'
  return 'G2估'
}

/**
 * 每片一抗成本 = 台账「每人份价（已换算）」直接取。
 * 缺价 / 零价 / 非数 → null（触发粗估降级）。**绝不再除换算率**。
 */
export function perSlidePrimaryCost(ab: AntibodyCostInput): number | null {
  const p = ab.perTestPrice
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null
}

/** 是否有台账真价（决定精算 vs 粗估）。 */
export function hasLedgerPrice(ab: AntibodyCostInput): boolean {
  return perSlidePrimaryCost(ab) !== null
}

/**
 * 缺价降级用的全院一抗均价。
 * ⚠️ 命名诚实：设计基线要「用量加权均价」，但台账 seed 无逐抗体用量 → 当前为**算术均值**降级；
 *    LIS 用量接入后升级为真加权（届时改此函数即可，接口不变）。
 */
export function fallbackAveragePrimary(seed: AntibodyLedgerDef[] = ANTIBODY_LEDGER_SEED): number {
  const prices = seed
    .filter((a) => a.category === '一抗' && typeof a.perTestPrice === 'number' && (a.perTestPrice as number) > 0)
    .map((a) => a.perTestPrice as number)
  if (!prices.length) return 0
  return round4(prices.reduce((s, x) => s + x, 0) / prices.length)
}

/**
 * 每片「算全」成本 = 一抗真价 + 二抗/显色 + 工时(G2) + 设备(G2)。
 * 有真价 → 精算；缺价 → 粗估（primary 降级到 opts.fallbackAvg，缺省取全院均价）+ 行级标注。
 */
export function computeFullSlideCost(
  ab: AntibodyCostInput,
  params: IhcCostParams = DEFAULT_IHC_COST_PARAMS,
  opts: { fallbackAvg?: number } = {},
): SlideCostBreakdown {
  const real = perSlidePrimaryCost(ab)
  const precise = real !== null
  const primary = precise ? (real as number) : opts.fallbackAvg ?? fallbackAveragePrimary()
  const secondary = params.secondaryPerSlide
  const labor = params.laborPerSlide
  const equipment = params.equipmentPerSlide
  const total = round4(primary + secondary + labor + equipment)
  return {
    primary: round4(primary),
    secondary,
    labor,
    equipment,
    total,
    completeness: precise ? '精算' : '粗估',
    laborEquipmentSource: deriveCalibrationState(!!params.laborCalibrated, !!params.equipmentCalibrated),
    // 诚实文案：当前降级为算术均值（见 fallbackAveragePrimary），非用量加权——故不写「加权」。
    note: precise ? undefined : '成本缺价·毛利待定（降级全院均价）',
  }
}

export interface StainKitInput {
  name?: string
  kitPrice: number // 盒价（G2 真实盒价，如 Masson¥318 / 网状¥549 / 抗酸¥195）
  nominalTests: number // 标称次数
  actualYield?: number | null // 可选：实际得率（吸收到期损耗，优先于标称次数）
  laborPerTest?: number // 可选：工时（G2 估）
}

/**
 * 特染每次成本 = 盒价 ÷ 标称次数（有实际得率则优先用得率）+ 可选工时(G2)。
 * 全成本 ≈ ¥20/次（人力主导）——材料份额小，工时/设备同样走 G2 估。
 */
export function specialStainPerTestCost(kit: StainKitInput): number {
  const denom = kit.actualYield && kit.actualYield > 0 ? kit.actualYield : kit.nominalTests
  const material = denom > 0 ? kit.kitPrice / denom : 0
  return round4(material + (kit.laborPerTest ?? 0))
}

// ────────────────────────────────────────────────────────────────────────────
// B4 弱锚校准 —— 用康湾真实工资/折旧/房租「摊算」出每片工时/设备成本（写回参数用）。
//   「回归」在这里 = 成本摊算（把月总成本除以月产片量），不是统计回归。真值待 PM 补，本函数只给机制。
// ────────────────────────────────────────────────────────────────────────────

/** 校准输入（月度真实成本 + 月产免疫组化片量）。真值待康湾补，见 B4 数据清单文档。 */
export interface LaborEquipmentCalibrationInput {
  monthlyTechnicianCost: number // 月技师人力总成本（工资+社保+福利）
  monthlyEquipmentDepreciation: number // 月设备折旧（染色机/切片机等）
  monthlyFacilityCost?: number // 月房租/水电等固定摊（可选；默认 0）
  monthlySlideVolume: number // 月免疫组化产片量（分母；须 > 0）
  facilityToLaborRatio?: number // 房租等固定摊归工时的比例(0~1，默认 0.5)，其余归设备
}

export interface LaborEquipmentCalibrationResult {
  laborPerSlide: number
  equipmentPerSlide: number
  inputs: Required<Omit<LaborEquipmentCalibrationInput, 'monthlyFacilityCost' | 'facilityToLaborRatio'>> &
    Pick<LaborEquipmentCalibrationInput, 'monthlyFacilityCost' | 'facilityToLaborRatio'>
  method: string
}

/**
 * 摊算每片工时/设备成本 = （月人力/月折旧 + 分摊到该半的固定摊）÷ 月产片量。
 * 分母守卫：monthlySlideVolume ≤ 0 → 抛错（不产 NaN/Infinity）。
 * 结果写回 ihc_cost_params 时把 source→「康湾实测校准」、confidence→「已校准」并留痕（见路由）。
 */
export function deriveLaborEquipmentPerSlide(input: LaborEquipmentCalibrationInput): LaborEquipmentCalibrationResult {
  // 成本输入统一校验：须有限且非负——挡住 Infinity/-Infinity/NaN/负值。
  //   ⚠️ node:sqlite 会**接受 Infinity 写入 REAL 列**（实测），若不拦，一次 1e400 输入就把成本口径参数写成 Infinity＝伪校准成功。
  const finiteNonNeg = (v: unknown, label: string, required: boolean): number => {
    if (v == null) {
      if (required) throw new Error(`${label}必填`)
      return 0
    }
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`${label}须为有限数值（收到 ${String(v)}）`)
    if (n < 0) throw new Error(`${label}不能为负`)
    return n
  }
  const volume = Number(input.monthlySlideVolume)
  // 月产片量是「张数」——须 ≥1 的有限数。分数/零/负会把每片成本摊到离谱（如 0.0001 → 4 亿/片），一并挡掉。
  if (!Number.isFinite(volume) || volume < 1) {
    throw new Error('月产片量（monthlySlideVolume）须为 ≥1 的有限数——否则每片成本会摊到离谱')
  }
  const tech = finiteNonNeg(input.monthlyTechnicianCost, '月技师人力成本（monthlyTechnicianCost）', true)
  const equip = finiteNonNeg(input.monthlyEquipmentDepreciation, '月设备折旧（monthlyEquipmentDepreciation）', true)
  const facility = finiteNonNeg(input.monthlyFacilityCost, '月房租/固定摊（monthlyFacilityCost）', false)
  let ratio = input.facilityToLaborRatio == null ? 0.5 : Number(input.facilityToLaborRatio)
  if (!Number.isFinite(ratio) || ratio < 0) ratio = 0
  if (ratio > 1) ratio = 1
  const laborFacility = facility * ratio
  const equipFacility = facility - laborFacility
  const laborPerSlide = round4((tech + laborFacility) / volume)
  const equipmentPerSlide = round4((equip + equipFacility) / volume)
  // 兜底防御：正常输入下结果恒有限，这里挡非预期溢出，绝不把 Infinity/NaN 交给上游写库。
  if (!Number.isFinite(laborPerSlide) || !Number.isFinite(equipmentPerSlide)) {
    throw new Error('摊算结果非有限值——请检查输入量级')
  }
  return {
    laborPerSlide,
    equipmentPerSlide,
    inputs: {
      monthlyTechnicianCost: tech,
      monthlyEquipmentDepreciation: equip,
      monthlySlideVolume: volume,
      monthlyFacilityCost: facility,
      facilityToLaborRatio: ratio,
    },
    method: '摊算：每片 = (月成本 + 固定摊×分配比) ÷ 月产片量',
  }
}

// ────────────────────────────────────────────────────────────────────────────
// B3 承重墙敏感性 band —— 只读镜像收入侧制片份额公式，透出「诊断锚 105 → 本地协商值」区间。
//   ⚠️ 定性：把国标 36/105 套和睦家溢价单价 = 政策分摊、非「真实制片价值证明」。
//   本 band 不改活公式（收入侧 statement-revenue.ts 归另一线），只做只读区间演算供文档/前端标注。
//   默认诊断锚 = 收入侧 SPLIT_DIAG_FEE（105），drift-guard 测试锁死一致。
// ────────────────────────────────────────────────────────────────────────────

/** 国标诊断费锚（默认 105）。须与收入侧 statement-revenue.ts 的 SPLIT_DIAG_FEE 一致（drift-guard 测试守）。 */
export const DIAGNOSIS_ANCHOR_DEFAULT = 105

/** B3 band 默认区间宽度：绕锚 ±30%（本地协商诊断值占位·可配·PM 拍板 2026-07-02）。 */
export const DIAGNOSIS_ANCHOR_BAND_PCT = 0.3

/**
 * 制片份额 f = (处理费率×工作量) / (处理费率×工作量 + 诊断锚)。
 * 忠实复刻收入侧活公式（含 denom>0 守卫 → rate×workload=0 时 f=0），返回**未舍入**分数以对齐活公式的 f。
 */
export function manufactureShare(rate: number, workload: number, anchor: number = DIAGNOSIS_ANCHOR_DEFAULT): number {
  const numer = (Number(rate) || 0) * (Number(workload) || 0)
  const denom = numer + (Number(anchor) || 0)
  return denom > 0 ? numer / denom : 0
}

export interface AnchorPoint {
  anchor: number // 诊断锚取值
  share: number // 对应制片份额 f（未舍入，对齐活公式）
  labShare?: number // 给了 settle 才有：制片份额金额 = round2(settle × f)，与活公式逐分一致
}

export interface ManufactureShareBandInput {
  rate: number // 国标处理费率（组织 36/标本、细胞 75/玻片、冰冻 36）
  workload: number // 工作量（LIS 真蜡块 / 玻片数 / 账单数量）
  settle?: number // 可选：该组结算额，给了则算制片份额金额区间
  anchorBase?: number // 基锚（默认 105 = SPLIT_DIAG_FEE）
  bandPct?: number // 绕基锚的区间宽度（默认 ±30%）
  anchorLow?: number // 显式下限锚（覆盖 bandPct）
  anchorHigh?: number // 显式上限锚（覆盖 bandPct）
}

export interface ManufactureShareBandResult {
  base: AnchorPoint // 基锚（政策默认 105）
  low: AnchorPoint // 下限锚（份额上限：锚越低 → 制片份额越大）
  high: AnchorPoint // 上限锚（份额下限）
  spreadPct: number // 敏感性：(low.share − high.share) / base.share，制片份额相对波动幅度
  note: string // 口径基调：政策分摊·非真实制片价值证明·占位待本地协商值
}

/**
 * B3 承重墙敏感性区间：绕诊断锚 105 演算制片份额随锚浮动的区间。
 * 用途：诚实告知「105 是国标政策数，套溢价单价是分摊、不是价值证明；真值在此区间内，份额随之浮动」。
 * 锚越低 → 制片份额越大（分母越小）；故 low 锚给 share 上限、high 锚给 share 下限。
 */
export function manufactureShareBand(input: ManufactureShareBandInput): ManufactureShareBandResult {
  // 输入非有限一律回退到安全默认——本函数是只读展示演算，宁可给可解释的区间，也不把 NaN/Infinity 传出去。
  const rate = Number(input.rate) || 0
  const workload = Number(input.workload) || 0
  const baseRaw = input.anchorBase == null ? DIAGNOSIS_ANCHOR_DEFAULT : Number(input.anchorBase)
  const base = Number.isFinite(baseRaw) && baseRaw > 0 ? baseRaw : DIAGNOSIS_ANCHOR_DEFAULT
  const pctRaw = input.bandPct == null ? DIAGNOSIS_ANCHOR_BAND_PCT : Number(input.bandPct)
  const pct = Number.isFinite(pctRaw) && pctRaw >= 0 ? pctRaw : DIAGNOSIS_ANCHOR_BAND_PCT
  const anchorLow = input.anchorLow != null && Number.isFinite(Number(input.anchorLow)) ? Number(input.anchorLow) : round2(base * (1 - pct))
  const anchorHigh = input.anchorHigh != null && Number.isFinite(Number(input.anchorHigh)) ? Number(input.anchorHigh) : round2(base * (1 + pct))
  const settleNum = input.settle == null ? undefined : Number(input.settle)
  const settle = settleNum != null && Number.isFinite(settleNum) ? settleNum : undefined

  const point = (anchor: number): AnchorPoint => {
    const share = manufactureShare(rate, workload, anchor)
    return settle == null ? { anchor, share } : { anchor, share, labShare: round2(settle * share) }
  }
  const baseP = point(base)
  const lowP = point(anchorLow)
  const highP = point(anchorHigh)
  const spreadPct = baseP.share > 0 ? round4((lowP.share - highP.share) / baseP.share) : 0
  return {
    base: baseP,
    low: lowP,
    high: highP,
    spreadPct,
    note: '国标 36/105 套溢价单价=政策分摊、非真实制片价值证明；本区间为占位（诊断锚 105→本地协商值 ±30%），待 PM 补真实协商值',
  }
}
