import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error, buildSuccessEnvelope } from '../utils/response.js'
import {
  readIdempotencyKey,
  fingerprintRequest,
  tryReplayIdempotency,
  claimIdempotency,
  finalizeIdempotency,
  isIdempotencyConflict,
} from '../utils/idempotency.js'
import { recordCostException } from '../utils/cost-exceptions.js'
import { resolveOutboundUnitCost } from '../utils/outbound-cost.js'
import { requirePermission } from '../middleware/permissions.js'
import { recordOverride } from '../utils/override-log.js'
import {
  checkedAdd,
  checkedMultiply,
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

const router = Router()

// 出库写入权限：挂载层仅按模块 R 放行（app.ts），写端点须内层 'W' 守卫（口径同 abc-v1.1 / labor-times / indirect-costs）。
// 缺此守卫则任何 outbound:R（只读，如 SEED_MATRIX lab_director / 角色矩阵编辑器只读授予）角色即可越权创建出库
// （减库存 + 写 batch_usage_tracking/stock_logs）。POST 创建端点此前遗漏、仅 PUT/DELETE 有守卫（相邻授权缺口·2026-07-09）。
const requireWriteAccess = requirePermission('outbound', 'W')
const LIVE_OUTBOUND_TYPES = new Set(['direct', 'project', 'transfer', 'scrap'])

function isLiveOutboundType(value: unknown): value is string {
  return typeof value === 'string' && LIVE_OUTBOUND_TYPES.has(value)
}

// 库存双账本漂移告警（项A）：出库时缺可消耗批次、单位成本走兜底 → 落 cost_exceptions（既有告警清单）。
// 事务内调用；项⑦「统一旁路台账」把此类软兜底一并汇入统一 override 日志（供旁路频率体检）。
function recordLedgerDrift(db: any, outboundId: string, oi: any, operator: string): void {
  const srcLabel = oi.costSource === 'material_avg' ? '物料历史批次均价'
    : oi.costSource === 'material_price' ? '物料基准价'
    : '0（无价格来源·须补价）'
  // fail-safe：告警落库失败绝不回滚合法出库（warn 阶段=不阻断）。与本文件 ABC 核算块同款吞错取向。
  try {
    recordCostException(db, {
      sourceModule: 'outbound', sourceType: 'ledger_drift', sourceId: outboundId, outboundId,
      exceptionType: 'ledger_drift', severity: 'warning',
      message: `库存台账漂移：物料缺可消耗批次，单位成本按${srcLabel}兜底（绝不静默按 0 计）`,
      details: { materialId: oi.materialId, unitCost: oi.unitCost, costSource: oi.costSource, note: oi.costNote, quantity: oi.quantity },
    })
  } catch (e) {
    console.error('recordLedgerDrift failed (non-blocking):', e)
  }
  // 项⑦：软兜底 = 系统自动旁路（无用户 confirm），reason 用系统兜底口径；operator 取出库操作人。
  recordOverride(db, {
    gateType: 'ledger_drift_fallback', module: 'outbound', targetId: outboundId, operator,
    reason: oi.costNote || `缺批次·按${srcLabel}兜底`,
    before: { materialId: oi.materialId, costSource: oi.costSource },
    after: { unitCost: oi.unitCost, quantity: oi.quantity },
  })
}

function recheckOutboundCosts(db: any, items: any[]): { items: any[]; totalCost: number } | null {
  let totalCost = 0
  const recheckedItems: any[] = []
  for (const item of items) {
    const batch = item.batchId
      ? db.prepare('SELECT * FROM batches WHERE id = ?').get(item.batchId) as any
      : null
    const costResult = resolveOutboundUnitCost(db, item.materialId, batch)
    const itemCost = checkedMultiply(costResult.unitCost, item.quantity)
    const nextTotalCost = itemCost === null ? null : checkedAdd(totalCost, itemCost)
    if (itemCost === null || nextTotalCost === null) return null
    totalCost = nextTotalCost
    recheckedItems.push({
      ...item,
      unitCost: costResult.unitCost,
      itemCost,
      drift: costResult.drift,
      costSource: costResult.source,
      costNote: costResult.note,
    })
  }
  return { items: recheckedItems, totalCost }
}

// 排序白名单：key = 前端/API 允许的排序字段名，value = 受控的 SQL 表达式（绝不拼接用户输入，防注入）。
// 「数量」跨明细汇总（outbound_records 无数量列），用相关子查询求和 outbound_items.quantity。
const OUTBOUND_SORT_COLUMNS: Record<string, string> = {
  createdAt: 'r.created_at',
  totalCost: 'r.total_cost',
  quantity: '(SELECT COALESCE(SUM(oi.quantity), 0) FROM outbound_items oi WHERE oi.outbound_id = r.id)',
}

function generateOutboundNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `OB-${date}-${timestamp}-${random}`
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, projectId, status, keyword, materialId, type, startDate, endDate, sortField, sortOrder } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))

    // 排序：白名单列 + asc/desc 归一，非法一律 400（不落入 SQL，防注入）。缺省=出库时间倒序（向后兼容）。
    let sortColumn = OUTBOUND_SORT_COLUMNS.createdAt
    if (sortField !== undefined && sortField !== '') {
      // 用自有属性判定，避免 __proto__/constructor/toString 等原型链键返回真值绕过白名单
      const key = String(sortField)
      if (!Object.prototype.hasOwnProperty.call(OUTBOUND_SORT_COLUMNS, key)) {
        error(res, 'Invalid sortField', 'INVALID_PARAMETER', 400); return
      }
      sortColumn = OUTBOUND_SORT_COLUMNS[key]
    }
    let sortDir = 'DESC'
    if (sortOrder !== undefined && sortOrder !== '') {
      const dir = String(sortOrder).toLowerCase()
      if (dir !== 'asc' && dir !== 'desc') { error(res, 'Invalid sortOrder', 'INVALID_PARAMETER', 400); return }
      sortDir = dir === 'asc' ? 'ASC' : 'DESC'
    }
    // 二级排序 r.id 作稳定 tiebreaker，使同值行分页顺序确定。
    const orderByClause = `${sortColumn} ${sortDir}, r.id DESC`

    const db = getDatabase()
    let where = 'r.is_deleted = 0'
    const params: any[] = []
    if (projectId) { where += ' AND r.project_id = ?'; params.push(projectId) }
    if (status) { where += ' AND r.status = ?'; params.push(status) }
    if (type) { where += ' AND r.type = ?'; params.push(type) }
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }
    if (keyword) {
      where += ` AND (r.outbound_no LIKE ? OR EXISTS (
        SELECT 1 FROM outbound_items oi JOIN materials m ON oi.material_id = m.id
        WHERE oi.outbound_id = r.id AND m.is_deleted = 0 AND m.name LIKE ?
      ))`
      params.push(`%${keyword}%`, `%${keyword}%`)
    }
    if (materialId) {
      where += ` AND EXISTS (
        SELECT 1 FROM outbound_items oi WHERE oi.outbound_id = r.id AND oi.material_id = ?
      )`
      params.push(materialId)
    }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM outbound_records r WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)

    const records = db.prepare(`
      SELECT r.*, p.name as project_name
      FROM outbound_records r
      LEFT JOIN projects p ON r.project_id = p.id AND p.is_deleted = 0
      WHERE ${where}
      ORDER BY ${orderByClause}
      LIMIT ? OFFSET ?
    `).all(...params, Number(pageSize), offset) as any[]

    const result = records.map((r: any) => {
      const items = db.prepare('SELECT oi.*, m.name as material_name FROM outbound_items oi LEFT JOIN materials m ON oi.material_id = m.id AND m.is_deleted = 0 WHERE oi.outbound_id = ?').all(r.id) as any[]
      return {
        id: r.id, outboundNo: r.outbound_no, type: r.type, projectId: r.project_id,
        projectName: r.project_name,
        items: items.map((i: any) => ({
          id: i.id, materialId: i.material_id, materialName: i.material_name,
          batchNo: i.batch_no, quantity: i.quantity, unit: i.unit,
          unitCost: i.unit_cost, totalCost: i.total_cost,
        })),
        totalCost: r.total_cost, operator: r.operator, status: r.status,
        remark: r.remark, createdAt: r.created_at,
      }
    })

    successList(res, result, Number(page), Number(pageSize), count)
  } catch (err: any) {
    if (err?.code === 'LEDGER_DRIFT') { error(res, err.message, 'LEDGER_DRIFT', 409); return }
    error(res, err.message)
  }
})

router.get('/stats', (req, res) => {
  try {
    const db = getDatabase()
    const total = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0").get() as any)?.c || 0
    const completed = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    const pending = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'pending'").get() as any)?.c || 0
    const cancelled = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'cancelled'").get() as any)?.c || 0
    const totalCost = (db.prepare("SELECT COALESCE(SUM(total_cost),0) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    success(res, { total, completed, pending, cancelled, totalCost })
  } catch (err: any) {
    if (err?.code === 'LEDGER_DRIFT') { error(res, err.message, 'LEDGER_DRIFT', 409); return }
    error(res, err.message)
  }
})

router.post('/', requireWriteAccess, (req, res) => {
  try {
    const { type, projectId, items, remark } = req.body
    if (!isLiveOutboundType(type) || !Array.isArray(items) || items.length === 0) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }

    const normalizedItems: any[] = []
    for (const item of items) {
      const normalizedQuantity = parseFinitePositiveNumber(item?.quantity)
      if (!item?.materialId || normalizedQuantity === null) {
        error(res, 'Invalid quantity', 'INVALID_PARAMETER', 400); return
      }
      normalizedItems.push({ ...item, quantity: normalizedQuantity })
    }

    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = 'outbound:create'
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return

    const outboundNo = generateOutboundNo()
    const id = uuidv4()
    const operator = req.body.operator || 'system'
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + normalizedItems.map(() => '?').join(',') + ')').all(...normalizedItems.map((i: any) => i.materialId)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))

    // 事务保护：出库涉及 records + items + inventory + batches + stock_logs 多表操作
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator)
      const transactionPlan = planInventoryDeductions(db, normalizedItems.map((item, index) => ({
        materialId: item.materialId,
        quantity: item.quantity,
        pinnedBatchId: item.batchId || null,
        ownerLineId: String(index),
      })))
      const allocatedItems = transactionPlan.allocations.map((allocation) => {
        const source = normalizedItems[Number(allocation.ownerLineId)]
        return {
          materialId: allocation.materialId,
          batchId: allocation.batchId,
          batchNo: allocation.batchNo,
          quantity: allocation.quantity,
          usage: source.usage || 'self',
          receiver: source.receiver || null,
          allocation,
        }
      })
      const recheckedCosts = recheckOutboundCosts(db, allocatedItems)
      if (!recheckedCosts) {
        db.exec('ROLLBACK')
        error(res, 'Outbound arithmetic exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
        return
      }
      const totalCost = recheckedCosts.totalCost

      db.prepare(`
        INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, remark)
        VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
      `).run(id, outboundNo, type, projectId || null, totalCost, operator, remark || null)

      for (let index = 0; index < recheckedCosts.items.length; index++) {
        const oi = recheckedCosts.items[index]
        const allocation = oi.allocation
        const itemId = uuidv4()
        allocation.ownerLineId = itemId
        db.prepare(`
          INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, id, oi.materialId, oi.batchId, oi.batchNo, oi.quantity, unitMap.get(oi.materialId) || 'pcs', oi.unitCost, oi.itemCost, oi.usage || 'self', oi.receiver || null)

        if (oi.drift) recordLedgerDrift(db, id, oi, operator)

        // 自用物料创建使用中跟踪记录
        if ((oi.usage || 'self') === 'self' && oi.batchId) {
          const mat = db.prepare('SELECT name, spec FROM materials WHERE id = ? AND is_deleted = 0').get(oi.materialId) as any
          const trkId = `TRK-${Date.now()}-${Math.floor(Math.random() * 1000)}`
          const today = new Date().toISOString().split('T')[0]
          db.prepare(`
            INSERT INTO batch_usage_tracking
            (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
          `).run(trkId, oi.materialId, mat?.name || '', oi.batchNo || '', mat?.spec || '', oi.quantity, oi.quantity, unitMap.get(oi.materialId) || 'pcs', today, 30, 'self', null)
        }

        const logId = uuidv4()
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
        `).run(logId, oi.materialId, -oi.quantity, allocation.inventoryBefore, allocation.inventoryAfter, id, operator)
      }
      applyInventoryPlan(db, transactionPlan)
      replaceAllocationFacts(db, {
        operationKind: 'outbound',
        ownerId: id,
        direction: 'out',
        allocations: transactionPlan.allocations,
      })

      responseEnvelope = buildSuccessEnvelope({ id, outboundNo, type, projectId, totalCost, status: 'completed', createdAt: new Date().toISOString() }, 'Outbound created')
      if (idemKey) finalizeIdempotency(db, idemKey, 201, responseEnvelope)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }

    res.status(201).json(responseEnvelope)
  } catch (err: any) {
    const inventoryFailure = inventoryErrorResponse(err)
    if (inventoryFailure) { error(res, inventoryFailure.message, inventoryFailure.code, inventoryFailure.status); return }
    if (err?.code === 'LEDGER_DRIFT') { error(res, err.message, 'LEDGER_DRIFT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const { type, projectId, items: newItems, remark } = req.body
    if ((type !== undefined && !isLiveOutboundType(type)) || !Array.isArray(newItems) || newItems.length === 0) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }

    const normalizedNewItems: any[] = []
    for (const item of newItems) {
      const normalizedQuantity = parseFinitePositiveNumber(item?.quantity)
      if (!item?.materialId || normalizedQuantity === null) {
        error(res, 'Invalid quantity', 'INVALID_PARAMETER', 400); return
      }
      normalizedNewItems.push({ ...item, quantity: normalizedQuantity })
    }

    const db = getDatabase()
    const record = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    if (record.type === 'bom') {
      error(res, 'Historical BOM outbound records are read-only', 'OUTBOUND_TYPE_RETIRED', 409); return
    }

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + normalizedNewItems.map(() => '?').join(',') + ')').all(...normalizedNewItems.map((i: any) => i.materialId)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))
    const idemKey = readIdempotencyKey(req)
    const idemScope = `outbound:update:${id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const operator = req.body.operator || 'system'
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null

    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator)
      const transactionRecord = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
      if (!transactionRecord) {
        db.exec('ROLLBACK')
        error(res, 'Outbound record changed before update', 'CONCURRENT_MODIFICATION', 409)
        return
      }
      const transactionOldItems = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]
      if (transactionOldItems.some((item) => !item.batch_id)) {
        db.exec('ROLLBACK')
        error(res, 'Historical outbound allocation is incomplete', 'ALLOCATION_NOT_FOUND', 409)
        return
      }
      const restorePlan = planExactInventoryAdditions(db, transactionOldItems.map((item) => ({
        materialId: item.material_id,
        batchId: item.batch_id,
        quantity: item.quantity,
        ownerLineId: item.id,
      })))
      applyInventoryPlan(db, restorePlan)
      const transactionPlan = planInventoryDeductions(db, normalizedNewItems.map((item, index) => ({
        materialId: item.materialId,
        quantity: item.quantity,
        pinnedBatchId: item.batchId || null,
        ownerLineId: String(index),
      })))
      const processedItems = transactionPlan.allocations.map((allocation) => {
        const source = normalizedNewItems[Number(allocation.ownerLineId)]
        return {
          materialId: allocation.materialId,
          batchId: allocation.batchId,
          batchNo: allocation.batchNo,
          quantity: allocation.quantity,
          usage: source.usage || 'self',
          receiver: source.receiver || null,
          allocation,
        }
      })
      const recheckedCosts = recheckOutboundCosts(db, processedItems)
      if (!recheckedCosts) {
        db.exec('ROLLBACK')
        error(res, 'Outbound update arithmetic exceeds the supported numeric range', 'INVALID_PARAMETER', 400)
        return
      }
      const newTotalCost = recheckedCosts.totalCost

      for (const allocation of restorePlan.allocations) {
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'return', ?, ?, ?, ?, ?, 'outbound_update', ?, '出库修改：回退原明细')
        `).run(uuidv4(), allocation.materialId, allocation.quantity, allocation.inventoryBefore, allocation.inventoryAfter, id, operator)
      }

      db.prepare('DELETE FROM outbound_items WHERE outbound_id = ?').run(id)
      db.prepare('UPDATE outbound_records SET type = ?, project_id = ?, total_cost = ?, remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(type || transactionRecord.type, projectId || null, newTotalCost, remark || null, id)

      for (const item of transactionOldItems) {
        if (item.batch_no) {
          db.prepare("DELETE FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'").run(item.material_id, item.batch_no)
        }
      }

      for (const pi of recheckedCosts.items) {
        const itemId = uuidv4()
        pi.allocation.ownerLineId = itemId
        db.prepare(`
          INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, id, pi.materialId, pi.batchId, pi.batchNo, pi.quantity, unitMap.get(pi.materialId) || 'pcs', pi.unitCost, pi.itemCost, pi.usage || 'self', pi.receiver || null)
        if (pi.drift) recordLedgerDrift(db, id, pi, operator)
        if ((pi.usage || 'self') === 'self') {
          const mat = db.prepare('SELECT name, spec FROM materials WHERE id = ? AND is_deleted = 0').get(pi.materialId) as any
          const today = new Date().toISOString().split('T')[0]
          db.prepare(`
            INSERT INTO batch_usage_tracking
            (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
          `).run(`TRK-${uuidv4()}`, pi.materialId, mat?.name || '', pi.batchNo, mat?.spec || '', pi.quantity, pi.quantity, unitMap.get(pi.materialId) || 'pcs', today, 30, 'self', null)
        }
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
        `).run(uuidv4(), pi.materialId, -pi.quantity, pi.allocation.inventoryBefore, pi.allocation.inventoryAfter, id, operator)
      }
      applyInventoryPlan(db, transactionPlan)
      replaceAllocationFacts(db, {
        operationKind: 'outbound',
        ownerId: id,
        direction: 'out',
        allocations: transactionPlan.allocations,
      })
      responseEnvelope = buildSuccessEnvelope({ id, totalCost: newTotalCost }, 'Outbound updated')
      if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }

    res.status(200).json(responseEnvelope)
  } catch (err: any) {
    const inventoryFailure = inventoryErrorResponse(err)
    if (inventoryFailure) { error(res, inventoryFailure.message, inventoryFailure.code, inventoryFailure.status); return }
    if (err?.code === 'LEDGER_DRIFT') { error(res, err.message, 'LEDGER_DRIFT', 409); return }
    error(res, err.message)
  }
})

router.delete('/:id', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const idemKey = readIdempotencyKey(req)
    const idemScope = `outbound:delete:${id}`
    const idemFingerprint = idemKey ? fingerprintRequest(req.body || {}) : ''
    if (tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
    const record = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }
    if (record.type === 'bom') {
      error(res, 'Historical BOM outbound records are read-only', 'OUTBOUND_TYPE_RETIRED', 409); return
    }

    const operator = req.body?.operator || 'system'
    let responseEnvelope: ReturnType<typeof buildSuccessEnvelope> | null = null

    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator)
      const lockedRecord = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
      if (!lockedRecord) {
        db.exec('ROLLBACK')
        error(res, '记录不存在', 'NOT_FOUND', 404)
        return
      }
      const items = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]
      if (items.length === 0 || items.some((item) => !item.batch_id)) {
        db.exec('ROLLBACK')
        error(res, 'Outbound allocation is unavailable', 'ALLOCATION_NOT_FOUND', 409)
        return
      }
      const restorePlan = planExactInventoryAdditions(db, items.map((item) => ({
        materialId: item.material_id,
        batchId: item.batch_id,
        quantity: item.quantity,
        ownerLineId: item.id,
      })))
      applyInventoryPlan(db, restorePlan)
      for (const item of items) {
        if (item.batch_no) {
          db.prepare("DELETE FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'").run(item.material_id, item.batch_no)
        }
      }
      db.prepare('UPDATE outbound_records SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
      for (const allocation of restorePlan.allocations) {
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'delete', ?, ?, ?, ?, ?, 'outbound_delete', ?, '删除出库记录')
        `).run(uuidv4(), allocation.materialId, allocation.quantity, allocation.inventoryBefore, allocation.inventoryAfter, id, operator)
      }
      if (listActiveAllocationFacts(db, 'outbound', id).length > 0) {
        markAllocationFactsReversed(db, 'outbound', id)
      }
      responseEnvelope = buildSuccessEnvelope(null, '删除成功，库存已同步回退')
      if (idemKey) finalizeIdempotency(db, idemKey, 200, responseEnvelope)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      throw err
    }
    res.status(200).json(responseEnvelope)
  } catch (err: any) {
    const inventoryFailure = inventoryErrorResponse(err)
    if (inventoryFailure) { error(res, inventoryFailure.message, inventoryFailure.code, inventoryFailure.status); return }
    if (err?.code === 'LEDGER_DRIFT') { error(res, err.message, 'LEDGER_DRIFT', 409); return }
    error(res, err.message)
  }
})

export default router
