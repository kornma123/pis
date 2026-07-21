import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { buildSuccessEnvelope, success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import { requireTrustedRequestActor, withoutUntrustedActorFields } from '../security/trusted-request-actor.js'
import { checkedSubtract, parseFiniteNonNegativeNumber, parseFiniteNumber } from '../utils/numeric-input.js'
import {
  claimIdempotency,
  finalizeIdempotency,
  fingerprintRequest,
  isIdempotencyConflict,
  readIdempotencyKey,
  tryReplayIdempotency,
} from '../utils/idempotency.js'
import { assertInventoryMatchesBatches, inventoryTransactionError, setMaterialStock } from '../services/inventory-transactions.js'
import { assertLocationCapacityHeld, locationCapacityError } from '../utils/location-capacity.js'

const router = Router()

// 盘点写入（登记 + 入账副作用最强的 /:id/adjust 直改 inventory.stock）：挂载层只 requirePermission('stocktaking','R')，
// 四个写端点必须自带 W 守卫，否则持 stocktaking:R 者即可越权调整库存。仿 projects/outbound 模式。
const requireStocktakingWrite = requirePermission('stocktaking', 'W')

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `ST-${date}-${timestamp}-${random}`
}

function generateSheetNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `STS-${date}-${timestamp}-${random}`
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, keyword } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) { where += ' AND (stocktaking_no LIKE ? OR material_name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    const count = (db.prepare(`SELECT COUNT(*) as total FROM stocktaking_records WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (page - 1) * pageSize
    const list = db.prepare(`SELECT * FROM stocktaking_records WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]
    successList(res, list.map((r: any) => ({
      id: r.id, stocktakingNo: r.stocktaking_no, sheetNo: r.sheet_no, materialId: r.material_id,
      systemStock: r.system_stock, actualStock: r.actual_stock,
      difference: r.difference, operator: r.operator, status: r.status,
      remark: r.remark, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireStocktakingWrite, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { materialId, actualStock, remark } = req.body
    if (!materialId || actualStock === undefined) { error(res, 'Missing fields', 'INVALID_PARAMETER', 400); return }
    const normalizedActualStock = parseFiniteNonNegativeNumber(actualStock)
    if (normalizedActualStock === null) { error(res, 'Invalid actual stock', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'stocktaking:create'
    const idemFingerprint = idemKey ? fingerprintRequest(withoutUntrustedActorFields(req.body)) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const material = db.prepare('SELECT 1 FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }

    // 两阶段·第一阶段「登记」：只记录盘点结果，不入账（不改 inventory、不写 stock_logs）。
    // 差异=0 → completed（账实相符，无需入账）；差异≠0 → pending（待「处理差异」入账）。
    // 真正的库存调整改由 POST /:id/adjust 完成，把「清点」与「审批入账」拆成两步（内控分离）。
    // 锁前只读预检保持非法数值请求零事务副作用；锁内仍会重读并重算，避免预检与提交之间的竞态。
    const preflightRawSystemStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock ?? 0
    const preflightSystemStock = parseFiniteNumber(preflightRawSystemStock)
    const preflightDifference = preflightSystemStock === null
      ? null
      : checkedSubtract(normalizedActualStock, preflightSystemStock)
    if (preflightSystemStock === null || preflightDifference === null) {
      error(res, 'Stocktaking difference exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
      return
    }
    try {
      assertInventoryMatchesBatches(db, materialId)
    } catch (err) {
      const inventoryError = inventoryTransactionError(err)
      if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
      throw err
    }

    const id = uuidv4()
    const op = actor.username
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      assertInventoryMatchesBatches(db, materialId)
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, op)
      const rawSystemStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock ?? 0
      const systemStock = parseFiniteNumber(rawSystemStock)
      const difference = systemStock === null ? null : checkedSubtract(normalizedActualStock, systemStock)
      if (systemStock === null || difference === null) {
        db.exec('ROLLBACK')
        error(res, 'Stocktaking difference exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
        return
      }
      const status = difference === 0 ? 'completed' : 'pending'
      db.prepare('INSERT INTO stocktaking_records (id, stocktaking_no, material_id, system_stock, actual_stock, difference, operator, status, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, generateNo(), materialId, systemStock, normalizedActualStock, difference, op, status, remark || null)
      responseEnvelope = buildSuccessEnvelope({ id, status }, '盘点记录已创建')
      if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }

    res.status(200).json(responseEnvelope)
  } catch (err: any) {
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    error(res, err.message)
  }
})

// 差异原因白名单（受控口径，与前端弹窗 select 一致；非白名单一律拒绝，防手写脏原因）
const ADJUST_REASONS: Record<string, string> = {
  normal: '正常损耗',
  record: '账务问题',
  physical: '实物问题',
  other: '其他',
}

/**
 * 处理盘点差异（两阶段·第二阶段「入账」）——仅对 pending 记录生效。
 * body: { reason: normal|record|physical|other, remark? }
 * - 受控原因校验：非白名单 → 400，无任何库存副作用。
 * - 幂等：非 pending（completed/confirmed/…）→ 400，防重复入账把库存双计。
 * - 防过期：入账前若账面已不等于创建时快照(system_stock) → 409，不入账（防旧盘点覆盖期间发生的新库存变动）。
 * - 入账 = inventory.stock 改到实盘 + 写 stock_logs 'adjust' + status='confirmed' + 差异原因/说明落 remark。
 * - 操作人以登录用户(req.user)为准，忽略 body 伪造；成功写操作由全局 auditWrite 统一留痕 operation_logs。
 */
router.post('/:id/adjust', requireStocktakingWrite, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { id } = req.params
    const { reason, remark } = req.body
    const operator = actor.username
    // 用 own-property 校验做白名单，避免 constructor/toString 等原型链键绕过 `if (!label)`（原型污染式脏原因）。
    // 用 Object.prototype.hasOwnProperty.call（而非 Object.hasOwn）以免依赖 ES2022 运行时/lib。
    const hasReason = Object.prototype.hasOwnProperty.call(ADJUST_REASONS, reason)
    const label = (typeof reason === 'string' && hasReason) ? ADJUST_REASONS[reason] : undefined
    if (!label) { error(res, '差异原因无效', 'INVALID_PARAMETER', 400); return }

    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = `stocktaking:adjust:${id}`
    const idemFingerprint = idemKey ? fingerprintRequest(withoutUntrustedActorFields(req.body)) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator)
      const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0').get(id) as any
      if (!record) {
        db.exec('ROLLBACK')
        error(res, '记录不存在或已删除', 'NOT_FOUND', 404)
        return
      }
      if (record.status !== 'pending') {
        db.exec('ROLLBACK')
        error(res, '该盘点差异已处理，不可重复调整', 'ALREADY_ADJUSTED', 400)
        return
      }
      const systemStock = record.system_stock
      const currentStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any)?.stock ?? 0
      // 防过期：账面已变（期间发生了出入库）→ 拒绝用旧盘点结果覆盖当前库存
      if (Number(currentStock) !== Number(systemStock)) {
        db.exec('ROLLBACK')
        error(res, '当前库存已变化，请重新盘点后再处理', 'STOCK_CHANGED', 409)
        return
      }
      const actualStock = record.actual_stock
      const difference = record.difference

      const adjustment = setMaterialStock(db, record.material_id, actualStock, id)
      // 库位容量门（LOC-029）：盘点上调抬高物料当前库位占用，锁内重读库位与占用事实，超容抛错回滚
      if (adjustment.after > adjustment.before) {
        const adjustLocationId = (db.prepare('SELECT location_id FROM inventory WHERE material_id = ?').get(record.material_id) as any)?.location_id ?? null
        assertLocationCapacityHeld(db, adjustLocationId)
      }

      const noteText = String(remark || '').trim()
      const reasonNote = noteText ? `差异原因：${label}；处理说明：${noteText}` : `差异原因：${label}`
      const logId = uuidv4()
      db.prepare('INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(logId, 'adjust', record.material_id, difference, systemStock, actualStock, id, 'stocktaking', operator, reasonNote)

      const mergedRemark = record.remark ? `${record.remark} ｜ ${reasonNote}` : reasonNote
      db.prepare("UPDATE stocktaking_records SET status = 'confirmed', remark = ? WHERE id = ?").run(mergedRemark, id)

      responseEnvelope = buildSuccessEnvelope({ id, status: 'confirmed' }, '盘点差异已处理，库存已更新')
      if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(e) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw e
    }

    res.status(200).json(responseEnvelope)
  } catch (err: any) {
    const capacityError = locationCapacityError(err)
    if (capacityError) { error(res, capacityError.message, capacityError.code, capacityError.statusCode); return }
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    error(res, err.message)
  }
})

/**
 * 批量盘点：一次事务提交多物料盘点，同一 sheet_no 归组。
 * 全行预校验，任一行非法 → 整单 422 回滚（all-or-nothing），不写任何记录、不动库存。
 * body: { items: [{ materialId, actualStock, remark? }], operator?, remark? }
 */
router.post('/batch', requireStocktakingWrite, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { items, remark } = req.body
    if (!Array.isArray(items) || items.length === 0) {
      error(res, '盘点明细不能为空', 'INVALID_PARAMETER', 400); return
    }

    // ── 全行预校验（任一非法整单拒绝，未进事务前不写任何数据）──
    const seen = new Set<string>()
    const normalizedItems: any[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const rowLabel = `第 ${i + 1} 行`
      if (!it || typeof it !== 'object') { error(res, `${rowLabel}格式错误`, 'INVALID_PARAMETER', 422); return }
      const { materialId, actualStock } = it
      if (!materialId || actualStock === undefined || actualStock === null) {
        error(res, `${rowLabel}缺少物料或实盘数量`, 'INVALID_PARAMETER', 422); return
      }
      const normalizedActualStock = parseFiniteNumber(actualStock)
      if (normalizedActualStock === null) { error(res, `${rowLabel}实盘数量无效`, 'INVALID_PARAMETER', 422); return }
      // 兼容既有批量盘点契约：该端点的任意非法 actualStock 均返回 422。
      if (normalizedActualStock < 0) { error(res, `${rowLabel}实盘数量不能为负数`, 'INVALID_PARAMETER', 422); return }
      if (seen.has(materialId)) { error(res, `${rowLabel}物料重复`, 'INVALID_PARAMETER', 422); return }
      seen.add(materialId)
      normalizedItems.push({ ...it, actualStock: normalizedActualStock })
    }

    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'stocktaking:batch'
    const idemFingerprint = idemKey ? fingerprintRequest(withoutUntrustedActorFields(req.body)) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    for (let i = 0; i < normalizedItems.length; i++) {
      const { materialId } = normalizedItems[i]
      const rowLabel = `第 ${i + 1} 行`
      const material = db.prepare('SELECT 1 FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)
      if (!material) { error(res, `${rowLabel}物料不存在或已删除`, 'NOT_FOUND', 422); return }
    }

    const buildBatchPlan = (): any[] | null => {
      const plan: any[] = []
      for (const item of normalizedItems) {
        const rawSystemStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(item.materialId) as any)?.stock ?? 0
        const systemStock = parseFiniteNumber(rawSystemStock)
        const difference = systemStock === null ? null : checkedSubtract(item.actualStock, systemStock)
        if (systemStock === null || difference === null) return null
        plan.push({ ...item, systemStock, difference })
      }
      return plan
    }

    const preflightPlan = buildBatchPlan()
    if (!preflightPlan) {
      error(res, 'Stocktaking difference exceeds the supported numeric range', 'INVALID_PARAMETER', 400); return
    }

    // ── 全行合法，单事务内创建（all-or-nothing）──
    const sheetNo = generateSheetNo()
    const op = actor.username
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, op)
      const transactionPlan = buildBatchPlan()
      if (!transactionPlan) {
        db.exec('ROLLBACK')
        error(res, 'Stocktaking difference exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
        return
      }
      const ids: string[] = []
      for (const item of transactionPlan) {
        const { materialId, actualStock, systemStock, difference, remark: rowRemark } = item
        const id = uuidv4()
        ids.push(id)
        db.prepare('INSERT INTO stocktaking_records (id, stocktaking_no, sheet_no, material_id, system_stock, actual_stock, difference, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, generateNo(), sheetNo, materialId, systemStock, actualStock, difference, op, rowRemark || remark || null)

        setMaterialStock(db, materialId, actualStock, id)
        // 库位容量门（LOC-029）：本行上调抬高物料当前库位占用，锁内重读库位与占用事实，超容抛错整单回滚
        if (difference > 0) {
          const itemLocationId = (db.prepare('SELECT location_id FROM inventory WHERE material_id = ?').get(materialId) as any)?.location_id ?? null
          assertLocationCapacityHeld(db, itemLocationId)
        }
        if (difference !== 0) {
          const logId = uuidv4()
          db.prepare('INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(logId, 'adjust', materialId, difference, systemStock, actualStock, id, 'stocktaking', op)
        }
      }

      responseEnvelope = buildSuccessEnvelope({ sheetNo, count: ids.length, ids }, '批量盘点完成')
      if (idemKey) finalizeIdempotency(db, idemKey, 201, responseEnvelope)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(e) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw e
    }

    res.status(201).json(responseEnvelope)
  } catch (err: any) {
    const capacityError = locationCapacityError(err)
    if (capacityError) { error(res, capacityError.message, capacityError.code, capacityError.statusCode); return }
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    error(res, err.message)
  }
})

router.delete('/:id', requireStocktakingWrite, (req, res) => {
  const actor = requireTrustedRequestActor(req, res)
  if (!actor) return
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }
    const difference = parseFiniteNumber(record.difference)
    if (difference === null) {
      error(res, '盘点差异超出支持的数值范围', 'INVALID_PARAMETER', 400); return
    }
    if (difference !== 0 && record.status !== 'pending') {
      error(res, '盘点批次分配未持久化，禁止不可审计的库存回滚', 'LEDGER_DRIFT', 409); return
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE stocktaking_records SET is_deleted = 1 WHERE id = ?').run(id)

      db.exec('COMMIT')
      success(res, null, '盘点记录已撤销')
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
