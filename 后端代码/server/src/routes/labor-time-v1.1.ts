import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { normalizeDisplayText, requireValidText, type TextGuardResult } from '../utils/text-guard.js'
import { logOperation } from '../utils/operation-logger.js'

const router = Router()

const PROJECT_TYPES = new Set(['all', 'ihc', 'he', 'ss', 'mp', 'cyto'])
const REFERENCE_SOURCES = new Set(['supplier', 'industry', 'system'])
const REFERENCE_SOURCE_LABELS: Record<string, string> = { supplier: '供应商提供', industry: '行业标准', system: '系统预设' }

function normalizeProjectType(projectType: unknown) {
  return String(projectType || 'all').trim().toLowerCase() || 'all'
}

function normalizeReferenceSource(referenceSource: unknown) {
  return String(referenceSource || 'system').trim().toLowerCase() || 'system'
}

function sendTextError(res: any, result: TextGuardResult): result is Extract<TextGuardResult, { ok: false }> {
  if ('message' in result) {
    error(res, result.message, result.code, result.status)
    return true
  }
  return false
}

function toLaborTimeDto(r: any) {
  const referenceSource = r.reference_source || 'system'
  return {
    id: r.id,
    stepCode: r.step_code,
    stepName: r.step_name,
    projectType: r.project_type,
    standardMinutes: r.standard_minutes,
    laborRatePerMinute: r.labor_rate_per_minute,
    isEquipmentStep: r.is_equipment_step === 1,
    description: r.description,
    sortOrder: r.sort_order,
    referenceSource,
    referenceSourceLabel: REFERENCE_SOURCE_LABELS[referenceSource] || '系统预设',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function validateLaborTimeInput(input: {
  stepCode?: unknown
  stepName?: unknown
  projectType?: unknown
  standardMinutes?: unknown
  laborRatePerMinute?: unknown
  sortOrder?: unknown
  referenceSource?: unknown
}, requireAll = false) {
  const stepCode = input.stepCode === undefined ? undefined : String(input.stepCode).trim()
  const stepName = input.stepName === undefined ? undefined : String(input.stepName).trim()
  const projectType = input.projectType === undefined ? undefined : normalizeProjectType(input.projectType)
  const standardMinutes = input.standardMinutes === undefined ? undefined : Number(input.standardMinutes)
  const laborRatePerMinute = input.laborRatePerMinute === undefined ? undefined : Number(input.laborRatePerMinute)
  const sortOrder = input.sortOrder === undefined ? undefined : Number(input.sortOrder)
  const referenceSource = input.referenceSource === undefined ? undefined : normalizeReferenceSource(input.referenceSource)

  if (requireAll && (!stepCode || !stepName || !projectType || standardMinutes === undefined)) {
    return { ok: false, message: '缺少必填字段' }
  }
  if (stepCode !== undefined && !stepCode) return { ok: false, message: '步骤编号不能为空' }
  if (stepName !== undefined && !stepName) return { ok: false, message: '步骤名称不能为空' }
  if (projectType !== undefined && !PROJECT_TYPES.has(projectType)) {
    return { ok: false, message: '项目类型不支持' }
  }
  if (standardMinutes !== undefined && (!Number.isFinite(standardMinutes) || standardMinutes <= 0)) {
    return { ok: false, message: '标准时长必须大于0' }
  }
  if (laborRatePerMinute !== undefined && (!Number.isFinite(laborRatePerMinute) || laborRatePerMinute < 0)) {
    return { ok: false, message: '费率不能为负数' }
  }
  if (sortOrder !== undefined && (!Number.isFinite(sortOrder) || sortOrder < 0)) {
    return { ok: false, message: '排序必须大于等于0' }
  }
  if (referenceSource !== undefined && !REFERENCE_SOURCES.has(referenceSource)) {
    return { ok: false, message: '参考来源不支持' }
  }

  return { ok: true, stepCode, stepName, projectType, standardMinutes, laborRatePerMinute, sortOrder, referenceSource }
}

function buildLaborTimeWhere(query: any) {
  const { projectType, stepCode, keyword, referenceSource } = query
  let where = 'COALESCE(is_deleted, 0) = 0'
  const params: any[] = []
  if (projectType) {
    where += ' AND project_type = ?'
    params.push(normalizeProjectType(projectType))
  }
  if (stepCode) {
    where += ' AND step_code = ?'
    params.push(stepCode)
  }
  if (keyword) {
    where += ' AND (step_name LIKE ? OR step_code LIKE ?)'
    const like = `%${keyword}%`
    params.push(like, like)
  }
  if (referenceSource) {
    where += ' AND reference_source = ?'
    params.push(referenceSource)
  }
  return { where, params }
}

// 获取工时列表
router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query
    const db = getDatabase()
    const { where, params } = buildLaborTimeWhere(req.query)

    const count = (db.prepare(`SELECT COUNT(*) as total FROM standard_labor_times WHERE ${where}`).get(...params) as any)?.total || 0
    const pageNum = Math.max(1, Number(page))
    const safePageSize = Math.max(1, Math.min(1000, Number(pageSize)))
    const offset = (pageNum - 1) * safePageSize
    const list = db.prepare(`SELECT * FROM standard_labor_times WHERE ${where} ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?`).all(...params, safePageSize, offset) as any[]

    successList(res, list.map(toLaborTimeDto), pageNum, safePageSize, count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/stats', (req, res) => {
  try {
    const db = getDatabase()
    const { where, params } = buildLaborTimeWhere(req.query)
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(standard_minutes), 0) as totalMinutes,
        COALESCE(AVG(labor_rate_per_minute), 0) as avgRate,
        COALESCE(SUM(CASE WHEN is_equipment_step = 1 THEN 1 ELSE 0 END), 0) as equipmentSteps
      FROM standard_labor_times
      WHERE ${where}
    `).get(...params) as any
    success(res, {
      total: row?.total || 0,
      totalMinutes: row?.totalMinutes || 0,
      avgRate: row?.avgRate || 0,
      equipmentSteps: row?.equipmentSteps || 0,
    })
  } catch (err: any) { error(res, err.message) }
})

// 按项目类型获取工时模板
router.get('/project-type/:type', (req, res) => {
  try {
    const type = normalizeProjectType(req.params.type)
    if (!PROJECT_TYPES.has(type)) { error(res, '项目类型不支持', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const list = db.prepare(`
      SELECT * FROM standard_labor_times
      WHERE COALESCE(is_deleted, 0) = 0
        AND (project_type = ? OR project_type = 'all')
      ORDER BY sort_order ASC, created_at ASC
    `).all(type) as any[]

    success(res, list.map(toLaborTimeDto))
  } catch (err: any) { error(res, err.message) }
})

// 获取工时详情
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const r = db.prepare('SELECT * FROM standard_labor_times WHERE id = ? AND COALESCE(is_deleted, 0) = 0').get(id) as any
    if (!r) { error(res, '记录不存在', 'NOT_FOUND', 404); return }

    success(res, toLaborTimeDto(r))
  } catch (err: any) { error(res, err.message) }
})

// 创建工时定义
router.post('/', (req, res) => {
  try {
    const { stepCode, stepName, projectType, standardMinutes, laborRatePerMinute, isEquipmentStep, description, sortOrder, referenceSource } = req.body
    const stepCodeText = requireValidText(stepCode, '步骤编号', 100)
    if (sendTextError(res, stepCodeText)) return
    const stepNameText = requireValidText(stepName, '步骤名称')
    if (sendTextError(res, stepNameText)) return
    const descriptionText = normalizeDisplayText(description, '工时说明', { maxLength: 500 })
    if (sendTextError(res, descriptionText)) return
    const validation = validateLaborTimeInput({ stepCode, stepName, projectType, standardMinutes, laborRatePerMinute, sortOrder, referenceSource }, true)
    if (!validation.ok) { error(res, validation.message ?? '参数校验失败', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()
    db.prepare('INSERT INTO standard_labor_times (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, description, sort_order, reference_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, stepCodeText.value, stepNameText.value, validation.projectType, validation.standardMinutes, validation.laborRatePerMinute || 0, isEquipmentStep ? 1 : 0, descriptionText.value, validation.sortOrder || 0, validation.referenceSource || 'system')
    logOperation(db, req, {
      operation: 'POST /labor-times',
      description: `创建标准工时 ${stepNameText.value}`,
      requestData: { module: 'labor', id, stepCode: stepCodeText.value, projectType: validation.projectType },
      responseData: { id },
    })
    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed')) { error(res, 'Step code exists for this project type', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

// 更新工时定义
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params
    const { stepCode, stepName, projectType, standardMinutes, laborRatePerMinute, isEquipmentStep, description, sortOrder, referenceSource } = req.body
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM standard_labor_times WHERE id = ? AND COALESCE(is_deleted, 0) = 0').get(id) as any
    if (!existing) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    const stepCodeText = stepCode !== undefined
      ? requireValidText(stepCode, '步骤编号', 100)
      : { ok: true as const, value: existing.step_code }
    if (sendTextError(res, stepCodeText)) return
    if (stepCodeText.value !== existing.step_code) {
      error(res, '步骤编号创建后不允许修改', 'INVALID_PARAMETER', 400)
      return
    }
    const normalizedProjectType = projectType !== undefined ? normalizeProjectType(projectType) : existing.project_type
    if (normalizedProjectType !== existing.project_type) {
      error(res, '项目类型创建后不允许修改', 'INVALID_PARAMETER', 400)
      return
    }
    const stepNameText = stepName !== undefined
      ? requireValidText(stepName, '步骤名称')
      : { ok: true as const, value: existing.step_name }
    if (sendTextError(res, stepNameText)) return
    const descriptionText = description !== undefined
      ? normalizeDisplayText(description, '工时说明', { maxLength: 500 })
      : { ok: true as const, value: existing.description }
    if (sendTextError(res, descriptionText)) return
    const validation = validateLaborTimeInput({ stepCode, stepName, projectType, standardMinutes, laborRatePerMinute, sortOrder, referenceSource })
    if (!validation.ok) { error(res, validation.message ?? '参数校验失败', 'INVALID_PARAMETER', 400); return }

    db.prepare('UPDATE standard_labor_times SET step_code = ?, step_name = ?, project_type = ?, standard_minutes = ?, labor_rate_per_minute = ?, is_equipment_step = ?, description = ?, sort_order = ?, reference_source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        stepCodeText.value,
        stepNameText.value,
        validation.projectType !== undefined ? validation.projectType : existing.project_type,
        validation.standardMinutes !== undefined ? validation.standardMinutes : existing.standard_minutes,
        validation.laborRatePerMinute !== undefined ? validation.laborRatePerMinute : existing.labor_rate_per_minute,
        isEquipmentStep !== undefined ? (isEquipmentStep ? 1 : 0) : existing.is_equipment_step,
        descriptionText.value,
        validation.sortOrder !== undefined ? validation.sortOrder : existing.sort_order,
        validation.referenceSource !== undefined ? validation.referenceSource : (existing.reference_source || 'system'),
        id
      )
    logOperation(db, req, {
      operation: 'PUT /labor-times/:id',
      description: `更新标准工时 ${stepNameText.value}`,
      requestData: { module: 'labor', id, stepCode: stepCodeText.value, projectType: normalizedProjectType },
      responseData: { id },
    })
    success(res, { id }, 'Updated')
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed')) { error(res, 'Step code exists for this project type', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

// 删除工时定义
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM standard_labor_times WHERE id = ? AND COALESCE(is_deleted, 0) = 0').get(id) as any
    if (!existing) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    db.prepare('UPDATE standard_labor_times SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    logOperation(db, req, {
      operation: 'DELETE /labor-times/:id',
      description: `归档标准工时 ${existing.step_name}`,
      requestData: { module: 'labor', id, stepCode: existing.step_code, projectType: existing.project_type },
      responseData: { id, archived: true },
    })
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
