import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) { where += ' AND (username LIKE ? OR real_name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM users WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT id, username, real_name, role, department, phone, email, status, created_at FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, username: r.username, realName: r.real_name,
      role: r.role, department: r.department, phone: r.phone,
      email: r.email, status: r.status === 1 ? 'active' : 'inactive',
      createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { username, password, realName, role, department, phone } = req.body
    if (!username || !password || !realName) { error(res, 'Username, password and realName required', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()
    const hashedPassword = bcrypt.hashSync(password, 12)
    db.prepare('INSERT INTO users (id, username, password, real_name, role, department, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, username, hashedPassword, realName, role || 'operator', department || null, phone || null)
    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Username exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params
    const data = req.body
    const db = getDatabase()
    const fields: string[] = []; const params: any[] = []
    if (data.realName !== undefined) { fields.push('real_name = ?'); params.push(data.realName) }
    if (data.role !== undefined) { fields.push('role = ?'); params.push(data.role) }
    if (data.department !== undefined) { fields.push('department = ?'); params.push(data.department) }
    if (data.phone !== undefined) { fields.push('phone = ?'); params.push(data.phone) }
    if (data.email !== undefined) { fields.push('email = ?'); params.push(data.email) }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status === 'active' ? 1 : 0) }
    if (data.password) { fields.push('password = ?'); params.push(bcrypt.hashSync(data.password, 12)) }
    if (fields.length > 0) { params.push(id); db.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params) }
    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    db.prepare('UPDATE users SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
