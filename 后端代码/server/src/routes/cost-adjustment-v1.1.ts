import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { logOperation } from '../utils/operation-logger.js'

const router = Router()

function isValidYearQuarter(value: unknown) {
  return typeof value === 'string' && /^\d{4}-Q[1-4]$/.test(value)
}

function quarterMonths(yearQuarter: string) {
  const year = parseInt(yearQuarter.split('-')[0], 10)
  const quarter = parseInt(yearQuarter.split('-Q')[1], 10)
  const startMonth = (quarter - 1) * 3 + 1
  return [
    `${year}-${String(startMonth).padStart(2, '0')}`,
    `${year}-${String(startMonth + 1).padStart(2, '0')}`,
    `${year}-${String(startMonth + 2).padStart(2, '0')}`,
  ]
}

function parseNonNegativeAmount(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function parsePaginationParam(value: unknown, fallback: number, max = 200) {
  const raw = String(value ?? fallback).trim()
  if (!/^\d+$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null
}

const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected'])

function adjustmentSnapshot(row: any) {
  if (!row) return null
  return {
    id: row.id,
    costCenterId: row.cost_center_id,
    costCenterCode: row.cost_center_code,
    costCenterName: row.cost_center_name,
    yearQuarter: row.year_quarter,
    preProvisionAmount: row.pre_provision_amount,
    actualAmount: row.actual_amount,
    adjustmentAmount: row.adjustment_amount,
    adjustmentReason: row.adjustment_reason,
    reviewStatus: row.review_status,
    submittedBy: row.submitted_by,
    reviewedBy: row.reviewed_by,
    reviewReason: row.review_reason,
  }
}

function getAdjustmentWithCenter(db: any, id: string) {
  return db.prepare(`
    SELECT ca.*, icc.code as cost_center_code, icc.name as cost_center_name
    FROM cost_adjustments ca
    LEFT JOIN indirect_cost_centers icc ON ca.cost_center_id = icc.id
    WHERE ca.id = ?
  `).get(id) as any
}

// 获取季度调整建议（自动计算）
router.get('/suggestions', authenticateToken, requirePermission('cost_analysis', 'R'), (req, res) => {
  try {
    const { yearQuarter } = req.query
    const db = getDatabase()

    if (!isValidYearQuarter(yearQuarter)) {
      error(res, '季度格式应为 YYYY-QN（如 2026-Q2）', 'INVALID_PARAMETER', 400); return
    }

    const normalizedYearQuarter = String(yearQuarter)
    const months = quarterMonths(normalizedYearQuarter)

    // 检查季度是否结束
    const now = new Date()
    const year = parseInt(normalizedYearQuarter.split('-')[0], 10)
    const quarter = parseInt(normalizedYearQuarter.split('-Q')[1], 10)
    const startMonth = (quarter - 1) * 3 + 1
    const quarterEndDate = new Date(year, startMonth + 2, 0)
    const isQuarterEnd = now > quarterEndDate

    // 查询成本中心
    const centers = db.prepare(`
      SELECT * FROM indirect_cost_centers WHERE status = 1
    `).all() as any[]

    // 查询已有调整记录
    const existingAdjustments = db.prepare(`
      SELECT cost_center_id FROM cost_adjustments WHERE year_quarter = ?
    `).all(yearQuarter) as any[]
    const existingSet = new Set(existingAdjustments.map((a: any) => a.cost_center_id))

    const suggestions = centers
      .filter(c => !existingSet.has(c.id))
      .map(center => {
        // 计算预提金额（该季度3个月的分摊总和）
        const monthPlaceholders = months.map(() => '?').join(',')
        const allocRows = db.prepare(`
          SELECT SUM(total_amount) as total, SUM(allocation_rate) as rate_sum
          FROM indirect_cost_allocations
          WHERE cost_center_id = ? AND year_month IN (${monthPlaceholders})
        `).get(center.id, ...months) as any

        const preProvisionAmount = allocRows?.total || 0

        return {
          costCenterId: center.id,
          costCenterName: center.name,
          costCenterCode: center.code,
          costType: center.cost_type,
          yearQuarter: normalizedYearQuarter,
          preProvisionAmount: Math.round(preProvisionAmount * 100) / 100,
          actualAmount: 0,
          adjustmentAmount: 0,
          isQuarterEnd,
        }
      })

    success(res, { suggestions, isQuarterEnd })
  } catch (err: any) { error(res, err.message) }
})

// 创建调整记录
router.post('/', authenticateToken, requirePermission('cost_analysis', 'W'), (req, res) => {
  try {
    const { costCenterId, yearQuarter, actualAmount, adjustmentReason } = req.body
    const normalizedCostCenterId = String(costCenterId || '').trim()
    if (!normalizedCostCenterId || !yearQuarter || actualAmount === undefined) {
      error(res, '缺少必填字段', 'INVALID_PARAMETER', 400); return
    }
    if (!isValidYearQuarter(yearQuarter)) {
      error(res, '季度格式应为 YYYY-QN（如 2026-Q2）', 'INVALID_PARAMETER', 400); return
    }
    const actualAmountValue = parseNonNegativeAmount(actualAmount)
    if (actualAmountValue === null) {
      error(res, '实际金额必须为非负数字', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()

    // 验证成本中心存在
    const center = db.prepare('SELECT * FROM indirect_cost_centers WHERE id = ?').get(normalizedCostCenterId) as any
    if (!center) { error(res, '成本中心不存在', 'NOT_FOUND', 404); return }
    if (Number(center.status) !== 1) {
      error(res, '停用成本中心不可创建季度调整', 'BUSINESS_RULE', 400); return
    }

    const normalizedYearQuarter = String(yearQuarter)
    const existing = db.prepare(`
      SELECT id FROM cost_adjustments
      WHERE cost_center_id = ? AND year_quarter = ?
    `).get(normalizedCostCenterId, normalizedYearQuarter) as any
    if (existing) {
      error(res, '该成本中心本季度已有调整单', 'RESOURCE_CONFLICT', 409); return
    }

    const months = quarterMonths(normalizedYearQuarter)

    const monthPlaceholders = months.map(() => '?').join(',')
    const allocRows = db.prepare(`
      SELECT SUM(total_amount) as total
      FROM indirect_cost_allocations
      WHERE cost_center_id = ? AND year_month IN (${monthPlaceholders})
    `).get(normalizedCostCenterId, ...months) as any

    const preProvisionAmount = allocRows?.total || 0
    const adjustmentAmount = actualAmountValue - preProvisionAmount
    const userId = (req as any).user?.userId

    const id = uuidv4()
    db.prepare(`
      INSERT INTO cost_adjustments (id, cost_center_id, year_quarter, pre_provision_amount, actual_amount, adjustment_amount, adjustment_reason, submitted_by, submitted_at, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'pending')
    `).run(id, normalizedCostCenterId, normalizedYearQuarter, preProvisionAmount, actualAmountValue, adjustmentAmount, adjustmentReason || null, userId)

    const created = getAdjustmentWithCenter(db, id)
    logOperation(db, req as any, {
      operation: 'POST /cost-adjustments',
      description: '创建季度成本调整单',
      requestData: adjustmentSnapshot(created),
      responseData: { adjustmentId: id, costCenterId: normalizedCostCenterId },
    })

    success(res, { id, adjustmentAmount: Math.round(adjustmentAmount * 100) / 100 }, 'Created', 201)
  } catch (err: any) { error(res, err.message) }
})

// 审核调整
router.post('/:id/review', authenticateToken, requirePermission('cost_analysis', 'W'), (req, res) => {
  try {
    const { id } = req.params
    const { status, reason } = req.body
    if (!status || !['approved', 'rejected'].includes(status)) {
      error(res, '状态应为 approved 或 rejected', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const userId = (req as any).user?.userId

    const existing = db.prepare('SELECT * FROM cost_adjustments WHERE id = ?').get(id) as any
    if (!existing) { error(res, '调整记录不存在', 'NOT_FOUND', 404); return }
    if (existing.review_status !== 'pending') {
      error(res, '该调整已审核', 'CONFLICT', 409); return
    }
    if (existing.submitted_by === userId) {
      error(res, '不能审核自己提交的调整', 'FORBIDDEN', 403); return
    }

    // 乐观锁：仅当状态仍为 pending 时更新
    const result = db.prepare(`
      UPDATE cost_adjustments
      SET review_status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_reason = ?
      WHERE id = ? AND review_status = 'pending'
    `).run(status, userId, reason || null, id)

    if (result.changes === 0) {
      error(res, '审核冲突，请刷新后重试', 'CONFLICT', 409); return
    }

    const reviewed = getAdjustmentWithCenter(db, id)
    logOperation(db, req as any, {
      operation: 'POST /cost-adjustments/:id/review',
      description: status === 'approved' ? '审核通过季度成本调整单' : '驳回季度成本调整单',
      requestData: {
        before: adjustmentSnapshot(existing),
        after: adjustmentSnapshot(reviewed),
      },
      responseData: { adjustmentId: id, status },
    })

    success(res, { id, status }, 'Reviewed')
  } catch (err: any) { error(res, err.message) }
})

// 获取调整记录列表
router.get('/', authenticateToken, requirePermission('cost_analysis', 'R'), (req, res) => {
  try {
    const { page = 1, pageSize = 20, yearQuarter, costCenterId, reviewStatus } = req.query
    const db = getDatabase()
    const pageNum = parsePaginationParam(page, 1)
    const safePageSize = parsePaginationParam(pageSize, 20)
    if (!pageNum || !safePageSize) {
      error(res, '分页参数无效', 'INVALID_PARAMETER', 400); return
    }
    const normalizedYearQuarter = String(yearQuarter || '').trim()
    const normalizedCostCenterId = String(costCenterId || '').trim()
    const normalizedReviewStatus = String(reviewStatus || '').trim()
    if (normalizedYearQuarter && !isValidYearQuarter(normalizedYearQuarter)) {
      error(res, '季度格式应为 YYYY-QN（如 2026-Q2）', 'INVALID_PARAMETER', 400); return
    }
    if (normalizedReviewStatus && !REVIEW_STATUSES.has(normalizedReviewStatus)) {
      error(res, '审核状态无效', 'INVALID_PARAMETER', 400); return
    }
    if (normalizedCostCenterId) {
      const center = db.prepare('SELECT id FROM indirect_cost_centers WHERE id = ?').get(normalizedCostCenterId)
      if (!center) { error(res, '成本中心筛选不存在', 'INVALID_PARAMETER', 400); return }
    }
    let where = '1=1'
    const params: any[] = []

    if (normalizedYearQuarter) { where += ' AND ca.year_quarter = ?'; params.push(normalizedYearQuarter) }
    if (normalizedCostCenterId) { where += ' AND ca.cost_center_id = ?'; params.push(normalizedCostCenterId) }
    if (normalizedReviewStatus) { where += ' AND ca.review_status = ?'; params.push(normalizedReviewStatus) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM cost_adjustments ca WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (pageNum - 1) * safePageSize
    const list = db.prepare(`
      SELECT ca.*, icc.name as cost_center_name, icc.code as cost_center_code,
        u1.real_name as submitted_by_name, u2.real_name as reviewed_by_name
      FROM cost_adjustments ca
      LEFT JOIN indirect_cost_centers icc ON ca.cost_center_id = icc.id
      LEFT JOIN users u1 ON ca.submitted_by = u1.id
      LEFT JOIN users u2 ON ca.reviewed_by = u2.id
      WHERE ${where}
      ORDER BY ca.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, safePageSize, offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id,
      costCenterId: r.cost_center_id,
      costCenterName: r.cost_center_name,
      costCenterCode: r.cost_center_code,
      yearQuarter: r.year_quarter,
      preProvisionAmount: r.pre_provision_amount,
      actualAmount: r.actual_amount,
      adjustmentAmount: r.adjustment_amount,
      adjustmentReason: r.adjustment_reason,
      submittedBy: r.submitted_by,
      submittedByName: r.submitted_by_name,
      submittedAt: r.submitted_at,
      reviewStatus: r.review_status,
      reviewedBy: r.reviewed_by,
      reviewedByName: r.reviewed_by_name,
      reviewedAt: r.reviewed_at,
      reviewReason: r.review_reason,
      createdAt: r.created_at,
    })), pageNum, safePageSize, count)
  } catch (err: any) { error(res, err.message) }
})

export default router
