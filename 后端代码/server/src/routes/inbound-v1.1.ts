import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error, buildSuccessEnvelope } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  readIdempotencyKey,
  fingerprintRequest,
  tryReplayIdempotency,
  claimIdempotency,
  finalizeIdempotency,
  isIdempotencyConflict,
} from '../utils/idempotency.js'
import {
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  parseFiniteNonNegativeNumber,
  parseFiniteNumber,
  parseFinitePositiveNumber,
} from '../utils/numeric-input.js'

const router = Router()

// 写入权限：读 DB 矩阵（inbound W = admin/warehouse_manager/procurement，可在角色权限页改）
const requireWriteAccess = requirePermission('inbound', 'W')

function generateInboundNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `IB-${date}-${timestamp}-${random}`
}

type InboundCreateNumericPlan = {
  existingBatch: any | null
  batchQuantityAfter?: number
  batchRemainingAfter?: number
  purchaseOrder: any | null
  purchaseOrderReceivedAfter?: number
  purchaseOrderStatus?: string
  inventory: any | null
  inventoryBefore: number
  inventoryAfter: number
}

function buildInboundCreateNumericPlan(
  db: any,
  materialId: string,
  batchNo: string | undefined,
  purchaseOrderId: string | undefined,
  quantity: number,
): InboundCreateNumericPlan | null {
  const existingBatch = batchNo
    ? db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ? AND status = 1').get(materialId, batchNo) as any
    : null
  let batchQuantityAfter: number | undefined
  let batchRemainingAfter: number | undefined
  if (existingBatch) {
    const currentQuantity = parseFiniteNumber(existingBatch.quantity)
    const currentRemaining = parseFiniteNumber(existingBatch.remaining)
    batchQuantityAfter = currentQuantity === null ? undefined : checkedAdd(currentQuantity, quantity) ?? undefined
    batchRemainingAfter = currentRemaining === null ? undefined : checkedAdd(currentRemaining, quantity) ?? undefined
    if (batchQuantityAfter === undefined || batchRemainingAfter === undefined) return null
  }

  const purchaseOrder = purchaseOrderId
    ? db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').get(purchaseOrderId) as any
    : null
  let purchaseOrderReceivedAfter: number | undefined
  let purchaseOrderStatus: string | undefined
  if (purchaseOrder) {
    const receivedQty = parseFiniteNumber(purchaseOrder.received_qty)
    const orderedQty = parseFiniteNumber(purchaseOrder.ordered_qty)
    purchaseOrderReceivedAfter = receivedQty === null ? undefined : checkedAdd(receivedQty, quantity) ?? undefined
    if (orderedQty === null || purchaseOrderReceivedAfter === undefined) return null
    purchaseOrderStatus = purchaseOrderReceivedAfter >= orderedQty ? 'completed' : 'partial'
  }

  const inventory = db.prepare('SELECT * FROM inventory WHERE material_id = ?').get(materialId) as any
  const inventoryBefore = inventory ? parseFiniteNumber(inventory.stock) : 0
  const inventoryAfter = inventoryBefore === null ? null : checkedAdd(inventoryBefore, quantity)
  if (inventoryBefore === null || inventoryAfter === null) return null

  return {
    existingBatch,
    batchQuantityAfter,
    batchRemainingAfter,
    purchaseOrder,
    purchaseOrderReceivedAfter,
    purchaseOrderStatus,
    inventory,
    inventoryBefore,
    inventoryAfter,
  }
}

type InboundCancelCheck =
  | { kind: 'ok' }
  | { kind: 'numeric' }
  | { kind: 'business'; message: string }

type InboundBatchMutation = {
  row: any | null
  batchNo: string
  quantityAfter: number
  remainingAfter: number
  statusAfter: number
  inboundPrice?: number
}

type InboundUpdateNumericPlan = {
  record: any
  mode: 'cancel' | 'restore' | 'edit' | 'metadata'
  oldQty: number
  newQty: number
  qtyDiff: number
  oldBatch: string | null
  newBatch: string | null
  inventory: any | null
  inventoryBefore: number
  inventoryAfter: number
  inventoryChanged: boolean
  oldBatchMutation?: InboundBatchMutation
  newBatchMutation?: InboundBatchMutation
  purchaseOrder?: {
    row: any
    receivedAfter: number
    statusAfter: string
  }
  log: {
    quantity: number
    type: string
    remark: string
    beforeStock: number
    afterStock: number
  }
}

const INBOUND_INVENTORY_NOT_FOUND = Symbol('INBOUND_INVENTORY_NOT_FOUND')

function checkInboundCancellationRules(db: any, record: any, id: string): InboundCancelCheck {
  const rawOutboundTotal = (db.prepare(`
    SELECT COALESCE(SUM(oi.quantity),0) as total FROM outbound_items oi
    JOIN outbound_records o ON oi.outbound_id = o.id
    WHERE oi.material_id = ? AND oi.batch_no = ? AND o.is_deleted = 0
  `).get(record.material_id, record.batch_no) as any)?.total ?? 0
  const outboundTotal = parseFiniteNumber(rawOutboundTotal)
  if (outboundTotal === null) return { kind: 'numeric' }
  if (outboundTotal > 0) {
    return { kind: 'business', message: `该批次已有出库记录 ${outboundTotal} ${record.unit}，不可取消` }
  }

  const inUse = db.prepare("SELECT 1 FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use' LIMIT 1")
    .get(record.material_id, record.batch_no)
  if (inUse) return { kind: 'business', message: '该批次库存正在使用中，不可取消' }

  const rawOtherInbound = (db.prepare(`
    SELECT COALESCE(SUM(quantity),0) as total FROM inbound_records
    WHERE material_id = ? AND batch_no = ? AND status = 'completed' AND is_deleted = 0 AND id != ?
  `).get(record.material_id, record.batch_no, id) as any)?.total ?? 0
  const otherInbound = parseFiniteNumber(rawOtherInbound)
  if (otherInbound === null) return { kind: 'numeric' }
  if (otherInbound < outboundTotal) {
    return { kind: 'business', message: '取消后库存将变为负数，不可取消' }
  }
  return { kind: 'ok' }
}

function buildInboundUpdateNumericPlan(
  db: any,
  record: any,
  requestedQuantity: number | undefined,
  requestedBatchNo: string | undefined,
  requestedStatus: string | undefined,
  requestedPrice: number | undefined,
): InboundUpdateNumericPlan | typeof INBOUND_INVENTORY_NOT_FOUND | null {
  const oldQty = parseFiniteNumber(record.quantity)
  if (oldQty === null) return null
  const newQty = requestedQuantity ?? oldQty
  const qtyDiff = checkedSubtract(newQty, oldQty)
  if (qtyDiff === null) return null

  const oldBatch = record.batch_no || null
  const newBatch = requestedBatchNo !== undefined ? (requestedBatchNo || null) : oldBatch
  const oldStatus = record.status
  const newStatus = requestedStatus !== undefined ? requestedStatus : oldStatus
  const mode: InboundUpdateNumericPlan['mode'] = oldStatus === 'completed' && newStatus === 'cancelled'
    ? 'cancel'
    : oldStatus === 'cancelled' && newStatus === 'completed'
      ? 'restore'
      : oldStatus === 'completed' && newStatus !== 'cancelled'
        ? 'edit'
        : 'metadata'

  const inventory = db.prepare('SELECT * FROM inventory WHERE material_id = ?').get(record.material_id) as any
  const parsedInventory = inventory ? parseFiniteNumber(inventory.stock) : 0
  if (parsedInventory === null) return null
  const inventoryChanged = mode === 'cancel' || mode === 'restore' || (mode === 'edit' && qtyDiff !== 0)
  if (inventoryChanged && !inventory) return INBOUND_INVENTORY_NOT_FOUND
  let inventoryAfter = parsedInventory
  if (mode === 'cancel') {
    const next = checkedSubtract(parsedInventory, oldQty)
    if (next === null) return null
    inventoryAfter = next
  } else if (mode === 'restore') {
    const next = checkedAdd(parsedInventory, oldQty)
    if (next === null) return null
    inventoryAfter = next
  } else if (mode === 'edit' && qtyDiff !== 0) {
    const next = checkedAdd(parsedInventory, qtyDiff)
    if (next === null) return null
    inventoryAfter = next
  }

  const buildBatchMutation = (
    batchNoValue: string,
    operand: number,
    operation: 'add' | 'subtract',
    forceActive: boolean,
  ): InboundBatchMutation | null | undefined => {
    const row = db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ?').get(record.material_id, batchNoValue) as any
    if (!row) {
      if (operation === 'subtract') return undefined
      const inboundPrice = requestedPrice ?? parseFiniteNumber(record.price ?? 0)
      if (inboundPrice === null) return null
      return { row: null, batchNo: batchNoValue, quantityAfter: operand, remainingAfter: operand, statusAfter: 1, inboundPrice }
    }
    const quantityBefore = parseFiniteNumber(row.quantity)
    const remainingBefore = parseFiniteNumber(row.remaining)
    if (quantityBefore === null || remainingBefore === null) return null
    const quantityAfter = operation === 'add'
      ? checkedAdd(quantityBefore, operand)
      : checkedSubtract(quantityBefore, operand)
    const remainingAfter = operation === 'add'
      ? checkedAdd(remainingBefore, operand)
      : checkedSubtract(remainingBefore, operand)
    if (quantityAfter === null || remainingAfter === null) return null
    return {
      row,
      batchNo: batchNoValue,
      quantityAfter,
      remainingAfter,
      statusAfter: forceActive ? 1 : (remainingAfter <= 0 ? 0 : Number(row.status)),
    }
  }

  let oldBatchMutation: InboundBatchMutation | undefined
  let newBatchMutation: InboundBatchMutation | undefined
  if (mode === 'cancel' && oldBatch) {
    const mutation = buildBatchMutation(oldBatch, oldQty, 'subtract', false)
    if (mutation === null) return null
    oldBatchMutation = mutation
  } else if (mode === 'restore' && oldBatch) {
    const mutation = buildBatchMutation(oldBatch, oldQty, 'add', true)
    if (!mutation) return null
    oldBatchMutation = mutation
  } else if (mode === 'edit') {
    const batchChanged = newBatch !== oldBatch
    if (batchChanged) {
      if (oldBatch) {
        const mutation = buildBatchMutation(oldBatch, oldQty, 'subtract', false)
        if (mutation === null) return null
        oldBatchMutation = mutation
      }
      if (newBatch) {
        const mutation = buildBatchMutation(newBatch, newQty, 'add', true)
        if (!mutation) return null
        newBatchMutation = mutation
      }
    } else if (oldBatch && qtyDiff !== 0) {
      const row = db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ?').get(record.material_id, oldBatch) as any
      if (row) {
        const quantityBefore = parseFiniteNumber(row.quantity)
        const remainingBefore = parseFiniteNumber(row.remaining)
        const quantityAfter = quantityBefore === null ? null : checkedAdd(quantityBefore, qtyDiff)
        const remainingAfter = remainingBefore === null ? null : checkedAdd(remainingBefore, qtyDiff)
        if (quantityAfter === null || remainingAfter === null) return null
        oldBatchMutation = {
          row,
          batchNo: oldBatch,
          quantityAfter,
          remainingAfter,
          statusAfter: Number(row.status),
        }
      }
    }
  }

  let purchaseOrder: InboundUpdateNumericPlan['purchaseOrder']
  if ((mode === 'cancel' || mode === 'restore') && record.purchase_order_id) {
    const row = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(record.purchase_order_id) as any
    if (row) {
      const receivedBefore = parseFiniteNumber(row.received_qty)
      if (receivedBefore === null) return null
      if (mode === 'cancel') {
        const subtracted = checkedSubtract(receivedBefore, oldQty)
        if (subtracted === null) return null
        const receivedAfter = Math.max(0, subtracted)
        purchaseOrder = {
          row,
          receivedAfter,
          statusAfter: receivedAfter === 0 ? 'pending' : 'partial',
        }
      } else {
        const orderedQty = parseFiniteNumber(row.ordered_qty)
        const receivedAfter = checkedAdd(receivedBefore, oldQty)
        if (orderedQty === null || receivedAfter === null) return null
        purchaseOrder = {
          row,
          receivedAfter,
          statusAfter: receivedAfter >= orderedQty ? 'completed' : 'partial',
        }
      }
    }
  }

  let logQuantity = 0
  let logType = 'update'
  let logRemark = '更新入库记录'
  if (mode === 'cancel') { logQuantity = -oldQty; logType = 'cancel'; logRemark = '取消入库记录' }
  else if (mode === 'restore') { logQuantity = oldQty; logType = 'restore'; logRemark = '恢复入库记录' }
  else if (newQty !== oldQty) logQuantity = qtyDiff

  return {
    record,
    mode,
    oldQty,
    newQty,
    qtyDiff,
    oldBatch,
    newBatch,
    inventory,
    inventoryBefore: parsedInventory,
    inventoryAfter,
    inventoryChanged,
    oldBatchMutation,
    newBatchMutation,
    purchaseOrder,
    log: {
      quantity: logQuantity,
      type: logType,
      remark: logRemark,
      beforeStock: parsedInventory,
      afterStock: inventoryAfter,
    },
  }
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, status, type, materialId, keyword, startDate, endDate } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'r.is_deleted = 0'
    const params: any[] = []
    if (status) { where += ' AND r.status = ?'; params.push(status) }
    if (type) { where += ' AND r.type = ?'; params.push(type) }
    if (materialId) { where += ' AND r.material_id = ?'; params.push(materialId) }
    if (keyword) { where += ' AND (r.inbound_no LIKE ? OR m.name LIKE ? OR r.batch_no LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) }
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM inbound_records r WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (page - 1) * pageSize

    const sql = `
      SELECT r.*, m.name as material_name, s.name as supplier_name, l.name as location_name
      FROM inbound_records r
      LEFT JOIN materials m ON r.material_id = m.id AND m.is_deleted = 0
      LEFT JOIN suppliers s ON r.supplier_id = s.id AND s.is_deleted = 0
      LEFT JOIN locations l ON r.location_id = l.id AND l.is_deleted = 0
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `
    const list = db.prepare(sql).all(...params, pageSize, offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, inboundNo: r.inbound_no, type: r.type, materialId: r.material_id,
      materialName: r.material_name, batchNo: r.batch_no, quantity: r.quantity,
      unit: r.unit, price: r.price, amount: r.amount, supplierId: r.supplier_id,
      supplierName: r.supplier_name, locationId: r.location_id, locationName: r.location_name,
      productionDate: r.production_date, expiryDate: r.expiry_date, operator: r.operator,
      status: r.status, remark: r.remark, createdAt: r.created_at,
      purchaseOrderId: r.purchase_order_id,
      purchaseOrderNo: r.purchase_order_no,
    })), page, pageSize, count)
  } catch (err: any) { error(res, err.message) }
})

// 入库统计
router.get('/stats', (req, res) => {
  try {
    const db = getDatabase()
    const total = (db.prepare("SELECT COUNT(*) as c FROM inbound_records WHERE is_deleted = 0").get() as any)?.c || 0
    const completed = (db.prepare("SELECT COUNT(*) as c FROM inbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    const cancelled = (db.prepare("SELECT COUNT(*) as c FROM inbound_records WHERE is_deleted = 0 AND status = 'cancelled'").get() as any)?.c || 0
    const amount = (db.prepare("SELECT COALESCE(SUM(amount),0) as c FROM inbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    const supplierCount = (db.prepare("SELECT COUNT(DISTINCT supplier_id) as c FROM inbound_records WHERE is_deleted = 0 AND status = 'completed' AND supplier_id IS NOT NULL").get() as any)?.c || 0
    const pendingOrders = (db.prepare("SELECT COUNT(*) as c FROM purchase_orders WHERE is_deleted = 0 AND status IN ('pending','partial')").get() as any)?.c || 0
    success(res, { total, completed, cancelled, amount, supplierCount, pendingOrders })
  } catch (err: any) { error(res, err.message) }
})

// 检查入库记录是否可删除
router.get('/:id/check-deletable', (req, res) => {
  try {
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }

    const reasons: string[] = []
    let canDelete = true

    if (record.status === 'completed') {
      // 1. 检查是否有出库记录
      const outboundExists = db.prepare(`
        SELECT COALESCE(SUM(oi.quantity),0) as total
        FROM outbound_items oi
        JOIN outbound_records o ON oi.outbound_id = o.id
        WHERE oi.material_id = ? AND oi.batch_no = ? AND o.is_deleted = 0
      `).get(record.material_id, record.batch_no) as any
      if (outboundExists && outboundExists.total > 0) {
        canDelete = false
        reasons.push(`该批次已有出库记录 ${outboundExists.total} ${record.unit}`)
      }

      // 2. 检查是否有使用中的消耗跟踪
      const inUseExists = db.prepare(
        "SELECT 1 FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use' LIMIT 1"
      ).get(record.material_id, record.batch_no)
      if (inUseExists) {
        canDelete = false
        reasons.push('该批次库存正在使用中')
      }

      // 3. 检查删除后库存是否为负
      const totalInbound = (db.prepare(
        "SELECT COALESCE(SUM(quantity),0) as total FROM inbound_records WHERE material_id = ? AND batch_no = ? AND status = 'completed' AND is_deleted = 0 AND id != ?"
      ).get(record.material_id, record.batch_no, record.id) as any)?.total || 0
      const totalOutbound = outboundExists?.total || 0
      if (totalInbound < totalOutbound) {
        canDelete = false
        reasons.push(`删除后该批次库存将变为负数（剩余 ${totalInbound}，已出库 ${totalOutbound}）`)
      }
    }

    success(res, {
      canDelete,
      reasons,
      record: {
        id: record.id,
        inboundNo: record.inbound_no,
        materialId: record.material_id,
        quantity: record.quantity,
        batchNo: record.batch_no,
        unit: record.unit,
      }
    })
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireWriteAccess, (req, res) => {
  try {
    const { type, materialId, batchNo, quantity, price, supplierId, locationId, purchaseOrderId, productionDate, expiryDate, remark } = req.body
    if (!type || !materialId || quantity === undefined || !locationId) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }
    const normalizedQuantity = parseFinitePositiveNumber(quantity)
    if (normalizedQuantity === null) {
      error(res, 'Quantity must be a finite positive number', 'INVALID_PARAMETER', 400); return
    }
    const normalizedPrice = price === undefined ? 0 : parseFiniteNonNegativeNumber(price)
    if (normalizedPrice === null) {
      error(res, 'Price must be a finite non-negative number', 'INVALID_PARAMETER', 400); return
    }
    const amount = checkedMultiply(normalizedPrice, normalizedQuantity)
    if (amount === null) {
      error(res, 'Amount exceeds the supported numeric range', 'INVALID_PARAMETER', 400); return
    }

    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'inbound:create'
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return

    const inboundNo = generateInboundNo()
    const id = uuidv4()
    const operator = req.body.operator || 'system'

    const material = db.prepare('SELECT unit FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, 'Material not found', 'NOT_FOUND', 404); return }

    const unit = material.unit
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null

    const preflightPlan = buildInboundCreateNumericPlan(db, materialId, batchNo, purchaseOrderId, normalizedQuantity)
    if (!preflightPlan) {
      error(res, 'Inbound quantity exceeds the supported numeric range', 'INVALID_PARAMETER', 400); return
    }
    let purchaseOrderNo: string | null = preflightPlan.purchaseOrder?.order_no || null

    // 事务保护：入库涉及 records + batches + inventory + stock_logs 多表操作
    db.exec('BEGIN IMMEDIATE')
    try {
      const transactionPlan = buildInboundCreateNumericPlan(db, materialId, batchNo, purchaseOrderId, normalizedQuantity)
      if (!transactionPlan) {
        db.exec('ROLLBACK')
        error(res, 'Inbound quantity exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
        return
      }
      purchaseOrderNo = transactionPlan.purchaseOrder?.order_no || null
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator)
      db.prepare(`
        INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, price, amount, supplier_id, location_id, production_date, expiry_date, operator, status, remark, purchase_order_id, purchase_order_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
      `).run(id, inboundNo, type, materialId, batchNo || null, normalizedQuantity, unit, normalizedPrice, amount, supplierId || null, locationId, productionDate || null, expiryDate || null, operator, remark || null, purchaseOrderId || null, purchaseOrderNo)

      if (batchNo) {
        if (transactionPlan.existingBatch) {
          db.prepare('UPDATE batches SET quantity = ?, remaining = ? WHERE id = ?')
            .run(transactionPlan.batchQuantityAfter, transactionPlan.batchRemainingAfter, transactionPlan.existingBatch.id)
        } else {
          const batchId = uuidv4()
          db.prepare(`
            INSERT INTO batches (id, material_id, batch_no, quantity, remaining, production_date, expiry_date, inbound_id, inbound_price, supplier_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          `).run(batchId, materialId, batchNo, normalizedQuantity, normalizedQuantity, productionDate || null, expiryDate || null, id, normalizedPrice, supplierId || null)
        }
      }

      // 更新采购订单收货数量
      if (purchaseOrderId && transactionPlan.purchaseOrder) {
        db.prepare('UPDATE purchase_orders SET received_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(transactionPlan.purchaseOrderReceivedAfter, transactionPlan.purchaseOrderStatus, purchaseOrderId)
      }

      if (transactionPlan.inventory) {
        db.prepare("UPDATE inventory SET stock = ?, location_id = ?, last_inbound_id = ?, last_inbound_date = date('now','localtime'), update_time = CURRENT_TIMESTAMP WHERE material_id = ?")
          .run(transactionPlan.inventoryAfter, locationId, id, materialId)
      } else {
        db.prepare(`
          INSERT INTO inventory (id, material_id, stock, locked_stock, location_id, last_inbound_id, last_inbound_date, update_time)
          VALUES (?, ?, ?, 0, ?, ?, date('now','localtime'), CURRENT_TIMESTAMP)
        `).run(uuidv4(), materialId, normalizedQuantity, locationId, id)
      }

      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'inbound', ?, ?, ?, ?, ?, 'inbound', ?)
      `).run(logId, materialId, normalizedQuantity, transactionPlan.inventoryBefore, transactionPlan.inventoryAfter, id, operator)

      responseEnvelope = buildSuccessEnvelope({ id, inboundNo, type, materialId, quantity: normalizedQuantity, status: 'completed', purchaseOrderId, purchaseOrderNo }, 'Inbound created')
      if (idemKey) finalizeIdempotency(db, idemKey, 201, responseEnvelope)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }

    res.status(201).json(responseEnvelope)
  } catch (err: any) { error(res, err.message) }
})

router.put('/:id', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const { batchNo, quantity, price, supplierId, locationId, productionDate, expiryDate, remark, status } = req.body

    let normalizedQuantity: number | undefined
    if (quantity !== undefined) {
      const parsedQuantity = parseFinitePositiveNumber(quantity)
      if (parsedQuantity === null) {
        error(res, 'Quantity must be a finite positive number', 'INVALID_PARAMETER', 400); return
      }
      normalizedQuantity = parsedQuantity
    }

    let normalizedPrice: number | undefined
    if (price !== undefined) {
      const parsedPrice = parseFiniteNonNegativeNumber(price)
      if (parsedPrice === null) {
        error(res, 'Price must be a finite non-negative number', 'INVALID_PARAMETER', 400); return
      }
      normalizedPrice = parsedPrice
    }

    const db = getDatabase()
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const fields: string[] = []; const params: any[] = []
    if (batchNo !== undefined) { fields.push('batch_no = ?'); params.push(batchNo || null) }
    if (normalizedQuantity !== undefined) { fields.push('quantity = ?'); params.push(normalizedQuantity) }
    if (normalizedPrice !== undefined) { fields.push('price = ?'); params.push(normalizedPrice) }
    if (supplierId !== undefined) { fields.push('supplier_id = ?'); params.push(supplierId || null) }
    if (locationId !== undefined) { fields.push('location_id = ?'); params.push(locationId) }
    if (productionDate !== undefined) { fields.push('production_date = ?'); params.push(productionDate || null) }
    if (expiryDate !== undefined) { fields.push('expiry_date = ?'); params.push(expiryDate || null) }
    if (remark !== undefined) { fields.push('remark = ?'); params.push(remark || '') }
    if (status !== undefined) { fields.push('status = ?'); params.push(status) }

    const requestedNewStatus = status !== undefined ? status : record.status
    if (record.status === 'completed' && requestedNewStatus === 'cancelled') {
      const cancelCheck = checkInboundCancellationRules(db, record, id)
      if (cancelCheck.kind === 'numeric') {
        error(res, 'Inbound update arithmetic exceeds the supported numeric range', 'INVALID_PARAMETER', 400); return
      }
      if (cancelCheck.kind === 'business') {
        error(res, cancelCheck.message, 'BUSINESS_RULE', 400); return
      }
    }
    const preflightPlan = buildInboundUpdateNumericPlan(db, record, normalizedQuantity, batchNo, status, normalizedPrice)
    if (preflightPlan === INBOUND_INVENTORY_NOT_FOUND) {
      error(res, 'Inventory record not found', 'INVENTORY_NOT_FOUND', 422); return
    }
    if (!preflightPlan) {
      error(res, 'Inbound update arithmetic exceeds the supported numeric range', 'INVALID_PARAMETER', 400); return
    }
    const { oldQty, newQty, oldBatch, newBatch } = preflightPlan
    const oldStatus = record.status
    const newStatus = requestedNewStatus

    db.exec('BEGIN IMMEDIATE')
    try {
      const transactionRecord = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
      if (!transactionRecord) {
        db.exec('ROLLBACK')
        error(res, 'Not found', 'NOT_FOUND', 404)
        return
      }
      const transactionNewStatus = status !== undefined ? status : transactionRecord.status
      if (transactionRecord.status === 'completed' && transactionNewStatus === 'cancelled') {
        const cancelCheck = checkInboundCancellationRules(db, transactionRecord, id)
        if (cancelCheck.kind === 'numeric') {
          db.exec('ROLLBACK')
          error(res, 'Inbound update arithmetic exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
          return
        }
        if (cancelCheck.kind === 'business') {
          db.exec('ROLLBACK')
          error(res, cancelCheck.message, 'BUSINESS_RULE', 400)
          return
        }
      }
      const transactionPlan = buildInboundUpdateNumericPlan(db, transactionRecord, normalizedQuantity, batchNo, status, normalizedPrice)
      if (transactionPlan === INBOUND_INVENTORY_NOT_FOUND) {
        db.exec('ROLLBACK')
        error(res, 'Inventory record not found', 'INVENTORY_NOT_FOUND', 422)
        return
      }
      if (!transactionPlan) {
        db.exec('ROLLBACK')
        error(res, 'Inbound update arithmetic exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
        return
      }
      const stableDependencyKeys = [
        'material_id',
        'status',
        'purchase_order_id',
        'price',
        'production_date',
        'expiry_date',
        'supplier_id',
        'unit',
      ] as const
      const sourceChanged = transactionPlan.oldQty !== preflightPlan.oldQty
        || transactionPlan.oldBatch !== preflightPlan.oldBatch
        || stableDependencyKeys.some((key) => (transactionRecord[key] ?? null) !== (record[key] ?? null))
      if (sourceChanged) {
        db.exec('ROLLBACK')
        error(res, 'Inbound record changed during update; please retry', 'CONCURRENT_MODIFICATION', 409)
        return
      }
      // ===== 1. 取消操作（completed → cancelled）=====
      if (oldStatus === 'completed' && newStatus === 'cancelled') {
        const outboundTotal = (db.prepare(`
          SELECT COALESCE(SUM(oi.quantity),0) as total FROM outbound_items oi
          JOIN outbound_records o ON oi.outbound_id = o.id
          WHERE oi.material_id = ? AND oi.batch_no = ? AND o.is_deleted = 0
        `).get(record.material_id, oldBatch) as any)?.total || 0

        if (outboundTotal > 0) {
          db.exec('ROLLBACK')
          error(res, `该批次已有出库记录 ${outboundTotal} ${record.unit}，不可取消`, 'BUSINESS_RULE', 400)
          return
        }

        const inUse = db.prepare("SELECT 1 FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use' LIMIT 1")
          .get(record.material_id, oldBatch)
        if (inUse) {
          db.exec('ROLLBACK')
          error(res, '该批次库存正在使用中，不可取消', 'BUSINESS_RULE', 400)
          return
        }

        const otherInbound = (db.prepare(`
          SELECT COALESCE(SUM(quantity),0) as total FROM inbound_records
          WHERE material_id = ? AND batch_no = ? AND status = 'completed' AND is_deleted = 0 AND id != ?
        `).get(record.material_id, oldBatch, id) as any)?.total || 0
        if (otherInbound < outboundTotal) {
          db.exec('ROLLBACK')
          error(res, `取消后库存将变为负数，不可取消`, 'BUSINESS_RULE', 400)
          return
        }

        if (record.purchase_order_id) {
          const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(record.purchase_order_id) as any
          if (order) {
            const newReceived = Math.max(0, Number(order.received_qty) - oldQty)
            db.prepare('UPDATE purchase_orders SET received_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(newReceived, newReceived === 0 ? 'pending' : 'partial', record.purchase_order_id)
          }
        }

        db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(oldQty, record.material_id)
        if (oldBatch) {
          db.prepare('UPDATE batches SET quantity = quantity - ?, remaining = remaining - ? WHERE material_id = ? AND batch_no = ?')
            .run(oldQty, oldQty, record.material_id, oldBatch)
          const b = db.prepare('SELECT remaining FROM batches WHERE material_id = ? AND batch_no = ?')
            .get(record.material_id, oldBatch) as any
          if (b && b.remaining <= 0) {
            db.prepare('UPDATE batches SET status = 0 WHERE material_id = ? AND batch_no = ?')
              .run(record.material_id, oldBatch)
          }
        }
      }

      // ===== 2. 恢复操作（cancelled → completed）=====
      if (oldStatus === 'cancelled' && newStatus === 'completed') {
        db.prepare('UPDATE inventory SET stock = stock + ? WHERE material_id = ?').run(oldQty, record.material_id)
        if (oldBatch) {
          const b = db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ?').get(record.material_id, oldBatch) as any
          if (b) {
            db.prepare('UPDATE batches SET quantity = quantity + ?, remaining = remaining + ?, status = 1 WHERE id = ?')
              .run(oldQty, oldQty, b.id)
          } else {
            const bid = uuidv4()
            db.prepare(`
              INSERT INTO batches (id, material_id, batch_no, quantity, remaining, production_date, expiry_date, inbound_id, inbound_price, supplier_id, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `).run(bid, record.material_id, oldBatch, oldQty, oldQty, record.production_date, record.expiry_date, id, record.price || 0, record.supplier_id)
          }
        }
        if (record.purchase_order_id) {
          const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(record.purchase_order_id) as any
          if (order) {
            const newReceived = Number(order.received_qty) + oldQty
            db.prepare('UPDATE purchase_orders SET received_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(newReceived, newReceived >= Number(order.ordered_qty) ? 'completed' : 'partial', record.purchase_order_id)
          }
        }
      }

      // ===== 3. 已完成记录的数量/批次编辑 =====
      if (oldStatus === 'completed' && newStatus !== 'cancelled') {
        const qtyDiff = newQty - oldQty
        const batchChanged = newBatch !== oldBatch

        if (batchChanged) {
          if (oldBatch) {
            db.prepare('UPDATE batches SET quantity = quantity - ?, remaining = remaining - ? WHERE material_id = ? AND batch_no = ?')
              .run(oldQty, oldQty, record.material_id, oldBatch)
            const b = db.prepare('SELECT remaining FROM batches WHERE material_id = ? AND batch_no = ?')
              .get(record.material_id, oldBatch) as any
            if (b && b.remaining <= 0) {
              db.prepare('UPDATE batches SET status = 0 WHERE material_id = ? AND batch_no = ?')
                .run(record.material_id, oldBatch)
            }
          }
          if (newBatch) {
            const b = db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ?').get(record.material_id, newBatch) as any
            if (b) {
              db.prepare('UPDATE batches SET quantity = quantity + ?, remaining = remaining + ?, status = 1 WHERE id = ?')
                .run(newQty, newQty, b.id)
            } else {
              const bid = uuidv4()
              db.prepare(`
                INSERT INTO batches (id, material_id, batch_no, quantity, remaining, production_date, expiry_date, inbound_id, inbound_price, supplier_id, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
              `).run(bid, record.material_id, newBatch, newQty, newQty, productionDate || record.production_date, expiryDate || record.expiry_date, id, normalizedPrice !== undefined ? normalizedPrice : record.price || 0, supplierId !== undefined ? supplierId : record.supplier_id)
            }
          }
          if (qtyDiff !== 0) {
            db.prepare('UPDATE inventory SET stock = stock + ? WHERE material_id = ?').run(qtyDiff, record.material_id)
          }
        } else if (qtyDiff !== 0) {
          db.prepare('UPDATE inventory SET stock = stock + ? WHERE material_id = ?').run(qtyDiff, record.material_id)
          if (oldBatch) {
            db.prepare('UPDATE batches SET quantity = quantity + ?, remaining = remaining + ? WHERE material_id = ? AND batch_no = ?')
              .run(qtyDiff, qtyDiff, record.material_id, oldBatch)
          }
        }
      }

      // 4. 更新入库记录
      if (fields.length > 0) {
        params.push(id)
        db.prepare(`UPDATE inbound_records SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params)
      }

      // 5. 记录日志
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound_update', ?, ?)
      `).run(
        logId,
        transactionPlan.log.type,
        transactionRecord.material_id,
        transactionPlan.log.quantity,
        transactionPlan.log.beforeStock,
        transactionPlan.log.afterStock,
        id,
        req.body.operator || 'system',
        transactionPlan.log.remark,
      )

      db.exec('COMMIT')

      let msg = '更新成功'
      if (newStatus === 'cancelled' && oldStatus !== 'cancelled') msg = '取消成功，库存已同步扣减'
      if (newStatus === 'completed' && oldStatus === 'cancelled') msg = '恢复成功，库存已同步增加'
      success(res, { id }, msg)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }

    // 事务保护：删除涉及 records + batches + purchase_orders + stock_logs 多表操作
    db.exec('BEGIN IMMEDIATE')
    try {
      if (record.status === 'completed') {
        // 1. 检查是否有出库记录
        const outboundExists = db.prepare(`
          SELECT COALESCE(SUM(oi.quantity),0) as total
          FROM outbound_items oi
          JOIN outbound_records o ON oi.outbound_id = o.id
          WHERE oi.material_id = ? AND oi.batch_no = ? AND o.is_deleted = 0
        `).get(record.material_id, record.batch_no) as any
        if (outboundExists && outboundExists.total > 0) {
          db.exec('ROLLBACK')
          error(res, `该入库记录对应的批次已有出库记录 ${outboundExists.total} ${record.unit}，不可删除。请先作废关联的出库单`, 'BUSINESS_RULE', 400)
          return
        }

        // 2. 检查是否有使用中的消耗跟踪
        const inUseExists = db.prepare(
          "SELECT 1 FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use' LIMIT 1"
        ).get(record.material_id, record.batch_no)
        if (inUseExists) {
          db.exec('ROLLBACK')
          error(res, '该批次库存正在使用中，请先确认耗尽后再删除', 'BUSINESS_RULE', 400)
          return
        }

        // 3. 检查删除后库存是否为负
        const totalInbound = (db.prepare(
          "SELECT COALESCE(SUM(quantity),0) as total FROM inbound_records WHERE material_id = ? AND batch_no = ? AND status = 'completed' AND is_deleted = 0 AND id != ?"
        ).get(record.material_id, record.batch_no, id) as any)?.total || 0
        const totalOutbound = (db.prepare(`
          SELECT COALESCE(SUM(oi.quantity),0) as total
          FROM outbound_items oi
          JOIN outbound_records o ON oi.outbound_id = o.id
          WHERE oi.material_id = ? AND oi.batch_no = ? AND o.is_deleted = 0
        `).get(record.material_id, record.batch_no) as any)?.total || 0
        if (totalInbound < totalOutbound) {
          db.exec('ROLLBACK')
          error(res, `删除后该批次库存将变为负数（剩余 ${totalInbound}，已出库 ${totalOutbound}），不可删除`, 'BUSINESS_RULE', 400)
          return
        }

        // 4. 回退采购订单收货数量
        if (record.purchase_order_id) {
          const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').get(record.purchase_order_id) as any
          if (order) {
            const newReceived = Math.max(0, Number(order.received_qty) - record.quantity)
            const poStatus = newReceived === 0 ? 'pending' : 'partial'
            db.prepare('UPDATE purchase_orders SET received_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(newReceived, poStatus, record.purchase_order_id)
          }
        }

        // 5. 扣减批次数量
        if (record.batch_no) {
          db.prepare('UPDATE batches SET quantity = quantity - ?, remaining = remaining - ? WHERE material_id = ? AND batch_no = ?')
            .run(record.quantity, record.quantity, record.material_id, record.batch_no)
          const batch = db.prepare('SELECT remaining FROM batches WHERE material_id = ? AND batch_no = ?')
            .get(record.material_id, record.batch_no) as any
          if (batch && batch.remaining <= 0) {
            db.prepare('UPDATE batches SET status = 0 WHERE material_id = ? AND batch_no = ?')
              .run(record.material_id, record.batch_no)
          }
        }
      }

      // 6. 软删除入库记录
      db.prepare('UPDATE inbound_records SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)

      // 7. 记录操作日志
      const totalInboundAfter = (db.prepare(
        "SELECT COALESCE(SUM(quantity),0) as total FROM inbound_records WHERE material_id = ? AND batch_no = ? AND status = 'completed' AND is_deleted = 0"
      ).get(record.material_id, record.batch_no) as any)?.total || 0
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'delete', ?, ?, ?, ?, ?, 'inbound_delete', ?, '删除入库记录')
      `).run(logId, record.material_id, record.quantity, totalInboundAfter + record.quantity, totalInboundAfter, id, req.body.operator || 'system')

      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    success(res, null, '删除成功，库存已同步扣减')
  } catch (err: any) { error(res, err.message) }
})

router.post('/:id/cancel', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const { reason } = req.body
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    if (record.status !== 'completed') {
      error(res, '只有已完成的入库记录可以取消', 'BUSINESS_RULE', 400)
      return
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      // 检查出库记录
      const outboundTotal = (db.prepare(`
        SELECT COALESCE(SUM(oi.quantity),0) as total FROM outbound_items oi
        JOIN outbound_records o ON oi.outbound_id = o.id
        WHERE oi.material_id = ? AND oi.batch_no = ? AND o.is_deleted = 0
      `).get(record.material_id, record.batch_no) as any)?.total || 0

      if (outboundTotal > 0) {
        db.exec('ROLLBACK')
        error(res, `该批次已有出库记录 ${outboundTotal} ${record.unit}，不可取消`, 'BUSINESS_RULE', 400)
        return
      }

      const inUse = db.prepare("SELECT 1 FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use' LIMIT 1")
        .get(record.material_id, record.batch_no)
      if (inUse) {
        db.exec('ROLLBACK')
        error(res, '该批次库存正在使用中，不可取消', 'BUSINESS_RULE', 400)
        return
      }

      const otherInbound = (db.prepare(`
        SELECT COALESCE(SUM(quantity),0) as total FROM inbound_records
        WHERE material_id = ? AND batch_no = ? AND status = 'completed' AND is_deleted = 0 AND id != ?
      `).get(record.material_id, record.batch_no, id) as any)?.total || 0
      if (otherInbound < outboundTotal) {
        db.exec('ROLLBACK')
        error(res, `取消后库存将变为负数，不可取消`, 'BUSINESS_RULE', 400)
        return
      }

      // 回退采购订单
      if (record.purchase_order_id) {
        const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(record.purchase_order_id) as any
        if (order) {
          const newReceived = Math.max(0, Number(order.received_qty) - record.quantity)
          db.prepare('UPDATE purchase_orders SET received_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(newReceived, newReceived === 0 ? 'pending' : 'partial', record.purchase_order_id)
        }
      }

      // 扣减库存
      db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(record.quantity, record.material_id)
      // 扣减批次
      if (record.batch_no) {
        db.prepare('UPDATE batches SET quantity = quantity - ?, remaining = remaining - ? WHERE material_id = ? AND batch_no = ?')
          .run(record.quantity, record.quantity, record.material_id, record.batch_no)
        const b = db.prepare('SELECT remaining FROM batches WHERE material_id = ? AND batch_no = ?')
          .get(record.material_id, record.batch_no) as any
        if (b && b.remaining <= 0) {
          db.prepare('UPDATE batches SET status = 0 WHERE material_id = ? AND batch_no = ?')
            .run(record.material_id, record.batch_no)
        }
      }

      db.prepare('UPDATE inbound_records SET status = "cancelled", cancel_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0')
        .run(reason || '', id)

      const currentStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any)?.stock || 0
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'inbound_cancel', ?, '取消入库记录')
      `).run(logId, record.material_id, -record.quantity, currentStock + record.quantity, currentStock, id, req.body.operator || 'system')

      db.exec('COMMIT')
      success(res, null, '取消成功，库存已同步扣减')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
