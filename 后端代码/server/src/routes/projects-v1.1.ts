import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { closeDatabase, getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import { findProjectLiveReferences, recoverFailedDeleteTransaction } from '../utils/delete-reference-guards.js'

const router = Router()

// 项目写入权限：仅 admin 可操作
const requireProjectWrite = requirePermission('projects', 'W')

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, type, status, keyword, bomFilter } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (type) { where += ' AND type = ?'; params.push(type) }
    if (status) { where += ' AND status = ?'; params.push(status === 'active' ? 1 : 0) }
    if (keyword) { where += ' AND (name LIKE ? OR code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    if (bomFilter === 'configured') { where += ' AND bom_id IS NOT NULL' }
    if (bomFilter === 'unconfigured') { where += ' AND bom_id IS NULL' }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM projects WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM projects WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, code: r.code, name: r.name, type: r.type, cycle: r.cycle,
      bomId: r.bom_id, supportableSamples: r.supportable_samples,
      status: r.status === 1 ? 'active' : 'inactive', manager: r.manager,
      description: r.description, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM projects WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!row) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const costStats = db.prepare(`
      SELECT SUM(total_cost) as total_cost, COUNT(DISTINCT id) as sample_count
      FROM outbound_records WHERE project_id = ? AND status = 'completed' AND is_deleted = 0
    `).get(id) as any

    success(res, {
      id: row.id, code: row.code, name: row.name, type: row.type, cycle: row.cycle,
      bomId: row.bom_id, supportableSamples: row.supportable_samples,
      status: row.status === 1 ? 'active' : 'inactive', manager: row.manager,
      description: row.description,
      costStats: {
        totalCost: costStats?.total_cost || 0,
        sampleCount: costStats?.sample_count || 0,
        unitCost: costStats?.sample_count > 0 ? (costStats.total_cost / costStats.sample_count) : 0,
      },
      createdAt: row.created_at,
    })
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireProjectWrite, (req, res) => {
  try {
    const { code, name, type, cycle, manager, description } = req.body
    if (!code || !name || !type) { error(res, 'Code, name and type required', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()
    db.prepare('INSERT INTO projects (id, code, name, type, cycle, manager, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, code, name, type, cycle || null, manager || null, description || null)
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
    success(res, {
      id: row.id, code: row.code, name: row.name, type: row.type, cycle: row.cycle,
      bomId: row.bom_id, supportableSamples: row.supportable_samples,
      status: row.status === 1 ? 'active' : 'inactive', manager: row.manager,
      description: row.description, createdAt: row.created_at,
    }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', requireProjectWrite, (req, res) => {
  try {
    const { id } = req.params
    const data = req.body
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM projects WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    if (data.code === '' || data.code === null || data.code === undefined ||
        data.name === '' || data.name === null || data.name === undefined ||
        data.type === '' || data.type === null || data.type === undefined) {
      error(res, 'Code, name and type cannot be empty', 'INVALID_PARAMETER', 400); return
    }
    const fields: string[] = []; const params: any[] = []
    if (data.code !== undefined) { fields.push('code = ?'); params.push(data.code) }
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type) }
    if (data.cycle !== undefined) { fields.push('cycle = ?'); params.push(data.cycle) }
    if (data.manager !== undefined) { fields.push('manager = ?'); params.push(data.manager) }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description) }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status === 'active' ? 1 : 0) }
    if (fields.length > 0) { params.push(id); db.prepare(`UPDATE projects SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params) }
    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', requireProjectWrite, (req, res) => {
  let db: ReturnType<typeof getDatabase> | undefined
  let transactionOpen = false
  try {
    const { id } = req.params
    db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const existing = db.prepare('SELECT * FROM projects WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Not found', 'NOT_FOUND', 404)
      return
    }
    if (findProjectLiveReferences(db, id).length > 0) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Project has active outbound or cost exception references', 'ENTITY_IN_USE', 409)
      return
    }
    db.prepare('UPDATE projects SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    db.exec('COMMIT')
    transactionOpen = false
    success(res, null, 'Deleted')
  } catch (err: any) {
    if (db && transactionOpen && !recoverFailedDeleteTransaction(db, closeDatabase)) {
      error(res, 'Delete transaction recovery failed', 'INTERNAL_ERROR', 500)
      return
    }
    error(res, err.message)
  }
})

export default router
