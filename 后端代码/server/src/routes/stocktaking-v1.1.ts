import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `ST-${date}-${timestamp}-${random}`
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20 } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    const count = (db.prepare('SELECT COUNT(*) as total FROM stocktaking_records').get() as any)?.total || 0
    const offset = (page - 1) * pageSize
    const list = db.prepare('SELECT * FROM stocktaking_records ORDER BY created_at DESC LIMIT ? OFFSET ?').all(pageSize, offset) as any[]
    successList(res, list.map((r: any) => ({
      id: r.id, stocktakingNo: r.stocktaking_no, materialId: r.material_id,
      systemStock: r.system_stock, actualStock: r.actual_stock,
      difference: r.difference, operator: r.operator, status: r.status,
      remark: r.remark, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { materialId, actualStock, operator, remark } = req.body
    if (!materialId || actualStock === undefined) { error(res, 'Missing fields', 'INVALID_PARAMETER', 400); return }
    if (isNaN(Number(actualStock))) { error(res, 'Invalid actual stock', 'INVALID_PARAMETER', 400); return }
    if (Number(actualStock) < 0) { error(res, 'actualStock 不能为负数', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const material = db.prepare('SELECT 1 FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }
    const systemStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock || 0
    const difference = actualStock - systemStock
    const id = uuidv4()
    db.prepare('INSERT INTO stocktaking_records (id, stocktaking_no, material_id, system_stock, actual_stock, difference, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, generateNo(), materialId, systemStock, actualStock, difference, operator || 'system', remark || null)

    if (difference !== 0) {
      db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(actualStock, materialId)
      const logId = uuidv4()
      db.prepare('INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(logId, 'adjust', materialId, difference, systemStock, actualStock, id, 'stocktaking', operator || 'system')
    }

    success(res, { id }, 'Stocktaking done')
  } catch (err: any) { error(res, err.message) }
})

export default router
