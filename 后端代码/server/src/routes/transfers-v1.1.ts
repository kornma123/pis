import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

// 排序白名单：键为前端可传的字段名，值为受控列名（只来自此表 → 杜绝 ORDER BY 注入）
const SORT_COLUMNS: Record<string, string> = { createdAt: 'i.created_at', quantity: 'i.quantity' }
function orderBy(sortField: unknown, sortOrder: unknown): string {
  const col = SORT_COLUMNS[String(sortField)] || 'i.created_at'
  const dir = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return `ORDER BY ${col} ${dir}`
}

// 获取调拨记录列表（筛选 + 排序 + 分页）
router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20 } = req.query as any
    const { keyword, locationId, materialId, startDate, endDate, sortField, sortOrder } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()

    let where = "i.type = 'transfer' AND i.is_deleted = 0"
    const params: any[] = []
    if (materialId) { where += ' AND i.material_id = ?'; params.push(materialId) }
    if (locationId) { where += ' AND i.location_id = ?'; params.push(locationId) }
    if (keyword) { where += ' AND (i.inbound_no LIKE ? OR m.name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    if (startDate) { where += ' AND i.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND i.created_at <= ?'; params.push(`${endDate}T23:59:59`) }

    const count = (db.prepare(`
      SELECT COUNT(*) as total FROM inbound_records i
      LEFT JOIN materials m ON i.material_id = m.id AND m.is_deleted = 0
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const offset = (page - 1) * pageSize

    const list = db.prepare(`
      SELECT i.*, m.name as material_name, m.unit as material_unit,
             lt.name as to_location_name, lf.name as from_location_name
      FROM inbound_records i
      LEFT JOIN materials m ON i.material_id = m.id AND m.is_deleted = 0
      LEFT JOIN locations lt ON i.location_id = lt.id AND lt.is_deleted = 0
      LEFT JOIN locations lf ON i.from_location_id = lf.id AND lf.is_deleted = 0
      WHERE ${where}
      ${orderBy(sortField, sortOrder)}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, inboundNo: r.inbound_no, materialId: r.material_id, materialName: r.material_name,
      batchNo: r.batch_no, quantity: r.quantity, unit: r.unit || r.material_unit,
      fromLocationId: r.from_location_id, fromLocationName: r.from_location_name,
      toLocationId: r.location_id, toLocationName: r.to_location_name,
      operator: r.operator, status: r.status, remark: r.remark, createdAt: r.created_at,
    })), page, pageSize, count)
  } catch (err: any) { error(res, err.message) }
})

// 调拨统计（本月/件数/涉及物料/今日）
router.get('/stats', (_req, res) => {
  try {
    const db = getDatabase()
    const base = "FROM inbound_records WHERE type = 'transfer' AND is_deleted = 0"
    const month = "strftime('%Y-%m', created_at) = strftime('%Y-%m','now')"
    const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get() as any)?.c || 0
    const monthCount = (db.prepare(`SELECT COUNT(*) c ${base} AND ${month}`).get() as any)?.c || 0
    const monthQty = (db.prepare(`SELECT COALESCE(SUM(quantity),0) c ${base} AND ${month}`).get() as any)?.c || 0
    const materialKinds = (db.prepare(`SELECT COUNT(DISTINCT material_id) c ${base} AND ${month}`).get() as any)?.c || 0
    const todayCount = (db.prepare(`SELECT COUNT(*) c ${base} AND date(created_at) = date('now')`).get() as any)?.c || 0
    success(res, { total, monthCount, monthQty, materialKinds, todayCount })
  } catch (err: any) { error(res, err.message) }
})

// 新增调拨（库位间移动、总库存不变：仅记录 + 改 location_id，不动 stock）
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

    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }
    const location = db.prepare('SELECT * FROM locations WHERE id = ? AND is_deleted = 0').get(toLocationId) as any
    if (!location) { error(res, '目标库位不存在或已删除', 'NOT_FOUND', 404); return }
    // 来源以 id 形式给出则校验存在 + 禁止同库位自调；保留 fromLocationName 兜底（外部/自由来源，其撤销无法还原库位）
    if (fromLocationId) {
      const fromLoc = db.prepare('SELECT id FROM locations WHERE id = ? AND is_deleted = 0').get(fromLocationId) as any
      if (!fromLoc) { error(res, '来源库位不存在或已删除', 'NOT_FOUND', 404); return }
      if (fromLocationId === toLocationId) { error(res, '来源库位和目标库位不能相同', 'INVALID_PARAMETER', 400); return }
    }
    // 调拨＝移动既有库存：物料必须已在库（无库存行不能凭空"移动"，首次入库请走入库）
    const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
    if (!inv) { error(res, '该物料暂无库存，无法调拨（如需入库请使用入库）', 'STOCK_INSUFFICIENT', 422); return }

    const qty = Number(quantity)
    const beforeStock = inv.stock
    db.exec('BEGIN IMMEDIATE')
    try {
      const inboundNo = `TF-${Date.now()}`
      const id = uuidv4()
      db.prepare(`
        INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, location_id, from_location_id, operator, status, remark)
        VALUES (?, ?, 'transfer', ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
      `).run(id, inboundNo, materialId, batchNo || null, qty, material.unit || '个', toLocationId, fromLocationId || null, operator || 'system', remark || '')

      // 库位间移动：总库存不变，只把物料当前库位指到目标（单库位模型：整物料 last-move-wins）
      db.prepare("UPDATE inventory SET location_id = ?, update_time = CURRENT_TIMESTAMP WHERE material_id = ?").run(toLocationId, materialId)

      // stock_logs：调拨对库存 0 变动（before==after，quantity=0），仅留移库痕
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'transfer', ?, 0, ?, ?, ?, 'transfer', ?, ?)
      `).run(uuidv4(), materialId, beforeStock, beforeStock, id, operator || 'system', `库位调拨 ${qty}（总量不变）`)

      db.exec('COMMIT')
      success(res, { id, inboundNo, materialId, quantity: qty, fromLocationId, fromLocationName, toLocationId }, 'Transfer created')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

// 撤销调拨（还原库位到来源；总库存仍不变。来源未知的历史记录保持现状、不乱写）
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare("SELECT * FROM inbound_records WHERE id = ? AND type = 'transfer' AND is_deleted = 0").get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE inbound_records SET is_deleted = 1 WHERE id = ?').run(id)

      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any
      const beforeStock = inv?.stock ?? 0
      if (record.from_location_id) {
        db.prepare('UPDATE inventory SET location_id = ?, update_time = CURRENT_TIMESTAMP WHERE material_id = ?').run(record.from_location_id, record.material_id)
      }

      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, 0, ?, ?, ?, 'transfer_cancel', ?, '撤销调拨（还原库位·总量不变）')
      `).run(uuidv4(), record.material_id, beforeStock, beforeStock, id, req.body?.operator || 'system')

      db.exec('COMMIT')
      success(res, null, '调拨记录已撤销')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
