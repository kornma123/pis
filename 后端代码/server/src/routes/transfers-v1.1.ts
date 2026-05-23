import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

// 获取调拨记录列表
router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query
    const db = getDatabase()
    const count = (db.prepare("SELECT COUNT(*) as total FROM inbound_records WHERE type = 'transfer' AND is_deleted = 0").get() as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`
      SELECT i.*, m.name as material_name, l.name as location_name
      FROM inbound_records i
      LEFT JOIN materials m ON i.material_id = m.id AND m.is_deleted = 0
      LEFT JOIN locations l ON i.location_id = l.id AND l.is_deleted = 0
      WHERE i.type = 'transfer' AND i.is_deleted = 0
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `).all(Number(pageSize), offset) as any[]
    successList(res, list.map((r: any) => ({
      id: r.id, inboundNo: r.inbound_no, materialId: r.material_id, materialName: r.material_name,
      batchNo: r.batch_no, quantity: r.quantity, locationId: r.location_id, locationName: r.location_name,
      operator: r.operator, status: r.status, remark: r.remark, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

// 新增调拨入库
router.post('/inbound', (req, res) => {
  try {
    const { materialId, batchNo, quantity, fromLocationId, fromLocationName, toLocationId, operator, remark } = req.body
    if (!materialId || !toLocationId || quantity === undefined || quantity === null || isNaN(Number(quantity)) || Number(quantity) <= 0) {
      error(res, '物料、目标库位和数量必填', 'INVALID_PARAMETER', 400)
      return
    }
    if (!fromLocationId && !fromLocationName) {
      error(res, '来源库位或来源库位名称必填', 'INVALID_PARAMETER', 400)
      return
    }
    const db = getDatabase()

    // 校验物料和目标库位是否存在且未删除
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }
    const location = db.prepare('SELECT * FROM locations WHERE id = ? AND is_deleted = 0').get(toLocationId) as any
    if (!location) { error(res, '目标库位不存在或已删除', 'NOT_FOUND', 404); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      // 创建入库记录
      const inboundNo = `TF-${Date.now()}`
      const id = uuidv4()
      db.prepare(`
        INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, location_id, operator, status, remark)
        VALUES (?, ?, 'transfer', ?, ?, ?, '个', ?, ?, 'completed', ?)
      `).run(id, inboundNo, materialId, batchNo || null, quantity, toLocationId, operator || 'system', remark || '')

      // 增加目标库位库存
      const existingInv = db.prepare('SELECT * FROM inventory WHERE material_id = ?').get(materialId) as any
      let beforeStock = 0
      let afterStock = 0
      if (existingInv) {
        beforeStock = existingInv.stock
        afterStock = beforeStock + quantity
        db.prepare("UPDATE inventory SET stock = stock + ?, location_id = ?, last_inbound_id = ?, last_inbound_date = date('now','localtime'), update_time = CURRENT_TIMESTAMP WHERE material_id = ?")
          .run(quantity, toLocationId, id, materialId)
      } else {
        afterStock = quantity
        db.prepare(`
          INSERT INTO inventory (id, material_id, stock, locked_stock, location_id, last_inbound_id, last_inbound_date, update_time)
          VALUES (?, ?, ?, 0, ?, ?, date('now','localtime'), CURRENT_TIMESTAMP)
        `).run(uuidv4(), materialId, quantity, toLocationId, id)
      }

      // 负库存兜底（调拨增加库存，不会负数，但保持统一检查）
      const afterCheck = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock
      if (afterCheck < 0) {
        db.exec('ROLLBACK')
        error(res, '库存不能为负数', 'STOCK_NEGATIVE', 422)
        return
      }

      // 记录 stock_logs
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'transfer', ?, ?, ?, ?, ?, 'transfer', ?)
      `).run(logId, materialId, quantity, beforeStock, afterStock, id, operator || 'system')

      db.exec('COMMIT')
      success(res, { id, inboundNo, materialId, quantity, fromLocationId, fromLocationName, toLocationId }, 'Transfer inbound created')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

// 撤销调拨记录
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare("SELECT * FROM inbound_records WHERE id = ? AND type = 'transfer' AND is_deleted = 0").get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      // 软删除调拨记录
      db.prepare('UPDATE inbound_records SET is_deleted = 1 WHERE id = ?').run(id)

      // 回滚库存（调拨是增加库存，撤销是减少）
      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any
      const beforeStock = inv?.stock || 0
      if (beforeStock < record.quantity) {
        db.exec('ROLLBACK')
        error(res, '库存不足，无法撤销调拨', 'STOCK_INSUFFICIENT', 422)
        return
      }
      const afterStock = beforeStock - record.quantity
      db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(afterStock, record.material_id)

      // 记录 stock_logs
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'transfer_cancel', ?, '撤销调拨记录')
      `).run(logId, record.material_id, -record.quantity, beforeStock, afterStock, id, req.body.operator || 'system')

      db.exec('COMMIT')
      success(res, null, '调拨记录已撤销')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
