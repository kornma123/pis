import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import {
  writeBomVersionSnapshot,
  getLatestBomVersionSnapshot,
  buildBomVersionSnapshot,
  buildBomChangeImpact,
} from '../utils/bom-version.js'
import { runCostRecalculation } from '../utils/cost-runs.js'
import { requireAnyRole } from '../middleware/permissions.js'
import { assertNotSelfReview } from '../middleware/authz-combinators.js'
import { canonicalCaseNo } from '../utils/classifier.js' // 病理号落库归一，与 lis-cases /import 及 case_revenue 同一 canonical（防全角号匹配漏）

const router = Router()
// 审批/驳回 BOM 修正提案限成本核准角色（admin/finance/lab_director）；propose 由挂载层 reconciliation R + 技术员 W 放行
const requireReconcileApprove = requireAnyRole('admin', 'finance', 'lab_director')
// 单次病例导入行数上限（防同步逐行 INSERT 阻塞事件循环的 DoS）。与 lis-cases /import 一致。
const MAX_LIS_IMPORT_ROWS = 1000

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
    // 防 DoS：node:sqlite 同步逐行 INSERT，行数过大会阻塞整个事件循环、令全站请求挂起。
    if (items.length > MAX_LIS_IMPORT_ROWS) {
      return error(res, `单次导入最多支持 ${MAX_LIS_IMPORT_ROWS} 条，请分批导入`, 'INVALID_PARAMETER', 400)
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
        canonicalCaseNo(item.caseNo || item.case_no || ''),
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
    const { page = '1', pageSize = '20', status, type } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(pageSize)

    let where = 'WHERE 1=1'
    const params: any[] = []
    if (status) { where += ' AND status = ?'; params.push(status) }
    if (type) { where += ' AND type = ?'; params.push(type) }

    const list = db.prepare(`
      SELECT * FROM reconciliation_logs ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(pageSize), offset) as any[]

    const count = db.prepare(`SELECT COUNT(*) as count FROM reconciliation_logs ${where}`).get(...params) as any

    successList(res, list, parseInt(page), parseInt(pageSize), count?.count || 0)
  } catch (e: any) {
    error(res, e.message || '获取日志失败')
  }
})

/**
 * POST /api/v1/reconciliation/logs
 * 提交「BOM 标准用量修正」提案（status=pending）——**不再直接改 bom_items**，
 * 须经独立审核人 approve 才生效（职责分离 SoD）。其余类型作普通审计留痕。
 */
router.post('/logs', (req, res) => {
  try {
    const db = getDatabase()
    const { type, targetId, targetName, field, oldValue, newValue, reason, projectId, materialId, newUsage } = req.body
    const operator = (req as any).user?.username || 'system'

    // —— BOM 标准用量修正提案路径 ——
    if (projectId && materialId && newUsage !== undefined) {
      const usage = Number(newUsage)
      if (isNaN(usage) || usage < 0) { error(res, '修正用量非法', 'INVALID_PARAMETER', 400); return }
      if (!reason || !String(reason).trim()) { error(res, '请填写修正原因', 'INVALID_PARAMETER', 400); return }
      const project = db.prepare('SELECT bom_id FROM projects WHERE id = ? AND is_deleted = 0').get(projectId) as any
      if (!project?.bom_id) { error(res, '项目未关联 BOM，无法提交修正', 'INVALID_PARAMETER', 400); return }
      const item = db.prepare('SELECT usage_per_sample FROM bom_items WHERE bom_id = ? AND material_id = ?')
        .get(project.bom_id, materialId) as any
      if (!item) { error(res, '该物料不在 BOM 标准内', 'NOT_FOUND', 404); return }

      const id = `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`
      db.prepare(`
        INSERT INTO reconciliation_logs
          (id, type, target_id, target_name, field, old_value, new_value, reason, operator,
           status, material_id, project_id, applied_bom_id, proposed_usage)
        VALUES (?, 'bom_fix_proposal', ?, ?, 'usage_per_sample', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        id, targetId || materialId, targetName || null,
        String(item.usage_per_sample), String(usage), reason, operator,
        materialId, projectId, project.bom_id, usage,
      )
      success(res, { id, status: 'pending' }, '修正已提交，待审核')
      return
    }

    // —— 其余：普通审计留痕（无审批，向后兼容）——
    const id = `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    db.prepare(`
      INSERT INTO reconciliation_logs (id, type, target_id, target_name, field, old_value, new_value, reason, operator, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied')
    `).run(id, type || 'note', targetId || null, targetName || null, field || null, oldValue ?? null, newValue ?? null, reason || '', operator)
    success(res, { id, status: 'applied' }, '已记录')
  } catch (e: any) {
    error(res, e.message || '提交失败')
  }
})

/**
 * POST /api/v1/reconciliation/logs/:id/approve
 * 审核通过 BOM 修正提案：他人审核（SoD）+ 乐观锁 + 落版本快照 + 升版本 + 写回 bom_items。
 * body.effectiveScope: 'future_only'（默认，不动历史）| 'retroactive'（P4 接通追溯重算）。
 */
router.post('/logs/:id/approve', requireReconcileApprove, (req, res) => {
  try {
    const db = getDatabase()
    const operator = (req as any).user?.username || 'system'
    const row = db.prepare('SELECT * FROM reconciliation_logs WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '提案不存在', 'NOT_FOUND', 404); return }
    if (row.type !== 'bom_fix_proposal') { error(res, '该记录不是可审核的修正提案', 'INVALID_STATUS', 422); return }
    if (row.status !== 'pending') { error(res, '只有待审核提案可以审核', 'INVALID_STATUS', 422); return }
    // SoD 自审拦截（提升进具名守卫，判定与响应逐字节不变）：不能审核自己提交的修正提案。
    if (!assertNotSelfReview(res, { submitterId: row.operator, actorId: operator, message: '不能审核自己提交的修正提案' })) return

    const effectiveScope = req.body?.effectiveScope === 'retroactive' ? 'retroactive' : 'future_only'
    const bomId = row.applied_bom_id
    const materialId = row.material_id

    db.exec('BEGIN IMMEDIATE')
    try {
      const item = db.prepare('SELECT usage_per_sample FROM bom_items WHERE bom_id = ? AND material_id = ?').get(bomId, materialId) as any
      if (!item) { db.exec('ROLLBACK'); error(res, '该物料已不在 BOM 标准内', 'NOT_FOUND', 404); return }
      // 乐观锁：现值须与提案时一致，否则提示重新核对
      if (Number(item.usage_per_sample) !== Number(row.old_value)) {
        db.exec('ROLLBACK')
        error(res, '标准用量已被他人改动，请重新核对后再提交', 'RESOURCE_CONFLICT', 409); return
      }
      const previousSnapshot = getLatestBomVersionSnapshot(db, bomId) || buildBomVersionSnapshot(db, bomId)
      // 写回标准 + 升版本
      db.prepare('UPDATE bom_items SET usage_per_sample = ? WHERE bom_id = ? AND material_id = ?')
        .run(Number(row.proposed_usage), bomId, materialId)
      const bom = db.prepare('SELECT version FROM boms WHERE id = ?').get(bomId) as any
      const vp = String(bom?.version || 'v1.0').replace('v', '').split('.').map(Number)
      const newVersion = `v${vp[0] || 1}.${(vp[1] || 0) + 1}`
      db.prepare('UPDATE boms SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newVersion, bomId)
      writeBomVersionSnapshot(db, bomId, previousSnapshot, operator, { effectiveScope })
      db.prepare(`UPDATE reconciliation_logs SET status = 'applied', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(operator, req.params.id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK'); throw e
    }

    // —— 追溯重算编排（仅 retroactive；future_only 完全不动历史）——
    // 已关账月不重算（recalculable=false），由调用方走关账后调整单。
    let retroactive: any = null
    if (effectiveScope === 'retroactive') {
      const impact = buildBomChangeImpact(db, bomId)
      // 仅对未关账月触发受控重算；已关账月跳过（须走调整单）。复用黄金钉死的 runCostRecalculation。
      const runs = impact.months
        .filter((m: any) => m.recalculable)
        .map((m: any) => runCostRecalculation(db, m.yearMonth, operator, 'bom_retroactive_recalculate'))
      retroactive = {
        affectedMonths: impact.affectedMonthCount,
        recalculatedMonths: impact.recalculableMonthCount,
        closedMonths: impact.closedMonthCount,
        requiresAdjustment: impact.closedMonthCount > 0,
        runIds: runs.map((r: any) => r?.runId || r?.id).filter(Boolean),
      }
    }

    success(res, { id: req.params.id, status: 'applied', effectiveScope, retroactive }, '修正已审核通过并生效')
  } catch (e: any) {
    error(res, e.message || '审核失败')
  }
})

/**
 * POST /api/v1/reconciliation/logs/:id/reject
 * 驳回/撤回修正提案（提交人可自行撤回，审核人可驳回；不动 bom_items）。
 */
router.post('/logs/:id/reject', requireReconcileApprove, (req, res) => {
  try {
    const db = getDatabase()
    const operator = (req as any).user?.username || 'system'
    const row = db.prepare('SELECT * FROM reconciliation_logs WHERE id = ?').get(req.params.id) as any
    if (!row) { error(res, '提案不存在', 'NOT_FOUND', 404); return }
    if (row.type !== 'bom_fix_proposal') { error(res, '该记录不是可审核的修正提案', 'INVALID_STATUS', 422); return }
    if (row.status !== 'pending') { error(res, '只有待审核提案可以驳回', 'INVALID_STATUS', 422); return }
    db.prepare(`UPDATE reconciliation_logs SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(operator, req.params.id)
    success(res, { id: req.params.id, status: 'rejected' }, '修正提案已驳回')
  } catch (e: any) {
    error(res, e.message || '驳回失败')
  }
})

export default router
