import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import { checkedAdd, parseFiniteNumber, parseFinitePositiveNumber } from '../utils/numeric-input.js'

const router = Router()

// 退库写入（改 inventory.stock）：挂载层只 requirePermission('returns','R')，
// 写端点必须自带 W 守卫，否则持 returns:R 者即可越权突变库存。仿 projects/outbound 模式。
const requireReturnsWrite = requirePermission('returns', 'W')

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
  return `RT-${date}-${timestamp}-${random}`
}

// 退库列表（筛选 + 排序 + 分页）
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
    if (keyword) { where += ' AND (r.return_no LIKE ? OR m.name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }

    const count = (db.prepare(`
      SELECT COUNT(*) as total FROM return_records r
      LEFT JOIN materials m ON r.material_id = m.id AND m.is_deleted = 0
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const offset = (page - 1) * pageSize

    const list = db.prepare(`
      SELECT r.*, m.name as material_name, m.unit as material_unit
      FROM return_records r
      LEFT JOIN materials m ON r.material_id = m.id AND m.is_deleted = 0
      WHERE ${where}
      ${orderBy(sortField, sortOrder)}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, returnNo: r.return_no, materialId: r.material_id, materialName: r.material_name,
      quantity: r.quantity, unit: r.material_unit, reason: r.reason, operator: r.operator,
      status: r.status, remark: r.remark, createdAt: r.created_at,
    })), page, pageSize, count)
  } catch (err: any) { error(res, err.message) }
})

// 退库统计（本月/件数/涉及物料/今日）
router.get('/stats', (_req, res) => {
  try {
    const db = getDatabase()
    const base = 'FROM return_records WHERE is_deleted = 0'
    const month = "strftime('%Y-%m', created_at) = strftime('%Y-%m','now')"
    const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get() as any)?.c || 0
    const monthCount = (db.prepare(`SELECT COUNT(*) c ${base} AND ${month}`).get() as any)?.c || 0
    const monthQty = (db.prepare(`SELECT COALESCE(SUM(quantity),0) c ${base} AND ${month}`).get() as any)?.c || 0
    const materialKinds = (db.prepare(`SELECT COUNT(DISTINCT material_id) c ${base} AND ${month}`).get() as any)?.c || 0
    const todayCount = (db.prepare(`SELECT COUNT(*) c ${base} AND date(created_at) = date('now')`).get() as any)?.c || 0
    success(res, { total, monthCount, monthQty, materialKinds, todayCount })
  } catch (err: any) { error(res, err.message) }
})

// 新增退库（物料退回仓库 → 库存 +数量；不设上限、无库存行则新建）
router.post('/', requireReturnsWrite, (req, res) => {
  try {
    const { materialId, quantity, reason, operator, remark } = req.body
    const qty = parseFinitePositiveNumber(quantity)
    if (!materialId || qty === null || !reason) {
      error(res, 'Missing or invalid fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }
    const preflightInv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
    const preflightBeforeStock = preflightInv ? parseFiniteNumber(preflightInv.stock) : 0
    const preflightAfterStock = preflightBeforeStock === null ? null : checkedAdd(preflightBeforeStock, qty)
    if (preflightBeforeStock === null || preflightAfterStock === null) {
      error(res, 'Return quantity exceeds the supported numeric range', 'INVALID_PARAMETER', 400); return
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
      const beforeStock = inv ? parseFiniteNumber(inv.stock) : 0
      const afterStock = beforeStock === null ? null : checkedAdd(beforeStock, qty)
      if (beforeStock === null || afterStock === null) {
        db.exec('ROLLBACK')
        error(res, 'Return quantity exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
        return
      }
      const id = uuidv4()
      db.prepare('INSERT INTO return_records (id, return_no, material_id, quantity, reason, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, generateNo(), materialId, qty, reason, operator || 'system', remark || null)

      // 退回仓库 → 库存增加（无库存行则新建，库位取物料默认库位）
      if (inv) {
        db.prepare('UPDATE inventory SET stock = ?, update_time = CURRENT_TIMESTAMP WHERE material_id = ?').run(afterStock, materialId)
      } else {
        db.prepare(`
          INSERT INTO inventory (id, material_id, stock, locked_stock, location_id, update_time)
          VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
        `).run(uuidv4(), materialId, qty, material.location_id || null)
      }
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'return', ?, ?, ?, ?, ?, 'return', ?)
      `).run(uuidv4(), materialId, qty, beforeStock, afterStock, id, operator || 'system')

      db.exec('COMMIT')
      success(res, { id }, 'Return created')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

// 撤销退库（对称扣回已加的库存；库存不足则拒绝，防负库存）
router.delete('/:id', requireReturnsWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM return_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any
      const beforeStock = inv?.stock ?? 0
      if (beforeStock < record.quantity) {
        db.exec('ROLLBACK')
        error(res, '库存不足，无法撤销退库', 'STOCK_INSUFFICIENT', 422)
        return
      }
      db.prepare('UPDATE return_records SET is_deleted = 1 WHERE id = ?').run(id)
      const afterStock = beforeStock - record.quantity
      db.prepare('UPDATE inventory SET stock = ?, update_time = CURRENT_TIMESTAMP WHERE material_id = ?').run(afterStock, record.material_id)

      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'return_cancel', ?, '撤销退库记录')
      `).run(uuidv4(), record.material_id, -record.quantity, beforeStock, afterStock, id, req.body?.operator || 'system')

      db.exec('COMMIT')
      success(res, null, '退库记录已撤销')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
