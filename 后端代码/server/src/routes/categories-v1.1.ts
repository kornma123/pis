import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requireRole } from '../middleware/auth.js'

const router = Router()

// 物料分类写入权限：仅 admin / warehouse_manager / procurement 可操作
const requireCategoryWrite = requireRole('admin', 'warehouse_manager', 'procurement')

router.get('/tree', (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT id, code, name, parent_id as parentId, level, sort_order as sortOrder, status
      FROM material_categories
      WHERE is_deleted = 0
      ORDER BY level, sort_order, created_at
    `).all() as any[]

    const buildTree = (parentId: string | null): any[] => {
      return rows
        .filter((r: any) => (r.parentId || null) === parentId)
        .map((r: any) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          level: r.level,
          sortOrder: r.sortOrder,
          status: r.status === 1 ? 'active' : 'inactive',
          children: buildTree(r.id),
          isLeaf: !rows.some((child: any) => child.parentId === r.id),
          count: (db.prepare('SELECT COUNT(*) as count FROM materials WHERE category_id = ? AND is_deleted = 0').get(r.id) as any)?.count || 0,
        }))
    }

    success(res, buildTree(null))
  } catch (err: any) {
    error(res, err.message)
  }
})

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query
    const db = getDatabase()
    let sql = 'SELECT * FROM material_categories WHERE is_deleted = 0'
    const params: any[] = []

    if (keyword) {
      sql += ' AND (name LIKE ? OR code LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`)
    }

    sql += ' ORDER BY level, sort_order, created_at'

    const count = (db.prepare(`SELECT COUNT(*) as total FROM material_categories WHERE is_deleted = 0${keyword ? ' AND (name LIKE ? OR code LIKE ?)' : ''}`).get(...params) as any)?.total || 0

    const offset = (Number(page) - 1) * Number(pageSize)
    sql += ' LIMIT ? OFFSET ?'
    params.push(Number(pageSize), offset)

    const list = db.prepare(sql).all(...params) as any[]

    successList(res, list.map((row: any) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      parentId: row.parent_id,
      level: row.level,
      sortOrder: row.sort_order,
      status: row.status === 1 ? 'active' : 'inactive',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) {
    error(res, err.message)
  }
})

function generateCategoryCode(db: any, parentId: string | null, level: number): string {
  if (!parentId) {
    const max = db.prepare('SELECT MAX(CAST(code AS INTEGER)) as max FROM material_categories WHERE parent_id IS NULL').get() as any
    return String((max?.max || 0) + 100)
  } else {
    const parent = db.prepare('SELECT code FROM material_categories WHERE id = ?').get(parentId) as any
    const prefix = Math.floor(Number(parent.code) / 100) * 100
    const max = db.prepare('SELECT MAX(CAST(code AS INTEGER)) as max FROM material_categories WHERE parent_id = ? AND CAST(code AS INTEGER) < ?').get(parentId, prefix + 100) as any
    return String((max?.max || prefix) + 1)
  }
}

router.post('/', requireCategoryWrite, (req, res) => {
  try {
    const { name, parentId, level, sortOrder = 0 } = req.body
    if (!name || !level) {
      error(res, 'Name and level required', 'INVALID_PARAMETER', 400)
      return
    }

    const db = getDatabase()
    const id = uuidv4()
    const finalCode = generateCategoryCode(db, parentId || null, level)

    db.prepare(`
      INSERT INTO material_categories (id, code, name, parent_id, level, sort_order, status)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(id, finalCode, name, parentId || null, level, sortOrder)

    success(res, { id, code: finalCode, name, parentId, level, status: 'active' }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint failed')) {
      error(res, 'Code already exists', 'RESOURCE_CONFLICT', 409)
      return
    }
    error(res, err.message)
  }
})

router.put('/:id', requireCategoryWrite, (req, res) => {
  try {
    const { id } = req.params
    const { code, name, parentId, level, sortOrder, status } = req.body

    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM material_categories WHERE id = ?').get(id) as any
    if (!existing) {
      error(res, 'Not found', 'NOT_FOUND', 404)
      return
    }

    const fields: string[] = []
    const params: any[] = []

    if (code !== undefined) { fields.push('code = ?'); params.push(code) }
    if (name !== undefined) { fields.push('name = ?'); params.push(name) }
    if (parentId !== undefined) { fields.push('parent_id = ?'); params.push(parentId || null) }
    if (level !== undefined) { fields.push('level = ?'); params.push(level) }
    if (sortOrder !== undefined) { fields.push('sort_order = ?'); params.push(sortOrder) }
    if (status !== undefined) { fields.push('status = ?'); params.push(status === 'active' ? 1 : 0) }

    if (fields.length > 0) {
      params.push(id)
      db.prepare(`UPDATE material_categories SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params)
    }

    success(res, { id }, 'Updated')
  } catch (err: any) {
    error(res, err.message)
  }
})

router.delete('/:id', requireCategoryWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()

    const hasChildren = (db.prepare('SELECT COUNT(*) as count FROM material_categories WHERE parent_id = ? AND is_deleted = 0').get(id) as any)?.count > 0
    if (hasChildren) {
      error(res, 'Has children', 'CONFLICT', 409)
      return
    }

    const hasMaterials = (db.prepare('SELECT COUNT(*) as count FROM materials WHERE category_id = ? AND is_deleted = 0').get(id) as any)?.count > 0
    if (hasMaterials) {
      error(res, 'Has materials', 'CONFLICT', 409)
      return
    }

    db.prepare('UPDATE material_categories SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    success(res, null, 'Deleted')
  } catch (err: any) {
    error(res, err.message)
  }
})

export default router
