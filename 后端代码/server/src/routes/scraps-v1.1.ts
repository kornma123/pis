import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { buildSuccessEnvelope, error, success, successList } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import { parseFinitePositiveNumber } from '../utils/numeric-input.js'
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
const requireScrapsWrite = requirePermission('scraps', 'W')
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
      SELECT COUNT(*) AS total FROM scrap_records r
      LEFT JOIN materials m ON r.material_id = m.id AND m.is_deleted = 0
      WHERE ${where}
    `).get(...params) as any)?.total || 0
    const offset = (page - 1) * pageSize
    const list = db.prepare(`
      SELECT r.*, m.name AS material_name, m.unit AS material_unit
      FROM scrap_records r
      LEFT JOIN materials m ON r.material_id = m.id AND m.is_deleted = 0
      WHERE ${where}
      ${orderBy(sortField, sortOrder)}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]
    successList(res, list.map((row) => ({
      id: row.id,
      scrapNo: row.scrap_no,
      materialId: row.material_id,
      materialName: row.material_name,
      batchId: row.batch_id,
      quantity: row.quantity,
      unit: row.material_unit,
      reason: row.reason,
      operator: row.operator,
      status: row.status,
      remark: row.remark,
      createdAt: row.created_at,
    })), page, pageSize, count)
  } catch (err: any) { error(res, err.message) }
})

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

router.post('/', requireScrapsWrite, (req, res) => {
  try {
    const { materialId, batchId, quantity, reason, operator, remark } = req.body
    const qty = parseFinitePositiveNumber(quantity)
    if (!materialId || qty === null || !reason) {
      error(res, 'Missing or invalid fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    if (!db.prepare('SELECT id FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)) {
      error(res, 'Material not found', 'NOT_FOUND', 404); return
    }
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'scrap:create'
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator || 'system')
      const id = uuidv4()
      const plan = planInventoryDeductions(db, [{
        materialId,
        quantity: qty,
        pinnedBatchId: batchId || null,
        ownerLineId: id,
      }])
      const exactBatchId = plan.allocations.length === 1 ? plan.allocations[0].batchId : null
      db.prepare(`
        INSERT INTO scrap_records (id, scrap_no, material_id, batch_id, quantity, reason, operator, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, generateNo(), materialId, exactBatchId, qty, reason, operator || 'system', remark || null)
      applyInventoryPlan(db, plan)
      replaceAllocationFacts(db, { operationKind: 'scrap', ownerId: id, direction: 'out', allocations: plan.allocations })
      for (const allocation of plan.allocations) {
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'scrap', ?, ?, ?, ?, ?, 'scrap', ?)
        `).run(uuidv4(), materialId, -allocation.quantity, allocation.inventoryBefore, allocation.inventoryAfter, id, operator || 'system')
      }
      responseEnvelope = buildSuccessEnvelope({ id }, 'Scrap created')
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

router.delete('/:id', requireScrapsWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = `scrap:delete:${id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body || {}) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    if (!db.prepare('SELECT id FROM scrap_records WHERE id = ? AND is_deleted = 0').get(id)) {
      error(res, 'Scrap record not found', 'NOT_FOUND', 404); return
    }
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, req.body?.operator || 'system')
      if (!db.prepare('SELECT id FROM scrap_records WHERE id = ? AND is_deleted = 0').get(id)) {
        error(res, 'Scrap record changed before cancellation', 'CONCURRENT_MODIFICATION', 409)
        db.exec('ROLLBACK')
        return
      }
      const facts = listActiveAllocationFacts(db, 'scrap', id)
      if (facts.length === 0) {
        error(res, 'Scrap allocation is unavailable', 'ALLOCATION_NOT_FOUND', 409)
        db.exec('ROLLBACK')
        return
      }
      const plan = planExactInventoryAdditions(db, facts.map((fact) => ({
        materialId: fact.material_id,
        batchId: fact.batch_id,
        quantity: fact.quantity,
        ownerLineId: fact.id,
      })))
      db.prepare('UPDATE scrap_records SET is_deleted = 1 WHERE id = ?').run(id)
      applyInventoryPlan(db, plan)
      markAllocationFactsReversed(db, 'scrap', id)
      for (const allocation of plan.allocations) {
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'scrap_cancel', ?, 'scrap cancellation')
        `).run(uuidv4(), allocation.materialId, allocation.quantity, allocation.inventoryBefore, allocation.inventoryAfter, id, req.body?.operator || 'system')
      }
      responseEnvelope = buildSuccessEnvelope(null, 'Scrap cancelled')
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
