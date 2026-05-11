import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `RT-${date}-${random}`
}

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query
    const db = getDatabase()
    const count = (db.prepare('SELECT COUNT(*) as total FROM return_records').get() as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare('SELECT * FROM return_records ORDER BY created_at DESC LIMIT ? OFFSET ?').all(Number(pageSize), offset) as any[]
    successList(res, list.map((r: any) => ({
      id: r.id, returnNo: r.return_no, materialId: r.material_id,
      quantity: r.quantity, reason: r.reason, operator: r.operator,
      status: r.status, remark: r.remark, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { materialId, quantity, reason, operator, remark } = req.body
    if (!materialId || !quantity || !reason) { error(res, 'Missing fields', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const id = uuidv4()
    db.prepare('INSERT INTO return_records (id, return_no, material_id, quantity, reason, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, generateNo(), materialId, quantity, reason, operator || 'system', remark || null)
    db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(quantity, materialId)
    success(res, { id }, 'Return created')
  } catch (err: any) { error(res, err.message) }
})

export default router
