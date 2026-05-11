import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList } from '../utils/response.js'
import { v4 as uuidv4 } from 'uuid'

const router = Router()

router.get('/', (req, res) => {
  const database = getDatabase()
  const page = Number(req.query.page) || 1
  const pageSize = Number(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize

  const stmt = database.prepare('SELECT * FROM roles WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?')
  const list = stmt.all(pageSize, offset)

  const countStmt = database.prepare('SELECT COUNT(*) as total FROM roles WHERE is_deleted = 0')
  const { total } = countStmt.get() as any

  successList(res, list, page, pageSize, total)
})

router.post('/', (req, res) => {
  const database = getDatabase()
  const { code, name, description, permissions, status } = req.body
  const id = uuidv4()
  database.prepare('INSERT INTO roles (id, code, name, description, permissions, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, code, name, description || '', JSON.stringify(permissions || []), status === 'active' ? 1 : 0)
  success(res, { id }, 'Created')
})

router.put('/:id', (req, res) => {
  const database = getDatabase()
  const { id } = req.params
  const { code, name, description, permissions, status } = req.body
  database.prepare('UPDATE roles SET code = ?, name = ?, description = ?, permissions = ?, status = ? WHERE id = ?')
    .run(code, name, description || '', JSON.stringify(permissions || []), status === 'active' ? 1 : 0, id)
  success(res, { id }, 'Updated')
})

router.delete('/:id', (req, res) => {
  const database = getDatabase()
  const { id } = req.params
  database.prepare('UPDATE roles SET is_deleted = 1 WHERE id = ?').run(id)
  success(res, { id }, 'Deleted')
})

export default router
