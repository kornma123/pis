import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'

const router = Router()

// 新增调拨入库
router.post('/inbound', (req, res) => {
  try {
    const { materialId, batchNo, quantity, fromLocationId, fromLocationName, toLocationId, operator, remark } = req.body
    if (!materialId || !toLocationId || quantity <= 0) {
      error(res, '物料、目标库位和数量必填', 'INVALID_PARAMETER', 400)
      return
    }
    if (!fromLocationId && !fromLocationName) {
      error(res, '来源库位或来源库位名称必填', 'INVALID_PARAMETER', 400)
      return
    }
    const db = getDatabase()

    // 创建入库记录
    const inboundNo = `TF-${Date.now()}`
    const id = uuidv4()
    db.prepare(`
      INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, location_id, operator, status, remark)
      VALUES (?, ?, 'transfer', ?, ?, ?, '个', ?, ?, 'completed', ?)
    `).run(id, inboundNo, materialId, batchNo || null, quantity, toLocationId, operator || 'system', remark || '')

    // 增加目标库位库存
    const existingInv = db.prepare('SELECT * FROM inventory WHERE material_id = ?').get(materialId) as any
    if (existingInv) {
      db.prepare("UPDATE inventory SET stock = stock + ?, location_id = ?, last_inbound_id = ?, last_inbound_date = date('now','localtime'), update_time = CURRENT_TIMESTAMP WHERE material_id = ?")
        .run(quantity, toLocationId, id, materialId)
    } else {
      db.prepare(`
        INSERT INTO inventory (id, material_id, stock, locked_stock, location_id, last_inbound_id, last_inbound_date, update_time)
        VALUES (?, ?, ?, 0, ?, ?, date('now','localtime'), CURRENT_TIMESTAMP)
      `).run(uuidv4(), materialId, quantity, toLocationId, id)
    }

    success(res, { id, inboundNo, materialId, quantity, fromLocationId, fromLocationName, toLocationId }, 'Transfer inbound created')
  } catch (err: any) { error(res, err.message) }
})

export default router
