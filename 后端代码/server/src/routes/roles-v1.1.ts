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
    database.exec('BEGIN IMMEDIATE')
    const role = database.prepare('SELECT * FROM roles WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!role) {
      database.exec('ROLLBACK')
      error(res, 'Role not found', 'NOT_FOUND', 404); return
    }
    if (role.code === 'admin') {
      database.exec('ROLLBACK')
      error(res, 'Cannot modify system admin role', 'FORBIDDEN', 403); return
    }
    const fields: string[] = []; const params: any[] = []
    if (code !== undefined) {
      if (code !== role.code) {
        const codeExists = database.prepare('SELECT 1 FROM roles WHERE code = ? AND id != ? AND is_deleted = 0').get(code, id)
        if (codeExists) {
          database.exec('ROLLBACK')
          error(res, 'Role code already exists', 'RESOURCE_CONFLICT', 409); return
        }
      }
      fields.push('code = ?'); params.push(code)
    }
    if (name !== undefined) { fields.push('name = ?'); params.push(name) }
    if (description !== undefined) { fields.push('description = ?'); params.push(description || '') }
    if (permissions !== undefined) { fields.push('permissions = ?'); params.push(JSON.stringify(permissions || [])) }
    if (status !== undefined) { fields.push('status = ?'); params.push(status === 'active' ? 1 : 0) }
    if (fields.length > 0) {
      params.push(id)
      database.prepare(`UPDATE roles SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params)
    }
    database.exec('COMMIT')
    success(res, { id }, 'Updated')
  } catch (err: any) {
    try { getDatabase().exec('ROLLBACK') } catch {}
    error(res, err.message)
  }
})

router.delete('/:id', (req, res) => {
  try {
    const database = getDatabase()
    const { id } = req.params
    const existing = database.prepare('SELECT * FROM roles WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    if (existing.code === 'admin') { error(res, 'Cannot delete system admin role', 'FORBIDDEN', 403); return }
    database.prepare('UPDATE roles SET is_deleted = 1 WHERE id = ?').run(id)
    success(res, { id }, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
