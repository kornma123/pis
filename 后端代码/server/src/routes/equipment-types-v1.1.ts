import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken, requireRole } from '../middleware/auth.js'
import { normalizeDisplayText, requireValidText, type TextGuardResult } from '../utils/text-guard.js'
import { logOperation } from '../utils/operation-logger.js'

const router = Router()
const requireEquipmentTypeWrite = requireRole()

type DepreciationMethodParse =
  | { ok: true; value: string }
  | { ok: false; message: string }

type EquipmentTypeStatusParse =
  | { ok: true; value: number }
  | { ok: false; message: string }

type EquipmentTypeValueValidation =
  | {
    ok: true
    defaultPurchasePrice: number
    defaultDepreciableLifeYears: number
    defaultValue: number
    defaultDepreciationMethod: string
    defaultTotalCapacity: number
  }
  | { ok: false; message: string }

function parseDepreciationMethod(method: unknown, fallback = 'straight_line'): DepreciationMethodParse {
  const value = method === undefined || method === null || method === '' ? fallback : String(method)
  if (value === 'straight_line' || value === 'units_of_production') return { ok: true, value }
  return { ok: false, message: '折旧方式无效' }
}

function parseEquipmentTypeStatus(status: unknown, fallback = 1): EquipmentTypeStatusParse {
  if (status === undefined || status === null || status === '') return { ok: true, value: fallback }
  if (status === 'active') return { ok: true, value: 1 }
  if (status === 'inactive') return { ok: true, value: 0 }
  return { ok: false, message: '设备类型状态无效' }
}

function numberOrDefault(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback
  return Number(value)
}

function validateEquipmentTypeValues(input: {
  defaultPurchasePrice: unknown
  defaultDepreciableLifeYears: unknown
  defaultValue: unknown
  defaultDepreciationMethod: unknown
  defaultTotalCapacity: unknown
}): EquipmentTypeValueValidation {
  const defaultPurchasePrice = numberOrDefault(input.defaultPurchasePrice, 0)
  const defaultDepreciableLifeYears = numberOrDefault(input.defaultDepreciableLifeYears, 5)
  const defaultValue = numberOrDefault(input.defaultValue, 0)
  const defaultDepreciationMethod = parseDepreciationMethod(input.defaultDepreciationMethod)
  const defaultTotalCapacity = numberOrDefault(input.defaultTotalCapacity, 0)

  if (!Number.isFinite(defaultPurchasePrice) || defaultPurchasePrice < 0) return { ok: false, message: '默认采购价必须大于等于0' }
  if (!Number.isFinite(defaultValue) || defaultValue < 0) return { ok: false, message: '默认残值必须大于等于0' }
  if (defaultValue > defaultPurchasePrice) return { ok: false, message: '默认残值不能大于默认采购价' }
  if (!Number.isFinite(defaultDepreciableLifeYears) || defaultDepreciableLifeYears <= 0) return { ok: false, message: '默认折旧年限必须大于0' }
  if (defaultDepreciationMethod.ok === false) return { ok: false, message: defaultDepreciationMethod.message }
  if (!Number.isFinite(defaultTotalCapacity) || defaultTotalCapacity < 0) return { ok: false, message: '默认总工作量必须大于等于0' }
  if (defaultDepreciationMethod.value === 'units_of_production' && defaultTotalCapacity <= 0) return { ok: false, message: '工作量法必须填写大于0的默认总工作量' }

  return {
    ok: true,
    defaultPurchasePrice,
    defaultDepreciableLifeYears,
    defaultValue,
    defaultDepreciationMethod: defaultDepreciationMethod.value,
    defaultTotalCapacity,
  }
}

function buildEquipmentTypeWhere(query: any) {
  const { keyword, status } = query
  const includeDeleted = query?.includeDeleted === true || query?.includeDeleted === 'true'
  let where = includeDeleted ? '1=1' : 'et.is_deleted = 0'
  const params: any[] = []

  if (keyword) {
    where += ' AND (et.id LIKE ? OR et.code LIKE ? OR et.name LIKE ?)'
    const like = `%${keyword}%`
    params.push(like, like, like)
  }
  if (status !== undefined && status !== '' && status !== 'all') {
    where += ' AND et.status = ?'
    params.push(status === 'active' ? 1 : 0)
  }

  return { where, params }
}

function sendTextError(res: any, result: TextGuardResult): result is Extract<TextGuardResult, { ok: false }> {
  if ('message' in result) {
    error(res, result.message, result.code, result.status)
    return true
  }
  return false
}

function toEquipmentTypeAuditSnapshot(row: any) {
  if (!row) return null
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || null,
    defaultPurchasePrice: row.default_purchase_price || 0,
    defaultDepreciableLifeYears: row.default_depreciable_life_years || 0,
    defaultValue: row.default_residual_value || 0,
    defaultDepreciationMethod: row.default_depreciation_method || null,
    defaultTotalCapacity: row.default_total_capacity || 0,
    defaultCapacityUnit: row.default_capacity_unit || null,
    status: row.status === 1 ? 'active' : 'inactive',
    isDeleted: Number(row.is_deleted || 0) !== 0,
  }
}

// 获取设备类型列表
router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20 } = req.query
    page = Math.max(1, Number(page) || 1) as any
    pageSize = Math.max(1, Math.min(1000, Number(pageSize) || 20)) as any
    const db = getDatabase()
    const { where, params } = buildEquipmentTypeWhere(req.query)

    const count = (db.prepare(`SELECT COUNT(*) as total FROM equipment_types et WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT et.* FROM equipment_types et WHERE ${where} ORDER BY et.created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    // 统计每个类型下的设备数量
    const eqCounts = db.prepare(`
      SELECT type_id, COUNT(*) as cnt FROM equipment WHERE type_id IS NOT NULL AND is_deleted = 0 GROUP BY type_id
    `).all() as any[]
    const countMap = new Map(eqCounts.map((c: any) => [c.type_id, c.cnt]))

    successList(res, list.map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      defaultPurchasePrice: r.default_purchase_price,
      defaultDepreciableLifeYears: r.default_depreciable_life_years,
      defaultValue: r.default_residual_value,
      defaultDepreciationMethod: r.default_depreciation_method,
      defaultTotalCapacity: r.default_total_capacity,
      defaultCapacityUnit: r.default_capacity_unit,
      status: r.status === 1 ? 'active' : 'inactive',
      equipmentCount: countMap.get(r.id) || 0,
      isDeleted: Number(r.is_deleted || 0) !== 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/stats', (req, res) => {
  try {
    const db = getDatabase()
    const { where, params } = buildEquipmentTypeWhere(req.query)
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT et.id) as total,
        COALESCE(SUM(CASE WHEN et.status = 1 THEN 1 ELSE 0 END), 0) as active,
        COUNT(e.id) as equipmentCount
      FROM equipment_types et
      LEFT JOIN equipment e ON e.type_id = et.id AND e.is_deleted = 0
      WHERE ${where}
    `).get(...params) as any
    success(res, {
      total: row?.total || 0,
      active: row?.active || 0,
      equipmentCount: row?.equipmentCount || 0,
    })
  } catch (err: any) { error(res, err.message) }
})

// 获取设备类型详情
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params
    const includeDeleted = req.query?.includeDeleted === 'true'
    const db = getDatabase()
    const r = db.prepare(`SELECT * FROM equipment_types WHERE id = ? ${includeDeleted ? '' : 'AND is_deleted = 0'}`).get(id) as any
    if (!r) { error(res, '设备类型不存在', 'NOT_FOUND', 404); return }

    // 统计设备数量
    const eqCount = (db.prepare('SELECT COUNT(*) as cnt FROM equipment WHERE type_id = ? AND is_deleted = 0').get(id) as any)?.cnt || 0

    success(res, {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      defaultPurchasePrice: r.default_purchase_price,
      defaultDepreciableLifeYears: r.default_depreciable_life_years,
      defaultValue: r.default_residual_value,
      defaultDepreciationMethod: r.default_depreciation_method,
      defaultTotalCapacity: r.default_total_capacity,
      defaultCapacityUnit: r.default_capacity_unit,
      status: r.status === 1 ? 'active' : 'inactive',
      equipmentCount: eqCount,
      isDeleted: Number(r.is_deleted || 0) !== 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })
  } catch (err: any) { error(res, err.message) }
})

// 创建设备类型
router.post('/', authenticateToken, requireEquipmentTypeWrite, (req, res) => {
  try {
    const { code, name, description, defaultPurchasePrice, defaultDepreciableLifeYears, defaultValue, defaultDepreciationMethod, defaultTotalCapacity, defaultCapacityUnit } = req.body
    const codeText = requireValidText(code, '设备类型编码', 100)
    if (sendTextError(res, codeText)) return
    const nameText = requireValidText(name, '设备类型名称')
    if (sendTextError(res, nameText)) return
    const descriptionText = normalizeDisplayText(description, '设备类型描述', { maxLength: 500 })
    if (sendTextError(res, descriptionText)) return
    const capacityUnitText = normalizeDisplayText(defaultCapacityUnit, '默认工作量单位', { maxLength: 40 })
    if (sendTextError(res, capacityUnitText)) return
    const values = validateEquipmentTypeValues({
      defaultPurchasePrice,
      defaultDepreciableLifeYears,
      defaultValue,
      defaultDepreciationMethod,
      defaultTotalCapacity,
    })
    if (values.ok === false) { error(res, values.message, 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()

    db.prepare(`INSERT INTO equipment_types (id, code, name, description, default_purchase_price, default_depreciable_life_years, default_residual_value, default_depreciation_method, default_total_capacity, default_capacity_unit, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(
        id,
        codeText.value,
        nameText.value,
        descriptionText.value,
        values.defaultPurchasePrice,
        values.defaultDepreciableLifeYears,
        values.defaultValue,
        values.defaultDepreciationMethod,
        values.defaultTotalCapacity,
        capacityUnitText.value || 'minutes',
      )

    const created = db.prepare('SELECT * FROM equipment_types WHERE id = ?').get(id)
    const after = toEquipmentTypeAuditSnapshot(created)
    logOperation(db, req as any, {
      operation: 'POST /equipment-types',
      description: '创建设备类型折旧口径',
      requestData: {
        module: 'equipment_types',
        businessId: id,
        code: codeText.value,
        name: nameText.value,
        after,
      },
      responseData: {
        id,
        after,
      },
    })

    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed')) { error(res, `类型编码 ${req.body.code} 已存在`, 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

// 更新设备类型
router.put('/:id', authenticateToken, requireEquipmentTypeWrite, (req, res) => {
  try {
    const { id } = req.params
    const { code, name, description, defaultPurchasePrice, defaultDepreciableLifeYears, defaultValue, defaultDepreciationMethod, defaultTotalCapacity, defaultCapacityUnit, status } = req.body
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM equipment_types WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!existing) { error(res, '设备类型不存在', 'NOT_FOUND', 404); return }
    const before = toEquipmentTypeAuditSnapshot(existing)
    if (code !== undefined) {
      const codeText = requireValidText(code, '设备类型编码', 100)
      if (sendTextError(res, codeText)) return
      if (codeText.value !== existing.code) {
        error(res, '设备类型编码创建后不允许修改', 'INVALID_PARAMETER', 400); return
      }
    }
    const nameText = name !== undefined
      ? requireValidText(name, '设备类型名称')
      : { ok: true as const, value: existing.name }
    if (sendTextError(res, nameText)) return
    const descriptionText = description !== undefined
      ? normalizeDisplayText(description, '设备类型描述', { maxLength: 500 })
      : { ok: true as const, value: existing.description }
    if (sendTextError(res, descriptionText)) return
    const capacityUnitText = defaultCapacityUnit !== undefined
      ? normalizeDisplayText(defaultCapacityUnit, '默认工作量单位', { maxLength: 40 })
      : { ok: true as const, value: existing.default_capacity_unit }
    if (sendTextError(res, capacityUnitText)) return
    const values = validateEquipmentTypeValues({
      defaultPurchasePrice: defaultPurchasePrice !== undefined ? defaultPurchasePrice : existing.default_purchase_price,
      defaultDepreciableLifeYears: defaultDepreciableLifeYears !== undefined ? defaultDepreciableLifeYears : existing.default_depreciable_life_years,
      defaultValue: defaultValue !== undefined ? defaultValue : existing.default_residual_value,
      defaultDepreciationMethod: defaultDepreciationMethod || existing.default_depreciation_method,
      defaultTotalCapacity: defaultTotalCapacity !== undefined ? defaultTotalCapacity : existing.default_total_capacity,
    })
    if (values.ok === false) { error(res, values.message, 'INVALID_PARAMETER', 400); return }
    const statusValue = parseEquipmentTypeStatus(status, existing.status)
    if (statusValue.ok === false) { error(res, statusValue.message, 'INVALID_PARAMETER', 400); return }

    db.prepare(`UPDATE equipment_types SET name = ?, description = ?, default_purchase_price = ?, default_depreciable_life_years = ?, default_residual_value = ?, default_depreciation_method = ?, default_total_capacity = ?, default_capacity_unit = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        nameText.value,
        descriptionText.value,
        values.defaultPurchasePrice,
        values.defaultDepreciableLifeYears,
        values.defaultValue,
        values.defaultDepreciationMethod,
        values.defaultTotalCapacity,
        capacityUnitText.value || existing.default_capacity_unit,
        statusValue.value,
        id
      )

    const updated = db.prepare('SELECT * FROM equipment_types WHERE id = ?').get(id)
    const after = toEquipmentTypeAuditSnapshot(updated)
    logOperation(db, req as any, {
      operation: 'PUT /equipment-types/:id',
      description: '更新设备类型折旧口径',
      requestData: {
        module: 'equipment_types',
        businessId: id,
        before,
        after,
      },
      responseData: {
        id,
        beforeStatus: before?.status,
        afterStatus: after?.status,
      },
    })

    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

// 删除设备类型
router.delete('/:id', authenticateToken, requireEquipmentTypeWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM equipment_types WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, '设备类型不存在', 'NOT_FOUND', 404); return }
    const before = toEquipmentTypeAuditSnapshot(existing)

    // 检查是否有设备关联
    const eqCount = (db.prepare('SELECT COUNT(*) as count FROM equipment WHERE type_id = ? AND is_deleted = 0').get(id) as any)?.count || 0
    if (eqCount > 0) {
      error(res, `该类型下有 ${eqCount} 台设备，无法删除。请先将设备转移到其他类型`, 'CONFLICT', 409)
      return
    }
    const bomTemplateCount = (db.prepare('SELECT COUNT(*) as count FROM bom_equipment_templates WHERE equipment_type_id = ?').get(id) as any)?.count || 0
    if (bomTemplateCount > 0) {
      error(res, `该类型已被 ${bomTemplateCount} 个BOM设备模板引用，不可删除`, 'CONFLICT', 409)
      return
    }

    db.prepare('UPDATE equipment_types SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    logOperation(db, req as any, {
      operation: 'DELETE /equipment-types/:id',
      description: '删除设备类型折旧口径',
      requestData: {
        module: 'equipment_types',
        businessId: id,
        before,
      },
      responseData: {
        id,
        isDeleted: true,
        beforeStatus: before?.status,
      },
    })
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
