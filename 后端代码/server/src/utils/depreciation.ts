/**
 * 设备折旧计算工具（纯函数，无状态、无 I/O、无 schema 依赖）
 *
 * 背景（P1-08 / triage 2026-06-26）：
 *   triage 声称 master 存在设备子系统（`equipment-v1.1.ts`）且 BOM 出库可自动写
 *   `equipment_usage`。**经核验，真实 master 完全没有设备子系统**——无 equipment 表、
 *   无 equipment_usage 表、无 equipment 路由、前端无设备 UI、bom_items 仅含
 *   material_id（消耗品），不存在 BOM↔设备关联（bom_equipment）。triage 的引用源自
 *   并行 codex fork，不适用于本分支。
 *
 *   因此「BOM 出库消耗设备时自动 INSERT equipment_usage」无落点（无设备主数据、无
 *   关联模型可挂钩）。完整自动入口属于更大的新功能（需先建设备注册表 + 折旧方法配置
 *   + BOM↔设备映射），本轮**降级为最小安全增量**：仅交付一个经测试的、可在设备模型
 *   落地后被 outbound/equipment 路由直接调用的折旧计算 util，不引入任何 schema、不
 *   伪造任何设备/折旧数据、不改动现有出库事务。
 *
 * 提供两种标准会计折旧法：
 *   1. 直线法（straight-line）：按时间均摊到每个会计期/每天。
 *   2. 工作量法（units-of-production / usage）：按实际使用量（如分钟数 × 样本量）摊销。
 */

/** 折旧法 */
export type DepreciationMethod = 'straight-line' | 'usage'

/** 直线法输入：按使用天数从可折旧基数（原值 − 残值）均摊 */
export interface StraightLineParams {
  /** 设备原值 */
  originalCost: number
  /** 预计残值（默认 0） */
  salvageValue?: number
  /** 折旧年限（年），用于换算成天 */
  usefulLifeYears: number
  /** 本次摊销的使用天数 */
  daysUsed: number
  /** 每年天数（默认 365） */
  daysPerYear?: number
}

/** 工作量法输入：按实际使用量 / 总可用产能摊销可折旧基数 */
export interface UsageParams {
  /** 设备原值 */
  originalCost: number
  /** 预计残值（默认 0） */
  salvageValue?: number
  /**
   * 设备全生命周期可用总产能（与 unitsUsed 同量纲）。
   * 例如以「分钟」为单位时，即设备一生可工作的总分钟数。
   */
  totalCapacityUnits: number
  /**
   * 本次实际使用量（与 totalCapacityUnits 同量纲）。
   * 例如 BOM 出库场景：usageMinutesPerSample × sampleCount。
   */
  unitsUsed: number
}

const isFiniteNonNegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

/** 计算可折旧基数（原值 − 残值，夹在 [0, originalCost]）。残值大于原值时视为 0。 */
function depreciableBase(originalCost: number, salvageValue: number): number {
  if (!isFiniteNonNegative(originalCost)) {
    throw new Error('originalCost must be a finite non-negative number')
  }
  if (!isFiniteNonNegative(salvageValue)) {
    throw new Error('salvageValue must be a finite non-negative number')
  }
  return Math.max(0, originalCost - salvageValue)
}

/** 四舍五入到分（2 位小数），避免浮点误差累积。 */
function roundToCent(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100
}

/**
 * 直线法折旧：本次使用天数应分摊的折旧额。
 *
 *   每日折旧 = (原值 − 残值) / (折旧年限 × 每年天数)
 *   本次折旧 = 每日折旧 × 使用天数
 */
export function straightLineDepreciation(params: StraightLineParams): number {
  const {
    originalCost,
    salvageValue = 0,
    usefulLifeYears,
    daysUsed,
    daysPerYear = 365,
  } = params

  if (!isFiniteNonNegative(usefulLifeYears) || usefulLifeYears <= 0) {
    throw new Error('usefulLifeYears must be a positive finite number')
  }
  if (!isFiniteNonNegative(daysPerYear) || daysPerYear <= 0) {
    throw new Error('daysPerYear must be a positive finite number')
  }
  if (!isFiniteNonNegative(daysUsed)) {
    throw new Error('daysUsed must be a finite non-negative number')
  }

  const base = depreciableBase(originalCost, salvageValue)
  const totalDays = usefulLifeYears * daysPerYear
  const perDay = base / totalDays
  // 摊销不应超过可折旧基数（使用天数超过寿命时封顶）
  const raw = Math.min(base, perDay * daysUsed)
  return roundToCent(raw)
}

/**
 * 工作量法折旧：本次使用量应分摊的折旧额。
 *
 *   单位折旧 = (原值 − 残值) / 总可用产能
 *   本次折旧 = 单位折旧 × 本次使用量
 *
 * BOM 出库语义：unitsUsed = 每样本使用分钟 × 样本量。
 */
export function usageDepreciation(params: UsageParams): number {
  const { originalCost, salvageValue = 0, totalCapacityUnits, unitsUsed } = params

  if (!isFiniteNonNegative(totalCapacityUnits) || totalCapacityUnits <= 0) {
    throw new Error('totalCapacityUnits must be a positive finite number')
  }
  if (!isFiniteNonNegative(unitsUsed)) {
    throw new Error('unitsUsed must be a finite non-negative number')
  }

  const base = depreciableBase(originalCost, salvageValue)
  const perUnit = base / totalCapacityUnits
  // 摊销不应超过可折旧基数（使用量超过总产能时封顶）
  const raw = Math.min(base, perUnit * unitsUsed)
  return roundToCent(raw)
}

/** 统一入口：按 method 分派到对应折旧法。 */
export function computeDepreciation(
  method: DepreciationMethod,
  params: StraightLineParams | UsageParams,
): number {
  switch (method) {
    case 'straight-line':
      return straightLineDepreciation(params as StraightLineParams)
    case 'usage':
      return usageDepreciation(params as UsageParams)
    default:
      throw new Error(`Unknown depreciation method: ${method as string}`)
  }
}
