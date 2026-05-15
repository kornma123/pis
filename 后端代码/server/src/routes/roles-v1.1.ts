import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { v4 as uuidv4 } from 'uuid'

const router = Router()

router.get('/', (req, res) => {
  const database = getDatabase()
  const page = Number(req.query.page) || 1
  const pageSize = Number(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize

  const stmt = database.prepare('SELECT * FROM roles WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?')
  const list = (stmt.all(pageSize, offset) as any[]).map((r: any) => ({
    ...r,
    permissions: (() => {
      try { return JSON.parse(r.permissions || '[]') } catch { return [] }
    })()
  }))

  const countStmt = database.prepare('SELECT COUNT(*) as total FROM roles WHERE is_deleted = 0')
  const { total } = countStmt.get() as any

  successList(res, list, page, pageSize, total)
})

router.post('/', (req, res) => {
  try {
    const database = getDatabase()
    const { code, name, description, permissions, status } = req.body
    if (!code || !name) { error(res, 'Code and name required', 'INVALID_PARAMETER', 400); return }
    const exists = database.prepare('SELECT 1 FROM roles WHERE code = ? AND is_deleted = 0').get(code)
    if (exists) { error(res, 'Role code already exists', 'RESOURCE_CONFLICT', 409); return }
    const id = uuidv4()
    database.prepare('INSERT INTO roles (id, code, name, description, permissions, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, code, name, description || '', JSON.stringify(permissions || []), status === 'active' ? 1 : 0)
    success(res, { id }, 'Created')
  } catch (err: any) { error(res, err.message) }
})

router.put('/:id', (req, res) => {
  try {
    const database = getDatabase()
    const { id } = req.params
    const { code, name, description, permissions, status } = req.body
    const role = database.prepare('SELECT 1 FROM roles WHERE id = ? AND is_deleted = 0').get(id)
    if (!role) { error(res, 'Role not found', 'NOT_FOUND', 404); return }
    database.prepare('UPDATE roles SET code = ?, name = ?, description = ?, permissions = ?, status = ? WHERE id = ?')
      .run(code, name, description || '', JSON.stringify(permissions || []), status === 'active' ? 1 : 0, id)
    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', (req, res) => {
  const database = getDatabase()
  const { id } = req.params
  database.prepare('UPDATE roles SET is_deleted = 1 WHERE id = ?').run(id)
  success(res, { id }, 'Deleted')
})

export default router
