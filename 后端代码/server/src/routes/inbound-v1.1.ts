import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { buildSuccessEnvelope, error, success, successList } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  parseFiniteNonNegativeNumber,
  parseFinitePositiveNumber,
} from '../utils/numeric-input.js'
import {
  applyInventoryPlan,
  inventoryErrorResponse,
  inventoryQuantityDelta,
  listActiveAllocationFacts,
  markAllocationFactsReversed,
  planBatchDeltas,
  replaceAllocationFacts,
  type BatchDeltaInput,
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
const requireWriteAccess = requirePermission('inbound', 'W')

function generateInboundNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `IB-${date}-${timestamp}-${random}`
}

function normalizePrice(value: unknown): number | null {
  return value === undefined ? 0 : parseFiniteNonNegativeNumber(value)
}

function normalizeQuantity(value: unknown): number | null {
  return parseFinitePositiveNumber(value)
}

function calculateAmount(quantity: number, price: number): number | null {
  return checkedMultiply(quantity, price)
}

function resolveBatch(db: any, materialId: string, batchNo: string): any | null {
  return db.prepare(`
    SELECT * FROM batches
    WHERE material_id = ? AND batch_no = ?
  `).get(materialId, batchNo) as any
}

function updatePurchaseOrderReceived(db: any, purchaseOrderId: string | null, delta: number): void {
  if (!purchaseOrderId || delta === 0) return
  const row = db.prepare(`
    SELECT ordered_qty, received_qty
    FROM purchase_orders
    WHERE id = ? AND is_deleted = 0
  `).get(purchaseOrderId) as any
  if (!row) throw Object.assign(new Error('Purchase order not found'), { code: 'PURCHASE_ORDER_NOT_FOUND' })
  const ordered = parseFiniteNonNegativeNumber(row.ordered_qty)
  const received = parseFiniteNonNegativeNumber(row.received_qty)
  if (ordered === null || received === null) throw new Error('Purchase order quantity is corrupt')
  const next = delta > 0 ? checkedAdd(received, delta) : checkedSubtract(received, -delta)
  if (next === null || next < 0) throw new Error('Purchase order received quantity exceeds the supported range')
  const status = next === 0 ? 'pending' : next >= ordered ? 'received' : 'partial'
  db.prepare(`
    UPDATE purchase_orders
    SET received_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(next, status, purchaseOrderId)
}

function writePlanLogs(db: any, plan: any, relatedId: string, relatedType: string, operator: string, remark?: string): void {
  for (const allocation of plan.allocations) {
    const delta = inventoryQuantityDelta(allocation.inventoryAfter, allocation.inventoryBefore)
    db.prepare(`
      INSERT INTO stock_logs
        (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      delta >= 0 ? 'inbound' : 'cancel',
      allocation.materialId,
      delta,
      allocation.inventoryBefore,
      allocation.inventoryAfter,
      relatedId,
      relatedType,
      operator,
      remark || null,
    )
  }
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20 } = req.query as any
    const { keyword, type, materialId, supplierId, status, startDate, endDate } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    let where = 'r.is_deleted = 0'
    const params: any[] = []
    if (type) { where += ' AND r.type = ?'; params.push(type) }
    if (materialId) { where += ' AND r.material_id = ?'; params.push(materialId) }
    if (supplierId) { where += ' AND r.supplier_id = ?'; params.push(supplierId) }
    if (status) { where += ' AND r.status = ?'; params.push(status) }
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }
    if (keyword) {
      where += ' AND (r.inbound_no LIKE ? OR r.batch_no LIKE ? OR m.name LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }
    const db = getDatabase()
    const total = (db.prepare(`
      SELECT COUNT(*) AS total
      FROM inbound_records r
      LEFT JOIN materials m ON m.id = r.material_id AND m.is_deleted = 0
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const list = db.prepare(`
      SELECT r.*, m.name AS material_name, s.name AS supplier_name, l.name AS location_name
      FROM inbound_records r
      LEFT JOIN materials m ON m.id = r.material_id AND m.is_deleted = 0
      LEFT JOIN suppliers s ON s.id = r.supplier_id AND s.is_deleted = 0
      LEFT JOIN locations l ON l.id = r.location_id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as any[]
    successList(res, list.map((row) => ({
      id: row.id,
      inboundNo: row.inbound_no,
      type: row.type,
      materialId: row.material_id,
      materialName: row.material_name,
      batchId: row.batch_id,
      batchNo: row.batch_no,
      quantity: row.quantity,
      unit: row.unit,
      price: row.price,
      amount: row.amount,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      locationId: row.location_id,
      locationName: row.location_name,
      productionDate: row.production_date,
      expiryDate: row.expiry_date,
      operator: row.operator,
      status: row.status,
      remark: row.remark,
      createdAt: row.created_at,
    })), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.get('/stats', (_req, res) => {
  try {
    const db = getDatabase()
    const total = (db.prepare('SELECT COUNT(*) c FROM inbound_records WHERE is_deleted = 0').get() as any)?.c || 0
    const completed = (db.prepare("SELECT COUNT(*) c FROM inbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    const cancelled = (db.prepare("SELECT COUNT(*) c FROM inbound_records WHERE is_deleted = 0 AND status = 'cancelled'").get() as any)?.c || 0
    const totalAmount = (db.prepare("SELECT COALESCE(SUM(amount),0) c FROM inbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    success(res, { total, completed, cancelled, totalAmount })
  } catch (err: any) { error(res, err.message) }
})

router.get('/:id/check-deletable', (req, res) => {
  try {
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Inbound record not found', 'NOT_FOUND', 404); return }
    if (record.status !== 'completed') { success(res, { deletable: true }); return }
    if (!record.batch_id) { success(res, { deletable: false, reason: 'Batch allocation is unavailable' }); return }
    const batch = db.prepare('SELECT quantity, remaining FROM batches WHERE id = ? AND material_id = ?').get(record.batch_id, record.material_id) as any
    const inUse = (db.prepare("SELECT COUNT(*) c FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'")
      .get(record.material_id, record.batch_no) as any)?.c || 0
    const remaining = batch ? parseFiniteNonNegativeNumber(batch.remaining) : null
    const inboundQuantity = normalizeQuantity(record.quantity)
    if (batch && (remaining === null || inboundQuantity === null)) {
      error(res, 'Inbound batch quantity is corrupt', 'INVENTORY_LEDGER_CORRUPT', 409)
      return
    }
    const deletable = Boolean(batch) && remaining! >= inboundQuantity! && Number(inUse) === 0
    success(res, { deletable, reason: deletable ? null : 'Batch has been consumed or is in use' })
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireWriteAccess, (req, res) => {
  try {
    const {
      type, materialId, batchNo, quantity, unit, price, supplierId, locationId,
      productionDate, expiryDate, operator, remark, purchaseOrderId, purchaseOrderNo,
    } = req.body
    const qty = normalizeQuantity(quantity)
    const normalizedPrice = normalizePrice(price)
    const amount = qty === null || normalizedPrice === null ? null : calculateAmount(qty, normalizedPrice)
    if (!type || !materialId || !String(batchNo || '').trim() || qty === null || normalizedPrice === null || amount === null || !locationId) {
      error(res, 'Missing or invalid inbound fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const material = db.prepare('SELECT unit FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, 'Material not found', 'NOT_FOUND', 404); return }
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'inbound:create'
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const id = uuidv4()
    const inboundNo = generateInboundNo()
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator || 'system')
      const existingBatch = resolveBatch(db, materialId, String(batchNo).trim())
      const batchId = existingBatch?.id || uuidv4()
      const plan = planBatchDeltas(db, [{
        materialId,
        batchId,
        quantityDelta: qty,
        remainingDelta: qty,
        ownerLineId: id,
        create: existingBatch ? undefined : {
          id: batchId,
          materialId,
          batchNo: String(batchNo).trim(),
          quantity: qty,
          remaining: qty,
          productionDate: productionDate || null,
          expiryDate: expiryDate || null,
          inboundId: id,
          inboundPrice: normalizedPrice,
          supplierId: supplierId || null,
        },
      }])
      db.prepare(`
        INSERT INTO inbound_records
          (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
           supplier_id, location_id, production_date, expiry_date, operator, status, remark,
           purchase_order_id, purchase_order_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
      `).run(
        id, inboundNo, type, materialId, batchId, String(batchNo).trim(), qty, unit || material.unit || 'pcs',
        normalizedPrice, amount, supplierId || null, locationId, productionDate || null, expiryDate || null,
        operator || 'system', remark || null, purchaseOrderId || null, purchaseOrderNo || null,
      )
      applyInventoryPlan(db, plan)
      db.prepare(`
        UPDATE inventory
        SET location_id = ?, last_inbound_id = ?, last_inbound_date = date('now','localtime')
        WHERE material_id = ?
      `).run(locationId, id, materialId)
      replaceAllocationFacts(db, {
        operationKind: 'inbound',
        ownerId: id,
        direction: 'in',
        allocations: [{ materialId, batchId, quantity: qty, ownerLineId: id }],
      })
      updatePurchaseOrderReceived(db, purchaseOrderId || null, qty)
      writePlanLogs(db, plan, id, 'inbound', operator || 'system')
      responseEnvelope = buildSuccessEnvelope({
        id,
        inboundNo,
        materialId,
        batchId,
        batchNo: String(batchNo).trim(),
        quantity: qty,
        price: normalizedPrice,
        status: 'completed',
      }, 'Inbound created')
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
    if (err?.code === 'PURCHASE_ORDER_NOT_FOUND') { error(res, err.message, err.code, 422); return }
    error(res, err.message)
  }
})

router.put('/:id', requireWriteAccess, (req, res) => {
  try {
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Inbound record not found', 'NOT_FOUND', 404); return }
    const qty = req.body.quantity === undefined ? normalizeQuantity(record.quantity) : normalizeQuantity(req.body.quantity)
    const price = req.body.price === undefined ? normalizePrice(record.price) : normalizePrice(req.body.price)
    const amount = qty === null || price === null ? null : calculateAmount(qty, price)
    const nextStatus = req.body.status ?? record.status
    const materialId = req.body.materialId ?? record.material_id
    const batchNo = String(req.body.batchNo ?? record.batch_no ?? '').trim()
    const locationId = req.body.locationId ?? record.location_id
    if (qty === null || price === null || amount === null || !batchNo || !locationId || !['completed', 'cancelled'].includes(nextStatus)) {
      error(res, 'Invalid inbound update', 'INVALID_PARAMETER', 400); return
    }
    const idemKey = readIdempotencyKey(req)
    const idemScope = `inbound:update:${req.params.id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, req.body.operator || record.operator || 'system')
      const locked = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
      if (!locked || JSON.stringify(locked) !== JSON.stringify(record)) {
        error(res, 'Inbound record changed before update', 'CONCURRENT_MODIFICATION', 409)
        db.exec('ROLLBACK')
        return
      }
      const oldQty = normalizeQuantity(locked.quantity)
      if (oldQty === null) throw new Error('Inbound source quantity is corrupt')
      const deltas: BatchDeltaInput[] = []
      let oldBatch: any = null
      if (locked.status === 'completed') {
        oldBatch = locked.batch_id
          ? db.prepare('SELECT * FROM batches WHERE id = ? AND material_id = ?').get(locked.batch_id, locked.material_id)
          : resolveBatch(db, locked.material_id, locked.batch_no)
        if (!oldBatch) {
          error(res, 'Inbound batch allocation is unavailable', 'ALLOCATION_NOT_FOUND', 409)
          db.exec('ROLLBACK')
          return
        }
      }
      let nextBatch: any = null
      let nextBatchId: string | null = null
      let nextBatchCreate: BatchDeltaInput['create']
      if (nextStatus === 'completed') {
        nextBatch = resolveBatch(db, materialId, batchNo)
        const resolvedNextBatchId: string = nextBatch?.id || uuidv4()
        nextBatchId = resolvedNextBatchId
        nextBatchCreate = nextBatch ? undefined : {
          id: resolvedNextBatchId,
          materialId,
          batchNo,
          quantity: qty,
          remaining: qty,
          productionDate: req.body.productionDate ?? locked.production_date,
          expiryDate: req.body.expiryDate ?? locked.expiry_date,
          inboundId: locked.id,
          inboundPrice: price,
          supplierId: req.body.supplierId ?? locked.supplier_id,
        }
      }
      if (locked.status === 'completed' && nextStatus === 'completed'
        && oldBatch.id === nextBatchId && locked.material_id === materialId) {
        deltas.push({
          materialId,
          batchId: nextBatchId!,
          quantityDelta: qty - oldQty,
          remainingDelta: qty - oldQty,
          ownerLineId: locked.id,
        })
      } else {
        if (locked.status === 'completed') {
          deltas.push({
            materialId: locked.material_id,
            batchId: oldBatch.id,
            quantityDelta: -oldQty,
            remainingDelta: -oldQty,
            ownerLineId: locked.id,
          })
        }
        if (nextStatus === 'completed' && nextBatchId) {
          deltas.push({
            materialId,
            batchId: nextBatchId,
            quantityDelta: qty,
            remainingDelta: qty,
            ownerLineId: locked.id,
            create: nextBatchCreate,
          })
        }
      }
      const plan = deltas.length > 0 ? planBatchDeltas(db, deltas) : { materials: [], allocations: [] }
      applyInventoryPlan(db, plan)
      if (nextStatus === 'completed') {
        db.prepare(`
          UPDATE inventory
          SET location_id = ?, last_inbound_id = ?, last_inbound_date = date('now','localtime')
          WHERE material_id = ?
        `).run(locationId, locked.id, materialId)
      }
      if (locked.status === 'completed') updatePurchaseOrderReceived(db, locked.purchase_order_id, -oldQty)
      const nextPurchaseOrderId = req.body.purchaseOrderId ?? locked.purchase_order_id
      if (nextStatus === 'completed') updatePurchaseOrderReceived(db, nextPurchaseOrderId, qty)
      db.prepare(`
        UPDATE inbound_records
        SET type = ?, material_id = ?, batch_id = ?, batch_no = ?, quantity = ?, unit = ?,
          price = ?, amount = ?, supplier_id = ?, location_id = ?, production_date = ?,
          expiry_date = ?, operator = ?, status = ?, remark = ?, cancel_reason = ?,
          purchase_order_id = ?, purchase_order_no = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        req.body.type ?? locked.type,
        materialId,
        nextBatchId,
        batchNo,
        qty,
        req.body.unit ?? locked.unit,
        price,
        amount,
        req.body.supplierId ?? locked.supplier_id,
        locationId,
        req.body.productionDate ?? locked.production_date,
        req.body.expiryDate ?? locked.expiry_date,
        req.body.operator ?? locked.operator,
        nextStatus,
        req.body.remark ?? locked.remark,
        req.body.cancelReason ?? locked.cancel_reason,
        nextPurchaseOrderId,
        req.body.purchaseOrderNo ?? locked.purchase_order_no,
        locked.id,
      )
      if (nextStatus === 'completed' && nextBatchId) {
        replaceAllocationFacts(db, {
          operationKind: 'inbound',
          ownerId: locked.id,
          direction: 'in',
          allocations: [{ materialId, batchId: nextBatchId, quantity: qty, ownerLineId: locked.id }],
        })
      } else if (listActiveAllocationFacts(db, 'inbound', locked.id).length > 0) {
        markAllocationFactsReversed(db, 'inbound', locked.id)
      }
      writePlanLogs(db, plan, locked.id, 'inbound_update', req.body.operator || locked.operator || 'system', req.body.cancelReason)
      responseEnvelope = buildSuccessEnvelope({ id: locked.id, status: nextStatus }, 'Inbound updated')
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
    if (err?.code === 'PURCHASE_ORDER_NOT_FOUND') { error(res, err.message, err.code, 422); return }
    error(res, err.message)
  }
})

function cancelOrDeleteInbound(req: any, res: any, deleteRecord: boolean): void {
  try {
    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const action = deleteRecord ? 'delete' : 'cancel'
    const idemScope = `inbound:${action}:${req.params.id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body || {}) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Inbound record not found', 'NOT_FOUND', 404); return }
    if (record.status !== 'completed') {
      if (deleteRecord) {
        let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
        db.exec('BEGIN IMMEDIATE')
        try {
          if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, req.body?.operator || 'system')
          db.prepare('UPDATE inbound_records SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id)
          responseEnvelope = buildSuccessEnvelope(null, 'Inbound record deleted')
          if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
          db.exec('COMMIT')
          res.status(200).json(responseEnvelope)
        } catch (err) {
          db.exec('ROLLBACK')
          if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
          throw err
        }
        return
      }
      error(res, 'Inbound record is not completed', 'INVALID_PARAMETER', 400)
      return
    }
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, req.body?.operator || 'system')
      const locked = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
      if (!locked || locked.status !== 'completed') {
        error(res, 'Inbound record changed before cancellation', 'CONCURRENT_MODIFICATION', 409)
        db.exec('ROLLBACK')
        return
      }
      const qty = normalizeQuantity(locked.quantity)
      if (qty === null) throw new Error('Inbound source quantity is corrupt')
      const batch = locked.batch_id
        ? db.prepare('SELECT * FROM batches WHERE id = ? AND material_id = ?').get(locked.batch_id, locked.material_id)
        : resolveBatch(db, locked.material_id, locked.batch_no)
      if (!batch) {
        error(res, 'Inbound batch allocation is unavailable', 'ALLOCATION_NOT_FOUND', 409)
        db.exec('ROLLBACK')
        return
      }
      const plan = planBatchDeltas(db, [{
        materialId: locked.material_id,
        batchId: batch.id,
        quantityDelta: -qty,
        remainingDelta: -qty,
        ownerLineId: locked.id,
      }])
      applyInventoryPlan(db, plan)
      updatePurchaseOrderReceived(db, locked.purchase_order_id, -qty)
      db.prepare(`
        UPDATE inbound_records
        SET status = 'cancelled', cancel_reason = ?, is_deleted = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.body?.reason || req.body?.cancelReason || null, deleteRecord ? 1 : 0, locked.id)
      if (listActiveAllocationFacts(db, 'inbound', locked.id).length > 0) {
        markAllocationFactsReversed(db, 'inbound', locked.id)
      }
      writePlanLogs(db, plan, locked.id, deleteRecord ? 'inbound_delete' : 'inbound_cancel', req.body?.operator || 'system')
      responseEnvelope = buildSuccessEnvelope(null, deleteRecord ? 'Inbound record deleted' : 'Inbound record cancelled')
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
    if (err?.code === 'PURCHASE_ORDER_NOT_FOUND') { error(res, err.message, err.code, 422); return }
    error(res, err.message)
  }
}

router.delete('/:id', requireWriteAccess, (req, res) => cancelOrDeleteInbound(req, res, true))
router.post('/:id/cancel', requireWriteAccess, (req, res) => cancelOrDeleteInbound(req, res, false))

export default router
