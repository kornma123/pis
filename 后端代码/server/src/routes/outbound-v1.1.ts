import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

function generateOutboundNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `OB-${date}-${random}`
}

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20, projectId, status } = req.query
    const db = getDatabase()
    let where = 'r.is_deleted = 0'
    const params: any[] = []
    if (projectId) { where += ' AND r.project_id = ?'; params.push(projectId) }
    if (status) { where += ' AND r.status = ?'; params.push(status) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM outbound_records r WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)

    const records = db.prepare(`
      SELECT r.*, p.name as project_name
      FROM outbound_records r
      LEFT JOIN projects p ON r.project_id = p.id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(pageSize), offset) as any[]

    const result = records.map((r: any) => {
      const items = db.prepare('SELECT oi.*, m.name as material_name FROM outbound_items oi LEFT JOIN materials m ON oi.material_id = m.id WHERE oi.outbound_id = ?').all(r.id) as any[]
      return {
        id: r.id, outboundNo: r.outbound_no, type: r.type, projectId: r.project_id,
        projectName: r.project_name,
        items: items.map((i: any) => ({
          id: i.id, materialId: i.material_id, materialName: i.material_name,
          batchNo: i.batch_no, quantity: i.quantity, unit: i.unit,
          unitCost: i.unit_cost, totalCost: i.total_cost,
        })),
        totalCost: r.total_cost, operator: r.operator, status: r.status,
        remark: r.remark, createdAt: r.created_at,
      }
    })

    successList(res, result, Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { type, projectId, items, remark } = req.body
    if (!type || !Array.isArray(items) || items.length === 0) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }

    const db = getDatabase()
    const outboundNo = generateOutboundNo()
    const id = uuidv4()
    const operator = req.body.operator || 'system'

    let totalCost = 0
    const outboundItems: any[] = []

    for (const item of items) {
      const { materialId, quantity } = item
      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
      if (!inv || inv.stock < quantity) {
        error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422); return
      }

      const batch = db.prepare('SELECT * FROM batches WHERE material_id = ? AND remaining > 0 AND status = 1 ORDER BY expiry_date ASC').get(materialId) as any
      const unitCost = batch?.inbound_price || 0
      const itemCost = unitCost * quantity
      totalCost += itemCost

      outboundItems.push({ materialId, batchId: batch?.id || null, batchNo: batch?.batch_no || null, quantity, unitCost, itemCost, usage: item.usage || 'self', receiver: item.receiver || null })
    }

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + items.map(() => '?').join(',') + ')').all(...items.map((i: any) => i.materialId)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))

    db.prepare(`
      INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
    `).run(id, outboundNo, type, projectId || null, totalCost, operator, remark || null)

    for (const oi of outboundItems) {
      const itemId = uuidv4()
      db.prepare(`
        INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(itemId, id, oi.materialId, oi.batchId, oi.batchNo, oi.quantity, unitMap.get(oi.materialId) || 'pcs', oi.unitCost, oi.itemCost, oi.usage || 'self', oi.receiver || null)

      db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(oi.quantity, oi.materialId)

      if (oi.batchId) {
        db.prepare('UPDATE batches SET remaining = remaining - ? WHERE id = ?').run(oi.quantity, oi.batchId)
        const batchRemaining = (db.prepare('SELECT remaining FROM batches WHERE id = ?').get(oi.batchId) as any)?.remaining
        if (batchRemaining <= 0) {
          db.prepare('UPDATE batches SET status = 0 WHERE id = ?').run(oi.batchId)
        }
      }

      // 自用物料创建使用中跟踪记录
      if ((oi.usage || 'self') === 'self' && oi.batchId) {
        const mat = db.prepare('SELECT name, spec FROM materials WHERE id = ?').get(oi.materialId) as any
        const trkId = `TRK-${Date.now()}-${Math.floor(Math.random() * 1000)}`
        const today = new Date().toISOString().split('T')[0]
        db.prepare(`
          INSERT INTO batch_usage_tracking
          (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
        `).run(trkId, oi.materialId, mat?.name || '', oi.batchNo || '', mat?.spec || '', oi.quantity, oi.quantity, unitMap.get(oi.materialId) || 'pcs', today, 30, 'self', null)
      }

      const logId = uuidv4()
      const beforeStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(oi.materialId) as any)?.stock || 0
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
      `).run(logId, oi.materialId, -oi.quantity, beforeStock + oi.quantity, beforeStock, id, operator)
    }

    success(res, { id, outboundNo, type, projectId, totalCost, status: 'completed' }, 'Outbound created')
  } catch (err: any) { error(res, err.message) }
})

export default router
