import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { logOperation } from '../utils/operation-logger.js'
import { normalizeDisplayText, requireValidText, type TextGuardResult } from '../utils/text-guard.js'

const router = Router()

const COST_TYPE_LABELS: Record<string, string> = {
  rent: '房租',
  utilities: '水电',
  maintenance: '维护',
  admin: '管理费',
  it: 'IT费用',
  other: '其他',
}

const COST_TYPES = new Set(Object.keys(COST_TYPE_LABELS))
const ALLOCATION_BASES = new Set(['sample_count', 'revenue', 'labor_hours', 'area'])
const STATUS_FILTERS = new Set(['all', 'active', 'inactive'])

function sendTextError(res: any, result: TextGuardResult): result is Extract<TextGuardResult, { ok: false }> {
  if ('message' in result) {
    error(res, result.message, result.code, result.status)
    return true
  }
  return false
}

function parseNonNegativeAmount(value: unknown, fallback = 0) {
  if (value === undefined || value === null || value === '') return { ok: true as const, value: fallback }
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false as const, message: '金额必须大于等于0' }
  }
  return { ok: true as const, value: amount }
}

function parsePositiveBaseValue(value: unknown) {
  const baseValue = Number(value)
  if (!Number.isFinite(baseValue) || baseValue <= 0) {
    return { ok: false as const, message: '分摊基础值必须大于0' }
  }
  return { ok: true as const, value: baseValue }
}

function parsePaginationParam(value: unknown, fallback: number, max = 1000) {
  const raw = String(value ?? fallback).trim()
  if (!/^\d+$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null
}

function isValidYearMonth(value: unknown) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

function parseStatus(status: unknown, fallback = 1) {
  if (status === undefined || status === null || status === '') return { ok: true as const, value: fallback }
  if (status === 'active') return { ok: true as const, value: 1 }
  if (status === 'inactive') return { ok: true as const, value: 0 }
  return { ok: false as const, message: '状态无效' }
}

function validateStatusFilter(status: unknown) {
  if (Array.isArray(status)) return false
  const raw = String(status || '').trim()
  return !raw || STATUS_FILTERS.has(raw)
}

function buildCostCenterWhere(query: any) {
  const { keyword, status } = query
  let where = '1=1'
  const params: any[] = []
  if (keyword) {
    where += ' AND (code LIKE ? OR name LIKE ?)'
    const like = `%${keyword}%`
    params.push(like, like)
  }
  if (status === 'active' || status === 'inactive') {
    where += ' AND status = ?'
    params.push(status === 'active' ? 1 : 0)
  }
  return { where, params }
}

function costCenterSnapshot(row: any) {
  if (!row) return null
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    costType: row.cost_type,
    monthlyAmount: row.monthly_amount,
    allocationBase: row.allocation_base,
    description: row.description,
    status: Number(row.status) === 1 ? 'active' : 'inactive',
  }
}

function allocationSnapshot(row: any) {
  if (!row) return null
  return {
    id: row.id,
    costCenterId: row.cost_center_id,
    yearMonth: row.year_month,
    totalAmount: row.total_amount,
    allocationBaseValue: row.allocation_base_value,
    allocationRate: row.allocation_rate,
  }
}

// 获取成本中心列表
router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query
    const db = getDatabase()
    if (!validateStatusFilter(req.query.status)) {
      error(res, '状态筛选无效', 'INVALID_PARAMETER', 400); return
    }
    const { where, params } = buildCostCenterWhere(req.query)

    const count = (db.prepare(`SELECT COUNT(*) as total FROM indirect_cost_centers WHERE ${where}`).get(...params) as any)?.total || 0
    const pageNum = parsePaginationParam(page, 1)
    const safePageSize = parsePaginationParam(pageSize, 20)
    if (!pageNum || !safePageSize) {
      error(res, '分页参数无效', 'INVALID_PARAMETER', 400); return
    }
    const offset = (pageNum - 1) * safePageSize
    const list = db.prepare(`SELECT * FROM indirect_cost_centers WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, safePageSize, offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      costType: r.cost_type,
      costTypeLabel: COST_TYPE_LABELS[r.cost_type] || r.cost_type,
      monthlyAmount: r.monthly_amount,
      allocationBase: r.allocation_base,
      description: r.description,
      status: r.status === 1 ? 'active' : 'inactive',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })), pageNum, safePageSize, count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/stats', (req, res) => {
  try {
    const db = getDatabase()
    if (!validateStatusFilter(req.query.status)) {
      error(res, '状态筛选无效', 'INVALID_PARAMETER', 400); return
    }
    const { where, params } = buildCostCenterWhere(req.query)
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) as active,
        COALESCE(SUM(monthly_amount), 0) as totalMonthly
      FROM indirect_cost_centers
      WHERE ${where}
    `).get(...params) as any
    const allocationRow = db.prepare(`
      SELECT COUNT(a.id) as allocationCount
      FROM indirect_cost_centers c
      LEFT JOIN indirect_cost_allocations a ON a.cost_center_id = c.id
      WHERE ${where.replace(/\bcode\b/g, 'c.code').replace(/\bname\b/g, 'c.name').replace(/\bstatus\b/g, 'c.status')}
    `).get(...params) as any
    success(res, {
      total: row?.total || 0,
      active: row?.active || 0,
      totalMonthly: row?.totalMonthly || 0,
      allocationCount: allocationRow?.allocationCount || 0,
    })
  } catch (err: any) { error(res, err.message) }
})

// 获取成本中心详情
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const r = db.prepare('SELECT * FROM indirect_cost_centers WHERE id = ?').get(id) as any
    if (!r) { error(res, '记录不存在', 'NOT_FOUND', 404); return }

    success(res, {
      id: r.id,
      code: r.code,
      name: r.name,
      costType: r.cost_type,
      costTypeLabel: COST_TYPE_LABELS[r.cost_type] || r.cost_type,
      monthlyAmount: r.monthly_amount,
      allocationBase: r.allocation_base,
      description: r.description,
      status: r.status === 1 ? 'active' : 'inactive',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })
  } catch (err: any) { error(res, err.message) }
})

// 创建成本中心
router.post('/', (req, res) => {
  try {
    const { code, name, costType, monthlyAmount, allocationBase, description, status } = req.body
    const codeText = requireValidText(code, '成本中心编码', 100)
    if (sendTextError(res, codeText)) return
    const nameText = requireValidText(name, '成本中心名称')
    if (sendTextError(res, nameText)) return
    const descriptionText = normalizeDisplayText(description, '成本中心描述', { maxLength: 500 })
    if (sendTextError(res, descriptionText)) return
    const normalizedCostType = String(costType || '').trim()
    const normalizedAllocationBase = String(allocationBase || 'sample_count').trim()
    if (!normalizedCostType) {
      error(res, '缺少必填字段', 'INVALID_PARAMETER', 400); return
    }
    if (!COST_TYPES.has(normalizedCostType)) {
      error(res, '费用类型无效', 'INVALID_PARAMETER', 400); return
    }
    if (!ALLOCATION_BASES.has(normalizedAllocationBase)) {
      error(res, '分摊基础无效', 'INVALID_PARAMETER', 400); return
    }
    const amount = parseNonNegativeAmount(monthlyAmount, 0)
    if (!amount.ok) { error(res, amount.message, 'INVALID_PARAMETER', 400); return }
    const parsedStatus = parseStatus(status, 1)
    if (!parsedStatus.ok) { error(res, parsedStatus.message, 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()
    db.prepare('INSERT INTO indirect_cost_centers (id, code, name, cost_type, monthly_amount, allocation_base, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, codeText.value, nameText.value, normalizedCostType, amount.value, normalizedAllocationBase, descriptionText.value, parsedStatus.value)
    const created = db.prepare('SELECT * FROM indirect_cost_centers WHERE id = ?').get(id) as any
    logOperation(db, req as any, {
      operation: 'POST /indirect-costs',
      description: '创建间接成本中心',
      requestData: costCenterSnapshot(created),
      responseData: { costCenterId: id },
    })
    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed')) { error(res, 'Code exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

// 更新成本中心
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params
    const { name, costType, monthlyAmount, allocationBase, description, status } = req.body
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM indirect_cost_centers WHERE id = ?').get(id) as any
    if (!existing) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    const nameText = name === undefined
      ? { ok: true as const, value: existing.name }
      : requireValidText(name, '成本中心名称')
    if (sendTextError(res, nameText)) return
    const descriptionText = description === undefined
      ? { ok: true as const, value: existing.description }
      : normalizeDisplayText(description, '成本中心描述', { maxLength: 500 })
    if (sendTextError(res, descriptionText)) return
    const normalizedCostType = costType === undefined ? existing.cost_type : String(costType || '').trim()
    const normalizedAllocationBase = allocationBase === undefined ? existing.allocation_base : String(allocationBase || '').trim()
    if (!COST_TYPES.has(normalizedCostType)) {
      error(res, '费用类型无效', 'INVALID_PARAMETER', 400); return
    }
    if (!ALLOCATION_BASES.has(normalizedAllocationBase)) {
      error(res, '分摊基础无效', 'INVALID_PARAMETER', 400); return
    }
    const amount = parseNonNegativeAmount(
      monthlyAmount !== undefined ? monthlyAmount : existing.monthly_amount,
      existing.monthly_amount
    )
    if (!amount.ok) { error(res, amount.message, 'INVALID_PARAMETER', 400); return }
    const parsedStatus = parseStatus(status, existing.status)
    if (!parsedStatus.ok) { error(res, parsedStatus.message, 'INVALID_PARAMETER', 400); return }

    db.prepare('UPDATE indirect_cost_centers SET name = ?, cost_type = ?, monthly_amount = ?, allocation_base = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        nameText.value,
        normalizedCostType,
        amount.value,
        normalizedAllocationBase,
        descriptionText.value,
        parsedStatus.value,
        id
      )
    const updated = db.prepare('SELECT * FROM indirect_cost_centers WHERE id = ?').get(id) as any
    logOperation(db, req as any, {
      operation: 'PUT /indirect-costs/:id',
      description: '更新间接成本中心',
      requestData: {
        before: costCenterSnapshot(existing),
        after: costCenterSnapshot(updated),
      },
      responseData: { costCenterId: id },
    })
    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

// 删除成本中心
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM indirect_cost_centers WHERE id = ?').get(id)
    if (!existing) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    const allocationCount = (db.prepare('SELECT COUNT(*) as count FROM indirect_cost_allocations WHERE cost_center_id = ?').get(id) as any)?.count || 0
    if (allocationCount > 0) {
      error(res, `成本中心已有 ${allocationCount} 条分摊记录，不可删除`, 'CONFLICT', 409)
      return
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM indirect_cost_centers WHERE id = ?').run(id)
      db.exec('COMMIT')
      logOperation(db, req as any, {
        operation: 'DELETE /indirect-costs/:id',
        description: '删除间接成本中心',
        requestData: costCenterSnapshot(existing),
        responseData: { costCenterId: id },
      })
    } catch (innerErr: any) {
      db.exec('ROLLBACK')
      throw innerErr
    }
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

// 获取成本中心分摊记录
router.get('/:id/allocations', (req, res) => {
  try {
    const { id } = req.params
    const { page = 1, pageSize = 20 } = req.query
    const db = getDatabase()
    const costCenter = db.prepare('SELECT id FROM indirect_cost_centers WHERE id = ?').get(id)
    if (!costCenter) { error(res, 'Cost center not found', 'NOT_FOUND', 404); return }
    const count = (db.prepare('SELECT COUNT(*) as total FROM indirect_cost_allocations WHERE cost_center_id = ?').get(id) as any)?.total || 0
    const pageNum = parsePaginationParam(page, 1)
    const safePageSize = parsePaginationParam(pageSize, 20)
    if (!pageNum || !safePageSize) {
      error(res, '分页参数无效', 'INVALID_PARAMETER', 400); return
    }
    const offset = (pageNum - 1) * safePageSize
    const list = db.prepare('SELECT * FROM indirect_cost_allocations WHERE cost_center_id = ? ORDER BY year_month DESC LIMIT ? OFFSET ?').all(id, safePageSize, offset) as any[]

    successList(res, list.map((a: any) => ({
      id: a.id,
      costCenterId: a.cost_center_id,
      yearMonth: a.year_month,
      totalAmount: a.total_amount,
      allocationBaseValue: a.allocation_base_value,
      allocationRate: a.allocation_rate,
      createdAt: a.created_at,
    })), pageNum, safePageSize, count)
  } catch (err: any) { error(res, err.message) }
})

// 录入月度分摊
router.post('/:id/allocations', (req, res) => {
  try {
    const { id } = req.params
    const { yearMonth, totalAmount, allocationBaseValue } = req.body
    if (!yearMonth || totalAmount === undefined) {
      error(res, '缺少必填字段', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()

    const costCenter = db.prepare('SELECT * FROM indirect_cost_centers WHERE id = ?').get(id) as any
    if (!costCenter) { error(res, 'Cost center not found', 'NOT_FOUND', 404); return }
    if (Number(costCenter.status) !== 1) { error(res, '停用成本中心不可录入分摊', 'BUSINESS_RULE', 400); return }
    if (!isValidYearMonth(yearMonth)) { error(res, '年月格式必须为 YYYY-MM', 'INVALID_PARAMETER', 400); return }

    const amount = parseNonNegativeAmount(totalAmount, 0)
    if (!amount.ok) { error(res, amount.message, 'INVALID_PARAMETER', 400); return }
    const parsedBaseValue = parsePositiveBaseValue(allocationBaseValue)
    if (!parsedBaseValue.ok) { error(res, parsedBaseValue.message, 'INVALID_PARAMETER', 400); return }
    const baseValue = parsedBaseValue.value
    const rate = amount.value / baseValue

    const existing = db.prepare('SELECT * FROM indirect_cost_allocations WHERE cost_center_id = ? AND year_month = ?').get(id, yearMonth) as any

    if (existing) {
      db.prepare('UPDATE indirect_cost_allocations SET total_amount = ?, allocation_base_value = ?, allocation_rate = ? WHERE id = ?')
        .run(amount.value, baseValue, rate, existing.id)
      const updated = db.prepare('SELECT * FROM indirect_cost_allocations WHERE id = ?').get(existing.id) as any
      logOperation(db, req as any, {
        operation: 'POST /indirect-costs/:id/allocations',
        description: '更新间接成本分摊',
        requestData: {
          costCenter: costCenterSnapshot(costCenter),
          before: allocationSnapshot(existing),
          after: allocationSnapshot(updated),
        },
        responseData: { costCenterId: id, allocationId: existing.id },
      })
      success(res, { id: existing.id, rate }, 'Updated')
    } else {
      const allocId = uuidv4()
      db.prepare('INSERT INTO indirect_cost_allocations (id, cost_center_id, year_month, total_amount, allocation_base_value, allocation_rate) VALUES (?, ?, ?, ?, ?, ?)')
        .run(allocId, id, yearMonth, amount.value, baseValue, rate)
      const created = db.prepare('SELECT * FROM indirect_cost_allocations WHERE id = ?').get(allocId) as any
      logOperation(db, req as any, {
        operation: 'POST /indirect-costs/:id/allocations',
        description: '录入间接成本分摊',
        requestData: {
          costCenter: costCenterSnapshot(costCenter),
          allocation: allocationSnapshot(created),
        },
        responseData: { costCenterId: id, allocationId: allocId },
      })
      success(res, { id: allocId, rate }, 'Created', 201)
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
