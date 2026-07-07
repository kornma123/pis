import { canonicalCaseNo } from './classifier.js' // 病理号落库/自连统一 NFKC 归一（+trim），与 lis_cases/case_revenue/statement-import 同一 canonical，堵 ABC 成本侧全角号 case_charge_groups 自成组、跨侧 join 匹配漏

export interface SlideCostInput {
  bomId?: string
  slideCount?: number
  blockCount?: number
  month?: string
  materialCost?: number
  caseNo?: string | null
  applyCaseAggregation?: boolean
  feeMappingsOverride?: any[]
  // 本出库样本数：块/片为每样本动因，逐单分摊量 = 每样本配置量 × 样本数。
  // 缺省 1（黄金用例直算/预览等单样本口径不受影响）。
  sampleCount?: number
  // 本出库实际病例数（病例为每病例动因，不随样本数缩放）：挂 case_no 计 1，否则 0。
  // 缺省 undefined → 退回 BOM 配置量，保持既有断言。
  caseCount?: number
}

export interface ActivityCost {
  activityCenterId: string
  activityCenterName: string
  activityCenterCode: string
  quantity: number
  unitCost: number
  totalCost: number
  // L3-5 可解释明细（逐中心：动因/费率/出处 + 池快照，供 Σ分摊=池 对账）
  driverType?: string | null
  driverRate?: number
  rateSource?: 'period' | 'pool_amount' | 'none'
  poolCost?: number
  poolDriverQuantity?: number
  allocatedCost?: number
}

const round2 = (value: number): number => Math.round((Number(value) || 0) * 100) / 100
const round4 = (value: number): number => Math.round((Number(value) || 0) * 10000) / 10000
const activeStatusSql = (column: string) =>
  `(${column} = 'active' OR ${column} = 1 OR ${column} = '1')`

export interface TierRule {
  maxQuantity?: number
  unitPrice: number
}

interface FeeBreakdownItem {
  feeStandardId: string | null
  feeStandardName: string | null
  category: string | null
  quantity: number
  feeAmount: number
  aggregationScope: 'outbound' | 'case'
  chargeGroupId?: string | null
}

export function calculateTieredCost(quantity: number, tiers: TierRule[], capAmount?: number | null): number {
  const safeQuantity = Math.max(0, Number(quantity) || 0)
  if (safeQuantity <= 0 || !tiers.length) return 0

  let remaining = safeQuantity
  let previousMax = 0
  let total = 0

  for (const tier of tiers) {
    if (remaining <= 0) break

    const maxQuantity = Number(tier.maxQuantity) || 0
    const tierSize = maxQuantity > previousMax ? Math.min(remaining, maxQuantity - previousMax) : remaining
    total += tierSize * (Number(tier.unitPrice) || 0)
    remaining -= tierSize
    if (maxQuantity > previousMax) previousMax = maxQuantity
  }

  const rounded = round2(total)
  return capAmount && capAmount > 0 ? Math.min(rounded, capAmount) : rounded
}

export function calculateFeeAmountFromStandard(feeStandard: any, quantity: number): number {
  const safeQuantity = Math.max(0, Number(quantity) || 0)
  if (!feeStandard || safeQuantity <= 0) return 0

  const basePrice = Number(feeStandard.base_price ?? feeStandard.fee_per_slide) || 0
  const capAmount = Number(feeStandard.cap_amount) || null

  if (feeStandard.tier_rules) {
    try {
      const tiers = JSON.parse(feeStandard.tier_rules) as TierRule[]
      if (Array.isArray(tiers) && tiers.length) {
        return calculateTieredCost(safeQuantity, tiers, capAmount)
      }
    } catch (_e) {
      // Fall back to the base price when historical tier rules are malformed.
    }
  }

  return round2(basePrice * safeQuantity)
}

function getFeeMappings(db: any, bom: any): any[] {
  if (!bom?.id) return []
  const rows = db.prepare(`
    SELECT m.*, fs.name as fee_standard_name, fs.category, fs.project_type,
           fs.fee_per_slide, fs.base_price, fs.tier_rules, fs.cap_amount
    FROM bom_fee_mappings m
    JOIN fee_standards fs ON m.fee_standard_id = fs.id AND ${activeStatusSql('fs.status')}
    WHERE m.bom_id = ? AND ${activeStatusSql('m.status')}
    ORDER BY m.sort_order ASC, m.created_at ASC
  `).all(bom.id) as any[]

  if (rows.length) return rows
  if (!bom.fee_standard_id) return []

  const legacy = db.prepare(`SELECT * FROM fee_standards WHERE id = ? AND ${activeStatusSql('status')}`)
    .get(bom.fee_standard_id) as any
  return legacy ? [{
    id: `legacy-${bom.fee_standard_id}`,
    fee_standard_id: legacy.id,
    fee_standard_name: legacy.name,
    category: legacy.category,
    project_type: legacy.project_type,
    fee_per_slide: legacy.fee_per_slide,
    base_price: legacy.base_price,
    tier_rules: legacy.tier_rules,
    cap_amount: legacy.cap_amount,
    quantity_multiplier: 1,
    aggregation_scope: 'outbound',
  }] : []
}

export function buildBomSourceSnapshot(db: any, bomId: string) {
  const bom = db.prepare(`
    SELECT id, code, name, version, type, service_id, description,
           supportable_samples, fee_standard_id, fee_category, status, updated_at
    FROM boms
    WHERE id = ? AND is_deleted = 0
  `).get(bomId) as any
  if (!bom) return null

  const mapMaterialRow = (row: any) => ({
    materialId: row.material_id,
    materialCode: row.material_code,
    materialName: row.material_name,
    spec: row.spec || null,
    unit: row.unit || null,
    usagePerSample: row.usage_per_sample ?? null,
    usagePerBatch: row.usage_per_batch ?? null,
    coversSamples: row.covers_samples ?? null,
    allocationType: row.allocation_type || null,
    groupName: row.group_name || null,
    sortOrder: row.sort_order || 0,
  })

  const items = db.prepare(`
    SELECT bi.*, m.code as material_code, m.name as material_name, m.spec
    FROM bom_items bi
    LEFT JOIN materials m ON bi.material_id = m.id AND m.is_deleted = 0
    WHERE bi.bom_id = ?
    ORDER BY bi.sort_order ASC, bi.created_at ASC
  `).all(bomId).map(mapMaterialRow)

  const generalReagents = db.prepare(`
    SELECT gr.*, m.code as material_code, m.name as material_name, m.spec
    FROM bom_general_reagents gr
    LEFT JOIN materials m ON gr.material_id = m.id AND m.is_deleted = 0
    WHERE gr.bom_id = ?
    ORDER BY gr.sort_order ASC, gr.created_at ASC
  `).all(bomId).map(mapMaterialRow)

  const generalConsumables = db.prepare(`
    SELECT gc.*, m.code as material_code, m.name as material_name, m.spec
    FROM bom_general_consumables gc
    LEFT JOIN materials m ON gc.material_id = m.id AND m.is_deleted = 0
    WHERE gc.bom_id = ?
    ORDER BY gc.sort_order ASC, gc.created_at ASC
  `).all(bomId).map(mapMaterialRow)

  const qualityControls = db.prepare(`
    SELECT qc.*, m.code as material_code, m.name as material_name, m.spec
    FROM bom_quality_controls qc
    LEFT JOIN materials m ON qc.material_id = m.id AND m.is_deleted = 0
    WHERE qc.bom_id = ?
    ORDER BY qc.sort_order ASC, qc.created_at ASC
  `).all(bomId).map(mapMaterialRow)

  const feeMappings = getFeeMappings(db, bom).map(mapping => ({
    feeStandardId: mapping.fee_standard_id,
    feeStandardName: mapping.fee_standard_name,
    category: mapping.category || null,
    projectType: mapping.project_type || null,
    feePerSlide: Number(mapping.fee_per_slide) || 0,
    basePrice: Number(mapping.base_price) || 0,
    quantityMultiplier: Number(mapping.quantity_multiplier) || 1,
    aggregationScope: mapping.aggregation_scope === 'case' ? 'case' : 'outbound',
  }))

  return {
    id: bom.id,
    code: bom.code,
    name: bom.name,
    version: bom.version,
    type: bom.type,
    serviceId: bom.service_id || null,
    supportableSamples: bom.supportable_samples ?? null,
    feeStandardId: bom.fee_standard_id || null,
    feeCategory: bom.fee_category || null,
    status: bom.status,
    updatedAt: bom.updated_at,
    items,
    generalReagents,
    generalConsumables,
    qualityControls,
    feeMappings,
  }
}

function applyCaseChargeGroup(db: any, input: {
  caseNo: string
  month: string
  feeStandard: any
  quantity: number
}) {
  const groupId = `${input.caseNo}-${input.month}-${input.feeStandard.fee_standard_id}`
  const existing = db.prepare(`
    SELECT * FROM case_charge_groups
    WHERE case_no = ? AND year_month = ? AND fee_standard_id = ?
  `).get(input.caseNo, input.month, input.feeStandard.fee_standard_id) as any
  const previousQuantity = Number(existing?.total_quantity) || 0
  const previousFee = Number(existing?.total_fee) || 0
  const nextQuantity = previousQuantity + input.quantity
  const nextFee = calculateFeeAmountFromStandard(input.feeStandard, nextQuantity)
  const incrementalFee = round2(nextFee - previousFee)
  const snapshot = JSON.stringify({
    feeStandardId: input.feeStandard.fee_standard_id,
    feeStandardName: input.feeStandard.fee_standard_name,
    tierRules: input.feeStandard.tier_rules ? parseJson(input.feeStandard.tier_rules) : null,
    capAmount: input.feeStandard.cap_amount ?? null,
  })

  db.prepare(`
    INSERT INTO case_charge_groups (
      id, case_no, year_month, fee_standard_id,
      total_quantity, total_fee, outbound_count, rule_snapshot
    )
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(case_no, year_month, fee_standard_id) DO UPDATE SET
      total_quantity = excluded.total_quantity,
      total_fee = excluded.total_fee,
      outbound_count = case_charge_groups.outbound_count + 1,
      rule_snapshot = excluded.rule_snapshot,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    existing?.id || groupId,
    input.caseNo,
    input.month,
    input.feeStandard.fee_standard_id,
    nextQuantity,
    nextFee,
    snapshot,
  )

  return { groupId, incrementalFee, totalFee: nextFee, totalQuantity: nextQuantity }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch (_e) {
    return null
  }
}

function calculateFeeBreakdown(db: any, input: {
  bom: any
  slideCount: number
  month: string
  caseNo?: string | null
  applyCaseAggregation?: boolean
  feeMappingsOverride?: any[]
}): FeeBreakdownItem[] {
  const mappings = input.feeMappingsOverride || getFeeMappings(db, input.bom)
  return mappings.map(mapping => {
    const quantity = round4(input.slideCount * (Number(mapping.quantity_multiplier) || 1))
    const aggregationScope = mapping.aggregation_scope === 'case' ? 'case' : 'outbound'
    const feeStandard = {
      ...mapping,
      id: mapping.fee_standard_id,
      name: mapping.fee_standard_name,
    }

    if (aggregationScope === 'case' && input.caseNo && input.applyCaseAggregation) {
      const group = applyCaseChargeGroup(db, {
        caseNo: input.caseNo,
        month: input.month,
        feeStandard: mapping,
        quantity,
      })
      return {
        feeStandardId: mapping.fee_standard_id,
        feeStandardName: mapping.fee_standard_name,
        category: mapping.category,
        quantity,
        feeAmount: group.incrementalFee,
        aggregationScope,
        chargeGroupId: group.groupId,
      }
    }

    return {
      feeStandardId: mapping.fee_standard_id,
      feeStandardName: mapping.fee_standard_name,
      category: mapping.category,
      quantity,
      feeAmount: calculateFeeAmountFromStandard(feeStandard, quantity),
      aggregationScope,
      chargeGroupId: input.caseNo && aggregationScope === 'case'
        ? `${input.caseNo}-${input.month}-${mapping.fee_standard_id}`
        : null,
    }
  })
}

export function getDriverRate(db: any, activityCenterId: string, month: string): number {
  const current = db.prepare(`
    SELECT driver_rate
    FROM abc_cost_pools
    WHERE activity_center_id = ? AND year_month = ?
  `).get(activityCenterId, month) as any
  if (Number(current?.driver_rate) > 0) return round2(Number(current.driver_rate))

  const previousMonth = getPreviousMonth(month)
  const previous = db.prepare(`
    SELECT driver_rate
    FROM abc_cost_pools
    WHERE activity_center_id = ? AND year_month = ?
  `).get(activityCenterId, previousMonth) as any
  if (Number(previous?.driver_rate) > 0) return round2(Number(previous.driver_rate))

  const average = db.prepare(`
    SELECT AVG(b.standard_activity_cost) as avg_rate
    FROM boms b
    JOIN bom_activity_links bal ON bal.bom_id = b.id
    WHERE bal.activity_center_id = ? AND b.is_deleted = 0
  `).get(activityCenterId) as any

  return round2(Number(average?.avg_rate) || 0)
}

function getPreviousMonth(month: string): string {
  const [year, monthIndex] = month.split('-').map(Number)
  if (!year || !monthIndex) return month
  const date = new Date(Date.UTC(year, monthIndex - 2, 1))
  return date.toISOString().slice(0, 7)
}

export function getOrCalculateProjectFullCost(db: any, projectId: string, month = new Date().toISOString().slice(0, 7)) {
  const cached = db.prepare(`
    SELECT *
    FROM project_cost_snapshots
    WHERE project_id = ? AND year_month = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, month) as any

  if (cached) return cached

  const project = db.prepare(`
    SELECT p.*, b.id as bom_id, b.unit_cost
    FROM projects p
    LEFT JOIN boms b ON p.bom_id = b.id
    WHERE p.id = ? AND p.is_deleted = 0
  `).get(projectId) as any

  if (!project) return null

  const sampleCount = Number(project.supportable_samples) || 1
  const materialCost = round2((Number(project.unit_cost) || 0) * sampleCount)
  const laborCost = calculateLaborCost(db, project.type || 'all', sampleCount)
  const equipmentCost = project.bom_id ? calculateEquipmentCost(db, project.bom_id, sampleCount) : 0
  const qcCost = project.bom_id ? calculateQCCost(db, project.bom_id, sampleCount) : 0
  const indirectCost = calculateIndirectCost(db, month, sampleCount)
  const totalCost = round2(materialCost + laborCost + equipmentCost + qcCost + indirectCost)

  return {
    project_id: projectId,
    year_month: month,
    material_cost: materialCost,
    labor_cost: laborCost,
    equipment_cost: equipmentCost,
    qc_cost: qcCost,
    indirect_cost: indirectCost,
    total_cost: totalCost,
  }
}

export function calculateLaborCost(db: any, projectType: string, sampleCount = 1): number {
  const rows = db.prepare(`
    SELECT standard_minutes, labor_rate_per_minute
    FROM standard_labor_times
    WHERE COALESCE(is_deleted, 0) = 0
      AND (project_type = ? OR project_type = 'all')
  `).all(projectType) as any[]

  return round2(rows.reduce((sum, row) =>
    sum + (Number(row.standard_minutes) || 0) * (Number(row.labor_rate_per_minute) || 0) * sampleCount,
  0))
}

export function calculateEquipmentCost(db: any, bomId: string, sampleCount = 1): number {
  const rows = db.prepare(`
    SELECT bet.usage_minutes,
           e.purchase_price, e.residual_value, e.depreciable_life_years,
           e.depreciation_method, e.total_capacity,
           et.default_purchase_price, et.default_residual_value,
           et.default_depreciable_life_years, et.default_depreciation_method,
           et.default_total_capacity
    FROM bom_equipment_templates bet
    LEFT JOIN equipment e ON bet.equipment_id = e.id
    LEFT JOIN equipment_types et ON bet.equipment_type_id = et.id
    WHERE bet.bom_id = ?
  `).all(bomId) as any[]

  return calculateEquipmentCostFromRows(rows, sampleCount)
}

function calculateEquipmentTemplateCost(row: any, sampleCount: number): number {
  const purchasePrice = Number(row.purchase_price ?? row.default_purchase_price) || 0
  const residualValue = Number(row.residual_value ?? row.default_residual_value) || 0
  const depreciableAmount = Math.max(0, purchasePrice - residualValue)
  const usageMinutes = Number(row.usage_minutes) || 0
  const depreciationMethod = row.depreciation_method || row.default_depreciation_method || 'straight_line'
  const totalCapacity = Number(row.total_capacity ?? row.default_total_capacity) || 0

  if (depreciationMethod === 'units_of_production' && totalCapacity > 0) {
    return (depreciableAmount / totalCapacity) * usageMinutes * sampleCount
  }

  const years = Number(row.depreciable_life_years ?? row.default_depreciable_life_years) || 5
  const perMinute = years > 0 ? depreciableAmount / years / 525600 : 0
  return perMinute * usageMinutes * sampleCount
}

export function calculateEquipmentCostFromRows(rows: any[], sampleCount = 1): number {
  const total = rows.reduce((sum, row) => {
    return sum + calculateEquipmentTemplateCost(row, sampleCount)
  }, 0)

  return round2(total)
}

export function calculateQCCost(db: any, bomId: string, sampleCount = 1): number {
  const rows = db.prepare(`
    SELECT qc.usage_per_batch, qc.covers_samples, m.price
    FROM bom_quality_controls qc
    LEFT JOIN materials m ON qc.material_id = m.id AND m.is_deleted = 0
    WHERE qc.bom_id = ?
  `).all(bomId) as any[]

  const total = rows.reduce((sum, row) => {
    const coversSamples = Math.max(1, Number(row.covers_samples) || 1)
    const batchCount = Math.ceil(sampleCount / coversSamples)
    return sum + (Number(row.usage_per_batch) || 0) * (Number(row.price) || 0) * batchCount
  }, 0)

  return round2(total)
}

export function calculateIndirectCost(db: any, month: string, sampleCount = 1): number {
  const rows = db.prepare(`
    SELECT allocation_rate
    FROM indirect_cost_allocations
    WHERE year_month = ?
  `).all(month) as any[]

  return round2(rows.reduce((sum, row) => sum + (Number(row.allocation_rate) || 0) * sampleCount, 0))
}

// R2：本期同一病例的已核算出库数（病例可跨多出库：一病例多蜡块→多 BOM 出库）。
// 用于把「每病例」作业成本按组均摊到该病例各出库，使逐单 Σ(1/groupSize)=去重病例数，
// 与期间池 COUNT(DISTINCT case_no) 同口径 → 完全吸收（CHAIN-06）。
// ⚠️ 口径必须与 abc-v1.1.getCenterDriverQuantity 一致：用 NOT IN('pending_cost','cost_exception')
//   而非 cost_status='costed'——重算路径把快照写成 'recalculated'，若只认 'costed' 则重算时组大小逐行塌缩
//   （3→2→1）致 Σ(1/groupSize)≠1 过吸收。涵盖 costed/recalculated，组大小在重算全程稳定。
function countCostedCaseOutbounds(db: any, caseNo: string, month: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as n
    FROM outbound_abc_details
    WHERE case_no = ?
      AND COALESCE(cost_month, substr(created_at, 1, 7)) = ?
      AND COALESCE(cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')
  `).get(caseNo, month) as any
  return Math.max(1, Number(row?.n) || 0)
}

export function calculateSlideCostWithFee(db: any, input: SlideCostInput) {
  const slideCount = Math.max(1, Number(input.slideCount) || 1)
  const blockCount = Math.max(1, Number(input.blockCount) || 1)
  const sampleCount = Math.max(1, Number(input.sampleCount) || 1)
  const rawCaseCount = input.caseCount == null ? null : Math.max(0, Number(input.caseCount) || 0)
  const month = input.month || new Date().toISOString().slice(0, 7)
  const bomId = input.bomId || ''
  // 病理号归一（NFKC+trim）：case_no 是 case_charge_groups 主键 + 逐病例组大小 COUNT 的 join key，
  // 落库/自连须与 lis_cases/case_revenue（消费侧 canonicalCaseNo）同一归一，否则全角号成本自成一组、跨侧匹配漏。
  const caseNo = canonicalCaseNo(input.caseNo) || null
  // R2：病例跨多出库时按组均摊（1/组大小），保证「每病例」作业成本只计一次、完全吸收。
  const caseGroupSize = (caseNo && rawCaseCount != null && rawCaseCount > 0)
    ? countCostedCaseOutbounds(db, caseNo, month)
    : 1
  const caseCount = rawCaseCount == null ? null : rawCaseCount / caseGroupSize

  const bom = bomId
    ? db.prepare('SELECT * FROM boms WHERE id = ? AND is_deleted = 0').get(bomId) as any
    : null

  const materialCost = round2(input.materialCost ?? calculateMaterialCost(db, bomId, bom, slideCount))

  const links = bomId ? getBomActivityLinks(db, bomId) : []

  const activityCosts: ActivityCost[] = links.map(link => {
    // 单行读取（不再混用 SUM(amount) 聚合，避免 >1 池时取到不一致行）。费率严格取 driver_rate；
    // 无费率即 0（不再回退整池 amount 作单价——那会把整池成本当单价，造成首次重算严重高估）。
    const pool = db.prepare(`
      SELECT driver_rate, total_cost, driver_quantity
      FROM abc_cost_pools
      WHERE activity_center_id = ? AND year_month = ?
      LIMIT 1
    `).get(link.activity_center_id, month) as any
    const driverRate = Number(pool?.driver_rate) || 0
    const unitCost = driverRate
    const quantity = getDriverQuantity(link, slideCount, blockCount, sampleCount, caseCount)
    const allocated = round2(unitCost * quantity)
    return {
      activityCenterId: link.activity_center_id,
      activityCenterName: link.activity_center_name || '未命名作业中心',
      activityCenterCode: link.activity_center_code || '',
      quantity,
      unitCost,
      totalCost: allocated,
      // L3-5 可解释明细
      driverType: link.cost_driver_type || null,
      driverRate,
      rateSource: driverRate > 0 ? 'period' : 'none',
      poolCost: Number(pool?.total_cost) || 0,
      poolDriverQuantity: Number(pool?.driver_quantity) || 0,
      allocatedCost: allocated,
    }
  })

  const totalActivityCost = round2(activityCosts.reduce((sum, item) => sum + item.totalCost, 0))
  const totalCost = round2(materialCost + totalActivityCost)

  const feeBreakdown = calculateFeeBreakdown(db, {
    bom,
    slideCount,
    month,
    caseNo,
    applyCaseAggregation: input.applyCaseAggregation,
    feeMappingsOverride: input.feeMappingsOverride,
  })
  const feeAmount = round2(feeBreakdown.reduce((sum, item) => sum + item.feeAmount, 0))
  const profit = round2(feeAmount - totalCost)
  const profitRate = feeAmount > 0 ? round4(profit / feeAmount) : 0
  const primaryFee = feeBreakdown.length === 1 ? feeBreakdown[0] : null

  // L3-7 间接费披露标注：本期使用的单一基准（UI 据此标"间接为分摊估算"）
  const disclosure = db.prepare('SELECT basis, note FROM abc_indirect_disclosure WHERE year_month = ?').get(month) as any

  return {
    materialCost,
    totalActivityCost,
    totalCost,
    costPerSlide: round2(totalCost / slideCount),
    indirectBasis: disclosure?.basis || null,
    indirectNote: disclosure?.note || null,
    feeCategory: primaryFee?.category || bom?.fee_category || null,
    feeStandardId: primaryFee?.feeStandardId || bom?.fee_standard_id || null,
    feeAmount,
    profit,
    profitRate,
    feeBreakdown,
    chargeGroupId: primaryFee?.chargeGroupId || null,
    activityCosts,
  }
}

function calculateMaterialCost(db: any, bomId: string, bom: any, slideCount: number): number {
  if (!bomId) return 0

  const items = db.prepare(`
    SELECT bi.material_id, bi.usage_per_sample, m.price
    FROM bom_items bi
    LEFT JOIN materials m ON bi.material_id = m.id
    WHERE bi.bom_id = ?
  `).all(bomId) as any[]

  if (!items.length) return round2((Number(bom?.unit_cost) || 0) * slideCount)

  const batchPrices = db.prepare(`
    SELECT
      material_id,
      SUM(remaining * inbound_price) / NULLIF(SUM(remaining), 0) as weighted_price
    FROM batches
    WHERE material_id IN (${items.map(() => '?').join(',')})
    GROUP BY material_id
  `).all(...items.map(item => item.material_id)) as any[]
  const priceMap = new Map(batchPrices.map(row => [row.material_id, Number(row.weighted_price) || 0]))

  return round2(items.reduce((sum, item) => {
    const price = priceMap.get(item.material_id) || Number(item.price) || 0
    return sum + price * (Number(item.usage_per_sample) || 0)
  }, 0))
}

function getBomActivityLinks(db: any, bomId: string): any[] {
  // L2-6 统一表名：bom_activity_links 为唯一规范表（abc_bom_activity_links 从无 CREATE TABLE，遗留兼容分支已删）。
  // 带出中心 cost_driver_type，供 getDriverQuantity 按动因类型判定（L3-2）。
  return db.prepare(`
    SELECT l.*, ac.name as activity_center_name, ac.code as activity_center_code, ac.cost_driver_type as cost_driver_type
    FROM bom_activity_links l
    LEFT JOIN abc_activity_centers ac ON l.activity_center_id = ac.id
    WHERE l.bom_id = ?
    ORDER BY l.sort_order ASC
  `).all(bomId) as any[]
}

// 逐单作业动因量（按中心 cost_driver_type 判定）。link.quantity = BOM「每样本」配置量。
// 块/片为每样本动因 → 逐单量 = 每样本配置量 × 样本数（R1：修旧码漏乘 sampleCount，致 N>1 逐单偏小且欠吸收）。
// 病例为每病例动因（不随样本数缩放）→ 取本单实际病例数 caseCount，与期间池 SUM(case_count) 同口径保证完全吸收。
// 兼容：未传 sampleCount（默认 1）/ caseCount（默认退回配置量）的既有调用方行为不变（黄金用例直算、预览等单样本口径）。
function getDriverQuantity(
  link: any,
  slideCount: number,
  blockCount: number,
  sampleCount: number,
  caseCount: number | null,
): number {
  const configured = Number(link.driver_quantity ?? link.quantity)

  switch (link.cost_driver_type) {
    case 'block_count': return (configured > 0 ? configured : blockCount) * sampleCount
    case 'slide_count': return (configured > 0 ? configured : slideCount) * sampleCount
    case 'case_count': return caseCount != null ? caseCount : (configured > 0 ? configured : 1)
    case 'sample_count': return sampleCount
    default: return configured > 0 ? configured : 1
  }
}

// 每样本的驱动消耗（由 BOM 作业关联按中心 cost_driver_type 聚合 quantity）。
// 出库写快照时用「每样本量 × 样本数」得到真实块/片数，替代写死的 block_count=1 / slide_count=sampleCount，
// 使 M3 期间动因量（费率分母 getCenterDriverQuantity）在真实数据上成立。
export function getBomPerSampleDriverQty(db: any, bomId: string): { block: number; slide: number; case: number } {
  const out = { block: 0, slide: 0, case: 0 }
  if (!bomId) return out
  const rows = db.prepare(`
    SELECT ac.cost_driver_type as driver_type, COALESCE(SUM(l.quantity), 0) as qty
    FROM bom_activity_links l
    JOIN abc_activity_centers ac ON ac.id = l.activity_center_id
    WHERE l.bom_id = ?
    GROUP BY ac.cost_driver_type
  `).all(bomId) as any[]
  for (const r of rows) {
    const q = Number(r.qty) || 0
    if (r.driver_type === 'block_count') out.block += q
    else if (r.driver_type === 'slide_count') out.slide += q
    else if (r.driver_type === 'case_count') out.case += q
  }
  return out
}
