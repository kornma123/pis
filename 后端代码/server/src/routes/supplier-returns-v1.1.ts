import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { buildSuccessEnvelope, error, success, successList } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  checkedAdd,
  checkedMultiply,
  parseFiniteNonNegativeNumber,
  parseFinitePositiveNumber,
} from '../utils/numeric-input.js'
import {
  applyInventoryPlan,
  inventoryErrorResponse,
  listActiveAllocationFacts,
  markAllocationFactsReversed,
  planExactInventoryAdditions,
  planInventoryDeductions,
  replaceAllocationFacts,
} from '../services/inventory-transactions.js'
import {
  claimIdempotency,
  finalizeIdempotency,
  fingerprintRequest,
  isIdempotencyConflict,
  readIdempotencyKey,
  tryReplayIdempotency,
} from '../utils/idempotency.js'

const router = Router()
const requireWriteAccess = requirePermission('supplier_returns', 'W')

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `SR-${date}-${timestamp}-${random}`
}

function responseRow(row: any) {
  return {
    id: row.id,
    returnNo: row.return_no,
    materialId: row.material_id,
    materialName: row.material_name,
    batchId: row.batch_id,
    batchNo: row.batch_no,
    quantity: row.quantity,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNo: row.purchase_order_no,
    inboundRecordId: row.inbound_record_id,
    inboundNo: row.inbound_no,
    reason: row.reason,
    refundAmount: row.refund_amount,
    trackingNo: row.tracking_no,
    status: row.status,
    operator: row.operator,
    remark: row.remark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function loadAllocationRefundCap(db: any, ownerId: string): number {
  const rows = db.prepare(`
    SELECT a.quantity, b.inbound_price
    FROM inventory_transaction_allocations a
    JOIN batches b ON b.id = a.batch_id AND b.material_id = a.material_id
    WHERE a.operation_kind = 'supplier_return'
      AND a.owner_id = ?
      AND a.direction = 'out'
      AND a.is_reversed = 0
  `).all(ownerId) as any[]
  if (rows.length === 0) throw Object.assign(new Error('Supplier return allocation is unavailable'), { allocationMissing: true })
  let cap = 0
  for (const row of rows) {
    const quantity = parseFinitePositiveNumber(row.quantity)
    const unitCost = parseFiniteNonNegativeNumber(row.inbound_price)
    if (quantity === null || unitCost === null) throw new Error('Supplier return source cost is corrupt')
    const line = checkedMultiply(quantity, unitCost)
    if (line === null) throw new Error('Supplier return source cost exceeds the supported range')
    const next = checkedAdd(cap, line)
    if (next === null) throw new Error('Supplier return source cost exceeds the supported range')
    cap = next
  }
  return cap
}

router.get('/', (req, res) => {
  try {
    let { keyword, status, supplierId, startDate, endDate, page = '1', pageSize = '20' } = req.query
    const normalizedPage = Math.max(1, Number(page) || 1)
    const normalizedPageSize = Math.max(1, Math.min(200, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'sr.is_deleted = 0'
    const params: any[] = []
    if (status) { where += ' AND sr.status = ?'; params.push(status) }
    if (supplierId) { where += ' AND sr.supplier_id = ?'; params.push(supplierId) }
    if (startDate) { where += ' AND date(sr.created_at) >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND date(sr.created_at) <= ?'; params.push(endDate) }
    if (keyword) {
      where += ' AND (sr.return_no LIKE ? OR m.name LIKE ? OR sr.reason LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }
    const total = (db.prepare(`
      SELECT COUNT(*) AS total
      FROM supplier_returns sr
      LEFT JOIN materials m ON m.id = sr.material_id AND m.is_deleted = 0
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const list = db.prepare(`
      SELECT sr.*, m.name AS material_name, s.name AS supplier_name,
        po.order_no AS purchase_order_no, ir.inbound_no
      FROM supplier_returns sr
      LEFT JOIN materials m ON m.id = sr.material_id AND m.is_deleted = 0
      LEFT JOIN suppliers s ON s.id = sr.supplier_id AND s.is_deleted = 0
      LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id AND po.is_deleted = 0
      LEFT JOIN inbound_records ir ON ir.id = sr.inbound_record_id AND ir.is_deleted = 0
      WHERE ${where}
      ORDER BY sr.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, normalizedPageSize, (normalizedPage - 1) * normalizedPageSize) as any[]
    successList(res, list.map(responseRow), normalizedPage, normalizedPageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.get('/:id', (req, res) => {
  try {
    const row = getDatabase().prepare(`
      SELECT sr.*, m.name AS material_name, s.name AS supplier_name,
        po.order_no AS purchase_order_no, ir.inbound_no
      FROM supplier_returns sr
      LEFT JOIN materials m ON m.id = sr.material_id AND m.is_deleted = 0
      LEFT JOIN suppliers s ON s.id = sr.supplier_id AND s.is_deleted = 0
      LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id AND po.is_deleted = 0
      LEFT JOIN inbound_records ir ON ir.id = sr.inbound_record_id AND ir.is_deleted = 0
      WHERE sr.id = ? AND sr.is_deleted = 0
    `).get(req.params.id) as any
    if (!row) { error(res, 'Supplier return not found', 'NOT_FOUND', 404); return }
    success(res, responseRow(row))
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireWriteAccess, (req, res) => {
  try {
    const {
      materialId, batchId, quantity, supplierId, purchaseOrderId, inboundRecordId,
      reason, refundAmount, trackingNo, operator, remark,
    } = req.body
    const normalizedQuantity = parseFinitePositiveNumber(quantity)
    const refund = refundAmount === undefined ? 0 : parseFiniteNonNegativeNumber(refundAmount)
    if (!materialId || normalizedQuantity === null || !reason || refund === null) {
      error(res, 'Material, positive quantity, reason, and a valid refund are required', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    if (!db.prepare('SELECT id FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)) {
      error(res, 'Material not found', 'NOT_FOUND', 404); return
    }
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'supplier-return:create'
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator || 'system')
      let pinnedBatchId = batchId || null
      let sourceInbound: any = null
      if (inboundRecordId) {
        sourceInbound = db.prepare(`
          SELECT * FROM inbound_records
          WHERE id = ? AND is_deleted = 0 AND status = 'completed'
        `).get(inboundRecordId) as any
        if (!sourceInbound || sourceInbound.material_id !== materialId || !sourceInbound.batch_id) {
          error(res, 'Inbound source is unavailable or belongs to another material', 'INBOUND_SOURCE_INVALID', 422)
          db.exec('ROLLBACK')
          return
        }
        if (pinnedBatchId && pinnedBatchId !== sourceInbound.batch_id) {
          error(res, 'Batch does not match the inbound source', 'INBOUND_SOURCE_INVALID', 422)
          db.exec('ROLLBACK')
          return
        }
        pinnedBatchId = sourceInbound.batch_id
      }
      const id = uuidv4()
      const plan = planInventoryDeductions(db, [{
        materialId,
        quantity: normalizedQuantity,
        pinnedBatchId,
        ownerLineId: id,
      }])
      const exactBatchId = plan.allocations.length === 1 ? plan.allocations[0].batchId : null
      const exactBatchNo = plan.allocations.length === 1 ? plan.allocations[0].batchNo : null
      db.prepare(`
        INSERT INTO supplier_returns
          (id, return_no, material_id, batch_id, batch_no, quantity, supplier_id, purchase_order_id,
           inbound_record_id, reason, refund_amount, tracking_no, status, operator, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id, generateNo(), materialId, exactBatchId, exactBatchNo, normalizedQuantity,
        supplierId || sourceInbound?.supplier_id || null,
        purchaseOrderId || sourceInbound?.purchase_order_id || null,
        inboundRecordId || null, reason, refund, trackingNo || null, operator || 'system', remark || null,
      )
      applyInventoryPlan(db, plan)
      replaceAllocationFacts(db, { operationKind: 'supplier_return', ownerId: id, direction: 'out', allocations: plan.allocations })
      if (refund > loadAllocationRefundCap(db, id)) {
        error(res, 'Refund exceeds the exact allocated batch source cost', 'REFUND_EXCEEDS_SOURCE_COST', 422)
        db.exec('ROLLBACK')
        return
      }
      for (const allocation of plan.allocations) {
        db.prepare(`
          INSERT INTO stock_logs
            (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'supplier_return', ?, ?, ?, ?, ?, 'supplier_return', ?, 'supplier return')
        `).run(
          uuidv4(), allocation.materialId, -allocation.quantity,
          allocation.inventoryBefore, allocation.inventoryAfter, id, operator || 'system',
        )
      }
      const row = db.prepare('SELECT return_no FROM supplier_returns WHERE id = ?').get(id) as any
      responseEnvelope = buildSuccessEnvelope({ id, returnNo: row.return_no }, 'Supplier return created')
      if (idemKey) finalizeIdempotency(db, idemKey, 201, responseEnvelope)
      db.exec('COMMIT')
      res.status(201).json(responseEnvelope)
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }
  } catch (err: any) {
    const failure = inventoryErrorResponse(err)
    if (failure) { error(res, failure.message, failure.code, failure.status); return }
    error(res, err.message)
  }
})

router.put('/:id/status', requireWriteAccess, (req, res) => {
  try {
    const status = String(req.body.status || '')
    const validStatuses = ['pending', 'shipped', 'received', 'refunded', 'cancelled']
    if (!validStatuses.includes(status)) { error(res, 'Invalid status', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const idemKey = status === 'cancelled' ? readIdempotencyKey(req) : null
    const idemScope = `supplier-return:cancel:${req.params.id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (status === 'cancelled' && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const record = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Supplier return not found', 'NOT_FOUND', 404); return }
    const flow: Record<string, string[]> = {
      pending: ['shipped', 'cancelled'],
      shipped: ['received', 'cancelled'],
      received: ['refunded', 'cancelled'],
      refunded: [],
      cancelled: [],
    }
    if (!flow[record.status]?.includes(status)) {
      error(res, `Cannot change ${record.status} to ${status}`, 'INVALID_PARAMETER', 400); return
    }
    if (status !== 'cancelled') {
      db.prepare('UPDATE supplier_returns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id)
      success(res, { id: req.params.id, status }, 'Supplier return status updated')
      return
    }
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, req.body.operator || 'system')
      const facts = listActiveAllocationFacts(db, 'supplier_return', req.params.id)
      if (facts.length === 0) {
        error(res, 'Supplier return allocation is unavailable', 'ALLOCATION_NOT_FOUND', 409)
        db.exec('ROLLBACK')
        return
      }
      const plan = planExactInventoryAdditions(db, facts.map((fact) => ({
        materialId: fact.material_id,
        batchId: fact.batch_id,
        quantity: fact.quantity,
        ownerLineId: fact.id,
      })))
      applyInventoryPlan(db, plan)
      markAllocationFactsReversed(db, 'supplier_return', req.params.id)
      db.prepare("UPDATE supplier_returns SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id)
      for (const allocation of plan.allocations) {
        db.prepare(`
          INSERT INTO stock_logs
            (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'supplier_return_cancel', ?, 'supplier return cancellation')
        `).run(
          uuidv4(), allocation.materialId, allocation.quantity,
          allocation.inventoryBefore, allocation.inventoryAfter, req.params.id, req.body.operator || 'system',
        )
      }
      responseEnvelope = buildSuccessEnvelope({ id: req.params.id, status }, 'Supplier return cancelled')
      if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
      db.exec('COMMIT')
      res.status(200).json(responseEnvelope)
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }
  } catch (err: any) {
    const failure = inventoryErrorResponse(err)
    if (failure) { error(res, failure.message, failure.code, failure.status); return }
    error(res, err.message)
  }
})

router.put('/:id/refund-amount', requireWriteAccess, (req: any, res) => {
  try {
    const refund = parseFiniteNonNegativeNumber(req.body.refundAmount)
    if (refund === null) { error(res, 'Refund must be a finite non-negative number', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Supplier return not found', 'NOT_FOUND', 404); return }
    if (record.status === 'refunded') { error(res, 'Refund is locked', 'REFUND_LOCKED', 409); return }
    try {
      if (refund > loadAllocationRefundCap(db, req.params.id)) {
        error(res, 'Refund exceeds the exact allocated batch source cost', 'REFUND_EXCEEDS_SOURCE_COST', 422); return
      }
    } catch (err: any) {
      if (err?.allocationMissing) { error(res, err.message, 'ALLOCATION_NOT_FOUND', 409); return }
      throw err
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const locked = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
      if (!locked || locked.status === 'refunded') {
        error(res, 'Supplier return changed before update', 'CONCURRENT_MODIFICATION', 409)
        db.exec('ROLLBACK')
        return
      }
      const oldRefund = parseFiniteNonNegativeNumber(locked.refund_amount)
      if (oldRefund === null || refund > loadAllocationRefundCap(db, req.params.id)) {
        error(res, 'Refund source is corrupt or exceeded', 'REFUND_EXCEEDS_SOURCE_COST', 422)
        db.exec('ROLLBACK')
        return
      }
      db.prepare('UPDATE supplier_returns SET refund_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(refund, req.params.id)
      db.prepare(`
        INSERT INTO operation_logs (id, user_id, username, operation, description, request_data)
        VALUES (?, ?, ?, 'supplier_return_refund_amount', ?, ?)
      `).run(
        uuidv4(), req.user?.userId || null, req.user?.username || 'system',
        `Supplier return ${locked.return_no} refund changed from ${oldRefund} to ${refund}`,
        JSON.stringify({ returnId: req.params.id, oldRefund, newRefund: refund }),
      )
      db.exec('COMMIT')
      success(res, { id: req.params.id, refundAmount: refund }, 'Refund updated')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', requireWriteAccess, (req, res) => {
  try {
    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = `supplier-return:delete:${req.params.id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body || {}) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const record = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Supplier return not found', 'NOT_FOUND', 404); return }
    if (record.status !== 'pending') {
      error(res, 'Only pending supplier returns can be deleted', 'INVALID_PARAMETER', 400); return
    }
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, req.body?.operator || 'system')
      const facts = listActiveAllocationFacts(db, 'supplier_return', req.params.id)
      if (facts.length === 0) {
        error(res, 'Supplier return allocation is unavailable', 'ALLOCATION_NOT_FOUND', 409)
        db.exec('ROLLBACK')
        return
      }
      const plan = planExactInventoryAdditions(db, facts.map((fact) => ({
        materialId: fact.material_id,
        batchId: fact.batch_id,
        quantity: fact.quantity,
        ownerLineId: fact.id,
      })))
      db.prepare('UPDATE supplier_returns SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id)
      applyInventoryPlan(db, plan)
      markAllocationFactsReversed(db, 'supplier_return', req.params.id)
      for (const allocation of plan.allocations) {
        db.prepare(`
          INSERT INTO stock_logs
            (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'supplier_return_cancel', ?, 'supplier return deletion')
        `).run(
          uuidv4(), allocation.materialId, allocation.quantity,
          allocation.inventoryBefore, allocation.inventoryAfter, req.params.id, req.body?.operator || 'system',
        )
      }
      responseEnvelope = buildSuccessEnvelope(null, 'Supplier return deleted')
      if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
      db.exec('COMMIT')
      res.status(200).json(responseEnvelope)
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }
  } catch (err: any) {
    const failure = inventoryErrorResponse(err)
    if (failure) { error(res, failure.message, failure.code, failure.status); return }
    error(res, err.message)
  }
})

export default router
