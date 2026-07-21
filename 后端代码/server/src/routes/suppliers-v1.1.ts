import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { closeDatabase, getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { findSupplierLiveReferences, recoverFailedDeleteTransaction } from '../utils/delete-reference-guards.js'

const router = Router()

const requireSupplierRead = requirePermission('suppliers', 'R')
const requireSupplierWrite = requirePermission('suppliers', 'W')

router.get('/', authenticateToken, requireSupplierRead, (req, res) => {
  try {
    let { page = 1, pageSize = 20, keyword, status } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) { where += ' AND (name LIKE ? OR code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    if (status) { where += ' AND status = ?'; params.push(status === 'active' ? 1 : 0) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM suppliers WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM suppliers WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, code: r.code, name: r.name, contact: r.contact, phone: r.phone,
      email: r.email, address: r.address, status: r.status === 1 ? 'active' : 'inactive',
      cooperationCount: r.cooperation_count, totalAmount: r.total_amount, rating: r.rating,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

function generateSupplierCode(db: any): string {
  const max = db.prepare("SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) as max FROM suppliers WHERE code LIKE 'SUP-%'").get() as any
  let num = (Number(max?.max) || 0) + 1
  if (num <= 0) num = 11
  let code = `SUP-${String(num).padStart(5, '0')}`
  while (db.prepare('SELECT 1 FROM suppliers WHERE code = ?').get(code)) {
    num++
    code = `SUP-${String(num).padStart(5, '0')}`
  }
  return code
}

router.post('/', authenticateToken, requireSupplierWrite, (req, res) => {
  try {
    const { name, contact, phone, email, address } = req.body
    if (!name) { error(res, 'Name required', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()
    const finalCode = generateSupplierCode(db)
    db.prepare('INSERT INTO suppliers (id, code, name, contact, phone, email, address, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, finalCode, name, contact || null, phone || null, email || null, address || null)
    success(res, { id, code: finalCode }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', authenticateToken, requireSupplierWrite, (req, res) => {
  try {
    const { id } = req.params
    const data = req.body
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    const fields: string[] = []; const params: any[] = []
    if (data.code !== undefined) { fields.push('code = ?'); params.push(data.code) }
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
    if (data.contact !== undefined) { fields.push('contact = ?'); params.push(data.contact) }
    if (data.phone !== undefined) { fields.push('phone = ?'); params.push(data.phone) }
    if (data.email !== undefined) { fields.push('email = ?'); params.push(data.email) }
    if (data.address !== undefined) { fields.push('address = ?'); params.push(data.address) }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status === 'active' ? 1 : 0) }
    if (fields.length > 0) { params.push(id); db.prepare(`UPDATE suppliers SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params) }
    success(res, { id }, 'Updated')
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.delete('/:id', authenticateToken, requireSupplierWrite, (req, res) => {
  let db: ReturnType<typeof getDatabase> | undefined
  let transactionOpen = false
  try {
    const { id } = req.params
    db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Not found', 'NOT_FOUND', 404)
      return
    }
    // 锁内重读：committed-race 防线
    if (findSupplierLiveReferences(db, id).length > 0) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Supplier has active purchase, inbound, or return references', 'ENTITY_IN_USE', 409)
      return
    }
    db.prepare('UPDATE suppliers SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    db.exec('COMMIT')
    transactionOpen = false
    success(res, null, 'Deleted')
  } catch (err: any) {
    if (transactionOpen && db) {
      if (!recoverFailedDeleteTransaction(db, closeDatabase)) {
        error(res, 'Delete transaction recovery failed', 'INTERNAL_ERROR', 500)
        return
      }
    }
    error(res, err.message)
  }
})

export default router
