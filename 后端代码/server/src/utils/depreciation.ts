/**
 * 设备折旧成本计算（直线法 / 工作量法）。
 * 与 equipment 路由 POST /:id/usage 的口径一致，抽出供 BOM 出库自动登记设备使用复用（P1-08）。
 */
export interface DepreciableEquipment {
  purchase_price?: number | null
  residual_value?: number | null
  depreciation_method?: string | null
  total_capacity?: number | null
  depreciable_life_years?: number | null
}

export function computeEquipmentDepreciation(equipment: DepreciableEquipment, usageMinutes: number): number {
  const depreciableAmount = (Number(equipment.purchase_price) || 0) - (Number(equipment.residual_value) || 0)
  if (depreciableAmount <= 0 || usageMinutes <= 0) return 0
  // 工作量法：按使用分钟占总工作量比例
  if (equipment.depreciation_method === 'units_of_production' && Number(equipment.total_capacity) > 0) {
    return (depreciableAmount / Number(equipment.total_capacity)) * usageMinutes
  }
  // 直线法：按日历分钟折旧（365天×24时×60分=525600分/年）
  const minutesPerYear = 365 * 24 * 60
  const totalMinutes = (Number(equipment.depreciable_life_years) || 5) * minutesPerYear
  if (totalMinutes <= 0) return 0
  return (depreciableAmount / totalMinutes) * usageMinutes
}
