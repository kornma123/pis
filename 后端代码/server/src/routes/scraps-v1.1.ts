import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `SC-${date}-${timestamp}-${random}`
}

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query
    const db = getDatabase()
    const count = (db.prepare('SELECT COUNT(*) as total FROM scrap_records WHERE is_deleted = 0').get() as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare('SELECT * FROM scrap_records WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?').all(Number(pageSize), offset) as any[]
    successList(res, list.map((r: any) => ({
      id: r.id, scrapNo: r.scrap_no, materialId: r.material_id,
      quantity: r.quantity, reason: r.reason, operator: r.operator,
      status: r.status, remark: r.remark, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { materialId, quantity, reason, operator, remark } = req.body
    if (!materialId || quantity === undefined || quantity === null || isNaN(Number(quantity)) || Number(quantity) <= 0 || !reason) {
      error(res, 'Missing or invalid fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }
    const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
    if (!inv || inv.stock < quantity) { error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      const id = uuidv4()
      db.prepare('INSERT INTO scrap_records (id, scrap_no, material_id, quantity, reason, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, generateNo(), materialId, quantity, reason, operator || 'system', remark || null)
      db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(quantity, materialId)

      // 负库存兜底
      const afterCheck = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock
      if (afterCheck < 0) {
        db.exec('ROLLBACK')
        error(res, '库存不能为负数', 'STOCK_NEGATIVE', 422)
        return
      }

      const afterStock = (inv?.stock || 0) - quantity
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'scrap', ?, ?, ?, ?, ?, 'scrap', ?)
      `).run(logId, materialId, -quantity, inv?.stock || 0, afterStock, id, operator || 'system')

      db.exec('COMMIT')
      success(res, { id }, 'Scrap created')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM scrap_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE scrap_records SET is_deleted = 1 WHERE id = ?').run(id)

      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any
      const beforeStock = inv?.stock || 0
      const afterStock = beforeStock + record.quantity
      db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(afterStock, record.material_id)

      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'scrap_cancel', ?, '撤销报废记录')
      `).run(logId, record.material_id, record.quantity, beforeStock, afterStock, id, req.body.operator || 'system')

      db.exec('COMMIT')
      success(res, null, '报废记录已撤销')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
