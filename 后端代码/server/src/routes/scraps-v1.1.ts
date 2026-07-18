import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { buildSuccessEnvelope, success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import { requireTrustedRequestActor, withoutUntrustedActorFields } from '../security/trusted-request-actor.js'
import { parseFinitePositiveNumber } from '../utils/numeric-input.js'
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
  InventoryTransactionError,
  inventoryTransactionError,
  restoreBatchStock,
} from '../services/inventory-transactions.js'

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
      batchId: r.batch_id, quantity: r.quantity, unit: r.material_unit, reason: r.reason, operator: r.operator,
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
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { materialId, quantity, reason, remark, batchId, batchNo } = req.body
    const qty = parseFinitePositiveNumber(quantity)
    if (!materialId || qty === null || !reason) {
      error(res, 'Missing or invalid fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'scraps:create'
    const idemFingerprint = idemKey ? fingerprintRequest(withoutUntrustedActorFields(req.body)) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return

    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(materialId) as any
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }

    const id = uuidv4()
    const normalizedOperator = actor.username
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null

    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, normalizedOperator)
      if (batchId && batchNo) {
        const selectedBatch = db.prepare('SELECT batch_no FROM batches WHERE id = ? AND material_id = ?')
          .get(batchId, materialId) as any
        if (!selectedBatch || selectedBatch.batch_no !== batchNo) {
          throw new InventoryTransactionError('Batch id and batch number do not identify the same batch', 'INVALID_PARAMETER')
        }
      }

      const batchResult = consumeBatchStock(db, materialId, qty, { batchId: batchId || null, batchNo: batchNo || null })
      // 单列 batch_id 只能精确记录单批次；跨批次 FEFO 入账不伪造可逆信息。
      const reversibleBatchId = batchResult.allocations.length === 1 ? batchResult.allocations[0].batchId : null
      db.prepare('INSERT INTO scrap_records (id, scrap_no, material_id, batch_id, quantity, reason, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, generateNo(), materialId, reversibleBatchId, qty, reason, normalizedOperator, remark || null)

      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'scrap', ?, ?, ?, ?, ?, 'scrap', ?)
      `).run(uuidv4(), materialId, -qty, batchResult.inventory.before, batchResult.inventory.after, id, normalizedOperator)

      responseEnvelope = buildSuccessEnvelope({ id }, 'Scrap created')
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

// 撤销报废（回滚库存 +数量）
router.delete('/:id', requireScrapsWrite, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { id } = req.params
    const db = getDatabase()
    let record = db.prepare('SELECT * FROM scrap_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }
    let qty = parseFinitePositiveNumber(record.quantity)
    if (qty === null) { error(res, '报废记录数量无效，无法精确撤销', 'LEDGER_DRIFT', 409); return }
    if (!record.batch_id) {
      error(res, '该报废记录涉及多个批次或未保存原批次，当前结构无法安全撤销', 'LEDGER_DRIFT', 409); return
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const lockedRecord = db.prepare('SELECT * FROM scrap_records WHERE id = ? AND is_deleted = 0').get(id) as any
      if (!lockedRecord) {
        db.exec('ROLLBACK')
        error(res, 'Scrap record changed while waiting for the write lock', 'CONCURRENT_MODIFICATION', 409)
        return
      }
      record = lockedRecord
      qty = parseFinitePositiveNumber(record.quantity)
      if (qty === null || !record.batch_id) {
        db.exec('ROLLBACK')
        error(res, 'Scrap record cannot be reversed exactly', 'LEDGER_DRIFT', 409)
        return
      }
      const claimed = db.prepare('UPDATE scrap_records SET is_deleted = 1 WHERE id = ? AND is_deleted = 0').run(id)
      if (Number(claimed.changes) !== 1) {
        db.exec('ROLLBACK')
        error(res, 'Scrap record changed while waiting for reversal', 'CONCURRENT_MODIFICATION', 409)
        return
      }
      const inventory = restoreBatchStock(db, record.material_id, [{ batchId: record.batch_id, quantity: qty }])

      db.prepare(`
        INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'scrap_cancel', ?, '撤销报废记录')
      `).run(uuidv4(), record.material_id, qty, inventory.before, inventory.after, id, actor.username)

      db.exec('COMMIT')
      success(res, null, '报废记录已撤销')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) {
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    error(res, err.message)
  }
})

export default router
