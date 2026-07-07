import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

// 报废写入（改 inventory.stock）：挂载层只 requirePermission('scraps','R')，
// 写端点必须自带 W 守卫，否则持 scraps:R 者即可越权突变库存。仿 projects/outbound 模式。
const requireScrapsWrite = requirePermission('scraps', 'W')

// 排序白名单（受控列，杜绝 ORDER BY 注入）
const SORT_COLUMNS: Record<string, string> = { createdAt: 'r.created_at', quantity: 'r.quantity' }
function orderBy(sortField: unknown, sortOrder: unknown): string {
  const col = SORT_COLUMNS[String(sortField)] || 'r.created_at'
  const dir = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return `ORDER BY ${col} ${dir}`
}

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `SC-${date}-${timestamp}-${random}`
}

// 报废列表（筛选 + 排序 + 分页）
router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20 } = req.query as any
    const { keyword, reason, materialId, startDate, endDate, sortField, sortOrder } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()

    let where = 'r.is_deleted = 0'
    const params: any[] = []
    if (materialId) { where += ' AND r.material_id = ?'; params.push(materialId) }
    if (reason) { where += ' AND r.reason = ?'; params.push(reason) }
    if (keyword) { where += ' AND (r.scrap_no LIKE ? OR m.name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }

    const count = (db.prepare(`
      SELECT COUNT(*) as total FROM scrap_records r
      LEFT JOIN materials m ON r.material_id = m.id AND m.is_deleted = 0
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const offset = (page - 1) * pageSize

    const list = db.prepare(`
      SELECT r.*, m.name as material_name, m.unit as material_unit
      FROM scrap_records r
      LEFT JOIN materials m ON r.material_id = m.id AND m.is_deleted = 0
      WHERE ${where}
      ${orderBy(sortField, sortOrder)}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, scrapNo: r.scrap_no, materialId: r.material_id, materialName: r.material_name,
      quantity: r.quantity, unit: r.material_unit, reason: r.reason, operator: r.operator,
      status: r.status, remark: r.remark, createdAt: r.created_at,
    })), page, pageSize, count)
  } catch (err: any) { error(res, err.message) }
})

// 报废统计（本月/件数/涉及物料/今日）
router.get('/stats', (_req, res) => {
  try {
    const db = getDatabase()
    const base = 'FROM scrap_records WHERE is_deleted = 0'
    const month = "strftime('%Y-%m', created_at) = strftime('%Y-%m','now')"
    const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get() as any)?.c || 0
    const monthCount = (db.prepare(`SELECT COUNT(*) c ${base} AND ${month}`).get() as any)?.c || 0
    const monthQty = (db.prepare(`SELECT COALESCE(SUM(quantity),0) c ${base} AND ${month}`).get() as any)?.c || 0
    const materialKinds = (db.prepare(`SELECT COUNT(DISTINCT material_id) c ${base} AND ${month}`).get() as any)?.c || 0
    const todayCount = (db.prepare(`SELECT COUNT(*) c ${base} AND date(created_at) = date('now')`).get() as any)?.c || 0
    success(res, { total, monthCount, monthQty, materialKinds, todayCount })
  } catch (err: any) { error(res, err.message) }
})

// 新增报废（物料退出库存 → 库存 −数量；库存不足则拒绝）
router.post('/', requireScrapsWrite, (req, res) => {
  try {
    const { materialId, quantity, reason, operator, remark } = req.body
    if (!materialId || quantity === undefined || quantity === null || isNaN(Number(quantity)) || Number(quantity) <= 0 || !reason) {
      error(res, 'Missing or invalid fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }
    const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
    if (!inv || inv.stock < Number(quantity)) { error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422); return }

    const qty = Number(quantity)
    db.exec('BEGIN IMMEDIATE')
    try {
      const id = uuidv4()
      db.prepare('INSERT INTO scrap_records (id, scrap_no, material_id, quantity, reason, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, generateNo(), materialId, qty, reason, operator || 'system', remark || null)
      db.prepare('UPDATE inventory SET stock = stock - ?, update_time = CURRENT_TIMESTAMP WHERE material_id = ?').run(qty, materialId)

      const afterCheck = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock
      if (afterCheck < 0) {
        db.exec('ROLLBACK')
        error(res, '库存不能为负数', 'STOCK_NEGATIVE', 422)
        return
      }

      const afterStock = (inv?.stock || 0) - qty
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'scrap', ?, ?, ?, ?, ?, 'scrap', ?)
      `).run(uuidv4(), materialId, -qty, inv?.stock || 0, afterStock, id, operator || 'system')

      db.exec('COMMIT')
      success(res, { id }, 'Scrap created')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

// 撤销报废（回滚库存 +数量）
router.delete('/:id', requireScrapsWrite, (req, res) => {
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
      db.prepare('UPDATE inventory SET stock = ?, update_time = CURRENT_TIMESTAMP WHERE material_id = ?').run(afterStock, record.material_id)

      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'scrap_cancel', ?, '撤销报废记录')
      `).run(uuidv4(), record.material_id, record.quantity, beforeStock, afterStock, id, req.body?.operator || 'system')

      db.exec('COMMIT')
      success(res, null, '报废记录已撤销')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
