import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { calculateSlideCostWithFee } from '../utils/cost-calculator.js'
import { canonicalCaseNo } from '../utils/classifier.js' // 病理号预览口径与落库同一 NFKC 归一（全角号预览即所存）
import { recordCostException } from '../utils/cost-exceptions.js'
import { ensurePeriodOpen, getOrCreatePeriod, normalizeMonth, runCostRecalculation, writeAuditLog } from '../utils/cost-runs.js'
import { buildClosingReadiness } from '../utils/closing-readiness.js'
import { requirePermission } from '../middleware/permissions.js'
import { assertNotSelfReview } from '../middleware/authz-combinators.js'
import { logOperation } from '../utils/operation-logger.js'

const router = Router()
const requireCostWrite = requirePermission('abc_config', 'W')
const requireCostWorkbenchRead = requirePermission('abc_dashboard', 'R')

const pageParams = (query: any) => {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 20))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

const currentMonth = () => new Date().toISOString().slice(0, 7)

const getOperator = (req: any) => req.user?.username || 'system'

const previousMonth = (month: string) => {
  const [year, monthIndex] = month.split('-').map(Number)
  if (!year || !monthIndex) return currentMonth()
  const date = new Date(Date.UTC(year, monthIndex - 2, 1))
  return date.toISOString().slice(0, 7)
}

const changeRate = (current: number, previous: number) => {
  if (previous > 0) return (current - previous) / previous
  return current > 0 ? 1 : 0
}

const getCostInsightQuality = (db: any, yearMonth: string) => {
  const period = db.prepare('SELECT * FROM abc_periods WHERE year_month = ?').get(yearMonth) as any
  const outboundCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM outbound_records
    WHERE is_deleted = 0 AND status = 'completed' AND substr(created_at, 1, 7) = ?
  `).get(yearMonth) as any)?.total || 0)
  const abcSnapshotCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM outbound_abc_details
    WHERE cost_month = ?
  `).get(yearMonth) as any)?.total || 0)
  const pendingCostCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM outbound_records
    WHERE is_deleted = 0 AND status = 'completed'
      AND substr(created_at, 1, 7) = ?
      AND COALESCE(cost_status, 'pending_cost') IN ('pending_cost', 'cost_exception')
  `).get(yearMonth) as any)?.total || 0)
  const openExceptionCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM cost_exceptions
    WHERE status = 'open' AND (year_month = ? OR year_month IS NULL)
  `).get(yearMonth) as any)?.total || 0)
  const periodStatus = period?.status || 'not_started'
  const isClosed = periodStatus === 'closed'
  const isFinal = isClosed && openExceptionCount === 0 && pendingCostCount === 0
  const reasons: string[] = []

  if (!period) reasons.push('成本期间未开启')
  if (period && !isClosed) reasons.push('成本期间未关账')
  if (openExceptionCount > 0) reasons.push(`${openExceptionCount} 条开放成本异常`)
  if (pendingCostCount > 0) reasons.push(`${pendingCostCount} 单未补算或成本异常`)
  if (outboundCount > abcSnapshotCount) reasons.push(`出库单 ${outboundCount} 单，成本快照 ${abcSnapshotCount} 条`)

  return {
    yearMonth,
    periodStatus,
    isClosed,
    isFinal,
    openExceptionCount,
    pendingCostCount,
    abcSnapshotCount,
    outboundCount,
    reliability: isFinal ? 'final' : period ? 'attention' : 'draft',
    message: isFinal
      ? '本期间已关账，且没有开放成本异常或未补算单据，可作为经营判断口径。'
      : `${reasons.join('；')}，当前数据仅适合作为过程观察，不能作为最终经营判断。`,
  }
}

const getCostInsightQualityMap = (db: any, months: string[]) => {
  const uniqueMonths = [...new Set(months.map(month => String(month || '').slice(0, 7)).filter(Boolean))]
  return uniqueMonths.reduce((acc: Record<string, ReturnType<typeof getCostInsightQuality>>, month) => {
    acc[month] = getCostInsightQuality(db, month)
    return acc
  }, {})
}

const getMonthRange = (startMonth: string, endMonth: string) => {
  const start = String(startMonth || endMonth || currentMonth()).slice(0, 7)
  const end = String(endMonth || start || currentMonth()).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end)) return [start]

  const months: string[] = []
  let year = Number(start.slice(0, 4))
  let month = Number(start.slice(5, 7))
  const endYear = Number(end.slice(0, 4))
  const endMonthNumber = Number(end.slice(5, 7))

  for (let guard = 0; guard < 60 && (year < endYear || (year === endYear && month <= endMonthNumber)); guard += 1) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }

  return months.length > 0 ? months : [start]
}

const getProfitabilityInsightExtra = (db: any, startMonth: string, endMonth: string) => {
  const months = getMonthRange(startMonth, endMonth)
  const insightQualityByMonth = getCostInsightQualityMap(db, months)
  const primaryMonth = months[0] || currentMonth()

  return {
    insightQuality: insightQualityByMonth[primaryMonth] || getCostInsightQuality(db, primaryMonth),
    insightQualityByMonth,
  }
}

const periodPayload = (row: any) => ({
  id: row.id,
  yearMonth: row.year_month,
  status: row.status,
  startedAt: row.started_at,
  calculatedAt: row.calculated_at,
  reviewedAt: row.reviewed_at,
  closedAt: row.closed_at,
  closedBy: row.closed_by,
  remark: row.remark,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const parseJsonOrNull = (value: string | null | undefined) => {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch (_e) {
    return null
  }
}

const activeStatusSql = (column: string, allowBlank = false) =>
  `(${column} = 'active' OR ${column} = 1 OR ${column} = '1'${allowBlank ? ` OR ${column} IS NULL OR ${column} = ''` : ''})`

const activeStatusPayload = (status: any) => (
  status === 'active' || status === 1 || status === '1' || status === null || status === undefined || status === ''
    ? 'active'
    : 'inactive'
)

const feeMappingAuditSelect = `
  SELECT
    b.id as bom_id,
    b.code as bom_code,
    b.name as bom_name,
    b.type as bom_type,
    b.status as bom_status,
    b.fee_standard_id as legacy_fee_standard_id,
    legacy_fs.name as legacy_fee_standard_name,
    COUNT(fs.id) as mapping_count,
    GROUP_CONCAT(fs.name, '、') as mapped_fee_names,
    open_ex.id as exception_id,
    open_ex.exception_no,
    open_ex.status as exception_status,
    open_ex.created_at as exception_created_at
  FROM boms b
  LEFT JOIN fee_standards legacy_fs
    ON b.fee_standard_id = legacy_fs.id AND ${activeStatusSql('legacy_fs.status')}
  LEFT JOIN bom_fee_mappings m
    ON b.id = m.bom_id AND ${activeStatusSql('m.status')}
  LEFT JOIN fee_standards fs
    ON m.fee_standard_id = fs.id AND ${activeStatusSql('fs.status')}
  LEFT JOIN cost_exceptions open_ex
    ON open_ex.bom_id = b.id
    AND open_ex.exception_type = 'missing_fee_mapping'
    AND open_ex.status = 'open'
  WHERE b.is_deleted = 0
    AND (b.status = 1 OR b.status = '1' OR b.status = 'active')
`

const feeMappingAuditGroup = `
  GROUP BY b.id, b.code, b.name, b.type, b.status, b.fee_standard_id,
           legacy_fs.name, open_ex.id, open_ex.exception_no, open_ex.status, open_ex.created_at
`

const feeMappingAuditHaving = (status: string) => {
  if (status === 'missing') return ' HAVING mapping_count = 0 AND legacy_fee_standard_id IS NULL'
  if (status === 'mapped') return ' HAVING mapping_count > 0'
  if (status === 'legacy') return ' HAVING mapping_count = 0 AND legacy_fee_standard_id IS NOT NULL'
  return ''
}

const feeMappingStatus = (row: any) => {
  if ((Number(row.mapping_count) || 0) > 0) return 'mapped'
  if (row.legacy_fee_standard_id) return 'legacy'
  return 'missing'
}

const feeMappingAuditPayload = (row: any) => ({
  bomId: row.bom_id,
  bomCode: row.bom_code,
  bomName: row.bom_name,
  bomType: row.bom_type,
  status: feeMappingStatus(row),
  mappingCount: Number(row.mapping_count) || 0,
  mappedFeeNames: row.mapped_fee_names ? String(row.mapped_fee_names).split('、') : [],
  legacyFeeStandardId: row.legacy_fee_standard_id,
  legacyFeeStandardName: row.legacy_fee_standard_name,
  exceptionId: row.exception_id,
  exceptionNo: row.exception_no,
  exceptionStatus: row.exception_status,
  exceptionCreatedAt: row.exception_created_at,
})

function assertActiveBom(db: any, bomId: string) {
  const bom = db.prepare(`
    SELECT id, code, name, status
    FROM boms
    WHERE id = ? AND is_deleted = 0
  `).get(bomId) as any
  if (!bom) return { ok: false as const, message: 'BOM不存在', code: 'NOT_FOUND', status: 404 }
  const active = bom.status === 'active' || bom.status === 1 || bom.status === '1'
  if (!active) return { ok: false as const, message: '停用BOM不能配置收费映射', code: 'INVALID_PARAMETER', status: 400 }
  return { ok: true as const, bom }
}

function normalizeFeeMappingsInput(db: any, mappings: any[], requireNonEmpty = true) {
  if (!Array.isArray(mappings)) {
    return { ok: false as const, message: '收费映射格式不正确', code: 'INVALID_PARAMETER', status: 400 }
  }
  const normalized = []
  const seen = new Set<string>()
  for (const mapping of mappings) {
    const feeStandardId = String(mapping?.feeStandardId || '').trim()
    if (!feeStandardId) continue
    const quantityMultiplier = Number(mapping?.quantityMultiplier)
    if (!Number.isFinite(quantityMultiplier) || quantityMultiplier <= 0) {
      return { ok: false as const, message: '数量系数必须大于0', code: 'INVALID_PARAMETER', status: 400 }
    }
    const aggregationScope = mapping?.aggregationScope === 'case' ? 'case' : mapping?.aggregationScope === 'outbound' || !mapping?.aggregationScope ? 'outbound' : ''
    if (!aggregationScope) {
      return { ok: false as const, message: '聚合方式不支持', code: 'INVALID_PARAMETER', status: 400 }
    }
    const duplicateKey = `${feeStandardId}:${aggregationScope}`
    if (seen.has(duplicateKey)) {
      return { ok: false as const, message: '同一收费标准和聚合方式不能重复配置', code: 'RESOURCE_CONFLICT', status: 409 }
    }
    const feeStandard = db.prepare(`SELECT * FROM fee_standards WHERE id = ? AND ${activeStatusSql('status')}`)
      .get(feeStandardId) as any
    if (!feeStandard) {
      return { ok: false as const, message: '收费标准不存在或已停用', code: 'INVALID_PARAMETER', status: 400 }
    }
    seen.add(duplicateKey)
    normalized.push({
      feeStandard,
      feeStandardId,
      quantityMultiplier,
      aggregationScope,
      sortOrder: Number.isFinite(Number(mapping?.sortOrder)) ? Number(mapping.sortOrder) : normalized.length,
    })
  }
  if (requireNonEmpty && normalized.length === 0) {
    return { ok: false as const, message: '至少配置一个有效收费标准', code: 'INVALID_PARAMETER', status: 400 }
  }
  return { ok: true as const, mappings: normalized }
}

const costRunPayload = (row: any) => ({
  id: row.id,
  yearMonth: row.year_month,
  runType: row.run_type,
  status: row.status,
  startedBy: row.started_by,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  summary: parseJsonOrNull(row.summary),
  createdAt: row.created_at,
})

const costAdjustmentPayload = (row: any) => ({
  id: row.id,
  adjustmentNo: row.adjustment_no,
  yearMonth: row.year_month,
  adjustmentType: row.adjustment_type,
  amount: Number(row.amount) || 0,
  reason: row.reason,
  sourceModule: row.source_module,
  sourceId: row.source_id,
  status: row.status,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at,
  reviewRemark: row.review_remark,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const costAdjustmentSnapshot = (row: any) => {
  if (!row) return null
  return costAdjustmentPayload(row)
}

const approvedAdjustmentTotal = (db: any, yearMonth: string) => Number((db.prepare(`
  SELECT COALESCE(SUM(amount), 0) as total
  FROM abc_cost_adjustments
  WHERE year_month = ? AND status = 'approved'
`).get(yearMonth) as any)?.total) || 0

const pendingAdjustmentCount = (db: any, yearMonth: string) => Number((db.prepare(`
  SELECT COUNT(*) as total
  FROM abc_cost_adjustments
  WHERE year_month = ? AND status = 'pending'
`).get(yearMonth) as any)?.total) || 0

// SoD 自审拦截统一走具名守卫 assertNotSelfReview（见下方两处 approve 端点直接内联调用）——
// 不再包本地 wrapper：让每个端点各自携带一个注册表符号调用，供下游权限影子矩阵按调用点精确枚举。

const countableAbcCostClause = `
  COALESCE(cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')
`

const csvEscape = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const toCsv = (headers: string[], rows: Array<Array<unknown>>) => [
  headers.map(csvEscape).join(','),
  ...rows.map(row => row.map(csvEscape).join(',')),
].join('\n')

const monthRangeClause = (alias: string, query: any, field = 'cost_month') => {
  const params: any[] = []
  const startMonth = query.startMonth || query.startDate || query.month || query.yearMonth
  const endMonth = query.endMonth || query.endDate || query.month || query.yearMonth
  let where = '1 = 1'
  if (startMonth) { where += ` AND ${alias}.${field} >= ?`; params.push(String(startMonth).slice(0, 7)) }
  if (endMonth) { where += ` AND ${alias}.${field} <= ?`; params.push(String(endMonth).slice(0, 7)) }
  return { where, params }
}

const upsertCostPool = (
  db: any,
  input: {
    activityCenterId: string
    yearMonth: string
    directCost?: number
    indirectCost?: number
    driverQuantity?: number
    source?: string
    description?: string | null
  },
) => {
  const direct = Number(input.directCost) || 0
  const indirect = Number(input.indirectCost) || 0
  const total = direct + indirect
  const driverQty = Math.max(0, Number(input.driverQuantity) || 0)
  const driverRate = driverQty > 0 ? total / driverQty : 0
  const existing = db.prepare(`
    SELECT id FROM abc_cost_pools WHERE activity_center_id = ? AND year_month = ?
  `).get(input.activityCenterId, input.yearMonth) as any

  if (existing) {
    db.prepare(`
      UPDATE abc_cost_pools
      SET direct_cost = ?, indirect_cost = ?, total_cost = ?, driver_quantity = ?,
          driver_rate = ?, amount = ?, source = ?, description = ?
      WHERE id = ?
    `).run(direct, indirect, total, driverQty, driverRate, total, input.source || 'manual', input.description || null, existing.id)
    return existing.id
  }

  const id = uuidv4()
  db.prepare(`
    INSERT INTO abc_cost_pools (
      id, activity_center_id, year_month,
      direct_cost, indirect_cost, total_cost, driver_quantity, driver_rate,
      amount, source, description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.activityCenterId,
    input.yearMonth,
    direct,
    indirect,
    total,
    driverQty,
    driverRate,
    total,
    input.source || 'manual',
    input.description || null,
  )
  return id
}

const getCostSourceTotals = (db: any, yearMonth: string) => {
  const sampleRows = db.prepare(`
    SELECT p.type as project_type, COALESCE(SUM(r.sample_count), 0) as sample_count
    FROM outbound_records r
    LEFT JOIN projects p ON r.project_id = p.id
    WHERE r.is_deleted = 0 AND r.status = 'completed' AND substr(r.created_at, 1, 7) = ?
    GROUP BY p.type
  `).all(yearMonth) as any[]

  const laborRows = db.prepare(`
    SELECT project_type, standard_minutes, labor_rate_per_minute
    FROM standard_labor_times
    WHERE COALESCE(is_deleted, 0) = 0
  `).all() as any[]

  const sampleCountByType = new Map(sampleRows.map(row => [row.project_type || 'all', Number(row.sample_count) || 0]))
  const totalSamples = sampleRows.reduce((sum, row) => sum + (Number(row.sample_count) || 0), 0)
  const laborTotal = laborRows.reduce((sum, row) => {
    const projectType = row.project_type || 'all'
    const samples = projectType === 'all' ? totalSamples : (sampleCountByType.get(projectType) || 0)
    return sum + samples * (Number(row.standard_minutes) || 0) * (Number(row.labor_rate_per_minute) || 0)
  }, 0)

  const equipmentTotal = (db.prepare(`
    SELECT COALESCE(SUM(depreciation_cost), 0) as total
    FROM equipment_usage
    WHERE substr(COALESCE(usage_date, created_at), 1, 7) = ?
  `).get(yearMonth) as any)?.total || 0

  const indirectTotal = (db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total
    FROM indirect_cost_allocations
    WHERE year_month = ?
  `).get(yearMonth) as any)?.total || 0

  return {
    sampleCount: totalSamples,
    laborTotal,
    equipmentTotal: Number(equipmentTotal) || 0,
    indirectTotal: Number(indirectTotal) || 0,
    total: laborTotal + (Number(equipmentTotal) || 0) + (Number(indirectTotal) || 0),
  }
}

const roundCost = (value: number): number => Math.round((Number(value) || 0) * 100) / 100

// 动因类型 → outbound_abc_details 计量列（白名单，防注入；与 abc_cost_drivers.driver_source_column 对齐）。
const DRIVER_COLUMN: Record<string, string> = {
  block_count: 'block_count',
  slide_count: 'slide_count',
  case_count: 'case_count',
  sample_count: 'sample_count',
}

// 每中心当期实际动因量：按中心 cost_driver_type 取 outbound_abc_details 对应计量列求和（替代旧"全局样本量"）。
const getCenterDriverQuantity = (db: any, centerDriverType: string, yearMonth: string): number => {
  // R2：病例为「每病例」动因 → 取去重病例数 COUNT(DISTINCT case_no)，而非 SUM(case_count)。
  //   否则一病例跨多出库会被重复计数，费率（=池÷动因量）失真为"每出库病例"而非"每病例"。
  //   逐单分摊侧按 1/组大小均摊（cost-calculator.countCostedCaseOutbounds），两侧同口径 → 完全吸收。
  if (centerDriverType === 'case_count') {
    // 混合口径：有 case_no 的行按去重病例数计（一病例跨多出库只计一次）；无 case_no 的行（聚合/历史写法）
    //   退回其 case_count 列求和。两者相加即当期病例动因量。逐单分摊侧对有 case_no 的按 1/组大小均摊，
    //   故两侧同口径、完全吸收。
    const row = db.prepare(`
      SELECT COUNT(DISTINCT case_no)
             + COALESCE(SUM(CASE WHEN case_no IS NULL OR case_no = '' THEN case_count ELSE 0 END), 0) as qty
      FROM outbound_abc_details
      WHERE COALESCE(cost_month, substr(created_at, 1, 7)) = ?
        AND ${countableAbcCostClause}
    `).get(yearMonth) as any
    return Number(row?.qty) || 0
  }
  // 不可计量动因（无对应计量列，如 stain_count/test_count/report_count）→ 返回 0（诚实留作未吸收→残差异常），
  // 不臆造为 slide_count（否则产出貌似合理实则错误的费率）。
  const col = DRIVER_COLUMN[centerDriverType]
  if (!col) return 0
  const row = db.prepare(`
    SELECT COALESCE(SUM(${col}), 0) as qty
    FROM outbound_abc_details
    WHERE COALESCE(cost_month, substr(created_at, 1, 7)) = ?
      AND ${countableAbcCostClause}
  `).get(yearMonth) as any
  return Number(row?.qty) || 0
}

// 间接费单一披露快照（CHAIN-09：每期一个公开基准 + 总额对账锚点）。
const upsertIndirectDisclosure = (db: any, yearMonth: string, basis: string, totalIndirect: number) => {
  const note = '间接费为单一基准分摊估算'
  const existing = db.prepare('SELECT id FROM abc_indirect_disclosure WHERE year_month = ?').get(yearMonth) as any
  if (existing) {
    db.prepare(`UPDATE abc_indirect_disclosure SET basis = ?, total_indirect = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(basis, totalIndirect, note, existing.id)
  } else {
    db.prepare(`INSERT INTO abc_indirect_disclosure (id, year_month, basis, total_indirect, note) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), yearMonth, basis, totalIndirect, note)
  }
}

// 按作业中心归集每中心成本池（B 方案动因优先；删除旧 `/ centers.length` 平均分）。
const collectPerCenterPools = (db: any, yearMonth: string, centers: any[]) => {
  // 0) 先清本期"自动归集"旧池（保留 source='manual' 手工池）：避免改映射/停用中心后残留陈池被重复计入吸收对账，使重算幂等。
  db.prepare(`DELETE FROM abc_cost_pools WHERE year_month = ? AND source = 'auto_collect'`).run(yearMonth)

  // 1) 样本量（按项目类型，供人工成本按类型摊到样本）
  const sampleRows = db.prepare(`
    SELECT p.type as project_type, COALESCE(SUM(r.sample_count), 0) as sample_count
    FROM outbound_records r
    LEFT JOIN projects p ON r.project_id = p.id
    WHERE r.is_deleted = 0 AND r.status = 'completed' AND substr(r.created_at, 1, 7) = ?
    GROUP BY p.type
  `).all(yearMonth) as any[]
  const sampleByType = new Map(sampleRows.map(r => [r.project_type || 'all', Number(r.sample_count) || 0]))
  const totalSamples = sampleRows.reduce((s, r) => s + (Number(r.sample_count) || 0), 0)

  // 2) 人工 → 中心（按 activity_center_id 分组；NULL 计未映射，不静默并入任何中心）
  const laborRows = db.prepare(`
    SELECT activity_center_id, project_type, standard_minutes, labor_rate_per_minute
    FROM standard_labor_times WHERE COALESCE(is_deleted, 0) = 0
  `).all() as any[]
  const laborByCenter = new Map<string, number>()
  let laborUnmapped = 0
  for (const r of laborRows) {
    const pt = r.project_type || 'all'
    const samples = pt === 'all' ? totalSamples : (sampleByType.get(pt) || 0)
    const cost = samples * (Number(r.standard_minutes) || 0) * (Number(r.labor_rate_per_minute) || 0)
    if (cost === 0) continue
    if (r.activity_center_id) laborByCenter.set(r.activity_center_id, (laborByCenter.get(r.activity_center_id) || 0) + cost)
    else laborUnmapped += cost
  }

  // 3) 设备折旧 → 中心（COALESCE 用量定格 / 实例 / 类型默认；NULL 计未映射）
  const equipRows = db.prepare(`
    SELECT COALESCE(eu.activity_center_id, e.activity_center_id, et.default_activity_center_id) as center_id,
           COALESCE(SUM(eu.depreciation_cost), 0) as cost
    FROM equipment_usage eu
    LEFT JOIN equipment e ON e.id = eu.equipment_id
    LEFT JOIN equipment_types et ON et.id = e.type_id
    WHERE substr(COALESCE(eu.usage_date, eu.created_at), 1, 7) = ?
    GROUP BY center_id
  `).all(yearMonth) as any[]
  const equipByCenter = new Map<string, number>()
  let equipUnmapped = 0
  for (const r of equipRows) {
    const cost = Number(r.cost) || 0
    if (r.center_id) equipByCenter.set(r.center_id, (equipByCenter.get(r.center_id) || 0) + cost)
    else equipUnmapped += cost
  }

  // 4) 间接费：direct_activity_center_id 直接归属 vs 其余按单一披露基准分摊
  const allocRows = db.prepare(`
    SELECT a.total_amount, c.direct_activity_center_id
    FROM indirect_cost_allocations a
    LEFT JOIN indirect_cost_centers c ON c.id = a.cost_center_id
    WHERE a.year_month = ?
  `).all(yearMonth) as any[]
  const directIndirectByCenter = new Map<string, number>()
  let indirectTotal = 0
  let distributableIndirect = 0
  for (const r of allocRows) {
    const amt = Number(r.total_amount) || 0
    indirectTotal += amt
    if (r.direct_activity_center_id) {
      directIndirectByCenter.set(r.direct_activity_center_id, (directIndirectByCenter.get(r.direct_activity_center_id) || 0) + amt)
    } else {
      distributableIndirect += amt
    }
  }
  const disclosure = db.prepare('SELECT basis FROM abc_indirect_disclosure WHERE year_month = ?').get(yearMonth) as any
  let basis = (disclosure?.basis as string) || 'by_direct_cost'

  // 5) 每中心直接成本 + 实际动因量
  const centerData = centers.map(c => {
    const labor = laborByCenter.get(c.id) || 0
    const equip = equipByCenter.get(c.id) || 0
    return {
      id: c.id,
      driverType: c.cost_driver_type || 'slide_count',
      labor,
      equip,
      directCost: labor + equip,
      driverQty: getCenterDriverQuantity(db, c.cost_driver_type || 'slide_count', yearMonth),
      directIndirect: directIndirectByCenter.get(c.id) || 0,
    }
  })
  const sumDirect = centerData.reduce((s, c) => s + c.directCost, 0)
  const sumDriverQty = centerData.reduce((s, c) => s + c.driverQty, 0)
  // 单一披露基准权重；若基准信号为 0（如无直接成本），退化为按中心数等分（已披露，确保间接费不凭空消失→保完全吸收）
  let weightOf: (c: typeof centerData[number]) => number
  if (basis === 'by_driver_volume' && sumDriverQty > 0) {
    weightOf = c => c.driverQty / sumDriverQty
  } else if (basis !== 'by_driver_volume' && sumDirect > 0) {
    weightOf = c => c.directCost / sumDirect
  } else {
    weightOf = () => (centerData.length > 0 ? 1 / centerData.length : 0)
    if (distributableIndirect > 0) basis = `${basis}|equal_fallback`
  }

  let created = 0
  for (const c of centerData) {
    const indirectCost = distributableIndirect * weightOf(c) + c.directIndirect
    // 不为"零成本且零动因"的中心建空池（噪声）；有成本或有动因即建（保完全吸收 + 满足下游"动因量>0"）
    if (c.directCost === 0 && indirectCost === 0 && c.driverQty === 0) continue
    upsertCostPool(db, {
      activityCenterId: c.id,
      yearMonth,
      directCost: c.directCost,
      indirectCost,
      driverQuantity: c.driverQty,
      source: 'auto_collect',
      description: `按动因归集：人工 ${roundCost(c.labor)}，设备 ${roundCost(c.equip)}，间接 ${roundCost(indirectCost)}（基准 ${basis}）`,
    })
    created++
  }

  upsertIndirectDisclosure(db, yearMonth, basis, indirectTotal)
  return { created, basis, indirectTotal, laborUnmapped, equipUnmapped }
}

const autoCollectCostPools = (db: any, yearMonth: string) => {
  const centers = db.prepare(`
    SELECT * FROM abc_activity_centers
    WHERE status = 'active' OR status = 1 OR status = '1'
    ORDER BY sort_order ASC
  `).all() as any[]
  const sourceTotals = getCostSourceTotals(db, yearMonth)
  if (centers.length === 0) return { updated: 0, sourceTotals }

  const collected = collectPerCenterPools(db, yearMonth, centers)

  // 完全吸收校验（CHAIN-06）：Σ池 必须 = Σ来源；差额（通常=未映射来源）登记异常台账，不静默。
  const sumPools = Number((db.prepare(
    `SELECT COALESCE(SUM(total_cost), 0) as total FROM abc_cost_pools WHERE year_month = ? AND source = 'auto_collect'`
  ).get(yearMonth) as any)?.total || 0)
  const sourceTotal = Number(sourceTotals.total) || 0
  const diff = roundCost(sumPools - sourceTotal)
  const absorptionOk = Math.abs(diff) <= 0.01
  if (!absorptionOk && sourceTotal > 0) {
    const open = db.prepare(
      `SELECT id FROM cost_exceptions WHERE source_module = 'cost_pool' AND exception_type = 'absorption_residual' AND year_month = ? AND status = 'open'`
    ).get(yearMonth) as any
    if (!open) {
      recordCostException(db, {
        sourceModule: 'cost_pool',
        sourceType: 'absorption',
        yearMonth,
        exceptionType: 'absorption_residual',
        severity: 'warning',
        message: `成本池未完全吸收：Σ池 ${roundCost(sumPools)} ≠ Σ来源 ${roundCost(sourceTotal)}（差额 ${diff}，多为来源未映射作业中心）`,
        details: {
          sumPools: roundCost(sumPools), sourceTotal: roundCost(sourceTotal), diff,
          laborUnmapped: roundCost(collected.laborUnmapped), equipUnmapped: roundCost(collected.equipUnmapped), basis: collected.basis,
        },
      })
    }
  } else {
    // R4：吸收恢复（或无来源）→ 关闭遗留未吸收残差异常，使关账硬门禁（INCOMPLETE_ABSORPTION）口径与当前吸收状态一致，避免陈旧残差永久挡关账。
    db.prepare(
      `UPDATE cost_exceptions SET status = 'resolved', resolved_by = 'system', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE source_module = 'cost_pool' AND exception_type = 'absorption_residual' AND year_month = ? AND status = 'open'`
    ).run(yearMonth)
  }

  return {
    updated: collected.created,
    sourceTotals,
    absorption: {
      sumPools: roundCost(sumPools), sourceTotal: roundCost(sourceTotal), diff, ok: absorptionOk,
      laborUnmapped: roundCost(collected.laborUnmapped), equipUnmapped: roundCost(collected.equipUnmapped), basis: collected.basis,
    },
  }
}

const listTable = (res: any, table: string, mapRow: (row: any) => any, query: any = {}, orderBy = 'created_at DESC') => {
  const { page, pageSize, offset } = pageParams(query)
  const db = getDatabase()
  const total = (db.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as any)?.total || 0
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(pageSize, offset) as any[]
  successList(res, rows.map(mapRow), page, pageSize, total)
}

const budgetPayload = (row: any) => {
  const budgetAmount = Number(row.budget_amount) || 0
  const actualAmount = Number(row.actual_amount) || 0
  return {
    id: row.id,
    yearMonth: row.year_month,
    category: row.category,
    budgetAmount,
    actualAmount,
    executionRate: budgetAmount > 0 ? Math.round((actualAmount / budgetAmount) * 10000) / 10000 : 0,
    status: row.status || 'active',
    description: row.description,
    createdAt: row.created_at,
  }
}

const qualityCostPayload = (row: any) => ({
  id: row.id,
  yearMonth: row.year_month,
  costType: row.cost_type || row.category || '',
  subType: row.sub_type || '',
  amount: Number(row.amount) || 0,
  description: row.description,
  createdAt: row.created_at,
})

const budgetAuditSnapshot = (row: any) => {
  if (!row) return null
  const payload = budgetPayload(row)
  return {
    yearMonth: payload.yearMonth,
    category: payload.category,
    budgetAmount: payload.budgetAmount,
    actualAmount: payload.actualAmount,
    executionRate: payload.executionRate,
    status: payload.status,
    description: payload.description,
  }
}

const qualityCostAuditSnapshot = (row: any) => {
  if (!row) return null
  const payload = qualityCostPayload(row)
  return {
    yearMonth: payload.yearMonth,
    costType: payload.costType,
    subType: payload.subType,
    amount: payload.amount,
    description: payload.description,
  }
}

const activityCenterPayload = (row: any) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description || '',
  costDriverType: row.cost_driver_type || 'slide_count',
  parentId: row.parent_id || null,
  parentName: row.parent_name || null,
  sortOrder: row.sort_order || 0,
  status: activeStatusPayload(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

function normalizeActivityCenterStatus(value: unknown, fallback = 'active') {
  const status = value === undefined || value === null || value === '' ? fallback : String(value)
  if (status === 'active' || status === '1' || status === 'true') return { ok: true as const, value: 'active' }
  if (status === 'inactive' || status === '0' || status === 'false') return { ok: true as const, value: 'inactive' }
  return { ok: false as const, message: '作业中心状态无效' }
}

function normalizeActivityCenterParent(db: any, parentId: unknown, selfId?: string) {
  if (parentId === undefined) return { ok: true as const, value: undefined }
  const normalizedParentId = String(parentId || '').trim()
  if (!normalizedParentId) return { ok: true as const, value: null }
  const parent = db.prepare('SELECT id, parent_id FROM abc_activity_centers WHERE id = ?').get(normalizedParentId) as any
  if (!parent) return { ok: false as const, message: '上级作业中心不存在' }
  if (selfId) {
    let current: any = parent
    while (current) {
      if (current.id === selfId) return { ok: false as const, message: '作业中心不能选择自己或下级作为上级' }
      if (!current.parent_id) break
      current = db.prepare('SELECT id, parent_id FROM abc_activity_centers WHERE id = ?').get(current.parent_id) as any
    }
  }
  return { ok: true as const, value: normalizedParentId }
}

const costDriverPayload = (row: any) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  unit: row.unit || '',
  calculationMethod: row.calculation_method || 'linear',
  tierRules: parseJsonOrNull(row.tier_rules),
  description: row.description || '',
  status: activeStatusPayload(row.status),
  createdAt: row.created_at,
})

const COST_DRIVER_METHODS = new Set(['linear', 'tiered', 'fixed'])

function normalizeCostDriverPayload(body: any, existing?: any) {
  const method = String(body?.calculationMethod || existing?.calculation_method || 'linear').trim()
  if (!COST_DRIVER_METHODS.has(method)) {
    return { ok: false as const, message: '成本动因计算方法不支持', code: 'INVALID_PARAMETER', status: 400 }
  }

  let tierRules: Array<{ from: number; to: number | null; rate: number; label: string }> | null = null

  if (method === 'tiered') {
    const rawRules = body?.tierRules !== undefined ? body.tierRules : parseJsonOrNull(existing?.tier_rules)
    if (!Array.isArray(rawRules) || rawRules.length === 0) {
      return { ok: false as const, message: '阶梯成本动因必须配置区间费率', code: 'INVALID_TIER_RULES', status: 400 }
    }

    const normalized = rawRules.map((rule: any, index: number) => {
      const from = Number(rule?.from)
      const hasOpenEnd = rule?.to === null || rule?.to === undefined || String(rule?.to).trim() === ''
      const to = hasOpenEnd ? null : Number(rule?.to)
      const rate = Number(rule?.rate)
      const label = String(rule?.label || '').trim()

      if (!Number.isFinite(from) || from < 0) {
        return { error: `第${index + 1}阶梯起始数量必须大于等于0` }
      }
      if (to !== null && (!Number.isFinite(to) || to <= from)) {
        return { error: `第${index + 1}阶梯结束数量必须大于起始数量` }
      }
      if (!Number.isFinite(rate) || rate < 0) {
        return { error: `第${index + 1}阶梯费率必须大于等于0` }
      }

      return {
        from,
        to,
        rate,
        label: label || `${from}${to === null ? '以上' : `-${to}`}`,
      }
    })

    const invalid = normalized.find((rule: any) => rule.error) as any
    if (invalid) {
      return { ok: false as const, message: invalid.error, code: 'INVALID_TIER_RULES', status: 400 }
    }

    const sorted = normalized as Array<{ from: number; to: number | null; rate: number; label: string }>
    for (let index = 0; index < sorted.length; index += 1) {
      const rule = sorted[index]
      if (index === 0 && rule.from !== 0) {
        return { ok: false as const, message: '阶梯费率必须从0开始', code: 'INVALID_TIER_RULES', status: 400 }
      }
      if (index > 0) {
        const previous = sorted[index - 1]
        if (previous.to === null) {
          return { ok: false as const, message: '开口阶梯只能放在最后一行', code: 'INVALID_TIER_RULES', status: 400 }
        }
        if (rule.from !== previous.to) {
          return { ok: false as const, message: '阶梯区间必须连续且不能重叠', code: 'INVALID_TIER_RULES', status: 400 }
        }
      }
      if (rule.to === null && index !== sorted.length - 1) {
        return { ok: false as const, message: '开口阶梯只能放在最后一行', code: 'INVALID_TIER_RULES', status: 400 }
      }
    }

    tierRules = sorted
  }

  return { ok: true as const, method, tierRules }
}

function validateCostDriverType(db: any, code: string) {
  const driverCode = String(code || '').trim()
  if (!driverCode) return { ok: false as const, message: '成本动因类型不能为空' }
  const driver = db.prepare(`
    SELECT * FROM abc_cost_drivers
    WHERE code = ?
      AND (status = 'active' OR status = 1 OR status = '1' OR status IS NULL OR status = '')
  `).get(driverCode) as any
  if (!driver) return { ok: false as const, message: '成本动因类型不存在或已停用' }
  return { ok: true as const, code: driverCode }
}

function validateCostPoolInput(db: any, body: any) {
  const activityCenterId = String(body?.activityCenterId || '').trim()
  if (!activityCenterId) {
    return { ok: false as const, message: '作业中心不能为空', code: 'INVALID_PARAMETER', status: 400 }
  }

  const activityCenter = db.prepare(`
    SELECT * FROM abc_activity_centers
    WHERE id = ?
      AND (status = 'active' OR status = 1 OR status = '1' OR status IS NULL OR status = '')
  `).get(activityCenterId) as any
  if (!activityCenter) {
    return { ok: false as const, message: '作业中心不存在或已停用', code: 'INVALID_PARAMETER', status: 400 }
  }

  const yearMonth = normalizeMonth(body?.yearMonth)
  const direct = body?.directCost === undefined || body?.directCost === null ? 0 : Number(body.directCost)
  const indirect = body?.indirectCost === undefined || body?.indirectCost === null ? 0 : Number(body.indirectCost)
  const total = body?.amount === undefined || body?.amount === null ? direct + indirect : Number(body.amount)
  const driverQty = Number(body?.driverQuantity)
  const source = String(body?.source || 'manual').trim() || 'manual'
  const adjustmentReason = trimmedText(body?.adjustmentReason || body?.manualAdjustmentReason || body?.reason)
  const sourceDocumentNo = trimmedText(body?.sourceDocumentNo || body?.sourceDocument || body?.documentNo)
  const attachmentUrl = trimmedText(body?.attachmentUrl || body?.attachment)
  const linkedAdjustmentId = trimmedText(body?.adjustmentId || body?.linkedAdjustmentId)

  if (!Number.isFinite(direct) || direct < 0) {
    return { ok: false as const, message: '直接成本不能为负数', code: 'INVALID_PARAMETER', status: 400 }
  }
  if (!Number.isFinite(indirect) || indirect < 0) {
    return { ok: false as const, message: '间接成本不能为负数', code: 'INVALID_PARAMETER', status: 400 }
  }
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false as const, message: '成本池金额不能为负数', code: 'INVALID_PARAMETER', status: 400 }
  }
  if (!Number.isFinite(driverQty) || driverQty <= 0) {
    return { ok: false as const, message: '动因数量必须大于0', code: 'INVALID_PARAMETER', status: 400 }
  }
  if (source === 'manual' && !adjustmentReason) {
    return { ok: false as const, message: '手工成本池调整原因不能为空', code: 'COST_POOL_ADJUSTMENT_REASON_REQUIRED', status: 400 }
  }
  if (linkedAdjustmentId) {
    const linkedAdjustment = db.prepare(`
      SELECT id, status
      FROM abc_cost_adjustments
      WHERE id = ?
    `).get(linkedAdjustmentId) as any
    if (!linkedAdjustment) {
      return { ok: false as const, message: '关联调整单不存在', code: 'INVALID_PARAMETER', status: 400 }
    }
    if (linkedAdjustment.status !== 'approved') {
      return { ok: false as const, message: '关联调整单必须已通过审核', code: 'INVALID_PARAMETER', status: 400 }
    }
  }

  return {
    ok: true as const,
    activityCenterId,
    yearMonth,
    direct,
    indirect,
    total,
    driverQty,
    driverRate: total / driverQty,
    source,
    description: body?.description || null,
    adjustmentReason: adjustmentReason || null,
    sourceDocumentNo: sourceDocumentNo || null,
    attachmentUrl: attachmentUrl || null,
    linkedAdjustmentId: linkedAdjustmentId || null,
  }
}

function costPoolSnapshot(row: any) {
  if (!row) return null
  return {
    id: row.id,
    activityCenterId: row.activity_center_id,
    yearMonth: row.year_month,
    directCost: Number(row.direct_cost || 0),
    indirectCost: Number(row.indirect_cost || 0),
    totalCost: Number(row.total_cost || row.amount || 0),
    driverQuantity: Number(row.driver_quantity || 0),
    driverRate: Number(row.driver_rate || 0),
    source: row.source || 'manual',
    description: row.description || null,
    adjustmentReason: row.adjustment_reason || null,
    sourceDocumentNo: row.source_document_no || null,
    attachmentUrl: row.attachment_url || null,
    linkedAdjustmentId: row.linked_adjustment_id || null,
  }
}

const costExceptionPayload = (row: any) => ({
  id: row.id,
  exceptionNo: row.exception_no,
  sourceModule: row.source_module,
  sourceType: row.source_type,
  sourceId: row.source_id,
  projectId: row.project_id,
  projectName: row.project_name || null,
  bomId: row.bom_id,
  bomName: row.bom_name || null,
  outboundId: row.outbound_id,
  outboundNo: row.outbound_no || null,
  yearMonth: row.year_month,
  exceptionType: row.exception_type,
  severity: row.severity,
  status: row.status,
  message: row.message,
  details: parseJsonOrNull(row.details),
  retryCount: row.retry_count || 0,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const ensureCostExceptionOpen = (res: any, row: any) => {
  if (row.status === 'open') return true
  error(res, '成本异常已处理，不可重复操作', 'COST_EXCEPTION_ALREADY_HANDLED', 409)
  return false
}

const trimmedText = (value: unknown) => typeof value === 'string' ? value.trim() : ''

router.get('/closing-readiness', requireCostWorkbenchRead, (req, res) => {
  try {
    const yearMonth = normalizeMonth(req.query.yearMonth)
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
      error(res, 'yearMonth 必须为 YYYY-MM', 'INVALID_PARAMETER', 400)
      return
    }
    const db = getDatabase()
    success(res, buildClosingReadiness(db, yearMonth))
  } catch (err: any) { error(res, err.message) }
})

router.get('/periods', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const { status, yearMonth } = req.query
    let where = '1 = 1'
    const params: any[] = []

    if (status) { where += ' AND status = ?'; params.push(status) }
    if (yearMonth) { where += ' AND year_month = ?'; params.push(yearMonth) }

    const total = (db.prepare(`SELECT COUNT(*) as total FROM abc_periods WHERE ${where}`).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT * FROM abc_periods
      WHERE ${where}
      ORDER BY year_month DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, rows.map(periodPayload), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.post('/periods', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const yearMonth = normalizeMonth(req.body?.yearMonth)
    const remark = req.body?.remark || null
    const existing = db.prepare('SELECT * FROM abc_periods WHERE year_month = ?').get(yearMonth) as any

    if (existing) {
      if (remark !== null) {
        db.prepare('UPDATE abc_periods SET remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(remark, existing.id)
      }
      success(res, periodPayload(db.prepare('SELECT * FROM abc_periods WHERE id = ?').get(existing.id) as any))
      return
    }

    const id = uuidv4()
    db.prepare(`
      INSERT INTO abc_periods (id, year_month, status, started_at, remark)
      VALUES (?, ?, 'open', CURRENT_TIMESTAMP, ?)
    `).run(id, yearMonth, remark)
    writeAuditLog(db, 'period', 'create', id, { yearMonth, remark }, operator)
    success(res, periodPayload(db.prepare('SELECT * FROM abc_periods WHERE id = ?').get(id) as any), 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

router.post('/periods/:id/start-collection', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const period = db.prepare('SELECT * FROM abc_periods WHERE id = ?').get(req.params.id) as any
    if (!period) { error(res, '成本期间不存在', 'NOT_FOUND', 404); return }
    if (period.status === 'closed') { error(res, '已关账期间不能重新开始归集', 'PERIOD_CLOSED', 422); return }

    db.prepare(`
      UPDATE abc_periods
      SET status = 'collecting', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id)
    writeAuditLog(db, 'period', 'start_collection', req.params.id, { yearMonth: period.year_month }, operator)
    success(res, periodPayload(db.prepare('SELECT * FROM abc_periods WHERE id = ?').get(req.params.id) as any))
  } catch (err: any) { error(res, err.message) }
})

router.post('/periods/:id/close', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const period = db.prepare('SELECT * FROM abc_periods WHERE id = ?').get(req.params.id) as any
    if (!period) { error(res, '成本期间不存在', 'NOT_FOUND', 404); return }
    if (period.status === 'closed') { success(res, periodPayload(period)); return }
    if (period.status !== 'calculated') {
      error(res, '成本期间尚未完成核算，不能关账', 'PERIOD_NOT_CALCULATED', 422, { status: period.status })
      return
    }

    const openFeeMapping = (db.prepare(`
      SELECT COUNT(*) as total
      FROM cost_exceptions
      WHERE (year_month = ? OR year_month IS NULL)
        AND status = 'open'
        AND exception_type = 'missing_fee_mapping'
    `).get(period.year_month) as any)?.total || 0
    if (openFeeMapping > 0) {
      error(res, '存在未处理的收费映射异常，不能关账', 'OPEN_FEE_MAPPING_EXCEPTIONS', 422, { blocking: openFeeMapping })
      return
    }
    const blocking = (db.prepare(`
      SELECT COUNT(*) as total
      FROM cost_exceptions
      WHERE (year_month = ? OR year_month IS NULL) AND status = 'open' AND severity = 'error'
    `).get(period.year_month) as any)?.total || 0
    if (blocking > 0) {
      error(res, '存在未处理的错误级成本异常，不能关账', 'OPEN_COST_EXCEPTIONS', 422, { blocking })
      return
    }
    const pendingCost = (db.prepare(`
      SELECT COUNT(*) as total
      FROM outbound_records
      WHERE is_deleted = 0
        AND status = 'completed'
        AND substr(created_at, 1, 7) = ?
        AND COALESCE(cost_status, 'pending_cost') IN ('pending_cost', 'cost_exception')
    `).get(period.year_month) as any)?.total || 0
    if (pendingCost > 0) {
      error(res, '存在未补算或成本异常的出库记录，不能关账', 'PENDING_COST_ITEMS', 422, { blocking: pendingCost })
      return
    }
    // R4（CHAIN-10 关账可信）：完全吸收硬门禁——成本池未完全吸收（Σ池≠Σ来源，有未映射来源残差）时阻断关账，
    // 不再仅以 warning 放行。残差在补映射后重跑 auto-collect 即自动 resolve（见归集 resolve-on-OK）。
    const openAbsorption = (db.prepare(`
      SELECT COUNT(*) as total
      FROM cost_exceptions
      WHERE (year_month = ? OR year_month IS NULL)
        AND status = 'open'
        AND exception_type = 'absorption_residual'
    `).get(period.year_month) as any)?.total || 0
    if (openAbsorption > 0) {
      error(res, '成本池未完全吸收（Σ池≠Σ来源），不能关账：请补齐未映射成本来源后重新归集', 'INCOMPLETE_ABSORPTION', 422, { blocking: openAbsorption })
      return
    }

    db.prepare(`
      UPDATE abc_periods
      SET status = 'closed', closed_by = ?, closed_at = CURRENT_TIMESTAMP,
          remark = COALESCE(?, remark), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(operator, req.body?.remark || null, req.params.id)
    writeAuditLog(db, 'period', 'close', req.params.id, { yearMonth: period.year_month }, operator)
    success(res, periodPayload(db.prepare('SELECT * FROM abc_periods WHERE id = ?').get(req.params.id) as any))
  } catch (err: any) { error(res, err.message) }
})

router.get('/activity-centers', requireCostWorkbenchRead, (req, res) => {
  try {
    const db = getDatabase()
    const keyword = String(req.query.keyword || '').trim()
    const params: any[] = []
    let where = ''
    if (keyword) {
      const kw = `%${keyword}%`
      where = `
        WHERE ac.id LIKE ?
           OR ac.code LIKE ?
           OR ac.name LIKE ?
           OR ac.description LIKE ?
           OR ac.cost_driver_type LIKE ?
           OR ac.status LIKE ?
      `
      params.push(kw, kw, kw, kw, kw, kw)
    }
    const rows = db.prepare(`
      SELECT ac.*, parent.name as parent_name
      FROM abc_activity_centers ac
      LEFT JOIN abc_activity_centers parent ON parent.id = ac.parent_id
      ${where}
      ORDER BY ac.sort_order ASC, ac.created_at DESC
    `).all(...params) as any[]
    success(res, rows.map(activityCenterPayload))
  } catch (err: any) { error(res, err.message) }
})

router.get('/activity-centers/:id', requireCostWorkbenchRead, (req, res) => {
  try {
    const row = getDatabase().prepare(`
      SELECT ac.*, parent.name as parent_name
      FROM abc_activity_centers ac
      LEFT JOIN abc_activity_centers parent ON parent.id = ac.parent_id
      WHERE ac.id = ?
    `).get(req.params.id) as any
    if (!row) { error(res, '作业中心不存在', 'NOT_FOUND', 404); return }
    success(res, activityCenterPayload(row))
  } catch (err: any) { error(res, err.message) }
})

router.post('/activity-centers', requireCostWrite, (req, res) => {
  try {
    const { code, name, description, costDriverType, parentId, sortOrder, status } = req.body
    if (!code || !name) { error(res, '缺少必填字段', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const operator = getOperator(req)
    const driverValidation = validateCostDriverType(db, costDriverType || 'slide_count')
    if (!driverValidation.ok) { error(res, driverValidation.message, 'INVALID_PARAMETER', 400); return }
    const parentValidation = normalizeActivityCenterParent(db, parentId)
    if (!parentValidation.ok) { error(res, parentValidation.message, 'INVALID_PARAMETER', 400); return }
    const statusValidation = normalizeActivityCenterStatus(status)
    if (!statusValidation.ok) { error(res, statusValidation.message, 'INVALID_PARAMETER', 400); return }
    const id = uuidv4()
    db.prepare(`
      INSERT INTO abc_activity_centers (id, code, name, description, cost_driver_type, parent_id, sort_order, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, code, name, description || null, driverValidation.code, parentValidation.value ?? null, sortOrder || 0, statusValidation.value)
    writeAuditLog(db, 'activity_center', 'create', id, { code, name, costDriverType: driverValidation.code, parentId: parentValidation.value ?? null, status: statusValidation.value }, operator)
    success(res, { id }, 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

router.put('/activity-centers/:id', requireCostWrite, (req, res) => {
  try {
    const { name, description, costDriverType, parentId, sortOrder, status } = req.body
    const db = getDatabase()
    const operator = getOperator(req)
    const existing = db.prepare('SELECT * FROM abc_activity_centers WHERE id = ?').get(req.params.id) as any
    if (!existing) { error(res, '作业中心不存在', 'NOT_FOUND', 404); return }
    const nextCostDriverType = costDriverType || existing.cost_driver_type
    const driverValidation = validateCostDriverType(db, nextCostDriverType)
    if (!driverValidation.ok) { error(res, driverValidation.message, 'INVALID_PARAMETER', 400); return }
    const parentValidation = normalizeActivityCenterParent(db, parentId, req.params.id)
    if (!parentValidation.ok) { error(res, parentValidation.message, 'INVALID_PARAMETER', 400); return }
    const statusValidation = normalizeActivityCenterStatus(status, existing.status)
    if (!statusValidation.ok) { error(res, statusValidation.message, 'INVALID_PARAMETER', 400); return }
    const nextParentId = parentValidation.value === undefined ? existing.parent_id : parentValidation.value
    db.prepare(`
      UPDATE abc_activity_centers
      SET name = ?, description = ?, cost_driver_type = ?, parent_id = ?, sort_order = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name || existing.name,
      description !== undefined ? description : existing.description,
      driverValidation.code,
      nextParentId,
      sortOrder !== undefined ? sortOrder : existing.sort_order,
      statusValidation.value,
      req.params.id
    )
    writeAuditLog(db, 'activity_center', 'update', req.params.id, {
      name: name || existing.name,
      costDriverType: driverValidation.code,
      parentId: nextParentId,
      status: statusValidation.value,
    }, operator)
    success(res, { id: req.params.id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/activity-centers/:id', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const existing = db.prepare('SELECT * FROM abc_activity_centers WHERE id = ?').get(req.params.id) as any
    if (!existing) { error(res, '作业中心不存在', 'NOT_FOUND', 404); return }
    const childCount = (db.prepare('SELECT COUNT(*) as count FROM abc_activity_centers WHERE parent_id = ?').get(req.params.id) as any)?.count || 0
    if (Number(childCount) > 0) { error(res, '存在子作业中心，不能删除', 'RESOURCE_CONFLICT', 409); return }
    const bomLinkCount = (db.prepare('SELECT COUNT(*) as count FROM bom_activity_links WHERE activity_center_id = ?').get(req.params.id) as any)?.count || 0
    if (Number(bomLinkCount) > 0) { error(res, '作业中心已被BOM引用，不能删除', 'RESOURCE_CONFLICT', 409); return }
    const poolCount = (db.prepare('SELECT COUNT(*) as count FROM abc_cost_pools WHERE activity_center_id = ?').get(req.params.id) as any)?.count || 0
    if (Number(poolCount) > 0) { error(res, '作业中心已有成本池记录，不能删除', 'RESOURCE_CONFLICT', 409); return }
    db.prepare('DELETE FROM abc_activity_centers WHERE id = ?').run(req.params.id)
    writeAuditLog(db, 'activity_center', 'delete', req.params.id, { code: existing.code, name: existing.name }, operator)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

router.get('/cost-drivers', requireCostWorkbenchRead, (req, res) => {
  try {
    const keyword = String(req.query.keyword || '').trim()
    const params: any[] = []
    let where = ''
    if (keyword) {
      const kw = `%${keyword}%`
      where = `
        WHERE id LIKE ?
           OR code LIKE ?
           OR name LIKE ?
           OR unit LIKE ?
           OR calculation_method LIKE ?
           OR tier_rules LIKE ?
           OR description LIKE ?
           OR status LIKE ?
      `
      params.push(kw, kw, kw, kw, kw, kw, kw, kw)
    }
    const rows = getDatabase().prepare(`
      SELECT *
      FROM abc_cost_drivers
      ${where}
      ORDER BY created_at DESC
    `).all(...params) as any[]
    success(res, rows.map(costDriverPayload))
  } catch (err: any) { error(res, err.message) }
})

router.post('/cost-drivers', requireCostWrite, (req, res) => {
  try {
    const { code, name, unit, calculationMethod, tierRules, description } = req.body
    if (!code || !name) { error(res, '缺少必填字段', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const operator = getOperator(req)
    const normalized = normalizeCostDriverPayload({ calculationMethod, tierRules })
    if (!normalized.ok) { error(res, normalized.message, normalized.code, normalized.status); return }
    const id = uuidv4()
    db.prepare(`
      INSERT INTO abc_cost_drivers (id, code, name, unit, calculation_method, tier_rules, description, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id,
      code,
      name,
      unit || '',
      normalized.method,
      normalized.tierRules ? JSON.stringify(normalized.tierRules) : null,
      description || null
    )
    writeAuditLog(db, 'cost_driver', 'create', id, {
      code,
      name,
      unit,
      calculationMethod: normalized.method,
      tierRules: normalized.tierRules,
    }, operator)
    success(res, { id }, 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

router.put('/cost-drivers/:id', requireCostWrite, (req, res) => {
  try {
    const { name, unit, description, status } = req.body
    const db = getDatabase()
    const operator = getOperator(req)
    const existing = db.prepare('SELECT * FROM abc_cost_drivers WHERE id = ?').get(req.params.id) as any
    if (!existing) { error(res, '成本动因不存在', 'NOT_FOUND', 404); return }
    const normalized = normalizeCostDriverPayload(req.body, existing)
    if (!normalized.ok) { error(res, normalized.message, normalized.code, normalized.status); return }
    db.prepare(`
      UPDATE abc_cost_drivers
      SET name = ?, unit = ?, calculation_method = ?, tier_rules = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name || existing.name,
      unit !== undefined ? unit : existing.unit,
      normalized.method,
      normalized.tierRules ? JSON.stringify(normalized.tierRules) : null,
      description !== undefined ? description : existing.description,
      status || existing.status,
      req.params.id
    )
    writeAuditLog(db, 'cost_driver', 'update', req.params.id, {
      name: name || existing.name,
      unit: unit !== undefined ? unit : existing.unit,
      calculationMethod: normalized.method,
      tierRules: normalized.tierRules,
      status: status || existing.status,
    }, operator)
    success(res, { id: req.params.id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/cost-drivers/:id', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const existing = db.prepare('SELECT * FROM abc_cost_drivers WHERE id = ?').get(req.params.id) as any
    if (!existing) { error(res, '成本动因不存在', 'NOT_FOUND', 404); return }
    const activityCenterCount = (db.prepare('SELECT COUNT(*) as count FROM abc_activity_centers WHERE cost_driver_type = ?').get(existing.code) as any)?.count || 0
    if (Number(activityCenterCount) > 0) { error(res, '成本动因已被作业中心引用，不能删除', 'RESOURCE_CONFLICT', 409); return }
    db.prepare('DELETE FROM abc_cost_drivers WHERE id = ?').run(req.params.id)
    writeAuditLog(db, 'cost_driver', 'delete', req.params.id, { code: existing.code, name: existing.name }, operator)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

router.get('/cost-pools', requireCostWorkbenchRead, (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const { yearMonth, activityCenterId, source, keyword } = req.query
    let where = '1 = 1'
    const params: any[] = []

    if (yearMonth) { where += ' AND p.year_month = ?'; params.push(String(yearMonth).slice(0, 7)) }
    if (activityCenterId) { where += ' AND p.activity_center_id = ?'; params.push(activityCenterId) }
    if (source) { where += ' AND p.source = ?'; params.push(source) }
    if (keyword) {
      where += ' AND (p.id LIKE ? OR ac.name LIKE ? OR ac.code LIKE ? OR p.description LIKE ? OR p.source LIKE ? OR p.adjustment_reason LIKE ? OR p.source_document_no LIKE ?)'
      const kw = `%${String(keyword).trim()}%`
      params.push(kw, kw, kw, kw, kw, kw, kw)
    }

    const total = (db.prepare(`
      SELECT COUNT(*) as total
      FROM abc_cost_pools p
      LEFT JOIN abc_activity_centers ac ON p.activity_center_id = ac.id
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT p.*, ac.name as activity_center_name, ac.code as activity_center_code
      FROM abc_cost_pools p
      LEFT JOIN abc_activity_centers ac ON p.activity_center_id = ac.id
      WHERE ${where}
      ORDER BY p.year_month DESC, ac.sort_order ASC, p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, rows.map(row => ({
      id: row.id,
      activityCenterId: row.activity_center_id,
      activityCenterName: row.activity_center_name || '未关联作业中心',
      activityCenterCode: row.activity_center_code || '',
      yearMonth: row.year_month,
      directCost: row.direct_cost || 0,
      indirectCost: row.indirect_cost || 0,
      totalCost: row.total_cost || row.amount || 0,
      driverQuantity: row.driver_quantity || 0,
      driverRate: row.driver_rate || 0,
      amount: row.amount || row.total_cost || 0,
      source: row.source,
      description: row.description,
      adjustmentReason: row.adjustment_reason,
      sourceDocumentNo: row.source_document_no,
      attachmentUrl: row.attachment_url,
      linkedAdjustmentId: row.linked_adjustment_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.post('/cost-pools', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const input = validateCostPoolInput(db, req.body)
    if (!input.ok) { error(res, input.message, input.code, input.status); return }
    ensurePeriodOpen(db, input.yearMonth)

    const existing = db.prepare('SELECT * FROM abc_cost_pools WHERE activity_center_id = ? AND year_month = ?')
      .get(input.activityCenterId, input.yearMonth) as any

    if (existing) {
      db.prepare(`
        UPDATE abc_cost_pools
        SET direct_cost = ?, indirect_cost = ?, total_cost = ?, driver_quantity = ?,
            driver_rate = ?, amount = ?, source = ?, description = ?,
            adjustment_reason = ?, source_document_no = ?, attachment_url = ?,
            linked_adjustment_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        input.direct,
        input.indirect,
        input.total,
        input.driverQty,
        input.driverRate,
        input.total,
        input.source,
        input.description,
        input.adjustmentReason,
        input.sourceDocumentNo,
        input.attachmentUrl,
        input.linkedAdjustmentId,
        existing.id,
      )
      writeAuditLog(db, 'cost_pool', 'update', existing.id, {
        yearMonth: input.yearMonth,
        activityCenterId: input.activityCenterId,
        totalCost: input.total,
        driverQuantity: input.driverQty,
        driverRate: input.driverRate,
        source: input.source,
        adjustmentReason: input.adjustmentReason,
        sourceDocumentNo: input.sourceDocumentNo,
      }, operator)
      const updated = db.prepare('SELECT * FROM abc_cost_pools WHERE id = ?').get(existing.id) as any
      logOperation(db, req as any, {
        operation: 'POST /abc/cost-pools',
        description: `更新手工成本池 ${input.yearMonth}`,
        requestData: {
          module: 'abc_cost_pools',
          id: existing.id,
          action: 'update',
          before: costPoolSnapshot(existing),
          after: costPoolSnapshot(updated),
        },
        responseData: { id: existing.id, status: 'updated' },
      })
      success(res, { id: existing.id }, 'Updated')
      return
    }

    const id = uuidv4()
    db.prepare(`
      INSERT INTO abc_cost_pools (
        id, activity_center_id, year_month,
        direct_cost, indirect_cost, total_cost, driver_quantity, driver_rate,
        amount, source, description, adjustment_reason, source_document_no,
        attachment_url, linked_adjustment_id, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      input.activityCenterId,
      input.yearMonth,
      input.direct,
      input.indirect,
      input.total,
      input.driverQty,
      input.driverRate,
      input.total,
      input.source,
      input.description,
      input.adjustmentReason,
      input.sourceDocumentNo,
      input.attachmentUrl,
      input.linkedAdjustmentId,
    )
    writeAuditLog(db, 'cost_pool', 'create', id, {
      yearMonth: input.yearMonth,
      activityCenterId: input.activityCenterId,
      totalCost: input.total,
      driverQuantity: input.driverQty,
      driverRate: input.driverRate,
      source: input.source,
      adjustmentReason: input.adjustmentReason,
      sourceDocumentNo: input.sourceDocumentNo,
    }, operator)
    const created = db.prepare('SELECT * FROM abc_cost_pools WHERE id = ?').get(id) as any
    logOperation(db, req as any, {
      operation: 'POST /abc/cost-pools',
      description: `创建手工成本池 ${input.yearMonth}`,
      requestData: {
        module: 'abc_cost_pools',
        id,
        action: 'create',
        before: null,
        after: costPoolSnapshot(created),
      },
      responseData: { id, status: 'created' },
    })
    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    const code = err.message?.includes('已关账') ? 'PERIOD_CLOSED' : 'INTERNAL_ERROR'
    error(res, err.message, code, code === 'PERIOD_CLOSED' ? 422 : 500)
  }
})

router.post('/cost-pools/:action(sync|auto-collect|recalculate)', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const yearMonth = normalizeMonth(req.body?.yearMonth)
    const action = req.params.action
    ensurePeriodOpen(db, yearMonth)
    const period = getOrCreatePeriod(db, yearMonth, operator)

    if (action === 'sync') {
      const sourceTotals = getCostSourceTotals(db, yearMonth)
      db.prepare(`
        UPDATE abc_periods
        SET status = 'collecting', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(period.id)
      writeAuditLog(db, 'cost_pool', 'sync', period.id, { yearMonth, sourceTotals }, operator)
      const payload = { yearMonth, periodId: period.id, sourceTotals }
      logOperation(db, req as any, {
        operation: 'POST /abc/cost-pools/:action',
        description: '同步ABC成本池来源数据',
        requestData: { action, yearMonth },
        responseData: payload,
      })
      success(res, payload, 'Synced')
      return
    }

    if (action === 'auto-collect') {
      const result = autoCollectCostPools(db, yearMonth)
      db.prepare(`
        UPDATE abc_periods
        SET status = 'collecting', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(period.id)
      writeAuditLog(db, 'cost_pool', 'auto_collect', period.id, { yearMonth, ...result }, operator)
      const payload = { yearMonth, periodId: period.id, ...result }
      logOperation(db, req as any, {
        operation: 'POST /abc/cost-pools/:action',
        description: '自动归集ABC成本池',
        requestData: { action, yearMonth },
        responseData: payload,
      })
      success(res, payload, 'Collected')
      return
    }

    const collectResult = autoCollectCostPools(db, yearMonth)
    const run = runCostRecalculation(db, yearMonth, operator, 'recalculate')
    const payload = { yearMonth, periodId: period.id, collectResult, run }
    logOperation(db, req as any, {
      operation: 'POST /abc/cost-pools/:action',
      description: '重新计算ABC成本池与出库成本',
      requestData: { action, yearMonth },
      responseData: payload,
    })
    success(res, payload, 'Recalculated')
  } catch (err: any) {
    const code = err.message?.includes('已关账') ? 'PERIOD_CLOSED' : 'INTERNAL_ERROR'
    error(res, err.message, code, code === 'PERIOD_CLOSED' ? 422 : 500)
  }
})

router.get('/bom-links/:bomId', (req, res) => {
  try {
    const rows = getDatabase().prepare(`
      SELECT l.*, ac.name as activity_center_name, ac.code as activity_center_code
      FROM bom_activity_links l
      LEFT JOIN abc_activity_centers ac ON l.activity_center_id = ac.id
      WHERE l.bom_id = ?
      ORDER BY l.sort_order ASC
    `).all(req.params.bomId) as any[]
    success(res, rows.map(row => ({
      id: row.id,
      bomId: row.bom_id,
      activityCenterId: row.activity_center_id,
      activityCenterName: row.activity_center_name,
      activityCenterCode: row.activity_center_code,
      quantity: row.quantity || 0,
      unit: row.unit,
      sortOrder: row.sort_order || 0,
    })))
  } catch (err: any) { error(res, err.message) }
})

router.put('/bom-links/:bomId', requireCostWrite, (req, res) => {
  try {
    const { links = [] } = req.body
    const db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM bom_activity_links WHERE bom_id = ?').run(req.params.bomId)
      const stmt = db.prepare(`
        INSERT INTO bom_activity_links (id, bom_id, activity_center_id, quantity, unit, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      links.forEach((link: any, index: number) => {
        stmt.run(uuidv4(), req.params.bomId, link.activityCenterId, Number(link.quantity) || 0, link.unit || null, link.sortOrder ?? index)
      })
      db.exec('COMMIT')
    } catch (innerErr) {
      db.exec('ROLLBACK')
      throw innerErr
    }
    success(res, { count: links.length }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.get('/bom-fee-mappings/audit', requireCostWorkbenchRead, (req, res) => {
  try {
    const db = getDatabase()
    const { page, pageSize, offset } = pageParams(req.query)
    const status = ['mapped', 'legacy', 'missing'].includes(String(req.query.status))
      ? String(req.query.status)
      : ''
    const keyword = String(req.query.keyword || '').trim()
    const type = String(req.query.type || '').trim()
    const params: any[] = []
    let whereExtra = ''

    if (keyword) {
      whereExtra += `
        AND (
          b.id LIKE ?
          OR b.name LIKE ?
          OR b.code LIKE ?
          OR b.type LIKE ?
          OR legacy_fs.name LIKE ?
          OR legacy_fs.code LIKE ?
          OR open_ex.exception_no LIKE ?
        )
      `
      params.push(
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
      )
    }
    if (type) {
      whereExtra += ' AND b.type = ?'
      params.push(type)
    }

    const baseSql = `${feeMappingAuditSelect}${whereExtra}${feeMappingAuditGroup}${feeMappingAuditHaving(status)}`
    const countRows = db.prepare(`SELECT COUNT(*) as total FROM (${baseSql}) audit_rows`).get(...params) as any
    const rows = db.prepare(`${baseSql} ORDER BY bom_name ASC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]
    const summaryRows = db.prepare(`${feeMappingAuditSelect}${whereExtra}${feeMappingAuditGroup}`).all(...params) as any[]
    const summary = summaryRows.reduce(
      (acc, row) => {
        acc.total += 1
        acc[feeMappingStatus(row)] += 1
        return acc
      },
      { total: 0, mapped: 0, legacy: 0, missing: 0 } as Record<string, number>,
    )

    successList(res, rows.map(feeMappingAuditPayload), page, pageSize, Number(countRows?.total) || 0, { summary })
  } catch (err: any) { error(res, err.message) }
})

router.post('/bom-fee-mappings/audit', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const yearMonth = normalizeMonth(req.body?.yearMonth || req.query.yearMonth)
    const rows = db.prepare(`${feeMappingAuditSelect}${feeMappingAuditGroup}`).all() as any[]
    const missingRows = rows.filter(row => feeMappingStatus(row) === 'missing')
    const configuredRows = rows.filter(row => feeMappingStatus(row) !== 'missing')
    let created = 0
    let updated = 0
    let resolved = 0

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of missingRows) {
        const existing = db.prepare(`
          SELECT id FROM cost_exceptions
          WHERE bom_id = ? AND exception_type = 'missing_fee_mapping' AND status = 'open'
        `).get(row.bom_id) as any
        const details = {
          bomCode: row.bom_code,
          bomName: row.bom_name,
          bomType: row.bom_type,
          action: 'configure_bom_fee_mapping',
        }
        if (existing) {
          db.prepare(`
            UPDATE cost_exceptions
            SET year_month = ?, message = ?, details = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            yearMonth,
            `BOM ${row.bom_name} 未配置收费映射，出库收费与利润核算不可确认`,
            JSON.stringify(details),
            existing.id,
          )
          updated += 1
        } else {
          recordCostException(db, {
            sourceModule: 'abc',
            sourceType: 'bom_fee_mapping',
            sourceId: row.bom_id,
            bomId: row.bom_id,
            yearMonth,
            exceptionType: 'missing_fee_mapping',
            severity: 'warning',
            message: `BOM ${row.bom_name} 未配置收费映射，出库收费与利润核算不可确认`,
            details,
          })
          created += 1
        }
      }

      const configuredIds = configuredRows.map(row => row.bom_id)
      if (configuredIds.length > 0) {
        const placeholders = configuredIds.map(() => '?').join(',')
        const result = db.prepare(`
          UPDATE cost_exceptions
          SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE exception_type = 'missing_fee_mapping'
            AND status = 'open'
            AND bom_id IN (${placeholders})
        `).run(operator, ...configuredIds)
        resolved = Number(result.changes) || 0
      }

      writeAuditLog(db, 'bom_fee_mapping', 'audit', null, {
        yearMonth,
        missing: missingRows.length,
        created,
        updated,
        resolved,
      }, operator)
      db.exec('COMMIT')
    } catch (innerErr) {
      db.exec('ROLLBACK')
      throw innerErr
    }

    success(res, {
      yearMonth,
      total: rows.length,
      missing: missingRows.length,
      created,
      updated,
      resolved,
      missingBoms: missingRows.map(feeMappingAuditPayload),
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/bom-fee-mappings/:bomId', requireCostWorkbenchRead, (req, res) => {
  try {
    const bomCheck = assertActiveBom(getDatabase(), req.params.bomId)
    if (!bomCheck.ok) { error(res, bomCheck.message, bomCheck.code, bomCheck.status); return }
    const rows = getDatabase().prepare(`
      SELECT m.*, fs.name as fee_standard_name, fs.code as fee_standard_code, fs.category,
             fs.fee_per_slide, fs.base_price, fs.tier_rules, fs.cap_amount
      FROM bom_fee_mappings m
      LEFT JOIN fee_standards fs ON m.fee_standard_id = fs.id
      WHERE m.bom_id = ?
      ORDER BY m.sort_order ASC, m.created_at ASC
    `).all(req.params.bomId) as any[]
    success(res, rows.map(row => ({
      id: row.id,
      bomId: row.bom_id,
      feeStandardId: row.fee_standard_id,
      feeStandardName: row.fee_standard_name,
      feeStandardCode: row.fee_standard_code,
      category: row.category,
      feePerSlide: row.fee_per_slide || 0,
      basePrice: row.base_price || 0,
      tierRules: parseJsonOrNull(row.tier_rules),
      capAmount: row.cap_amount,
      quantityMultiplier: row.quantity_multiplier || 1,
      aggregationScope: row.aggregation_scope || 'outbound',
      sortOrder: row.sort_order || 0,
      status: row.status || 'active',
    })))
  } catch (err: any) { error(res, err.message) }
})

router.post('/bom-fee-mappings/:bomId/preview', requireCostWorkbenchRead, (req, res) => {
  try {
    const db = getDatabase()
    const bomCheck = assertActiveBom(db, req.params.bomId)
    if (!bomCheck.ok) { error(res, bomCheck.message, bomCheck.code, bomCheck.status); return }
    const sampleCount = Math.max(1, Number(req.body?.sampleCount) || 1)
    const month = normalizeMonth(req.body?.yearMonth)
    const caseNo = canonicalCaseNo(req.body?.caseNo) || null
    let previewMappings
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'mappings')) {
      const normalized = normalizeFeeMappingsInput(db, req.body.mappings, true)
      if (!normalized.ok) { error(res, normalized.message, normalized.code, normalized.status); return }
      previewMappings = normalized.mappings.map(mapping => ({
        fee_standard_id: mapping.feeStandard.id,
        fee_standard_name: mapping.feeStandard.name,
        category: mapping.feeStandard.category,
        project_type: mapping.feeStandard.project_type,
        fee_per_slide: mapping.feeStandard.fee_per_slide,
        base_price: mapping.feeStandard.base_price,
        tier_rules: mapping.feeStandard.tier_rules,
        cap_amount: mapping.feeStandard.cap_amount,
        quantity_multiplier: mapping.quantityMultiplier,
        aggregation_scope: mapping.aggregationScope,
      }))
    }
    const result = calculateSlideCostWithFee(db, {
      bomId: req.params.bomId,
      slideCount: sampleCount,
      blockCount: Number(req.body?.blockCount) || 1,
      month,
      materialCost: Number(req.body?.materialCost) || 0,
      caseNo,
      applyCaseAggregation: false,
      feeMappingsOverride: previewMappings,
    })

    success(res, {
      bomId: req.params.bomId,
      caseNo,
      yearMonth: month,
      sampleCount,
      feeAmount: result.feeAmount,
      feeBreakdown: result.feeBreakdown,
      totalCost: result.totalCost,
      profit: result.profit,
      profitRate: result.profitRate,
    })
  } catch (err: any) { error(res, err.message) }
})

router.put('/bom-fee-mappings/:bomId', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : []
    const operator = getOperator(req)
    const bomCheck = assertActiveBom(db, req.params.bomId)
    if (!bomCheck.ok) { error(res, bomCheck.message, bomCheck.code, bomCheck.status); return }
    const normalized = normalizeFeeMappingsInput(db, mappings, true)
    if (!normalized.ok) { error(res, normalized.message, normalized.code, normalized.status); return }

    const openExceptionRows = db.prepare(`
      SELECT id, outbound_id, year_month
      FROM cost_exceptions
      WHERE bom_id = ?
        AND exception_type = 'missing_fee_mapping'
        AND status = 'open'
    `).all(req.params.bomId) as any[]
    const openExceptionIds = openExceptionRows.map(row => row.id)
    const outboundExceptionRows = openExceptionRows.filter(row => row.outbound_id)
    let resolvedConfigurationExceptions = 0
    let recalculatedOutbounds = 0
    const recalculationFailures: any[] = []

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM bom_fee_mappings WHERE bom_id = ?').run(req.params.bomId)
      const stmt = db.prepare(`
        INSERT INTO bom_fee_mappings (
          id, bom_id, fee_standard_id, quantity_multiplier,
          aggregation_scope, sort_order, status
        )
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `)
      normalized.mappings.forEach((mapping: any, index: number) => {
        stmt.run(
          uuidv4(),
          req.params.bomId,
          mapping.feeStandardId,
          mapping.quantityMultiplier,
          mapping.aggregationScope,
          mapping.sortOrder ?? index,
        )
      })
      const resolvedResult = db.prepare(`
        UPDATE cost_exceptions
        SET status = 'resolved',
            resolved_by = ?,
            resolved_at = CURRENT_TIMESTAMP,
            details = json_set(COALESCE(details, '{}'), '$.sourceRepair', json(?)),
            updated_at = CURRENT_TIMESTAMP
        WHERE bom_id = ?
          AND exception_type = 'missing_fee_mapping'
          AND status = 'open'
          AND outbound_id IS NULL
      `).run(
        operator,
        JSON.stringify({
          action: 'bom_fee_mapping_configured',
          bomId: req.params.bomId,
          mappingCount: normalized.mappings.length,
        }),
        req.params.bomId,
      )
      resolvedConfigurationExceptions = Number(resolvedResult.changes) || 0
      writeAuditLog(db, 'bom_fee_mapping', 'update', req.params.bomId, { count: normalized.mappings.length }, operator)
      db.exec('COMMIT')
    } catch (innerErr) {
      db.exec('ROLLBACK')
      throw innerErr
    }
    for (const exceptionRow of outboundExceptionRows) {
      try {
        const run = runCostRecalculation(
          db,
          normalizeMonth(exceptionRow.year_month),
          operator,
          'recalculate',
          exceptionRow.outbound_id,
        )
        recalculatedOutbounds += Number(run.summary?.succeeded) || 0
      } catch (recalculationError: any) {
        recalculationFailures.push({
          exceptionId: exceptionRow.id,
          outboundId: exceptionRow.outbound_id,
          message: recalculationError?.message || '成本重算失败',
        })
      }
    }

    const statusRows = openExceptionIds.length > 0
      ? db.prepare(`
        SELECT status, COUNT(*) as count
        FROM cost_exceptions
        WHERE id IN (${openExceptionIds.map(() => '?').join(',')})
        GROUP BY status
      `).all(...openExceptionIds) as any[]
      : []
    const statusCounts = statusRows.reduce((acc: Record<string, number>, row: any) => {
      acc[row.status] = Number(row.count) || 0
      return acc
    }, {})
    const openExceptions = Number(statusCounts.open) || 0
    const resolvedExceptions = Number(statusCounts.resolved) || 0

    success(res, {
      bomId: req.params.bomId,
      count: normalized.mappings.length,
      resolvedExceptions,
      resolvedConfigurationExceptions,
      recalculatedOutbounds,
      openExceptions,
      recalculationFailures,
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/fee-standards', requireCostWorkbenchRead, (req, res) => {
  try {
    listTable(res, 'fee_standards', row => ({
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category,
      projectType: row.project_type,
      feePerSlide: row.fee_per_slide || 0,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }), req.query)
  } catch (err: any) { error(res, err.message) }
})

router.get('/fee-standards/:id', requireCostWorkbenchRead, (req, res) => {
  try {
    const row = getDatabase().prepare('SELECT * FROM fee_standards WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '收费标准不存在', 'NOT_FOUND', 404); return }
    success(res, row)
  } catch (err: any) { error(res, err.message) }
})

router.get('/dashboard', (req, res) => {
  try {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7))
    const db = getDatabase()
    const summaryRow = db.prepare(`
      SELECT
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(SUM(fee_amount), 0) as total_fee,
        COALESCE(SUM(profit), 0) as total_profit,
        COALESCE(SUM(material_cost), 0) as material_cost,
        COALESCE(SUM(activity_cost), 0) as activity_cost,
        COALESCE(SUM(sample_count), 0) as sample_count,
        COUNT(*) as case_count
      FROM outbound_abc_details
      WHERE cost_month = ? AND ${countableAbcCostClause}
    `).get(month) as any
    const totalFee = Number(summaryRow.total_fee) || 0
    const totalProfit = Number(summaryRow.total_profit) || 0
    const previousSummary = db.prepare(`
      SELECT
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(SUM(fee_amount), 0) as total_fee,
        COALESCE(SUM(profit), 0) as total_profit
      FROM outbound_abc_details
      WHERE cost_month = ? AND ${countableAbcCostClause}
    `).get(previousMonth(month)) as any
    const previousTotalCost = Number(previousSummary.total_cost) || 0
    const previousTotalFee = Number(previousSummary.total_fee) || 0
    const previousTotalProfit = Number(previousSummary.total_profit) || 0
    const outboundCount = (db.prepare(`
      SELECT COUNT(*) as total
      FROM outbound_records
      WHERE is_deleted = 0 AND status = 'completed' AND substr(created_at, 1, 7) = ?
    `).get(month) as any)?.total || 0
    const abcSnapshotCount = (db.prepare(`
      SELECT COUNT(*) as total FROM outbound_abc_details WHERE cost_month = ?
    `).get(month) as any)?.total || 0
    const pendingCostCount = (db.prepare(`
      SELECT COUNT(*) as total
      FROM outbound_records
      WHERE is_deleted = 0 AND status = 'completed'
        AND substr(created_at, 1, 7) = ?
        AND COALESCE(cost_status, 'pending_cost') IN ('pending_cost', 'cost_exception')
    `).get(month) as any)?.total || 0
    const openExceptionCount = (db.prepare(`
      SELECT COUNT(*) as total
      FROM cost_exceptions
      WHERE status = 'open' AND (year_month = ? OR year_month IS NULL)
    `).get(month) as any)?.total || 0
    const adjustmentAmount = approvedAdjustmentTotal(db, month)
    const awaitingAdjustmentCount = pendingAdjustmentCount(db, month)
    const latestAdjustments = db.prepare(`
      SELECT *
      FROM abc_cost_adjustments
      WHERE year_month = ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(month) as any[]
    const profitByProject = db.prepare(`
      SELECT p.id as project_id, p.name as project_name, p.type as project_type,
        COUNT(d.id) as case_count,
        COALESCE(SUM(d.sample_count), 0) as sample_count,
        COALESCE(SUM(d.total_cost), 0) as total_cost,
        COALESCE(SUM(d.fee_amount), 0) as fee_amount,
        COALESCE(SUM(d.profit), 0) as profit
      FROM outbound_abc_details d
      LEFT JOIN projects p ON d.project_id = p.id
      WHERE d.cost_month = ? AND COALESCE(d.cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')
      GROUP BY p.id
      ORDER BY profit DESC
      LIMIT 10
    `).all(month) as any[]
    const costPoolTotal = (db.prepare(`
      SELECT COALESCE(SUM(total_cost), 0) as total
      FROM abc_cost_pools
      WHERE year_month = ?
    `).get(month) as any)?.total || 0
    const costByActivity = db.prepare(`
      SELECT
        p.activity_center_id,
        ac.name as activity_center_name,
        ac.code as activity_center_code,
        COALESCE(SUM(p.total_cost), 0) as cost
      FROM abc_cost_pools p
      LEFT JOIN abc_activity_centers ac ON p.activity_center_id = ac.id
      WHERE p.year_month = ?
      GROUP BY p.activity_center_id, ac.name, ac.code
      HAVING cost > 0
      ORDER BY cost DESC
      LIMIT 10
    `).all(month) as any[]
    const openExceptions = db.prepare(`
      SELECT e.*, p.name as project_name, b.name as bom_name, o.outbound_no
      FROM cost_exceptions e
      LEFT JOIN projects p ON e.project_id = p.id
      LEFT JOIN boms b ON e.bom_id = b.id
      LEFT JOIN outbound_records o ON e.outbound_id = o.id
      WHERE e.status = 'open' AND (e.year_month = ? OR e.year_month IS NULL)
      ORDER BY CASE e.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.created_at DESC
      LIMIT 10
    `).all(month) as any[]
    success(res, {
      summary: {
        totalCost: Number(summaryRow.total_cost) || 0,
        totalFee,
        totalProfit,
        profitRate: totalFee > 0 ? totalProfit / totalFee : 0,
        adjustmentAmount,
        pendingAdjustmentCount: awaitingAdjustmentCount,
        adjustedTotalCost: (Number(summaryRow.total_cost) || 0) + adjustmentAmount,
        adjustedTotalProfit: totalProfit - adjustmentAmount,
        adjustedProfitRate: totalFee > 0 ? (totalProfit - adjustmentAmount) / totalFee : 0,
        caseCount: Number(summaryRow.case_count) || 0,
        sampleCount: Number(summaryRow.sample_count) || 0,
        outboundCount: Number(outboundCount) || 0,
        abcSnapshotCount: Number(abcSnapshotCount) || 0,
        openExceptionCount: Number(openExceptionCount) || 0,
        pendingCostCount: Number(pendingCostCount) || 0,
        materialCost: Number(summaryRow.material_cost) || 0,
        activityCost: Number(summaryRow.activity_cost) || 0,
        costChange: changeRate(Number(summaryRow.total_cost) || 0, previousTotalCost),
        feeChange: changeRate(totalFee, previousTotalFee),
        profitChange: changeRate(totalProfit, previousTotalProfit),
      },
      profitByProject: profitByProject.map(row => ({
        projectId: row.project_id,
        projectName: row.project_name || '未关联项目',
        projectType: row.project_type || '',
        caseCount: row.case_count || 0,
        sampleCount: row.sample_count || 0,
        totalCost: row.total_cost || 0,
        feeAmount: row.fee_amount || 0,
        profit: row.profit || 0,
        profitRate: row.fee_amount > 0 ? row.profit / row.fee_amount : 0,
      })),
      costByActivity: costByActivity.map(row => ({
        activityCenterId: row.activity_center_id,
        activityCenterName: row.activity_center_name || '未关联作业中心',
        activityCenterCode: row.activity_center_code || '',
        cost: Number(row.cost) || 0,
        ratio: costPoolTotal > 0 ? (Number(row.cost) || 0) / costPoolTotal : 0,
      })),
      alerts: openExceptions.map(costExceptionPayload),
      adjustments: latestAdjustments.map(costAdjustmentPayload),
      insightQuality: getCostInsightQuality(db, month),
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/exceptions', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const { status, severity, yearMonth, sourceModule, exceptionType, keyword, outboundId, projectId, includeUnassigned } = req.query
    let where = '1 = 1'
    const params: any[] = []

    if (status) { where += ' AND e.status = ?'; params.push(status) }
    if (severity) { where += ' AND e.severity = ?'; params.push(severity) }
    if (yearMonth && includeUnassigned) {
      where += ' AND (e.year_month = ? OR e.year_month IS NULL)'
      params.push(yearMonth)
    } else if (yearMonth) {
      where += ' AND e.year_month = ?'
      params.push(yearMonth)
    }
    if (sourceModule) { where += ' AND e.source_module = ?'; params.push(sourceModule) }
    if (exceptionType) { where += ' AND e.exception_type = ?'; params.push(exceptionType) }
    if (outboundId) { where += ' AND e.outbound_id = ?'; params.push(outboundId) }
    if (projectId) { where += ' AND e.project_id = ?'; params.push(projectId) }
    if (keyword) {
      where += ` AND (
        e.id LIKE ?
        OR e.exception_no LIKE ?
        OR e.message LIKE ?
        OR e.source_id LIKE ?
        OR e.outbound_id LIKE ?
        OR e.project_id LIKE ?
        OR e.bom_id LIKE ?
        OR o.outbound_no LIKE ?
        OR p.name LIKE ?
        OR b.name LIKE ?
      )`
      const kw = `%${keyword}%`
      params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw, kw)
    }

    const total = (db.prepare(`
      SELECT COUNT(*) as total
      FROM cost_exceptions e
      LEFT JOIN projects p ON e.project_id = p.id
      LEFT JOIN boms b ON e.bom_id = b.id
      LEFT JOIN outbound_records o ON e.outbound_id = o.id
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const summaryRows = db.prepare(`
      SELECT e.status, e.severity, COUNT(*) as count
      FROM cost_exceptions e
      LEFT JOIN projects p ON e.project_id = p.id
      LEFT JOIN boms b ON e.bom_id = b.id
      LEFT JOIN outbound_records o ON e.outbound_id = o.id
      WHERE ${where}
      GROUP BY e.status, e.severity
    `).all(...params) as any[]
    const summary = summaryRows.reduce((acc, row) => {
      const count = Number(row.count) || 0
      acc.total += count
      acc.status[row.status] = (acc.status[row.status] || 0) + count
      acc.severity[row.severity] = (acc.severity[row.severity] || 0) + count
      return acc
    }, {
      total: 0,
      status: { open: 0, resolved: 0, ignored: 0 },
      severity: { error: 0, warning: 0, info: 0 },
    } as {
      total: number
      status: Record<string, number>
      severity: Record<string, number>
    })
    const rows = db.prepare(`
      SELECT e.*, p.name as project_name, b.name as bom_name, o.outbound_no
      FROM cost_exceptions e
      LEFT JOIN projects p ON e.project_id = p.id
      LEFT JOIN boms b ON e.bom_id = b.id
      LEFT JOIN outbound_records o ON e.outbound_id = o.id
      WHERE ${where}
      ORDER BY CASE e.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, rows.map(costExceptionPayload), page, pageSize, total, { summary })
  } catch (err: any) { error(res, err.message) }
})

router.post('/exceptions/:id/resolve', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const row = db.prepare('SELECT * FROM cost_exceptions WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '成本异常不存在', 'NOT_FOUND', 404); return }
    if (!ensureCostExceptionOpen(res, row)) return
    const remark = trimmedText(req.body?.remark)
    if (!remark) { error(res, '请填写处理说明', 'INVALID_PARAMETER', 400); return }

    const details = {
      ...(parseJsonOrNull(row.details) || {}),
      resolution: {
        action: 'resolve',
        remark,
        operator,
        at: new Date().toISOString(),
      },
    }
    db.prepare(`
      UPDATE cost_exceptions
      SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
          details = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(operator, JSON.stringify(details), req.params.id)
    writeAuditLog(db, 'exception', 'resolve', req.params.id, { exceptionNo: row.exception_no, remark }, operator)

    const updated = db.prepare(`
      SELECT e.*, p.name as project_name, b.name as bom_name, o.outbound_no
      FROM cost_exceptions e
      LEFT JOIN projects p ON e.project_id = p.id
      LEFT JOIN boms b ON e.bom_id = b.id
      LEFT JOIN outbound_records o ON e.outbound_id = o.id
      WHERE e.id = ?
    `).get(req.params.id) as any
    success(res, costExceptionPayload(updated), 'Resolved')
  } catch (err: any) { error(res, err.message) }
})

router.post('/exceptions/:id/ignore', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const row = db.prepare('SELECT * FROM cost_exceptions WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '成本异常不存在', 'NOT_FOUND', 404); return }
    if (!ensureCostExceptionOpen(res, row)) return
    const reason = trimmedText(req.body?.reason || req.body?.remark)
    if (!reason) { error(res, '请填写忽略原因', 'INVALID_PARAMETER', 400); return }

    const details = {
      ...(parseJsonOrNull(row.details) || {}),
      resolution: {
        action: 'ignore',
        reason,
        operator,
        at: new Date().toISOString(),
      },
    }
    db.prepare(`
      UPDATE cost_exceptions
      SET status = 'ignored', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
          details = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(operator, JSON.stringify(details), req.params.id)
    writeAuditLog(db, 'exception', 'ignore', req.params.id, { exceptionNo: row.exception_no, reason }, operator)

    const updated = db.prepare(`
      SELECT e.*, p.name as project_name, b.name as bom_name, o.outbound_no
      FROM cost_exceptions e
      LEFT JOIN projects p ON e.project_id = p.id
      LEFT JOIN boms b ON e.bom_id = b.id
      LEFT JOIN outbound_records o ON e.outbound_id = o.id
      WHERE e.id = ?
    `).get(req.params.id) as any
    success(res, costExceptionPayload(updated), 'Ignored')
  } catch (err: any) { error(res, err.message) }
})

router.post('/exceptions/:id/retry', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const row = db.prepare('SELECT * FROM cost_exceptions WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '成本异常不存在', 'NOT_FOUND', 404); return }
    if (!ensureCostExceptionOpen(res, row)) return
    if (!row.outbound_id) { error(res, '该异常没有关联出库记录，不能自动重试', 'INVALID_PARAMETER', 400); return }

    const yearMonth = normalizeMonth(row.year_month)
    ensurePeriodOpen(db, yearMonth)
    db.prepare('UPDATE cost_exceptions SET retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id)
    const run = runCostRecalculation(db, yearMonth, operator, 'recalculate', row.outbound_id)
    writeAuditLog(db, 'exception', 'retry', req.params.id, { exceptionNo: row.exception_no, runId: run.id }, operator)
    const updated = db.prepare(`
      SELECT e.*, p.name as project_name, b.name as bom_name, o.outbound_no
      FROM cost_exceptions e
      LEFT JOIN projects p ON e.project_id = p.id
      LEFT JOIN boms b ON e.bom_id = b.id
      LEFT JOIN outbound_records o ON e.outbound_id = o.id
      WHERE e.id = ?
    `).get(req.params.id) as any
    success(res, { exceptionId: req.params.id, run, exception: updated ? costExceptionPayload(updated) : null }, 'Retried')
  } catch (err: any) {
    const code = err.message?.includes('已关账') ? 'PERIOD_CLOSED' : 'INTERNAL_ERROR'
    error(res, err.message, code, code === 'PERIOD_CLOSED' ? 422 : 500)
  }
})

router.get('/cost-runs', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const { yearMonth, status, runType, keyword } = req.query
    const keywordText = String(keyword || '').trim()
    let where = '1 = 1'
    const params: any[] = []

    if (yearMonth) { where += ' AND year_month = ?'; params.push(yearMonth) }
    if (status) { where += ' AND status = ?'; params.push(status) }
    if (runType) { where += ' AND run_type = ?'; params.push(runType) }
    if (keywordText) {
      const kw = `%${keywordText}%`
      where += ` AND (
        id LIKE ? OR year_month LIKE ? OR run_type LIKE ? OR status LIKE ? OR started_by LIKE ? OR summary LIKE ?
      )`
      params.push(kw, kw, kw, kw, kw, kw)
    }

    const total = (db.prepare(`SELECT COUNT(*) as total FROM cost_runs WHERE ${where}`).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT * FROM cost_runs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, rows.map(costRunPayload), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.get('/cost-runs/:id', (req, res) => {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM cost_runs WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '成本任务不存在', 'NOT_FOUND', 404); return }
    const details = db.prepare(`
      SELECT outbound_id as outboundId, project_id as projectId, bom_id as bomId,
             cost_month as costMonth, cost_status as costStatus, total_cost as totalCost,
             fee_amount as feeAmount, profit, created_at as createdAt
      FROM outbound_abc_details
      WHERE cost_run_id = ?
      ORDER BY created_at DESC
    `).all(req.params.id) as any[]
    success(res, { ...costRunPayload(row), details })
  } catch (err: any) { error(res, err.message) }
})

router.post('/cost-runs', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const yearMonth = normalizeMonth(req.body?.yearMonth)
    const runType = req.body?.runType || 'recalculate'
    const run = runCostRecalculation(db, yearMonth, operator, runType)
    logOperation(db, req as any, {
      operation: 'POST /abc/cost-runs',
      description: '执行ABC成本核算任务',
      requestData: { yearMonth, runType },
      responseData: run,
    })
    success(res, run, 'Created', 201)
  } catch (err: any) {
    const code = err.message?.includes('已关账') ? 'PERIOD_CLOSED' : 'INTERNAL_ERROR'
    error(res, err.message, code, code === 'PERIOD_CLOSED' ? 422 : 500)
  }
})

router.get('/adjustments', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const { yearMonth, status, adjustmentType, keyword } = req.query
    let where = '1 = 1'
    const params: any[] = []

    if (yearMonth) { where += ' AND year_month = ?'; params.push(String(yearMonth).slice(0, 7)) }
    if (status) { where += ' AND status = ?'; params.push(status) }
    if (adjustmentType) { where += ' AND adjustment_type = ?'; params.push(adjustmentType) }
    if (keyword) {
      where += ` AND (
        id LIKE ?
        OR adjustment_no LIKE ?
        OR adjustment_type LIKE ?
        OR reason LIKE ?
        OR source_module LIKE ?
        OR source_id LIKE ?
        OR submitted_by LIKE ?
        OR reviewed_by LIKE ?
        OR review_remark LIKE ?
      )`
      const kw = `%${keyword}%`
      params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw)
    }

    const total = (db.prepare(`SELECT COUNT(*) as total FROM abc_cost_adjustments WHERE ${where}`).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT * FROM abc_cost_adjustments
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, rows.map(costAdjustmentPayload), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.post('/adjustments', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const yearMonth = normalizeMonth(req.body?.yearMonth)
    const amount = Number(req.body?.amount)
    const reason = String(req.body?.reason || '').trim()
    const adjustmentType = String(req.body?.adjustmentType || 'manual').trim() || 'manual'

    if (!Number.isFinite(amount) || amount === 0) {
      error(res, '调整金额不能为 0', 'INVALID_PARAMETER', 400); return
    }
    if (!reason) {
      error(res, '调整原因不能为空', 'INVALID_PARAMETER', 400); return
    }

    const period = db.prepare('SELECT * FROM abc_periods WHERE year_month = ?').get(yearMonth) as any
    if (!period || period.status !== 'closed') {
      error(res, '只有已关账期间才能创建调整单', 'PERIOD_NOT_CLOSED', 422); return
    }

    const id = uuidv4()
    const adjustmentNo = `ADJ-${yearMonth.replace('-', '')}-${Date.now()}`
    db.prepare(`
      INSERT INTO abc_cost_adjustments (
        id, adjustment_no, year_month, adjustment_type, amount, reason,
        source_module, source_id, status, submitted_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      adjustmentNo,
      yearMonth,
      adjustmentType,
      amount,
      reason,
      req.body?.sourceModule || null,
      req.body?.sourceId || null,
      operator,
    )
    writeAuditLog(db, 'cost_adjustment', 'create', id, { adjustmentNo, yearMonth, amount, reason }, operator)
    const created = db.prepare('SELECT * FROM abc_cost_adjustments WHERE id = ?').get(id) as any
    logOperation(db, req as any, {
      operation: 'POST /abc/adjustments',
      description: '创建ABC闭账后成本调整单',
      requestData: costAdjustmentSnapshot(created),
      responseData: { adjustmentId: id, adjustmentNo },
    })
    success(res, costAdjustmentPayload(created), 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

router.post('/adjustments/:id/approve', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const row = db.prepare('SELECT * FROM abc_cost_adjustments WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '调整单不存在', 'NOT_FOUND', 404); return }
    if (row.status !== 'pending') { error(res, '只有待审核调整单可以审核通过', 'INVALID_STATUS', 422); return }
    if (!assertNotSelfReview(res, { submitterId: row.submitted_by, actorId: operator, message: '不能审核自己提交的调整单' })) return

    db.prepare(`
      UPDATE abc_cost_adjustments
      SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
          review_remark = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(operator, req.body?.remark || null, req.params.id)
    writeAuditLog(db, 'cost_adjustment', 'approve', req.params.id, {
      adjustmentNo: row.adjustment_no,
      yearMonth: row.year_month,
      amount: row.amount,
      remark: req.body?.remark || null,
    }, operator)
    const approved = db.prepare('SELECT * FROM abc_cost_adjustments WHERE id = ?').get(req.params.id) as any
    logOperation(db, req as any, {
      operation: 'POST /abc/adjustments/:id/approve',
      description: '审核通过ABC闭账后成本调整单',
      requestData: {
        before: costAdjustmentSnapshot(row),
        after: costAdjustmentSnapshot(approved),
      },
      responseData: { adjustmentId: req.params.id, status: 'approved' },
    })
    success(res, costAdjustmentPayload(approved), 'Approved')
  } catch (err: any) { error(res, err.message) }
})

router.post('/adjustments/:id/reject', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const row = db.prepare('SELECT * FROM abc_cost_adjustments WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '调整单不存在', 'NOT_FOUND', 404); return }
    if (row.status !== 'pending') { error(res, '只有待审核调整单可以驳回', 'INVALID_STATUS', 422); return }
    if (!assertNotSelfReview(res, { submitterId: row.submitted_by, actorId: operator, message: '不能审核自己提交的调整单' })) return

    db.prepare(`
      UPDATE abc_cost_adjustments
      SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
          review_remark = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(operator, req.body?.remark || null, req.params.id)
    writeAuditLog(db, 'cost_adjustment', 'reject', req.params.id, {
      adjustmentNo: row.adjustment_no,
      yearMonth: row.year_month,
      amount: row.amount,
      remark: req.body?.remark || null,
    }, operator)
    const rejected = db.prepare('SELECT * FROM abc_cost_adjustments WHERE id = ?').get(req.params.id) as any
    logOperation(db, req as any, {
      operation: 'POST /abc/adjustments/:id/reject',
      description: '驳回ABC闭账后成本调整单',
      requestData: {
        before: costAdjustmentSnapshot(row),
        after: costAdjustmentSnapshot(rejected),
      },
      responseData: { adjustmentId: req.params.id, status: 'rejected' },
    })
    success(res, costAdjustmentPayload(rejected), 'Rejected')
  } catch (err: any) { error(res, err.message) }
})

router.get('/profitability', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const { startDate, endDate, month, yearMonth, projectType, dimension } = req.query
    const startMonth = String(startDate || month || yearMonth || '').slice(0, 7)
    const endMonth = String(endDate || month || yearMonth || startMonth || '').slice(0, 7)
    const params: any[] = []
    let where = `COALESCE(d.cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')`

    if (startMonth) { where += ' AND d.cost_month >= ?'; params.push(startMonth) }
    if (endMonth) { where += ' AND d.cost_month <= ?'; params.push(endMonth) }
    if (projectType && projectType !== 'all') { where += ' AND p.type = ?'; params.push(projectType) }

    if (dimension === 'project') {
      const groupedSql = `
        SELECT
          COALESCE(d.project_id, d.outbound_id) as project_id,
          COALESCE(p.name, '未关联项目') as project_name,
          COALESCE(p.type, '') as project_type,
          COUNT(d.id) as case_count,
          COALESCE(SUM(d.sample_count), 0) as sample_count,
          COALESCE(SUM(d.material_cost), 0) as material_cost,
          COALESCE(SUM(d.activity_cost), 0) as activity_cost,
          COALESCE(SUM(d.total_cost), 0) as total_cost,
          COALESCE(SUM(d.fee_amount), 0) as fee_amount,
          COALESCE(SUM(d.profit), 0) as profit,
          MIN(d.cost_month) as cost_month
        FROM outbound_abc_details d
        LEFT JOIN projects p ON d.project_id = p.id
        WHERE ${where}
        GROUP BY COALESCE(d.project_id, d.outbound_id), COALESCE(p.name, '未关联项目'), COALESCE(p.type, '')
      `
      const total = (db.prepare(`SELECT COUNT(*) as total FROM (${groupedSql}) grouped_profitability`).get(...params) as any)?.total || 0
      const rows = db.prepare(`
        ${groupedSql}
        ORDER BY profit DESC, total_cost DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset) as any[]
      successList(res, rows.map(row => ({
        projectId: row.project_id,
        projectName: row.project_name,
        projectType: row.project_type || '',
        caseCount: row.case_count || 0,
        sampleCount: row.sample_count || 0,
        materialCost: row.material_cost || 0,
        activityCost: row.activity_cost || 0,
        totalCost: row.total_cost || 0,
        feeAmount: row.fee_amount || 0,
        profit: row.profit || 0,
        profitRate: row.fee_amount > 0 ? row.profit / row.fee_amount : 0,
        costMonth: row.cost_month,
      })), page, pageSize, total, {
        ...getProfitabilityInsightExtra(db, startMonth, endMonth),
      })
      return
    }

    if (dimension === 'bom') {
      const groupedSql = `
        SELECT
          COALESCE(d.bom_id, d.project_id, d.outbound_id) as bom_id,
          COALESCE(b.name, p.name, '未关联项目') as bom_name,
          COALESCE(p.type, b.type, '') as project_type,
          COUNT(d.id) as case_count,
          COALESCE(SUM(d.sample_count), 0) as sample_count,
          COALESCE(SUM(d.material_cost), 0) as material_cost,
          COALESCE(SUM(d.activity_cost), 0) as activity_cost,
          COALESCE(SUM(d.total_cost), 0) as total_cost,
          COALESCE(SUM(d.fee_amount), 0) as fee_amount,
          COALESCE(SUM(d.profit), 0) as profit,
          MIN(d.cost_month) as cost_month
        FROM outbound_abc_details d
        LEFT JOIN projects p ON d.project_id = p.id
        LEFT JOIN boms b ON d.bom_id = b.id
        WHERE ${where}
        GROUP BY COALESCE(d.bom_id, d.project_id, d.outbound_id), COALESCE(b.name, p.name, '未关联项目'), COALESCE(p.type, b.type, '')
      `
      const total = (db.prepare(`SELECT COUNT(*) as total FROM (${groupedSql}) grouped_profitability`).get(...params) as any)?.total || 0
      const rows = db.prepare(`
        ${groupedSql}
        ORDER BY total_cost DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset) as any[]
      successList(res, rows.map(row => ({
        bomId: row.bom_id,
        bomName: row.bom_name,
        projectType: row.project_type || '',
        caseCount: row.case_count || 0,
        sampleCount: row.sample_count || 0,
        materialCost: row.material_cost || 0,
        activityCost: row.activity_cost || 0,
        totalCost: row.total_cost || 0,
        feeAmount: row.fee_amount || 0,
        profit: row.profit || 0,
        profitRate: row.fee_amount > 0 ? row.profit / row.fee_amount : 0,
        costMonth: row.cost_month,
      })), page, pageSize, total, {
        ...getProfitabilityInsightExtra(db, startMonth, endMonth),
      })
      return
    }

    const total = (db.prepare(`
      SELECT COUNT(*) as total
      FROM outbound_abc_details d
      LEFT JOIN projects p ON d.project_id = p.id
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT d.*, p.name as project_name, p.type as project_type
      FROM outbound_abc_details d
      LEFT JOIN projects p ON d.project_id = p.id
      WHERE ${where}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]
    successList(res, rows.map(row => ({
      outboundId: row.outbound_id,
      projectId: row.project_id,
      projectName: row.project_name || '未关联项目',
      projectType: row.project_type || '',
      sampleCount: row.sample_count || 0,
      materialCost: row.material_cost || 0,
      activityCost: row.activity_cost || 0,
      totalCost: row.total_cost || 0,
      feeAmount: row.fee_amount || 0,
      profit: row.profit || 0,
      profitRate: row.profit_rate || 0,
      costMonth: row.cost_month,
    })), page, pageSize, total, {
      ...getProfitabilityInsightExtra(db, startMonth, endMonth),
    })
  } catch (err: any) { error(res, err.message) }
})

// L5-3 切片成本下钻：按 BOM + 期间聚合逐中心作业动因分解（来自 outbound_abc_details.activity_details 快照）。
// 让"切片成本=材料+按哪个动因以哪个费率消耗多少作业"可还原（CHAIN-07 可解释 / ADOPT-05）。
router.get('/profitability/activity-breakdown', (req, res) => {
  try {
    const db = getDatabase()
    const { bomId, startDate, endDate, month, yearMonth } = req.query
    const bom = String(bomId || '').trim()
    if (!bom) { error(res, '缺少 bomId', 'INVALID_PARAM', 400); return }
    const startMonth = String(startDate || month || yearMonth || '').slice(0, 7)
    const endMonth = String(endDate || month || yearMonth || startMonth || '').slice(0, 7)

    const params: any[] = [bom]
    let where = `bom_id = ? AND COALESCE(cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')`
    if (startMonth) { where += ' AND cost_month >= ?'; params.push(startMonth) }
    if (endMonth) { where += ' AND cost_month <= ?'; params.push(endMonth) }

    const rows = db.prepare(
      `SELECT activity_details FROM outbound_abc_details WHERE ${where}`
    ).all(...params) as any[]

    // 中心标识解析表（旧格式 key=中心 code/name → 还原中心名与动因类型）。
    const centerRows = db.prepare('SELECT id, code, name, cost_driver_type FROM abc_activity_centers').all() as any[]
    const centerByKey = new Map<string, any>()
    for (const c of centerRows) {
      if (c.code) centerByKey.set(String(c.code).toLowerCase(), c)
      if (c.name) centerByKey.set(String(c.name).toLowerCase(), c)
    }
    // 解析 activity_details：新格式=逐中心 ActivityCost 数组（含动因量/费率/池）；
    //   旧格式={中心标识: 分摊额} 对象（无逐动因明细）→ 退化为仅含中心名+分摊额的行（rateSource='legacy'），
    //   使历史数据下钻仍能展示"哪个中心消耗多少"，而非误显空/纯材料。
    const normalizeDetails = (raw: string): any[] => {
      let parsed: any
      try { parsed = JSON.parse(raw || '[]') } catch { return [] }
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed).map(([k, v]) => {
          const c = centerByKey.get(String(k).toLowerCase())
          return {
            activityCenterId: c?.id || k,
            activityCenterName: c?.name || k,
            activityCenterCode: c?.code || '',
            allocatedCost: Number(v) || 0,
            driverType: c?.cost_driver_type || null,
            driverRate: 0,
            rateSource: 'legacy',
            quantity: 0,
          }
        })
      }
      return []
    }

    // 逐中心聚合：分摊额/动因量按期内求和；费率/池为期间值（每中心一致，取代表值）。
    const byCenter = new Map<string, any>()
    let hasLegacy = false
    for (const row of rows) {
      let raw: any
      try { raw = JSON.parse(row.activity_details || '[]') } catch { raw = [] }
      if (raw && !Array.isArray(raw) && typeof raw === 'object') hasLegacy = true
      const details = normalizeDetails(row.activity_details)
      for (const it of details) {
        const id = it.activityCenterId || 'UNASSIGNED'
        const acc = byCenter.get(id) || {
          activityCenterId: id,
          activityCenterName: it.activityCenterName || '未命名作业中心',
          activityCenterCode: it.activityCenterCode || '',
          driverType: it.driverType || null,
          driverRate: Number(it.driverRate) || 0,
          rateSource: it.rateSource || 'none',
          poolCost: Number(it.poolCost) || 0,
          poolDriverQuantity: Number(it.poolDriverQuantity) || 0,
          driverQuantity: 0,
          allocatedCost: 0,
        }
        acc.driverQuantity += Number(it.quantity) || 0
        acc.allocatedCost += Number(it.allocatedCost ?? it.totalCost) || 0
        // 代表性期间值：取首个 >0 的费率/池（同中心同月一致）。
        if (!acc.driverRate && Number(it.driverRate) > 0) acc.driverRate = Number(it.driverRate)
        if (!acc.poolCost && Number(it.poolCost) > 0) acc.poolCost = Number(it.poolCost)
        byCenter.set(id, acc)
      }
    }

    const breakdown = [...byCenter.values()]
      .map(c => ({ ...c, allocatedCost: roundCost(c.allocatedCost), driverQuantity: roundCost(c.driverQuantity) }))
      .sort((a, b) => b.allocatedCost - a.allocatedCost)
    const totalActivityCost = roundCost(breakdown.reduce((s, c) => s + c.allocatedCost, 0))

    success(res, {
      bomId: bom,
      yearMonth: startMonth,
      snapshotCount: rows.length,
      totalActivityCost,
      breakdown,
      legacy: hasLegacy, // true=含旧格式快照（仅有分摊额、无逐动因明细），前端据此标注
      note: '作业成本含间接费按单一披露基准的分摊估算；材料与人工/设备按真实动因逐中心归集。',
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/fee-comparison', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const { startDate, endDate, startMonth, endMonth, month, yearMonth, projectType, profitFilter, mappingFilter } = req.query
    const dateExpr = 'COALESCE(o.created_at, d.created_at)'
    const params: any[] = []
    let where = `COALESCE(d.cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')`

    const startDateText = String(startDate || '').trim()
    const endDateText = String(endDate || '').trim()
    const startMonthText = String(startMonth || month || yearMonth || '').slice(0, 7)
    const endMonthText = String(endMonth || month || yearMonth || '').slice(0, 7)

    if (startDateText) {
      if (/^\d{4}-\d{2}$/.test(startDateText)) {
        where += ' AND d.cost_month >= ?'
        params.push(startDateText)
      } else {
        where += ` AND date(${dateExpr}) >= date(?)`
        params.push(startDateText)
      }
    } else if (startMonthText) {
      where += ' AND d.cost_month >= ?'
      params.push(startMonthText)
    }

    if (endDateText) {
      if (/^\d{4}-\d{2}$/.test(endDateText)) {
        where += ' AND d.cost_month <= ?'
        params.push(endDateText)
      } else {
        where += ` AND date(${dateExpr}) <= date(?)`
        params.push(endDateText)
      }
    } else if (endMonthText) {
      where += ' AND d.cost_month <= ?'
      params.push(endMonthText)
    }

    if (projectType && projectType !== 'all') { where += ' AND p.type = ?'; params.push(projectType) }
    if (profitFilter === 'loss') where += ' AND COALESCE(d.profit, 0) < 0'
    if (profitFilter === 'profitable') where += ' AND COALESCE(d.profit, 0) >= 0'
    if (mappingFilter === 'unmapped') where += ' AND d.fee_standard_id IS NULL'
    if (mappingFilter === 'mapped') where += ' AND d.fee_standard_id IS NOT NULL'

    const baseFrom = `
      FROM outbound_abc_details d
      LEFT JOIN outbound_records o ON d.outbound_id = o.id
      LEFT JOIN projects p ON d.project_id = p.id
      LEFT JOIN fee_standards fs ON d.fee_standard_id = fs.id
      WHERE ${where}
    `
    const total = (db.prepare(`SELECT COUNT(*) as total ${baseFrom}`).get(...params) as any)?.total || 0
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_outbounds,
        COALESCE(SUM(d.total_cost), 0) as total_cost,
        COALESCE(SUM(d.fee_amount), 0) as total_fee,
        COALESCE(SUM(d.profit), 0) as total_profit,
        COALESCE(SUM(CASE WHEN COALESCE(d.profit, 0) < 0 THEN 1 ELSE 0 END), 0) as loss_count,
        COALESCE(SUM(CASE WHEN d.fee_standard_id IS NULL THEN 1 ELSE 0 END), 0) as no_mapping_count
      ${baseFrom}
    `).get(...params) as any
    const rows = db.prepare(`
      SELECT
        d.*,
        COALESCE(o.outbound_no, d.outbound_id) as outbound_no,
        ${dateExpr} as outbound_date,
        p.name as project_name,
        p.type as project_type,
        fs.name as fee_standard_name
      ${baseFrom}
      ORDER BY ${dateExpr} DESC, d.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]
    successList(res, rows.map(row => ({
      outboundId: row.outbound_id,
      outboundNo: row.outbound_no || row.outbound_id || '',
      date: row.outbound_date || row.created_at,
      projectName: row.project_name || '未关联项目',
      projectType: row.project_type || '',
      sampleCount: row.sample_count || 0,
      materialCost: row.material_cost || 0,
      activityCost: row.activity_cost || 0,
      totalCost: row.total_cost || 0,
      feeAmount: row.fee_amount || 0,
      profit: row.profit || 0,
      profitRate: row.fee_amount > 0 ? row.profit / row.fee_amount : 0,
      feeStandardName: row.fee_standard_name || null,
      feeCategory: row.fee_category || null,
      costMonth: row.cost_month,
    })), page, pageSize, total, {
      summary: {
        totalOutbounds: summary.total_outbounds || 0,
        totalCost: summary.total_cost || 0,
        totalFee: summary.total_fee || 0,
        totalProfit: summary.total_profit || 0,
        lossCount: summary.loss_count || 0,
        noMappingCount: summary.no_mapping_count || 0,
      },
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/slide-cost-trend', (req, res) => {
  try {
    const db = getDatabase()
    const { projectType, dimension } = req.query
    const months = Math.max(1, Math.min(60, Number(req.query.months) || 12))
    const params: any[] = []
    let where = `d.cost_month IS NOT NULL AND COALESCE(d.cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')`
    if (projectType && projectType !== 'all') { where += ' AND p.type = ?'; params.push(projectType) }

    const monthScopeSql = `
      SELECT DISTINCT scoped.cost_month
      FROM outbound_abc_details scoped
      LEFT JOIN projects scoped_p ON scoped.project_id = scoped_p.id
      WHERE scoped.cost_month IS NOT NULL
        AND COALESCE(scoped.cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')
        ${projectType && projectType !== 'all' ? 'AND scoped_p.type = ?' : ''}
      ORDER BY scoped.cost_month DESC
      LIMIT ?
    `
    const scopedParams = projectType && projectType !== 'all' ? [projectType, months] : [months]
    where += ` AND d.cost_month IN (${monthScopeSql})`
    params.push(...scopedParams)

    if (dimension === 'quarterly') {
      const quarterExpr = `
        substr(d.cost_month, 1, 4) || '-Q' ||
        CASE
          WHEN CAST(substr(d.cost_month, 6, 2) AS INTEGER) BETWEEN 1 AND 3 THEN '1'
          WHEN CAST(substr(d.cost_month, 6, 2) AS INTEGER) BETWEEN 4 AND 6 THEN '2'
          WHEN CAST(substr(d.cost_month, 6, 2) AS INTEGER) BETWEEN 7 AND 9 THEN '3'
          WHEN CAST(substr(d.cost_month, 6, 2) AS INTEGER) BETWEEN 10 AND 12 THEN '4'
        END
      `
      const rows = db.prepare(`
        SELECT ${quarterExpr} as period,
          COALESCE(SUM(d.total_cost), 0) as cost,
          COUNT(d.id) as record_count,
          COALESCE(SUM(d.sample_count), 0) as sample_count
        FROM outbound_abc_details d
        LEFT JOIN projects p ON d.project_id = p.id
        WHERE ${where}
        GROUP BY period
        ORDER BY period ASC
      `).all(...params) as any[]
      const now = new Date()
      const currentQuarter = `Q${Math.ceil((now.getMonth() + 1) / 3)}`
      const currentPeriod = `${now.getFullYear()}-${currentQuarter}`
      success(res, {
        dimension: 'quarterly',
        trend: rows.map(row => ({
          period: row.period,
          cost: row.cost || 0,
          recordCount: row.record_count || 0,
          sampleCount: row.sample_count || 0,
          isComplete: row.period !== currentPeriod,
        })),
        insightQuality: {},
      })
      return
    }

    const rows = db.prepare(`
      SELECT d.cost_month as month,
        COALESCE(d.bom_id, d.project_id, d.outbound_id) as bom_id,
        COALESCE(b.name, p.name, '未关联项目') as bom_name,
        COALESCE(p.type, b.type, '') as project_type,
        COALESCE(SUM(d.total_cost), 0) as total_cost,
        COALESCE(SUM(d.activity_cost), 0) as activity_cost,
        COALESCE(SUM(d.material_cost), 0) as material_cost,
        COALESCE(SUM(d.fee_amount), 0) as fee_amount,
        COALESCE(SUM(d.profit), 0) as profit,
        COALESCE(SUM(d.sample_count), 0) as sample_count
      FROM outbound_abc_details d
      LEFT JOIN projects p ON d.project_id = p.id
      LEFT JOIN boms b ON d.bom_id = b.id
      WHERE ${where}
      GROUP BY d.cost_month, COALESCE(d.bom_id, d.project_id, d.outbound_id), COALESCE(b.name, p.name, '未关联项目'), COALESCE(p.type, b.type, '')
      ORDER BY d.cost_month ASC, total_cost DESC
    `).all(...params) as any[]
    success(res, {
      trend: rows.map(row => ({
        month: row.month,
        bomId: row.bom_id,
        bomName: row.bom_name,
        projectType: row.project_type || '',
        totalCost: row.total_cost || 0,
        activityCost: row.activity_cost || 0,
        materialCost: row.material_cost || 0,
        feeAmount: row.fee_amount || 0,
        profit: row.profit || 0,
        sampleCount: row.sample_count || 0,
        costPerSlide: row.sample_count > 0 ? row.total_cost / row.sample_count : 0,
        marginRate: row.fee_amount > 0 ? row.profit / row.fee_amount : 0,
      })),
      insightQuality: getCostInsightQualityMap(db, rows.map(row => row.month)),
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/export', (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const { where, params } = monthRangeClause('d', req.query)
    let filterWhere = where
    const filterParams = [...params]
    filterWhere += ` AND COALESCE(d.cost_status, 'costed') NOT IN ('pending_cost', 'cost_exception')`
    if (req.query.projectType && req.query.projectType !== 'all') {
      filterWhere += ' AND p.type = ?'
      filterParams.push(req.query.projectType)
    }
    const rows = db.prepare(`
      SELECT d.*, o.outbound_no, o.type as outbound_type,
             p.name as project_name, p.type as project_type,
             b.name as bom_name, b.code as bom_code
      FROM outbound_abc_details d
      LEFT JOIN outbound_records o ON d.outbound_id = o.id
      LEFT JOIN projects p ON d.project_id = p.id
      LEFT JOIN boms b ON d.bom_id = b.id
      WHERE ${filterWhere}
      ORDER BY d.cost_month DESC, d.created_at DESC
    `).all(...filterParams) as any[]
    const exceptionRows = db.prepare(`
      SELECT severity, status, COUNT(*) as count
      FROM cost_exceptions
      WHERE (? IS NULL OR year_month >= ?)
        AND (? IS NULL OR year_month <= ?)
      GROUP BY severity, status
    `).all(
      req.query.startMonth || req.query.startDate || req.query.month || req.query.yearMonth || null,
      String(req.query.startMonth || req.query.startDate || req.query.month || req.query.yearMonth || '').slice(0, 7),
      req.query.endMonth || req.query.endDate || req.query.month || req.query.yearMonth || null,
      String(req.query.endMonth || req.query.endDate || req.query.month || req.query.yearMonth || '').slice(0, 7),
    ) as any[]
    const adjustmentRows = db.prepare(`
      SELECT *
      FROM abc_cost_adjustments
      WHERE (? IS NULL OR year_month >= ?)
        AND (? IS NULL OR year_month <= ?)
      ORDER BY year_month DESC, created_at DESC
    `).all(
      req.query.startMonth || req.query.startDate || req.query.month || req.query.yearMonth || null,
      String(req.query.startMonth || req.query.startDate || req.query.month || req.query.yearMonth || '').slice(0, 7),
      req.query.endMonth || req.query.endDate || req.query.month || req.query.yearMonth || null,
      String(req.query.endMonth || req.query.endDate || req.query.month || req.query.yearMonth || '').slice(0, 7),
    ) as any[]
    const approvedAdjustmentAmount = adjustmentRows
      .filter(row => row.status === 'approved')
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
    const rawTotalCost = rows.reduce((sum, row) => sum + (Number(row.total_cost) || 0), 0)
    const rawProfit = rows.reduce((sum, row) => sum + (Number(row.profit) || 0), 0)

    const summary = {
      totalRecords: rows.length,
      sampleCount: rows.reduce((sum, row) => sum + (Number(row.sample_count) || 0), 0),
      materialCost: rows.reduce((sum, row) => sum + (Number(row.material_cost) || 0), 0),
      activityCost: rows.reduce((sum, row) => sum + (Number(row.activity_cost) || 0), 0),
      totalCost: rawTotalCost,
      feeAmount: rows.reduce((sum, row) => sum + (Number(row.fee_amount) || 0), 0),
      profit: rawProfit,
      adjustmentAmount: approvedAdjustmentAmount,
      adjustedTotalCost: rawTotalCost + approvedAdjustmentAmount,
      adjustedProfit: rawProfit - approvedAdjustmentAmount,
      pendingAdjustmentCount: adjustmentRows.filter(row => row.status === 'pending').length,
      exceptions: exceptionRows.reduce((acc: Record<string, number>, row) => {
        acc[`${row.severity}_${row.status}`] = row.count || 0
        return acc
      }, {}),
    }

    const detailCsv = toCsv(
      [
        'cost_month', 'outbound_no', 'project_name', 'project_type', 'bom_name',
        'sample_count', 'material_cost', 'activity_cost', 'total_cost',
        'fee_amount', 'profit', 'profit_rate', 'cost_status', 'cost_run_id',
      ],
      rows.map(row => [
        row.cost_month,
        row.outbound_no,
        row.project_name || '未关联项目',
        row.project_type || '',
        row.bom_name || row.bom_code || '',
        row.sample_count || 0,
        row.material_cost || 0,
        row.activity_cost || 0,
        row.total_cost || 0,
        row.fee_amount || 0,
        row.profit || 0,
        row.profit_rate || 0,
        row.cost_status || '',
        row.cost_run_id || '',
      ]),
    )
    const adjustmentCsv = toCsv(
      ['adjustment_no', 'year_month', 'adjustment_type', 'amount', 'status', 'reason', 'submitted_by', 'reviewed_by', 'review_remark'],
      adjustmentRows.map(row => [
        row.adjustment_no,
        row.year_month,
        row.adjustment_type,
        row.amount,
        row.status,
        row.reason,
        row.submitted_by,
        row.reviewed_by,
        row.review_remark,
      ]),
    )
    const summaryCsv = toCsv(
      ['metric', 'value'],
      [
        ['total_records', summary.totalRecords],
        ['sample_count', summary.sampleCount],
        ['material_cost', summary.materialCost],
        ['activity_cost', summary.activityCost],
        ['total_cost', summary.totalCost],
        ['fee_amount', summary.feeAmount],
        ['profit', summary.profit],
        ['adjustment_amount', summary.adjustmentAmount],
        ['adjusted_total_cost', summary.adjustedTotalCost],
        ['adjusted_profit', summary.adjustedProfit],
        ['pending_adjustment_count', summary.pendingAdjustmentCount],
      ],
    )
    const csv = `# summary\n${summaryCsv}\n\n# cost_details\n${detailCsv}\n\n# cost_adjustments\n${adjustmentCsv}`

    const filename = `abc-cost-export-${String(req.query.month || req.query.yearMonth || currentMonth()).slice(0, 7)}.csv`
    writeAuditLog(db, 'export', 'abc-cost-export', null, { filename, filters: req.query, totalRecords: rows.length }, operator)
    success(res, {
      filename,
      mimeType: 'text/csv;charset=utf-8',
      content: csv,
      summary,
      rows: rows.map(row => ({
        costMonth: row.cost_month,
        outboundId: row.outbound_id,
        outboundNo: row.outbound_no,
        projectName: row.project_name || '未关联项目',
        projectType: row.project_type || '',
        bomName: row.bom_name || row.bom_code || '',
        sampleCount: row.sample_count || 0,
        materialCost: row.material_cost || 0,
        activityCost: row.activity_cost || 0,
        totalCost: row.total_cost || 0,
        feeAmount: row.fee_amount || 0,
        profit: row.profit || 0,
        profitRate: row.profit_rate || 0,
        costStatus: row.cost_status,
        costRunId: row.cost_run_id,
      })),
      adjustments: adjustmentRows.map(costAdjustmentPayload),
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/batch-trace/:batchId', (req, res) => {
  try {
    const db = getDatabase()
    const batch = db.prepare(`
      SELECT b.*, m.name as material_name, m.code as material_code, m.unit,
             s.name as supplier_name
      FROM batches b
      LEFT JOIN materials m ON b.material_id = m.id
      LEFT JOIN suppliers s ON b.supplier_id = s.id
      WHERE b.id = ? OR b.batch_no = ?
    `).get(req.params.batchId, req.params.batchId) as any
    if (!batch) { error(res, '批次不存在', 'NOT_FOUND', 404); return }

    const outboundItems = db.prepare(`
      SELECT oi.*, o.outbound_no, o.type as outbound_type, o.project_id, o.created_at as outbound_at,
             p.name as project_name,
             d.id as abc_detail_id, d.cost_month, d.cost_status, d.total_cost as abc_total_cost,
             d.fee_amount, d.profit, d.cost_run_id
      FROM outbound_items oi
      LEFT JOIN outbound_records o ON oi.outbound_id = o.id
      LEFT JOIN projects p ON o.project_id = p.id
      LEFT JOIN outbound_abc_details d ON d.outbound_id = o.id
      WHERE oi.batch_id = ? OR oi.batch_no = ?
      ORDER BY o.created_at DESC
    `).all(batch.id, batch.batch_no) as any[]
    const stockLogs = db.prepare(`
      SELECT * FROM stock_logs
      WHERE material_id = ? AND (
        related_id = ?
        OR remark LIKE ?
        OR related_id IN (SELECT outbound_id FROM outbound_items WHERE batch_id = ? OR batch_no = ?)
      )
      ORDER BY created_at DESC
      LIMIT 100
    `).all(batch.material_id, batch.inbound_id, `%${batch.batch_no}%`, batch.id, batch.batch_no) as any[]

    success(res, {
      batch: {
        id: batch.id,
        batchNo: batch.batch_no,
        materialId: batch.material_id,
        materialCode: batch.material_code,
        materialName: batch.material_name,
        unit: batch.unit,
        inboundId: batch.inbound_id,
        inboundPrice: batch.inbound_price || 0,
        quantity: batch.quantity || 0,
        remaining: batch.remaining || 0,
        supplierName: batch.supplier_name,
        productionDate: batch.production_date,
        expiryDate: batch.expiry_date,
        createdAt: batch.created_at,
      },
      usage: outboundItems.map(row => ({
        outboundId: row.outbound_id,
        outboundNo: row.outbound_no,
        outboundType: row.outbound_type,
        projectId: row.project_id,
        projectName: row.project_name,
        quantity: row.quantity || 0,
        unit: row.unit,
        unitCost: row.unit_cost || 0,
        totalCost: row.total_cost || 0,
        costMonth: row.cost_month,
        costStatus: row.cost_status,
        abcTotalCost: row.abc_total_cost || 0,
        feeAmount: row.fee_amount || 0,
        profit: row.profit || 0,
        costRunId: row.cost_run_id,
        outboundAt: row.outbound_at,
      })),
      stockLogs: stockLogs.map(row => ({
        id: row.id,
        type: row.type,
        quantity: row.quantity || 0,
        beforeStock: row.before_stock || 0,
        afterStock: row.after_stock || 0,
        relatedId: row.related_id,
        relatedType: row.related_type,
        operator: row.operator,
        remark: row.remark,
        createdAt: row.created_at,
      })),
      summary: {
        consumedQuantity: outboundItems.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0),
        consumedCost: outboundItems.reduce((sum, row) => sum + (Number(row.total_cost) || 0), 0),
        outboundCount: new Set(outboundItems.map(row => row.outbound_id)).size,
        abcSnapshotCount: outboundItems.filter(row => row.abc_detail_id).length,
      },
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/variance-analysis', (req, res) => {
  try {
    const db = getDatabase()
    const { where, params } = monthRangeClause('d', req.query)
    let filterWhere = where
    const filterParams = [...params]
    if (req.query.projectType && req.query.projectType !== 'all') {
      filterWhere += ' AND p.type = ?'
      filterParams.push(req.query.projectType)
    }
    const groupBy = String(req.query.compareType || req.query.dimension || 'project')
    const rows = db.prepare(`
      SELECT d.*, o.outbound_no, o.total_cost as outbound_total_cost,
             p.id as project_id, p.name as project_name, p.type as project_type,
             b.id as bom_id, b.name as bom_name
      FROM outbound_abc_details d
      LEFT JOIN outbound_records o ON d.outbound_id = o.id
      LEFT JOIN projects p ON d.project_id = p.id
      LEFT JOIN boms b ON d.bom_id = b.id
      WHERE ${filterWhere}
      ORDER BY d.cost_month DESC, d.created_at DESC
    `).all(...filterParams) as any[]

    const groups = new Map<string, any>()
    for (const row of rows) {
      const key = groupBy === 'month'
        ? row.cost_month || '未分月'
        : groupBy === 'bom'
          ? row.bom_id || 'unknown-bom'
          : row.project_id || 'unknown-project'
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          month: groupBy === 'month' ? key : row.cost_month,
          projectId: row.project_id,
          projectName: groupBy === 'month' ? key : row.project_name || '未关联项目',
          projectType: row.project_type || '',
          bomId: row.bom_id,
          bomName: row.bom_name || '',
          materialActual: 0,
          activityCost: 0,
          totalActual: 0,
          sampleCount: 0,
          recordCount: 0,
        })
      }
      const item = groups.get(key)
      const materialActual = Number(row.outbound_total_cost) || Number(row.material_cost) || 0
      const totalActual = Number(row.total_cost) || 0
      item.materialActual += materialActual
      item.activityCost += Number(row.activity_cost) || 0
      item.totalActual += totalActual
      item.sampleCount += Number(row.sample_count) || 0
      item.recordCount += 1
    }

    // HON-3（P-7 · 假标准成本停返）：标准成本需 BOM 标准工时/用量校准后才存在。
    //   此前 totalStandard 用「物料实际」冒充标准、据此算 variance/varianceRate → **假差异**（拿实际算实际），
    //   #86 仅加免责声明字段、假数字仍返回。现停返：standard/variance/varianceRate 一律 null（= 未校准不可用），
    //   只透出**真实实际成本**（materialActual/activityCost/totalActual/sampleCount）。真实单片成本走「消耗对账」。
    const list = [...groups.values()].map(item => ({
      ...item,
      materialStandard: null,
      totalStandard: null,
      totalVariance: null,
      varianceRate: null,
      status: 'uncalibrated',
      standardCalibrated: false,
      standardSource: 'uncalibrated',
      disclaimer: '标准成本未接入（需 BOM 标准工时/用量校准）·「标准 vs 实际」差异暂不可用；本页仅展示真实实际成本，真实单片成本见「消耗对账」。',
    }))

    const summary = {
      totalActual: Math.round(list.reduce((sum, item) => sum + item.totalActual, 0) * 100) / 100,
      totalStandard: null,
      totalVariance: null,
      varianceRate: null,
      recordCount: rows.length,
      standardCalibrated: false,
    }

    success(res, { list, summary })
  } catch (err: any) { error(res, err.message) }
})

router.get('/budgets', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const filters: string[] = []
    const params: any[] = []
    const yearMonth = String(req.query.yearMonth || '').trim()
    const keyword = String(req.query.keyword || '').trim()
    if (yearMonth) {
      filters.push('year_month = ?')
      params.push(yearMonth)
    }
    if (keyword) {
      const kw = `%${keyword}%`
      filters.push('(id LIKE ? OR year_month LIKE ? OR COALESCE(category, \'\') LIKE ? OR COALESCE(description, \'\') LIKE ?)')
      params.push(kw, kw, kw, kw)
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const total = (db.prepare(`SELECT COUNT(*) as total FROM abc_budgets ${whereClause}`).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT *
      FROM abc_budgets
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]
    successList(res, rows.map(budgetPayload), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.post('/budgets', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const id = uuidv4()
    const { yearMonth, category, budgetAmount, actualAmount, description } = req.body
    const budgetValue = Number(budgetAmount) || 0
    const actualValue = Number(actualAmount) || 0
    if (budgetValue < 0 || actualValue < 0) {
      error(res, '预算金额和实际金额必须为非负数', 'VALIDATION_ERROR', 422)
      return
    }
    db.prepare(`
      INSERT INTO abc_budgets (id, year_month, category, budget_amount, actual_amount, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, yearMonth || new Date().toISOString().slice(0, 7), category || null, budgetValue, actualValue, description || null)
    const created = db.prepare('SELECT * FROM abc_budgets WHERE id = ?').get(id) as any
    writeAuditLog(db, 'budget', 'create', id, { after: budgetAuditSnapshot(created) }, operator)
    success(res, { id }, 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

router.put('/budgets/:id', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM abc_budgets WHERE id = ?').get(req.params.id) as any
    if (!existing) {
      error(res, '预算不存在', 'NOT_FOUND', 404)
      return
    }
    const before = budgetAuditSnapshot(existing)
    const budgetValue = req.body.budgetAmount !== undefined ? Number(req.body.budgetAmount) : Number(existing.budget_amount) || 0
    const actualValue = req.body.actualAmount !== undefined ? Number(req.body.actualAmount) : Number(existing.actual_amount) || 0
    if (budgetValue < 0 || actualValue < 0) {
      error(res, '预算金额和实际金额必须为非负数', 'VALIDATION_ERROR', 422)
      return
    }
    db.prepare(`
      UPDATE abc_budgets
      SET year_month = ?, category = ?, budget_amount = ?, actual_amount = ?, description = ?
      WHERE id = ?
    `).run(
      req.body.yearMonth || existing.year_month,
      req.body.category !== undefined ? req.body.category : existing.category,
      budgetValue,
      actualValue,
      req.body.description !== undefined ? req.body.description : existing.description,
      req.params.id,
    )
    const updated = db.prepare('SELECT * FROM abc_budgets WHERE id = ?').get(req.params.id) as any
    writeAuditLog(db, 'budget', 'update', req.params.id, {
      before,
      after: budgetAuditSnapshot(updated),
    }, getOperator(req))
    success(res, budgetPayload(updated), 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.get('/quality-costs/summary', (req, res) => {
  try {
    const yearMonth = req.query.yearMonth || new Date().toISOString().slice(0, 7)
    const rows = getDatabase().prepare(`
      SELECT COALESCE(cost_type, category, '') as cost_type, COALESCE(SUM(amount), 0) as total
      FROM quality_costs
      WHERE year_month = ?
      GROUP BY COALESCE(cost_type, category, '')
    `).all(yearMonth) as any[]
    const byType = new Map(rows.map(row => [row.cost_type, Number(row.total) || 0]))
    const preventionCost = byType.get('prevention') || 0
    const appraisalCost = byType.get('appraisal') || 0
    const internalFailureCost = byType.get('internal_failure') || 0
    const externalFailureCost = byType.get('external_failure') || 0
    success(res, {
      yearMonth,
      totalQualityCost: preventionCost + appraisalCost + internalFailureCost + externalFailureCost,
      preventionCost,
      appraisalCost,
      internalFailureCost,
      externalFailureCost,
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/quality-costs', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const filters: string[] = []
    const params: any[] = []
    const yearMonth = String(req.query.yearMonth || '').trim()
    const keyword = String(req.query.keyword || '').trim()
    if (yearMonth) {
      filters.push('year_month = ?')
      params.push(yearMonth)
    }
    if (keyword) {
      const kw = `%${keyword}%`
      filters.push(`(
        id LIKE ?
        OR year_month LIKE ?
        OR COALESCE(category, '') LIKE ?
        OR COALESCE(cost_type, '') LIKE ?
        OR COALESCE(sub_type, '') LIKE ?
        OR COALESCE(description, '') LIKE ?
      )`)
      params.push(kw, kw, kw, kw, kw, kw)
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const total = (db.prepare(`SELECT COUNT(*) as total FROM quality_costs ${whereClause}`).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT *
      FROM quality_costs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]
    successList(res, rows.map(qualityCostPayload), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.post('/quality-costs', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const operator = getOperator(req)
    const id = uuidv4()
    const { yearMonth, category, costType, subType, amount, description } = req.body
    const amountValue = Number(amount) || 0
    if (amountValue < 0) {
      error(res, '质量成本金额必须为非负数', 'VALIDATION_ERROR', 422)
      return
    }
    const finalCostType = costType || category || null
    db.prepare(`
      INSERT INTO quality_costs (id, year_month, category, cost_type, sub_type, amount, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      yearMonth || new Date().toISOString().slice(0, 7),
      finalCostType,
      finalCostType,
      subType || null,
      amountValue,
      description || null,
    )
    const created = db.prepare('SELECT * FROM quality_costs WHERE id = ?').get(id) as any
    writeAuditLog(db, 'quality_cost', 'create', id, { after: qualityCostAuditSnapshot(created) }, operator)
    success(res, { id }, 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

router.put('/quality-costs/:id', requireCostWrite, (req, res) => {
  try {
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM quality_costs WHERE id = ?').get(req.params.id) as any
    if (!existing) {
      error(res, '质量成本不存在', 'NOT_FOUND', 404)
      return
    }
    const before = qualityCostAuditSnapshot(existing)
    const amountValue = req.body.amount !== undefined ? Number(req.body.amount) : Number(existing.amount) || 0
    if (amountValue < 0) {
      error(res, '质量成本金额必须为非负数', 'VALIDATION_ERROR', 422)
      return
    }
    const finalCostType = req.body.costType || req.body.category || existing.cost_type || existing.category || null
    const finalSubType = req.body.subType !== undefined ? req.body.subType : existing.sub_type
    db.prepare(`
      UPDATE quality_costs
      SET year_month = ?, category = ?, cost_type = ?, sub_type = ?, amount = ?, description = ?
      WHERE id = ?
    `).run(
      req.body.yearMonth || existing.year_month,
      finalCostType,
      finalCostType,
      finalSubType || null,
      amountValue,
      req.body.description !== undefined ? req.body.description : existing.description,
      req.params.id,
    )
    const updated = db.prepare('SELECT * FROM quality_costs WHERE id = ?').get(req.params.id) as any
    writeAuditLog(db, 'quality_cost', 'update', req.params.id, {
      before,
      after: qualityCostAuditSnapshot(updated),
    }, getOperator(req))
    success(res, qualityCostPayload(updated), 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.get('/audit-logs', (req, res) => {
  try {
    const { page, pageSize, offset } = pageParams(req.query)
    const db = getDatabase()
    const {
      action,
      targetType,
      module,
      targetId,
      operator,
      keyword,
      startDate,
      endDate,
    } = req.query
    let where = '1 = 1'
    const params: any[] = []
    const normalizedModule = String(targetType || module || '').trim()
    const normalizedAction = String(action || '').trim()
    const normalizedTargetId = String(targetId || '').trim()
    const normalizedOperator = String(operator || '').trim()
    const normalizedKeyword = String(keyword || '').trim()
    const normalizedStartDate = String(startDate || '').trim()
    const normalizedEndDate = String(endDate || '').trim()
    const datePattern = /^\d{4}-\d{2}-\d{2}$/

    if (normalizedStartDate && !datePattern.test(normalizedStartDate)) {
      error(res, '开始日期格式应为 YYYY-MM-DD', 'INVALID_PARAMETER', 400); return
    }
    if (normalizedEndDate && !datePattern.test(normalizedEndDate)) {
      error(res, '结束日期格式应为 YYYY-MM-DD', 'INVALID_PARAMETER', 400); return
    }
    if (normalizedStartDate && normalizedEndDate && normalizedStartDate > normalizedEndDate) {
      error(res, '开始日期不能晚于结束日期', 'INVALID_PARAMETER', 400); return
    }
    if (normalizedAction) { where += ' AND action = ?'; params.push(normalizedAction) }
    if (normalizedModule) { where += ' AND module = ?'; params.push(normalizedModule) }
    if (normalizedTargetId) { where += ' AND target_id = ?'; params.push(normalizedTargetId) }
    if (normalizedOperator) { where += ' AND operator = ?'; params.push(normalizedOperator) }
    if (normalizedKeyword) {
      where += ' AND (module LIKE ? OR action LIKE ? OR target_id LIKE ? OR operator LIKE ? OR detail LIKE ?)'
      const kw = `%${normalizedKeyword}%`
      params.push(kw, kw, kw, kw, kw)
    }
    if (normalizedStartDate) { where += ' AND substr(created_at, 1, 10) >= ?'; params.push(normalizedStartDate) }
    if (normalizedEndDate) { where += ' AND substr(created_at, 1, 10) <= ?'; params.push(normalizedEndDate) }

    const total = (db.prepare(`SELECT COUNT(*) as total FROM abc_audit_logs WHERE ${where}`).get(...params) as any)?.total || 0
    const rows = db.prepare(`
      SELECT *
      FROM abc_audit_logs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, rows.map(row => ({
      id: row.id,
      module: row.module,
      targetType: row.module,
      action: row.action,
      targetId: row.target_id,
      detail: row.detail,
      operator: row.operator,
      createdAt: row.created_at,
    })), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.get('/alert-rules', (_req, res) => {
  try {
    const rows = getDatabase().prepare('SELECT * FROM abc_alert_rules ORDER BY created_at DESC').all() as any[]
    success(res, rows.map(row => ({
      id: row.id,
      type: row.type,
      name: row.name,
      threshold: row.threshold || 0,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    })))
  } catch (err: any) { error(res, err.message) }
})

router.post('/alert-rules', requireCostWrite, (req, res) => {
  try {
    const id = uuidv4()
    const { type, name, threshold, enabled } = req.body
    const normalizedThreshold = threshold === undefined || threshold === null || threshold === '' ? 0 : Number(threshold)
    if (!Number.isFinite(normalizedThreshold) || normalizedThreshold < 0) {
      error(res, '预警阈值必须为非负有限数字', 'INVALID_PARAMETER', 400); return
    }
    getDatabase().prepare(`
      INSERT INTO abc_alert_rules (id, type, name, threshold, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, type || 'profit', name || '成本预警', normalizedThreshold, enabled === false ? 0 : 1)
    success(res, { id }, 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

export default router
