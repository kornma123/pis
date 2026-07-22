import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { buildSuccessEnvelope, success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import { requireTrustedRequestActor, withoutUntrustedActorFields } from '../security/trusted-request-actor.js'
import { checkedMultiply, parseFiniteNonNegativeNumber, parseFinitePositiveNumber } from '../utils/numeric-input.js'
import {
  claimIdempotency,
  finalizeIdempotency,
  fingerprintRequest,
  isIdempotencyConflict,
  readIdempotencyKey,
  tryReplayIdempotency,
} from '../utils/idempotency.js'
import {
  consumeBatchStock,
  inventoryTransactionError,
  restoreBatchStock,
} from '../services/inventory-transactions.js'
import { assertLocationCapacityHeld, locationCapacityError } from '../utils/location-capacity.js'

const router = Router()

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `SR-${date}-${timestamp}-${random}`
}

// P1-14: 供应商退货为写操作（创建/流转/修正退款额/删除），finance 仅【只读】访问。
// 挂载层 supplier_returns R 给读权限；此端点级守卫要求 supplier_returns W（矩阵：admin/仓管/采购 W，finance R）。
const requireWriteAccess = requirePermission('supplier_returns', 'W')

// P1-13/P1-14: 退款额来源成本上界 = 来源单价 × 数量。
// 来源单价优先取关联入库单 price，其次该物料批次最近 inbound_price，最后 material.price。
// hasSource=false 表示所有候选均缺失/NULL/0（沿用“不设上界”）；0 继续回退到下一价格来源。
// valid=false 表示来源数据本身非法，必须 fail closed。
function resolveRefundCap(db: any, materialId: string, quantity: number, inboundRecordId?: string | null): { cap: number; valid: boolean; hasSource: boolean } {
  const normalizedQuantity = parseFinitePositiveNumber(quantity)
  if (normalizedQuantity === null) return { cap: 0, valid: false, hasSource: false }
  const candidates: unknown[] = []
  if (inboundRecordId) {
    const ir = db.prepare('SELECT price FROM inbound_records WHERE id = ? AND is_deleted = 0').get(inboundRecordId) as any
    if (ir) candidates.push(ir.price)
  }
  const batch = db.prepare('SELECT inbound_price FROM batches WHERE material_id = ? ORDER BY created_at DESC').get(materialId) as any
  if (batch) candidates.push(batch.inbound_price)
  const material = db.prepare('SELECT price FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
  if (material) candidates.push(material.price)

  for (const rawCost of candidates) {
    if (rawCost === null || rawCost === undefined) continue
    const sourceUnitCost = parseFiniteNonNegativeNumber(rawCost)
    if (sourceUnitCost === null) return { cap: 0, valid: false, hasSource: true }
    if (sourceUnitCost === 0) continue
    const cap = checkedMultiply(sourceUnitCost, normalizedQuantity)
    return cap === null
      ? { cap: 0, valid: false, hasSource: true }
      : { cap, valid: true, hasSource: true }
  }
  return { cap: 0, valid: true, hasSource: false }
}

// 列表查询
router.get('/', (req, res) => {
  try {
    let { keyword, status, supplierId, startDate, endDate, page = '1', pageSize = '20' } = req.query
    pageSize = String(Math.min(Number(pageSize), 200))
    const db = getDatabase()
    let sql = `
      SELECT sr.*, m.name as material_name, s.name as supplier_name, po.order_no as purchase_order_no, ir.inbound_no
      FROM supplier_returns sr
      LEFT JOIN materials m ON sr.material_id = m.id AND m.is_deleted = 0
      LEFT JOIN suppliers s ON sr.supplier_id = s.id AND s.is_deleted = 0
      LEFT JOIN purchase_orders po ON sr.purchase_order_id = po.id AND po.is_deleted = 0
      LEFT JOIN inbound_records ir ON sr.inbound_record_id = ir.id AND ir.is_deleted = 0
      WHERE sr.is_deleted = 0
    `
    const params: any[] = []
    if (status) { sql += ' AND sr.status = ?'; params.push(status) }
    if (supplierId) { sql += ' AND sr.supplier_id = ?'; params.push(supplierId) }
    if (startDate) { sql += ' AND date(sr.created_at) >= ?'; params.push(startDate) }
    if (endDate) { sql += ' AND date(sr.created_at) <= ?'; params.push(endDate) }
    if (keyword) {
      sql += ' AND (sr.return_no LIKE ? OR m.name LIKE ? OR sr.reason LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }
    sql += ' ORDER BY sr.created_at DESC'
    const limit = parseInt(pageSize as string, 10)
    const offset = (parseInt(page as string, 10) - 1) * limit
    sql += ' LIMIT ? OFFSET ?'
    params.push(limit, offset)
    const list = db.prepare(sql).all(...params) as any[]

    const countSql = `
      SELECT COUNT(*) as total FROM supplier_returns sr
      LEFT JOIN materials m ON sr.material_id = m.id AND m.is_deleted = 0
      WHERE sr.is_deleted = 0
      ${status ? ' AND sr.status = ?' : ''}
      ${supplierId ? ' AND sr.supplier_id = ?' : ''}
      ${startDate ? ' AND date(sr.created_at) >= ?' : ''}
      ${endDate ? ' AND date(sr.created_at) <= ?' : ''}
      ${keyword ? ' AND (sr.return_no LIKE ? OR m.name LIKE ? OR sr.reason LIKE ?)' : ''}
    `
    const countParams: any[] = []
    if (status) countParams.push(status)
    if (supplierId) countParams.push(supplierId)
    if (startDate) countParams.push(startDate)
    if (endDate) countParams.push(endDate)
    if (keyword) countParams.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    const total = (db.prepare(countSql).get(...countParams) as any)?.total || 0

    successList(res, list.map(r => ({
      id: r.id,
      returnNo: r.return_no,
      materialId: r.material_id,
      materialName: r.material_name,
      batchId: r.batch_id,
      batchNo: r.batch_no,
      quantity: Number(r.quantity),
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      purchaseOrderId: r.purchase_order_id,
      purchaseOrderNo: r.purchase_order_no,
      inboundRecordId: r.inbound_record_id,
      inboundNo: r.inbound_no,
      reason: r.reason,
      refundAmount: Number(r.refund_amount),
      trackingNo: r.tracking_no,
      status: r.status,
      operator: r.operator,
      remark: r.remark,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })), parseInt(page as string, 10), limit, total)
  } catch (err: any) { error(res, err.message) }
})

// 详情
router.get('/:id', (req, res) => {
  try {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT sr.*, m.name as material_name, s.name as supplier_name, po.order_no as purchase_order_no, ir.inbound_no
      FROM supplier_returns sr
      LEFT JOIN materials m ON sr.material_id = m.id AND m.is_deleted = 0
      LEFT JOIN suppliers s ON sr.supplier_id = s.id AND s.is_deleted = 0
      LEFT JOIN purchase_orders po ON sr.purchase_order_id = po.id AND po.is_deleted = 0
      LEFT JOIN inbound_records ir ON sr.inbound_record_id = ir.id AND ir.is_deleted = 0
      WHERE sr.id = ? AND sr.is_deleted = 0
    `).get(req.params.id) as any
    if (!row) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    success(res, {
      id: row.id,
      returnNo: row.return_no,
      materialId: row.material_id,
      materialName: row.material_name,
      batchId: row.batch_id,
      batchNo: row.batch_no,
      quantity: Number(row.quantity),
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      purchaseOrderId: row.purchase_order_id,
      purchaseOrderNo: row.purchase_order_no,
      inboundRecordId: row.inbound_record_id,
      inboundNo: row.inbound_no,
      reason: row.reason,
      refundAmount: Number(row.refund_amount),
      trackingNo: row.tracking_no,
      status: row.status,
      operator: row.operator,
      remark: row.remark,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch (err: any) { error(res, err.message) }
})

// 创建退货记录
router.post('/', requireWriteAccess, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { materialId, batchId, batchNo, quantity, supplierId, purchaseOrderId, inboundRecordId, reason, refundAmount, trackingNo, remark } = req.body
    const normalizedQuantity = parseFinitePositiveNumber(quantity)
    if (!materialId || normalizedQuantity === null || !reason) {
      error(res, '物料、数量和退货原因必填', 'INVALID_PARAMETER', 400); return
    }
    const refund = refundAmount === undefined ? 0 : parseFiniteNonNegativeNumber(refundAmount)
    if (refund === null) {
      error(res, '退款金额必须为有限非负数', 'INVALID_PARAMETER', 400); return
    }
    const requestedBatchId = typeof batchId === 'string' && batchId.trim() ? batchId.trim() : null
    const requestedBatchNo = typeof batchNo === 'string' && batchNo.trim() ? batchNo.trim() : null
    if ((batchId !== undefined && !requestedBatchId) || (batchNo !== undefined && !requestedBatchNo)) {
      error(res, '批次参数无效', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'supplier-return:create'
    const idemFingerprint = idemKey ? fingerprintRequest(withoutUntrustedActorFields(req.body)) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }

    // P1-13: 退款金额与来源成本勾稽，refundAmount 不得超过 来源单价 × 数量。
    if (refund > 0) {
      const refundCap = resolveRefundCap(db, materialId, normalizedQuantity, inboundRecordId)
      if (!refundCap.valid) {
        error(res, '退款来源成本超出支持的数值范围', 'INVALID_PARAMETER', 400); return
      }
      // 浮点容差，避免边界等值误判
      if (refundCap.hasSource && refund > refundCap.cap + 1e-6) {
        error(res, `退款金额(${refund})超过来源成本上界(${refundCap.cap})`, 'REFUND_EXCEEDS_SOURCE_COST', 422); return
      }
    }

    const id = uuidv4()
    const returnNo = generateNo()
    const op = actor.username
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, op)
      const lockedMaterial = db.prepare('SELECT 1 FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)
      if (!lockedMaterial) {
        db.exec('ROLLBACK')
        error(res, '物料不存在或已删除', 'NOT_FOUND', 404)
        return
      }
      if (refund > 0) {
        const lockedRefundCap = resolveRefundCap(db, materialId, normalizedQuantity, inboundRecordId)
        if (!lockedRefundCap.valid) {
          db.exec('ROLLBACK')
          error(res, '退款来源成本超出支持的数值范围', 'INVALID_PARAMETER', 400); return
        }
        if (lockedRefundCap.hasSource && refund > lockedRefundCap.cap + 1e-6) {
          db.exec('ROLLBACK')
          error(res, `退款金额(${refund})超过来源成本上界(${lockedRefundCap.cap})`, 'REFUND_EXCEEDS_SOURCE_COST', 422); return
        }
      }

      let selectedBatchId = requestedBatchId
      let selectedBatchNo = requestedBatchNo
      if (!selectedBatchId && !selectedBatchNo && inboundRecordId) {
        const sourceInbound = db.prepare(`
          SELECT material_id, batch_id, batch_no
          FROM inbound_records
          WHERE id = ? AND is_deleted = 0
        `).get(inboundRecordId) as any
        if (!sourceInbound) {
          db.exec('ROLLBACK')
          error(res, '关联入库记录不存在', 'NOT_FOUND', 404)
          return
        }
        if (sourceInbound.material_id !== materialId) {
          db.exec('ROLLBACK')
          error(res, '关联入库记录与退货物料不一致', 'INVALID_PARAMETER', 400)
          return
        }
        selectedBatchId = sourceInbound.batch_id || null
        selectedBatchNo = sourceInbound.batch_no || null
      }
      if (selectedBatchId && selectedBatchNo) {
        const selectedBatch = db.prepare('SELECT batch_no FROM batches WHERE id = ? AND material_id = ?')
          .get(selectedBatchId, materialId) as any
        if (!selectedBatch || selectedBatch.batch_no !== selectedBatchNo) {
          db.exec('ROLLBACK')
          error(res, '批次编号与批次标识不一致', 'INVALID_PARAMETER', 400)
          return
        }
      }

      const stockMutation = consumeBatchStock(
        db,
        materialId,
        normalizedQuantity,
        { batchId: selectedBatchId, batchNo: selectedBatchNo },
      )
      const persistedBatch = stockMutation.allocations.length === 1 ? stockMutation.allocations[0] : null
      db.prepare(`
        INSERT INTO supplier_returns (id, return_no, material_id, batch_id, batch_no, quantity, supplier_id, purchase_order_id, inbound_record_id, reason, refund_amount, tracking_no, status, operator, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(id, returnNo, materialId, persistedBatch?.batchId || null, persistedBatch?.batchNo || null, normalizedQuantity, supplierId || null, purchaseOrderId || null, inboundRecordId || null, reason, refund, trackingNo || null, op, remark || null)

      // 写库存流水
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'supplier_return', ?, ?, ?, ?, ?, 'supplier_return', ?, ?)
      `).run(logId, materialId, -normalizedQuantity, stockMutation.inventory.before, stockMutation.inventory.after, id, op, '退货给供应商')

      responseEnvelope = buildSuccessEnvelope({ id, returnNo }, '退货记录创建成功')
      if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(e) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw e
    }

    res.status(200).json(responseEnvelope)
  } catch (err: any) {
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    error(res, err.message)
  }
})

// 更新状态
router.put('/:id/status', requireWriteAccess, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { status } = req.body
    const validStatuses = ['pending', 'shipped', 'received', 'refunded', 'cancelled']
    if (!status || !validStatuses.includes(status)) {
      error(res, '无效的状态', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    let record = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }

    // 状态流转校验
    const flow: Record<string, string[]> = {
      pending: ['shipped', 'cancelled'],
      shipped: ['received', 'cancelled'],
      received: ['refunded', 'cancelled'],
      refunded: [],
      cancelled: [],
    }
    if (!flow[record.status].includes(status)) {
      error(res, `不能从 ${record.status} 变更为 ${status}`, 'INVALID_PARAMETER', 400); return
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const lockedRecord = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
      if (!lockedRecord) {
        db.exec('ROLLBACK')
        error(res, '记录不存在', 'NOT_FOUND', 404)
        return
      }
      if (!flow[lockedRecord.status]?.includes(status)) {
        db.exec('ROLLBACK')
        error(res, `不能从 ${lockedRecord.status} 变更为 ${status}`, 'INVALID_PARAMETER', 400)
        return
      }

      if (status === 'cancelled') {
        const normalizedQuantity = parseFinitePositiveNumber(lockedRecord.quantity)
        if (normalizedQuantity === null) {
          db.exec('ROLLBACK')
          error(res, '退货数量超出支持的数值范围', 'INVALID_PARAMETER', 400)
          return
        }
        const batchFromNo = !lockedRecord.batch_id && lockedRecord.batch_no
          ? db.prepare('SELECT id FROM batches WHERE material_id = ? AND batch_no = ?')
            .get(lockedRecord.material_id, lockedRecord.batch_no) as any
          : null
        const exactBatchId = lockedRecord.batch_id || batchFromNo?.id || null
        if (!exactBatchId) {
          db.exec('ROLLBACK')
          error(res, '原退货批次分配不可精确还原，禁止取消', 'LEDGER_DRIFT', 409)
          return
        }
        const inventorySnapshot = restoreBatchStock(
          db,
          lockedRecord.material_id,
          [{ batchId: exactBatchId, quantity: normalizedQuantity }],
        )
        // 库位容量门（LOC-029）：取消退货恢复物料当前库位占用，锁内重读库位与占用事实，超容抛错回滚
        const cancelLocationId = (db.prepare('SELECT location_id FROM inventory WHERE material_id = ?').get(lockedRecord.material_id) as any)?.location_id ?? null
        assertLocationCapacityHeld(db, cancelLocationId)
        db.prepare(`
          INSERT INTO stock_logs
            (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'supplier_return_cancel', ?, ?)
        `).run(
          uuidv4(),
          lockedRecord.material_id,
          normalizedQuantity,
          inventorySnapshot.before,
          inventorySnapshot.after,
          req.params.id,
          actor.username,
          '取消退货给供应商',
        )
      }

      db.prepare('UPDATE supplier_returns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    success(res, { id: req.params.id, status }, '状态更新成功')
  } catch (err: any) {
    const capacityError = locationCapacityError(err)
    if (capacityError) { error(res, capacityError.message, capacityError.code, capacityError.statusCode); return }
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    error(res, err.message)
  }
})

// P1-14: 修正退款额。
// - 受 P1-13 来源成本上界约束（与创建时同口径勾稽）；
// - 已 refunded 状态锁定不可改（409），避免改动已过账金额；
// - 修正写一条 operation_logs 审计留痕（旧值→新值）。
// 注：refunded 应付贷项过账因 master 无应付/财务台账表而 deferred（见交付 modelNote）。
router.put('/:id/refund-amount', requireWriteAccess, (req: any, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { refundAmount } = req.body
    const refund = parseFiniteNonNegativeNumber(refundAmount)
    if (refund === null) {
      error(res, '退款金额必须为非负数', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }

    // 已退款锁定：退款已完成的金额不允许再修正
    if (record.status === 'refunded') {
      error(res, '已退款记录的退款金额不可修正', 'REFUND_LOCKED', 409); return
    }

    // 来源成本上界勾稽（复用 P1-13）
    if (refund > 0) {
      const refundCap = resolveRefundCap(db, record.material_id, Number(record.quantity), record.inbound_record_id)
      if (!refundCap.valid) {
        error(res, '退款来源成本超出支持的数值范围', 'INVALID_PARAMETER', 400); return
      }
      if (refundCap.hasSource && refund > refundCap.cap + 1e-6) {
        error(res, `退款金额(${refund})超过来源成本上界(${refundCap.cap})`, 'REFUND_EXCEEDS_SOURCE_COST', 422); return
      }
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const lockedRecord = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
      if (!lockedRecord) {
        db.exec('ROLLBACK')
        error(res, '记录已变化，请刷新后重试', 'CONCURRENT_MODIFICATION', 409); return
      }
      if (lockedRecord.status === 'refunded') {
        db.exec('ROLLBACK')
        error(res, '已退款记录的退款金额不可修正', 'REFUND_LOCKED', 409); return
      }
      const oldRefund = parseFiniteNonNegativeNumber(lockedRecord.refund_amount)
      const lockedQuantity = parseFinitePositiveNumber(lockedRecord.quantity)
      if (oldRefund === null || lockedQuantity === null) {
        db.exec('ROLLBACK')
        error(res, '退货记录数值超出支持的范围', 'INVALID_PARAMETER', 400); return
      }
      if (refund > 0) {
        const lockedRefundCap = resolveRefundCap(db, lockedRecord.material_id, lockedQuantity, lockedRecord.inbound_record_id)
        if (!lockedRefundCap.valid) {
          db.exec('ROLLBACK')
          error(res, '退款来源成本超出支持的数值范围', 'INVALID_PARAMETER', 400); return
        }
        if (lockedRefundCap.hasSource && refund > lockedRefundCap.cap + 1e-6) {
          db.exec('ROLLBACK')
          error(res, `退款金额(${refund})超过来源成本上界(${lockedRefundCap.cap})`, 'REFUND_EXCEEDS_SOURCE_COST', 422); return
        }
      }
      db.prepare('UPDATE supplier_returns SET refund_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(refund, req.params.id)

      // 审计留痕：退款额修正
      db.prepare(`
        INSERT INTO operation_logs (id, user_id, username, operation, description, request_data)
        VALUES (?, ?, ?, 'supplier_return_refund_amount', ?, ?)
      `).run(
        uuidv4(),
        actor.userId,
        actor.username,
        `修正退货单 ${lockedRecord.return_no} 退款额：${oldRefund} → ${refund}`,
        JSON.stringify({ returnId: req.params.id, oldRefund, newRefund: refund })
      )

      db.exec('COMMIT')
      success(res, { id: req.params.id, refundAmount: refund }, '退款金额已修正')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

// 删除（仅 pending 状态可删除，恢复库存）
router.delete('/:id', requireWriteAccess, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const db = getDatabase()
    let record = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    if (record.status !== 'pending') {
      error(res, '仅待发货状态的退货记录可删除', 'INVALID_PARAMETER', 400); return
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const lockedRecord = db.prepare('SELECT * FROM supplier_returns WHERE id = ? AND is_deleted = 0').get(req.params.id) as any
      if (!lockedRecord || lockedRecord.status !== 'pending') {
        db.exec('ROLLBACK')
        error(res, 'Supplier return changed while waiting for the write lock', 'CONCURRENT_MODIFICATION', 409)
        return
      }
      record = lockedRecord
      const claimed = db.prepare(`
        UPDATE supplier_returns SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND is_deleted = 0 AND status = 'pending'
      `).run(req.params.id)
      if (Number(claimed.changes) !== 1) {
        db.exec('ROLLBACK')
        error(res, 'Supplier return changed while waiting for reversal', 'CONCURRENT_MODIFICATION', 409)
        return
      }

      // 恢复库存
      const normalizedQuantity = parseFinitePositiveNumber(record.quantity)
      if (normalizedQuantity === null) {
        db.exec('ROLLBACK')
        error(res, '退货数量超出支持的数值范围', 'INVALID_PARAMETER', 400)
        return
      }
      const batchFromNo = !record.batch_id && record.batch_no
        ? db.prepare('SELECT id FROM batches WHERE material_id = ? AND batch_no = ?').get(record.material_id, record.batch_no) as any
        : null
      const exactBatchId = record.batch_id || batchFromNo?.id || null
      if (!exactBatchId) {
        db.exec('ROLLBACK')
        error(res, '原退货批次分配不可精确还原，禁止撤销', 'LEDGER_DRIFT', 409)
        return
      }
      const inventorySnapshot = restoreBatchStock(
        db,
        record.material_id,
        [{ batchId: exactBatchId, quantity: normalizedQuantity }],
      )

      // 库位容量门（LOC-029）：删除退货恢复物料当前库位占用，锁内重读库位与占用事实，超容抛错回滚
      const deleteLocationId = (db.prepare('SELECT location_id FROM inventory WHERE material_id = ?').get(record.material_id) as any)?.location_id ?? null
      assertLocationCapacityHeld(db, deleteLocationId)

      // 写库存流水
      const logId = uuidv4()
      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'supplier_return_cancel', ?, ?)
      `).run(logId, record.material_id, normalizedQuantity, inventorySnapshot.before, inventorySnapshot.after, req.params.id, actor.username, '撤销退货给供应商')

      db.exec('COMMIT')
      success(res, null, '退货记录已删除')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) {
    const capacityError = locationCapacityError(err)
    if (capacityError) { error(res, capacityError.message, capacityError.code, capacityError.statusCode); return }
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    error(res, err.message)
  }
})

export default router
