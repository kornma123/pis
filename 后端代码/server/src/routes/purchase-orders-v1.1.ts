import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

// 写权限：读 DB 矩阵（purchase_orders W = admin/procurement；lab_director/warehouse/finance 仅 R）
const requirePOWrite = requirePermission('purchase_orders', 'W')

function generateOrderNo(): string {
  const date = new Date()
  const prefix = 'PO' + date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0')
  const db = getDatabase()
  const count = (db.prepare("SELECT COUNT(*) as count FROM purchase_orders WHERE order_no LIKE ?").get(prefix + '%') as any)?.count || 0
  return prefix + '-' + String(count + 1).padStart(4, '0')
}

// 获取采购订单列表
router.get('/', (req, res) => {
  try {
    let { status, supplierId, keyword, page = '1', pageSize = '20' } = req.query
    pageSize = String(Math.min(Number(pageSize), 200))
    const db = getDatabase()
    let sql = 'SELECT * FROM purchase_orders WHERE is_deleted = 0'
    const params: any[] = []
    if (status) {
      const statuses = String(status).split(',').filter(Boolean)
      if (statuses.length === 1) {
        sql += ' AND status = ?'; params.push(statuses[0])
      } else if (statuses.length > 1) {
        sql += ' AND status IN (' + statuses.map(() => '?').join(',') + ')'
        params.push(...statuses)
      }
    }
    if (supplierId) { sql += ' AND supplier_id = ?'; params.push(supplierId) }
    if (keyword) { sql += ' AND (order_no LIKE ? OR material_name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    sql += ' ORDER BY created_at DESC'
    const limit = parseInt(pageSize as string, 10)
    const offset = (parseInt(page as string, 10) - 1) * limit
    sql += ' LIMIT ? OFFSET ?'
    params.push(limit, offset)
    const list = db.prepare(sql).all(...params) as any[]
    const total = (db.prepare('SELECT COUNT(*) as count FROM purchase_orders WHERE is_deleted = 0').get() as any).count
    successList(res, list.map(r => ({
      ...r,
      totalAmount: Number(r.total_amount),
      orderedQty: Number(r.ordered_qty),
      receivedQty: Number(r.received_qty),
      remainingQty: Number(r.ordered_qty) - Number(r.received_qty),
    })), parseInt(page as string, 10), limit, total)
  } catch (err: any) { error(res, err.message) }
})

// 获取采购订单详情
router.get('/:id', (req, res) => {
  try {
    const db = getDatabase()
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!order) { error(res, '订单不存在', 'NOT_FOUND', 404); return }
    success(res, {
      ...order,
      totalAmount: Number(order.total_amount),
      orderedQty: Number(order.ordered_qty),
      receivedQty: Number(order.received_qty),
      remainingQty: Number(order.ordered_qty) - Number(order.received_qty),
    })
  } catch (err: any) { error(res, err.message) }
})

// 创建采购订单
router.post('/', requirePOWrite, (req, res) => {
  try {
    const { materialId, materialName, supplierId, orderedQty, unit, unitPrice, expectedDate, remark } = req.body
    if (!materialId || orderedQty === undefined || orderedQty === null || isNaN(Number(orderedQty)) || Number(orderedQty) <= 0) {
      error(res, '物料和采购数量必填', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const id = uuidv4()
    const orderNo = generateOrderNo()
    const totalAmount = (unitPrice || 0) * orderedQty
    db.prepare(`
      INSERT INTO purchase_orders (id, order_no, material_id, material_name, supplier_id, ordered_qty, received_qty, unit, unit_price, total_amount, expected_date, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending', ?)
    `).run(id, orderNo, materialId, materialName || '', supplierId || null, orderedQty, unit || '个', unitPrice || 0, totalAmount, expectedDate || null, remark || '')
    success(res, { id, orderNo }, '采购订单创建成功')
  } catch (err: any) { error(res, err.message) }
})

// 更新采购订单收货数量（部分入库时调用）
router.put('/:id/receive', requirePOWrite, (req, res) => {
  try {
    const { quantity } = req.body
    if (quantity === undefined || quantity === null || isNaN(Number(quantity)) || Number(quantity) <= 0) {
      error(res, '入库数量必填', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!order) { error(res, '订单不存在', 'NOT_FOUND', 404); return }
    const orderedQty = Number(order.ordered_qty)
    const receivedQty = Number(order.received_qty)
    const newReceived = receivedQty + quantity
    if (newReceived > orderedQty) {
      error(res, '入库数量超过订单数量', 'INVALID_PARAMETER', 400); return
    }
    const status = newReceived >= orderedQty ? 'completed' : 'partial'
    db.prepare('UPDATE purchase_orders SET received_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0')
      .run(newReceived, status, req.params.id)
    success(res, { id: req.params.id, receivedQty: newReceived, status }, '更新成功')
  } catch (err: any) { error(res, err.message) }
})

// 取消采购订单
router.put('/:id/cancel', requirePOWrite, (req, res) => {
  try {
    const db = getDatabase()
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!order) { error(res, '订单不存在', 'NOT_FOUND', 404); return }
    if (order.status === 'completed') {
      error(res, '已完成的订单不能取消', 'INVALID_PARAMETER', 400); return
    }
    db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0").run(req.params.id)
    success(res, { id: req.params.id }, '订单已取消')
  } catch (err: any) { error(res, err.message) }
})

export default router
