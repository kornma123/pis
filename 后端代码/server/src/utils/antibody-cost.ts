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
  laborPerSlide: number // 工时（G2 估·弱锚·待校准 B4）
  equipmentPerSlide: number // 设备折旧（G2 估·弱锚·待校准 B4）
}

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
  laborEquipmentSource: 'G2估' // 工时/设备透明标注：G2 估、待校准 B4（不因它标「粗估」，精算/粗估只看一抗真价）
  note?: string // 粗估时行级标注
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
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
    laborEquipmentSource: 'G2估',
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
