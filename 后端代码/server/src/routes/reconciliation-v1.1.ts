import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

/**
 * GET /api/v1/reconciliation/summary
 * 获取对账汇总数据（顶部统计卡片）
 */
router.get('/summary', (req, res) => {
  try {
    const db = getDatabase()
    const { startDate, endDate } = req.query as Record<string, string>

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if ((startDate && !dateRegex.test(startDate)) || (endDate && !dateRegex.test(endDate))) {
      error(res, 'Invalid date format', 'INVALID_PARAMETER', 400); return
    }

    let dateFilter = ''
    const dateParams: any[] = []
    if (startDate && endDate) {
      dateFilter = 'AND operate_time >= ? AND operate_time <= ?'
      dateParams.push(startDate, `${endDate} 23:59:59`)
    }

    // LIS病例总数
    const totalCases = db.prepare(`
      SELECT COUNT(*) as count FROM lis_cases WHERE 1=1 ${dateFilter}
    `).get(...dateParams) as any

    const outDateFilter = startDate && endDate ? 'AND o.created_at >= ? AND o.created_at <= ?' : ''
    const outDateParams = startDate && endDate ? [startDate, `${endDate} 23:59:59`] : []

    // 关联出库数（通过 outbound_items 关联 project_id 的出库记录）
    const linkedOutbounds = db.prepare(`
      SELECT COUNT(DISTINCT o.id) as count
      FROM outbound_records o
      WHERE o.project_id IS NOT NULL AND o.project_id != '' AND o.is_deleted = 0
      ${outDateFilter}
    `).get(...outDateParams) as any

    // 未关联出库数
    const unlinkedOutbounds = db.prepare(`
      SELECT COUNT(DISTINCT o.id) as count
      FROM outbound_records o
      WHERE (o.project_id IS NULL OR o.project_id = '') AND o.status = 'completed' AND o.is_deleted = 0
      ${outDateFilter}
    `).get(...outDateParams) as any

    // 未关联BOM的项目数
    const projectsWithoutBom = db.prepare(`
      SELECT COUNT(*) as count FROM projects WHERE (bom_id IS NULL OR bom_id = '') AND is_deleted = 0
    `).get() as any

    success(res, {
      totalCases: totalCases?.count || 0,
      linkedOutbounds: linkedOutbounds?.count || 0,
      unlinkedOutbounds: unlinkedOutbounds?.count || 0,
      projectsWithoutBom: projectsWithoutBom?.count || 0,
    })
  } catch (e: any) {
    error(res, e.message || '获取对账汇总失败')
  }
})

/**
 * GET /api/v1/reconciliation/projects
 * 按项目对账列表
 */
router.get('/projects', (req, res) => {
  try {
    const db = getDatabase()
    const { startDate, endDate } = req.query as Record<string, string>

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if ((startDate && !dateRegex.test(startDate)) || (endDate && !dateRegex.test(endDate))) {
      error(res, 'Invalid date format', 'INVALID_PARAMETER', 400); return
    }

    const hasDate = startDate && endDate
    const endDateTime = hasDate ? `${endDate} 23:59:59` : ''

    const projects = db.prepare(`
      SELECT p.id, p.code, p.name, p.bom_id, p.type,
        (SELECT COUNT(*) FROM lis_cases WHERE project_id = p.id
          ${hasDate ? 'AND operate_time >= ? AND operate_time <= ?' : ''}
        ) as case_count,
        (SELECT COUNT(DISTINCT o.id) FROM outbound_records o
          WHERE o.project_id = p.id AND o.status = 'completed' AND o.is_deleted = 0
          ${hasDate ? 'AND o.created_at >= ? AND o.created_at <= ?' : ''}
        ) as outbound_count
      FROM projects p
      WHERE p.is_deleted = 0 AND p.status = 1
      ORDER BY case_count DESC
    `).all(...(hasDate ? [startDate, endDateTime, startDate, endDateTime] : [])) as any[]

    const result = projects.map((p: any) => {
      const boms = db.prepare(`
        SELECT b.id, b.code, b.name FROM boms b
        WHERE (b.id = ? OR b.service_id = ?) AND b.is_deleted = 0
      `).all(p.bom_id || '', p.id || '') as any[]

      return {
        ...p,
        hasBom: !!p.bom_id && p.bom_id !== '',
        boms: boms.map(b => ({ id: b.id, code: b.code, name: b.name })),
      }
    })

    successList(res, result, 1, result.length, result.length)
  } catch (e: any) {
    error(res, e.message || '获取项目对账失败')
  }
})

/**
 * GET /api/v1/reconciliation/projects/:id/materials
 * 某个项目的物料对账明细
 */
router.get('/projects/:id/materials', (req, res) => {
  try {
    const db = getDatabase()
    const projectId = req.params.id
    const { startDate, endDate } = req.query as Record<string, string>

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if ((startDate && !dateRegex.test(startDate)) || (endDate && !dateRegex.test(endDate))) {
      error(res, 'Invalid date format', 'INVALID_PARAMETER', 400); return
    }

    const hasDate = startDate && endDate
    const dateParams: any[] = hasDate ? [startDate, `${endDate} 23:59:59`] : []

    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND is_deleted = 0').get(projectId) as any
    if (!project) {
      return error(res, '项目不存在', 'NOT_FOUND', 404)
    }

    // 获取BOM items
    const bomItems = db.prepare(`
      SELECT bi.*, m.name as material_name, m.spec, m.unit as material_unit, m.price
      FROM bom_items bi
      JOIN materials m ON bi.material_id = m.id
      WHERE bi.bom_id = ? AND m.is_deleted = 0
    `).all(project.bom_id || '') as any[]

    // LIS病例数
    const caseCount = db.prepare(`
      SELECT COUNT(*) as count FROM lis_cases
      WHERE project_id = ? ${hasDate ? 'AND operate_time >= ? AND operate_time <= ?' : ''}
    `).get(projectId, ...dateParams) as any

    const cases = caseCount?.count || 0

    // 实际出库量
    const actualOutbounds = db.prepare(`
      SELECT oi.material_id, SUM(oi.quantity) as total_qty, m.unit, m.name, m.spec
      FROM outbound_items oi
      JOIN outbound_records o ON oi.outbound_id = o.id
      JOIN materials m ON oi.material_id = m.id
      WHERE o.project_id = ? AND o.status = 'completed' AND o.is_deleted = 0 ${hasDate ? 'AND o.created_at >= ? AND o.created_at <= ?' : ''}
      GROUP BY oi.material_id
    `).all(projectId, ...dateParams) as any[]

    const result = bomItems.map((bi: any) => {
      const theoryQty = cases * (bi.usage_per_sample || 0)
      const actual = actualOutbounds.find((a: any) => a.material_id === bi.material_id)
      const actualQty = actual?.total_qty || 0
      const diff = actualQty - theoryQty
      const diffRate = theoryQty > 0 ? ((diff / theoryQty) * 100).toFixed(1) : '0'

      let status = 'match'
      if (diff > theoryQty * 0.2) status = 'warn'
      if (diff > theoryQty * 0.5) status = 'danger'
      if (diff < -theoryQty * 0.2) status = 'warn'

      return {
        materialId: bi.material_id,
        materialName: bi.material_name,
        spec: bi.spec,
        bomUsagePerSample: bi.usage_per_sample,
        bomUnit: bi.unit,
        theoryQty,
        theoryUnit: bi.unit,
        actualQty,
        actualUnit: actual?.unit || bi.unit,
        diff,
        diffRate: parseFloat(diffRate),
        status,
        price: bi.price || 0,
      }
    })

    successList(res, result, 1, result.length, result.length)
  } catch (e: any) {
    error(res, e.message || '获取项目物料对账失败')
  }
})

/**
 * GET /api/v1/reconciliation/materials
 * 按物料维度汇总对账
 */
router.get('/materials', (req, res) => {
  try {
    const db = getDatabase()
    const { startDate, endDate } = req.query as Record<string, string>
    const hasDate = startDate && endDate
    const dateParams: any[] = hasDate ? [startDate, `${endDate} 23:59:59`] : []

    const materials = db.prepare(`
      SELECT m.id, m.name, m.spec, m.unit, m.price,
        (SELECT COUNT(DISTINCT p.id) FROM projects p
          JOIN bom_items bi ON bi.bom_id = p.bom_id
          WHERE bi.material_id = m.id AND p.is_deleted = 0
        ) as project_count
      FROM materials m
      WHERE m.is_deleted = 0 AND m.status = 1
      ORDER BY m.name
    `).all() as any[]

    const result = materials.map((m: any) => {
      // 该物料关联的所有BOM标准用量之和
      const bomUsages = db.prepare(`
        SELECT bi.usage_per_sample, bi.unit, p.id as project_id
        FROM bom_items bi
        JOIN projects p ON bi.bom_id = p.bom_id
        WHERE bi.material_id = ? AND p.is_deleted = 0
      `).all(m.id) as any[]

      // 各项目病例数
      let theoryTotal = 0
      for (const bu of bomUsages) {
        const cc = db.prepare(`
          SELECT COUNT(*) as count FROM lis_cases
          WHERE project_id = ? ${hasDate ? 'AND operate_time >= ? AND operate_time <= ?' : ''}
        `).get(bu.project_id, ...dateParams) as any
        theoryTotal += (cc?.count || 0) * (bu.usage_per_sample || 0)
      }

      // 实际出库（仅计入挂项目的出库，与 theory 口径一致；
      // 无项目的直接出库不参与物料级对账，否则永远不平）
      const actual = db.prepare(`
        SELECT SUM(oi.quantity) as total_qty
        FROM outbound_items oi
        JOIN outbound_records o ON oi.outbound_id = o.id
        WHERE oi.material_id = ? AND o.status = 'completed' AND o.is_deleted = 0
          AND o.project_id IS NOT NULL AND o.project_id != ''
          ${hasDate ? 'AND o.created_at >= ? AND o.created_at <= ?' : ''}
      `).get(m.id, ...dateParams) as any

      const actualTotal = actual?.total_qty || 0
      const diff = actualTotal - theoryTotal

      let status = 'match'
      if (diff > theoryTotal * 0.2) status = 'warn'
      if (diff > theoryTotal * 0.5) status = 'danger'

      return {
        materialId: m.id,
        materialName: m.name,
        spec: m.spec,
        unit: m.unit,
        projectCount: m.project_count,
        theoryTotal,
        actualTotal,
        diff,
        diffRate: theoryTotal > 0 ? ((diff / theoryTotal) * 100).toFixed(1) : '0',
        status,
        price: m.price || 0,
      }
    })

    successList(res, result, 1, result.length, result.length)
  } catch (e: any) {
    error(res, e.message || '获取物料对账失败')
  }
})

/**
 * GET /api/v1/reconciliation/cases
 * 按病理号查看列表
 */
router.get('/cases', (req, res) => {
  try {
    const db = getDatabase()
    const { page = '1', pageSize = '20', search, projectId, status } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page))
    const offset = (pageNum - 1) * parseInt(pageSize)

    let where = 'WHERE 1=1'
    const params: any[] = []
    if (search) { where += ' AND (case_no LIKE ? OR project_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }
    if (projectId) { where += ' AND project_id = ?'; params.push(projectId) }
    if (status) { where += ' AND status = ?'; params.push(status) }

    const list = db.prepare(`
      SELECT * FROM lis_cases ${where}
      ORDER BY operate_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(pageSize), offset) as any[]

    const count = (db.prepare(`SELECT COUNT(*) as count FROM lis_cases ${where}`).get(...params) as any)?.count || 0

    const result = list.map((c: any) => {
      const project = db.prepare('SELECT name, bom_id FROM projects WHERE id = ? AND is_deleted = 0').get(c.project_id || '') as any
      return {
        ...c,
        projectName: project?.name || c.project_name || '-',
        hasBom: !!project?.bom_id,
      }
    })

    successList(res, result, pageNum, parseInt(pageSize), count)
  } catch (e: any) {
    error(res, e.message || '获取病例列表失败')
  }
})

/**
 * POST /api/v1/reconciliation/cases/import
 * 批量导入LIS病例数据
 */
router.post('/cases/import', (req, res) => {
  try {
    const db = getDatabase()
    const { items } = req.body as { items: any[] }

    if (!Array.isArray(items) || items.length === 0) {
      return error(res, '导入数据为空', 'BAD_REQUEST', 400)
    }

    const importBatch = `IMPORT-${Date.now()}`
    const stmt = db.prepare(`
      INSERT INTO lis_cases (id, case_no, project_id, project_name, operator, operate_time, import_batch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_no) DO UPDATE SET
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        operator = excluded.operator,
        operate_time = excluded.operate_time
    `)

    let successCount = 0
    for (const item of items) {
      const id = `LC-${Date.now()}-${Math.floor(Math.random() * 10000)}`
      stmt.run(
        id,
        item.caseNo || item.case_no || '',
        item.projectId || item.project_id || '',
        item.projectName || item.project_name || '',
        item.operator || '',
        item.operateTime || item.operate_time || null,
        importBatch
      )
      successCount++
    }

    success(res, { importBatch, count: successCount }, `成功导入 ${successCount} 条病例数据`)
  } catch (e: any) {
    error(res, e.message || '导入失败')
  }
})

/**
 * PUT /api/v1/reconciliation/cases/:id
 * 修改病例信息（关联项目等）
 */
router.put('/cases/:id', (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const { projectId, projectName, status } = req.body

    const existing = db.prepare('SELECT * FROM lis_cases WHERE id = ?').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    db.prepare(`
      UPDATE lis_cases SET
        project_id = COALESCE(?, project_id),
        project_name = COALESCE(?, project_name),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(projectId, projectName, status, id)

    success(res, null, '病例信息已更新')
  } catch (e: any) {
    error(res, e.message || '更新失败')
  }
})

/**
 * GET /api/v1/reconciliation/logs
 * 获取修正日志
 */
router.get('/logs', (req, res) => {
  try {
    const db = getDatabase()
    const { page = '1', pageSize = '20' } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(pageSize)

    const list = db.prepare(`
      SELECT * FROM reconciliation_logs
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(parseInt(pageSize), offset) as any[]

    const count = db.prepare('SELECT COUNT(*) as count FROM reconciliation_logs').get() as any

    successList(res, list, parseInt(page), parseInt(pageSize), count?.count || 0)
  } catch (e: any) {
    error(res, e.message || '获取日志失败')
  }
})

/**
 * POST /api/v1/reconciliation/logs
 * 记录修正日志，同时更新BOM用量（如果提供了projectId和materialId）
 */
router.post('/logs', (req, res) => {
  try {
    const db = getDatabase()
    const { type, targetId, targetName, field, oldValue, newValue, reason, projectId, materialId, newUsage } = req.body

    // 如果提供了projectId、materialId和newUsage，先更新bom_items
    if (projectId && materialId && newUsage !== undefined) {
      const project = db.prepare('SELECT bom_id FROM projects WHERE id = ? AND is_deleted = 0').get(projectId) as any
      if (project?.bom_id) {
        db.prepare('UPDATE bom_items SET usage_per_sample = ? WHERE bom_id = ? AND material_id = ?')
          .run(newUsage, project.bom_id, materialId)
      }
    }

    const id = `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    db.prepare(`
      INSERT INTO reconciliation_logs (id, type, target_id, target_name, field, old_value, new_value, reason, operator, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, type || 'bom_fix', targetId, targetName, field, oldValue, newValue, reason, (req as any).user?.username || 'system')

    success(res, { id }, 'BOM修正已生效，日志已记录')
  } catch (e: any) {
    error(res, e.message || '记录日志失败')
  }
})

export default router
