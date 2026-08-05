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
  planPositionAdditions,
  replaceAllocationFacts,
  type InventoryPlan,
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
const RESERVED_INBOUND_TYPES = new Set(['transfer', 'return'])

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
    error(
      res,
      record.type === 'transfer'
        ? 'Transfer records are immutable through the inbound route'
        : 'Completed inventory facts require an append-only compensation chain',
      record.type === 'transfer' ? 'ROUTE_OWNERSHIP_VIOLATION' : 'COMPENSATION_CHAIN_REQUIRED',
      409,
    )
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
    if (!type || RESERVED_INBOUND_TYPES.has(type) || !materialId || qty === null || normalizedPrice === null || amount === null || !locationId) {
      error(res, 'Missing or invalid inbound fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const material = db.prepare('SELECT unit, batch_managed FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, 'Material not found', 'NOT_FOUND', 404); return }
    const normalizedBatchNo = String(batchNo || '').trim()
    if (material.batch_managed === 1 && !normalizedBatchNo) {
      error(res, 'Batch number is required for a batch-managed material', 'BATCH_REQUIRED', 400); return
    }
    if (material.batch_managed === 0 && normalizedBatchNo) {
      error(res, 'Non-batch material cannot use a batch number', 'BATCH_FORBIDDEN', 400); return
    }
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
      const existingBatch = material.batch_managed === 1
        ? resolveBatch(db, materialId, normalizedBatchNo)
        : null
      const batchId = material.batch_managed === 1 ? (existingBatch?.id || uuidv4()) : null
      const plan = material.batch_managed === 1
        ? planBatchDeltas(db, [{
          materialId,
          batchId: batchId!,
          locationId,
          quantityDelta: qty,
          remainingDelta: qty,
          ownerLineId: id,
          create: existingBatch ? undefined : {
            id: batchId!,
            materialId,
            batchNo: normalizedBatchNo,
            quantity: qty,
            remaining: qty,
            productionDate: productionDate || null,
            expiryDate: expiryDate || null,
            inboundId: id,
            inboundPrice: normalizedPrice,
            supplierId: supplierId || null,
          },
        }])
        : planPositionAdditions(db, [{
          materialId,
          batchId: null,
          locationId,
          quantity: qty,
          ownerLineId: id,
        }], { operationKind: 'inbound', ownerId: id })
      db.prepare(`
        INSERT INTO inbound_records
          (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
           supplier_id, location_id, production_date, expiry_date, operator, status, remark,
           purchase_order_id, purchase_order_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
      `).run(
        id, inboundNo, type, materialId, batchId, normalizedBatchNo || null, qty, unit || material.unit || 'pcs',
        normalizedPrice, amount, supplierId || null, locationId, productionDate || null, expiryDate || null,
        operator || 'system', remark || null, purchaseOrderId || null, purchaseOrderNo || null,
      )
      applyInventoryPlan(db, plan)
      db.prepare(`
        UPDATE inventory
        SET last_inbound_id = ?, last_inbound_date = date('now','localtime')
        WHERE material_id = ?
      `).run(id, materialId)
      replaceAllocationFacts(db, {
        operationKind: 'inbound',
        ownerId: id,
        direction: 'in',
        allocations: plan.allocations,
      })
      updatePurchaseOrderReceived(db, purchaseOrderId || null, qty)
      writePlanLogs(db, plan, id, 'inbound', operator || 'system')
      responseEnvelope = buildSuccessEnvelope({
        id,
        inboundNo,
        materialId,
        batchId,
        batchNo: normalizedBatchNo || null,
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
    if (record.status === 'completed') {
      error(
        res,
        record.type === 'transfer'
          ? 'Transfer records are immutable through the inbound route'
          : 'Completed inventory facts require an append-only compensation chain',
        record.type === 'transfer' ? 'ROUTE_OWNERSHIP_VIOLATION' : 'COMPENSATION_CHAIN_REQUIRED',
        409,
      )
      return
    }
    const qty = req.body.quantity === undefined ? normalizeQuantity(record.quantity) : normalizeQuantity(req.body.quantity)
    const price = req.body.price === undefined ? normalizePrice(record.price) : normalizePrice(req.body.price)
    const amount = qty === null || price === null ? null : calculateAmount(qty, price)
    const nextStatus = req.body.status ?? record.status
    const materialId = req.body.materialId ?? record.material_id
    const batchNo = String(req.body.batchNo ?? record.batch_no ?? '').trim()
    const locationId = req.body.locationId ?? record.location_id
    const material = db.prepare(
      'SELECT unit, batch_managed FROM materials WHERE id = ? AND is_deleted = 0',
    ).get(materialId) as any
    if (!material) { error(res, 'Material not found', 'NOT_FOUND', 404); return }
    if (qty === null || price === null || amount === null || !locationId || !['completed', 'cancelled'].includes(nextStatus)) {
      error(res, 'Invalid inbound update', 'INVALID_PARAMETER', 400); return
    }
    if (nextStatus === 'completed' && material.batch_managed === 1 && !batchNo) {
      error(res, 'Batch number is required for a batch-managed material', 'BATCH_REQUIRED', 400); return
    }
    if (nextStatus === 'completed' && material.batch_managed === 0 && batchNo) {
      error(res, 'Non-batch material cannot use a batch number', 'BATCH_FORBIDDEN', 400); return
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
      const lockedMaterial = db.prepare(
        'SELECT batch_managed FROM materials WHERE id = ? AND is_deleted = 0',
      ).get(materialId) as any
      if (!lockedMaterial || lockedMaterial.batch_managed !== material.batch_managed) {
        error(res, 'Material policy changed before update', 'CONCURRENT_MODIFICATION', 409)
        db.exec('ROLLBACK')
        return
      }
      let nextBatchId: string | null = null
      let plan: InventoryPlan = { materials: [], allocations: [] }
      if (nextStatus === 'completed' && material.batch_managed === 1) {
        const nextBatch = resolveBatch(db, materialId, batchNo)
        const resolvedNextBatchId: string = nextBatch?.id || uuidv4()
        nextBatchId = resolvedNextBatchId
        plan = planBatchDeltas(db, [{
            materialId,
            batchId: resolvedNextBatchId,
            locationId,
            quantityDelta: qty,
            remainingDelta: qty,
            ownerLineId: locked.id,
            create: nextBatch ? undefined : {
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
            },
          }])
      } else if (nextStatus === 'completed') {
        plan = planPositionAdditions(db, [{
          materialId,
          batchId: null,
          locationId,
          quantity: qty,
          ownerLineId: locked.id,
        }], { operationKind: 'inbound', ownerId: locked.id })
      }
      applyInventoryPlan(db, plan)
      if (nextStatus === 'completed') {
        db.prepare(`
          UPDATE inventory
          SET last_inbound_id = ?, last_inbound_date = date('now','localtime')
          WHERE material_id = ?
        `).run(locked.id, materialId)
      }
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
        batchNo || null,
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
      if (nextStatus === 'completed') {
        replaceAllocationFacts(db, {
          operationKind: 'inbound',
          ownerId: locked.id,
          direction: 'in',
          allocations: plan.allocations,
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
    const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, 'Inbound record not found', 'NOT_FOUND', 404); return }
    if (record.status === 'completed') {
      error(res, 'Completed inventory facts require an append-only compensation chain', 'COMPENSATION_CHAIN_REQUIRED', 409)
      return
    }
    if (!deleteRecord) { error(res, 'Inbound record is not completed', 'INVALID_PARAMETER', 400); return }

    const idemKey = readIdempotencyKey(req)
    const idemScope = `inbound:delete:${req.params.id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body || {}) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, req.body?.operator || 'system')
      const locked = db.prepare('SELECT status FROM inbound_records WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
      if (!locked || locked.status === 'completed') {
        error(res, 'Inbound record changed before deletion', 'CONCURRENT_MODIFICATION', 409)
        db.exec('ROLLBACK')
        return
      }
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
