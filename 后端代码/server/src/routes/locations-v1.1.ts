import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken, requireRole } from '../middleware/auth.js'

const router = Router()

const requireLocationRead = requireRole('admin', 'warehouse_manager')
const requireLocationWrite = requireRole('admin', 'warehouse_manager')

router.get('/', authenticateToken, requireLocationRead, (req, res) => {
  try {
    const { page = 1, pageSize = 20, zone, status, type } = req.query
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (zone) { where += ' AND zone = ?'; params.push(zone) }
    if (type) { where += ' AND type = ?'; params.push(type) }
    if (status) { where += ' AND status = ?'; params.push(status === 'active' ? 1 : 0) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM locations WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM locations WHERE ${where} ORDER BY zone, name LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, code: r.code, name: r.name, type: r.type, parentId: r.parent_id, zone: r.zone, shelf: r.shelf, position: r.position,
      capacity: r.capacity, used: r.used, status: r.status === 1 ? 'active' : 'inactive',
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/tree', authenticateToken, requireLocationRead, (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT id, code, name, type, parent_id as parentId, zone, shelf, position FROM locations WHERE is_deleted = 0 ORDER BY zone, name').all() as any[]

    const buildTree = (parentId: string | null): any[] => {
      return rows
        .filter((r: any) => (r.parentId || null) === parentId)
        .map((r: any) => ({
          id: r.id, code: r.code, name: r.name, type: r.type, zone: r.zone,
          children: buildTree(r.id),
          isLeaf: !rows.some((child: any) => child.parentId === r.id),
        }))
    }

    success(res, buildTree(null))
  } catch (err: any) { error(res, err.message) }
})

function generateLocationCode(db: any): string {
  const max = db.prepare("SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) as max FROM locations WHERE code LIKE 'LOC-%'").get() as any
  const num = (Number(max?.max) || 0) + 1
  return `LOC-${String(num).padStart(5, '0')}`
}

router.post('/', authenticateToken, requireLocationWrite, (req, res) => {
  try {
    const { name, type, parentId, zone, shelf, position, capacity } = req.body
    if (!name || !zone) { error(res, 'Name and zone required', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()
    const finalCode = generateLocationCode(db)
    db.prepare('INSERT INTO locations (id, code, name, type, parent_id, zone, shelf, position, capacity, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, finalCode, name, type || 'shelf', parentId || null, zone, shelf || null, position || null, capacity || 999999)
    success(res, { id, code: finalCode }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', authenticateToken, requireLocationWrite, (req, res) => {
  try {
    const { id } = req.params
    const data = req.body
    const db = getDatabase()
    const fields: string[] = []; const params: any[] = []
    if (data.code !== undefined) { fields.push('code = ?'); params.push(data.code) }
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type) }
    if (data.parentId !== undefined) { fields.push('parent_id = ?'); params.push(data.parentId || null) }
    if (data.zone !== undefined) { fields.push('zone = ?'); params.push(data.zone) }
    if (data.shelf !== undefined) { fields.push('shelf = ?'); params.push(data.shelf) }
    if (data.position !== undefined) { fields.push('position = ?'); params.push(data.position) }
    if (data.capacity !== undefined) { fields.push('capacity = ?'); params.push(data.capacity) }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status === 'active' ? 1 : 0) }
    if (fields.length > 0) { params.push(id); db.prepare(`UPDATE locations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params) }
    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', authenticateToken, requireLocationWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM locations WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    db.prepare('UPDATE locations SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
