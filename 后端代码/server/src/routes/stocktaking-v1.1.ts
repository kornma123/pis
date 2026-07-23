import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { error, success, successList } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  assertInventoryConserved,
  inventoryErrorResponse,
  inventoryQuantityDelta,
  parseInventoryQuantity,
} from '../services/inventory-transactions.js'

const router = Router()
const requireStocktakingWrite = requirePermission('stocktaking', 'W')

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `ST-${date}-${timestamp}-${random}`
}

function generateSheetNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `STS-${date}-${timestamp}-${random}`
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, keyword } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) {
      where += ' AND stocktaking_no LIKE ?'
      params.push(`%${keyword}%`)
    }
    const count = (db.prepare(`SELECT COUNT(*) AS total FROM stocktaking_records WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`
      SELECT * FROM stocktaking_records
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(pageSize), offset) as any[]
    successList(res, list.map((row) => ({
      id: row.id,
      stocktakingNo: row.stocktaking_no,
      sheetNo: row.sheet_no,
      materialId: row.material_id,
      systemStock: row.system_stock,
      actualStock: row.actual_stock,
      difference: row.difference,
      operator: row.operator,
      status: row.status,
      remark: row.remark,
      createdAt: row.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireStocktakingWrite, (req, res) => {
  try {
    const { materialId, actualStock, operator, remark } = req.body
    if (!materialId || actualStock === undefined) {
      error(res, 'Missing fields', 'INVALID_PARAMETER', 400); return
    }
    const normalizedActualStock = parseInventoryQuantity(actualStock)
    const db = getDatabase()
    if (!db.prepare('SELECT id FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)) {
      error(res, 'Material not found', 'NOT_FOUND', 404); return
    }
    const systemStock = assertInventoryConserved(db, materialId)
    const difference = inventoryQuantityDelta(normalizedActualStock, systemStock)
    const status = difference === 0 ? 'completed' : 'pending'
    const id = uuidv4()
    db.prepare(`
      INSERT INTO stocktaking_records
        (id, stocktaking_no, material_id, system_stock, actual_stock, difference, operator, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, generateNo(), materialId, systemStock, normalizedActualStock, difference, operator || 'system', status, remark || null)
    success(res, { id, status }, 'Stocktaking draft created')
  } catch (err: any) {
    const failure = inventoryErrorResponse(err)
    if (failure) { error(res, failure.message, failure.code, failure.status); return }
    error(res, err.message)
  }
})

router.post('/batch', requireStocktakingWrite, (req, res) => {
  try {
    const { items, operator, remark } = req.body
    if (!Array.isArray(items) || items.length === 0) {
      error(res, 'Stocktaking items cannot be empty', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const seen = new Set<string>()
    const plan: Array<{ materialId: string; actualStock: number; systemStock: number; remark?: string }> = []
    for (const item of items) {
      if (!item || typeof item !== 'object' || !item.materialId || item.actualStock === undefined || seen.has(item.materialId)) {
        error(res, 'Invalid or duplicate stocktaking item', 'INVALID_PARAMETER', 422); return
      }
      seen.add(item.materialId)
      if (!db.prepare('SELECT id FROM materials WHERE id = ? AND is_deleted = 0').get(item.materialId)) {
        error(res, 'Material not found', 'NOT_FOUND', 422); return
      }
      const actual = parseInventoryQuantity(item.actualStock)
      const system = assertInventoryConserved(db, item.materialId)
      if (inventoryQuantityDelta(actual, system) !== 0) {
        error(res, 'Batch-level stocktaking detail is required for an inventory adjustment', 'BATCH_DETAIL_REQUIRED', 422)
        return
      }
      plan.push({ materialId: item.materialId, actualStock: actual, systemStock: system, remark: item.remark })
    }
    const sheetNo = generateSheetNo()
    const ids: string[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of plan) {
        const current = assertInventoryConserved(db, item.materialId)
        if (inventoryQuantityDelta(current, item.systemStock) !== 0) {
          error(res, 'Inventory changed before stocktaking was recorded', 'STOCK_CHANGED', 409)
          db.exec('ROLLBACK')
          return
        }
        const id = uuidv4()
        ids.push(id)
        db.prepare(`
          INSERT INTO stocktaking_records
            (id, stocktaking_no, sheet_no, material_id, system_stock, actual_stock, difference, operator, status, remark)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'completed', ?)
        `).run(id, generateNo(), sheetNo, item.materialId, item.systemStock, item.actualStock, operator || 'system', item.remark || remark || null)
      }
      db.exec('COMMIT')
      success(res, { sheetNo, count: ids.length, ids }, 'Stocktaking batch recorded', 201)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err: any) {
    const failure = inventoryErrorResponse(err)
    if (failure) { error(res, failure.message, failure.code, failure.status); return }
    error(res, err.message)
  }
})

router.post('/:id/adjust', requireStocktakingWrite, (req, res) => {
  try {
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Stocktaking record not found', 'NOT_FOUND', 404); return }
    if (record.status !== 'pending') {
      error(res, 'Stocktaking record is not pending', 'ALREADY_ADJUSTED', 400); return
    }
    assertInventoryConserved(db, record.material_id)
    error(
      res,
      'Batch-level stocktaking detail is required before this adjustment can be applied',
      'BATCH_DETAIL_REQUIRED',
      422,
    )
  } catch (err: any) {
    const failure = inventoryErrorResponse(err)
    if (failure) { error(res, failure.message, failure.code, failure.status); return }
    error(res, err.message)
  }
})

router.delete('/:id', requireStocktakingWrite, (req, res) => {
  try {
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Stocktaking record not found', 'NOT_FOUND', 404); return }
    if (Number(record.difference) !== 0 && record.status !== 'pending') {
      error(res, 'Historical stocktaking adjustment has no batch allocation fact', 'ALLOCATION_NOT_FOUND', 409)
      return
    }
    db.prepare('UPDATE stocktaking_records SET is_deleted = 1 WHERE id = ?').run(req.params.id)
    success(res, null, 'Stocktaking record cancelled')
  } catch (err: any) { error(res, err.message) }
})

export default router
