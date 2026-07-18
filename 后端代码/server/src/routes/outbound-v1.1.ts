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
  consumeBatchStock,
  inventoryTransactionError,
  InventoryTransactionError,
  restoreBatchStock,
} from '../services/inventory-transactions.js'
import {
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  parseFiniteNumber,
  parseFinitePositiveNumber,
} from '../utils/numeric-input.js'

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

type OutboundRequestItem = {
  materialId: string
  quantity: number
  batchId?: string | null
  batchNo?: string | null
  usage?: string
  receiver?: string | null
}

type RestoreAllocation = {
  materialId: string
  batchId: string
  quantity: number
}

type PreviewBatch = {
  id: string
  material_id: string
  batch_no: string
  quantity: number
  remaining: number
  status: number
  expiry_date?: string | null
  created_at?: string | null
  inbound_price?: number | null
  [key: string]: unknown
}

/**
 * 无副作用地预演 helper 将执行的“精确恢复 + 钉批优先 + FEFO 跨批分配”。
 * 用于在写锁前拒绝确定失败的请求；锁内仍会由 inventory-transactions helper
 * 重新读取并执行，预演结果绝不作为写入依据。
 */
function previewOutboundAllocations(
  db: any,
  requestItems: OutboundRequestItem[],
  restorations: RestoreAllocation[] = [],
): { items: any[]; totalCost: number } {
  const materialIds = [...new Set([
    ...requestItems.map((item) => item.materialId),
    ...restorations.map((item) => item.materialId),
  ])]
  const materialActive = new Map<string, boolean>()
  const batchesByMaterial = new Map<string, PreviewBatch[]>()

  for (const materialId of materialIds) {
    const material = db.prepare('SELECT is_deleted FROM materials WHERE id = ?').get(materialId) as any
    materialActive.set(materialId, Boolean(material) && Number(material.is_deleted) === 0)
    const batches = (db.prepare('SELECT * FROM batches WHERE material_id = ?').all(materialId) as any[])
      .map((batch): PreviewBatch => {
        const quantity = parseFiniteNumber(batch.quantity)
        const remaining = parseFiniteNumber(batch.remaining)
        if (quantity === null || remaining === null || quantity < 0 || remaining < 0) {
          throw new InventoryTransactionError('Batch stock exceeds the supported numeric range', 'INVALID_PARAMETER')
        }
        return { ...batch, quantity, remaining, status: Number(batch.status) }
      })
    batchesByMaterial.set(materialId, batches)
  }

  for (const restoration of restorations) {
    const batch = batchesByMaterial.get(restoration.materialId)?.find((candidate) => candidate.id === restoration.batchId)
    if (!batch) throw new InventoryTransactionError('Original batch is unavailable for reversal')
    const remainingAfter = checkedAdd(batch.remaining, restoration.quantity)
    if (remainingAfter === null) {
      throw new InventoryTransactionError('Batch reversal exceeds the supported numeric range', 'INVALID_PARAMETER')
    }
    if (remainingAfter > batch.quantity) {
      throw new InventoryTransactionError('Batch reversal would exceed its received quantity')
    }
    batch.remaining = remainingAfter
    batch.status = 1
  }

  const transactionItems = [
    ...requestItems.filter((item) => item.batchId || item.batchNo),
    ...requestItems.filter((item) => !item.batchId && !item.batchNo),
  ]
  const plannedItems: any[] = []
  let totalCost = 0

  for (const item of transactionItems) {
    if (!materialActive.get(item.materialId)) {
      throw new InventoryTransactionError('Insufficient batch stock', 'STOCK_INSUFFICIENT')
    }
    const materialBatches = batchesByMaterial.get(item.materialId) ?? []
    let candidates: PreviewBatch[]
    if (item.batchId || item.batchNo) {
      const selected = item.batchId
        ? materialBatches.find((batch) => batch.id === item.batchId)
        : materialBatches.find((batch) => batch.batch_no === item.batchNo)
      if (!selected || (item.batchNo && selected.batch_no !== item.batchNo)
        || selected.status !== 1 || selected.remaining <= 0) {
        throw new InventoryTransactionError('Specified batch is unavailable', 'STOCK_INSUFFICIENT')
      }
      candidates = [selected]
    } else {
      candidates = materialBatches
        .filter((batch) => batch.status === 1 && batch.remaining > 0)
        .sort((left, right) => {
          const leftExpiry = typeof left.expiry_date === 'string' && left.expiry_date.trim() ? left.expiry_date : null
          const rightExpiry = typeof right.expiry_date === 'string' && right.expiry_date.trim() ? right.expiry_date : null
          if (leftExpiry === null && rightExpiry !== null) return 1
          if (leftExpiry !== null && rightExpiry === null) return -1
          if (leftExpiry !== rightExpiry) return String(leftExpiry).localeCompare(String(rightExpiry))
          const createdOrder = String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''))
          return createdOrder || left.id.localeCompare(right.id)
        })
    }

    let needed = item.quantity
    for (const batch of candidates) {
      if (needed <= 0) break
      const quantity = Math.min(batch.remaining, needed)
      if (quantity <= 0) continue
      const costResult = resolveOutboundUnitCost(db, item.materialId, batch)
      const itemCost = checkedMultiply(costResult.unitCost, quantity)
      const nextTotalCost = itemCost === null ? null : checkedAdd(totalCost, itemCost)
      if (itemCost === null || nextTotalCost === null) {
        throw new InventoryTransactionError('Outbound cost exceeds the supported numeric range', 'INVALID_PARAMETER')
      }
      totalCost = nextTotalCost
      plannedItems.push({
        materialId: item.materialId,
        batchId: batch.id,
        batchNo: batch.batch_no,
        quantity,
        unitCost: costResult.unitCost,
        itemCost,
        usage: item.usage || 'self',
        receiver: item.receiver || null,
        drift: costResult.drift,
        costSource: costResult.source,
        costNote: costResult.note,
      })
      const remainingAfter = checkedSubtract(batch.remaining, quantity)
      const neededAfter = checkedSubtract(needed, quantity)
      if (remainingAfter === null || neededAfter === null) {
        throw new InventoryTransactionError('Batch allocation exceeds the supported numeric range', 'INVALID_PARAMETER')
      }
      batch.remaining = remainingAfter
      needed = neededAfter
      if (batch.remaining === 0) batch.status = 0
    }
    if (needed > 0) {
      const message = item.batchId || item.batchNo ? 'Insufficient specified batch stock' : 'Insufficient batch stock'
      throw new InventoryTransactionError(message, 'STOCK_INSUFFICIENT')
    }
  }

  return { items: plannedItems, totalCost }
}

function restoreAllocationsFromOutboundItems(items: any[]): RestoreAllocation[] {
  const grouped = new Map<string, RestoreAllocation>()
  for (const item of items) {
    const materialId = typeof item.material_id === 'string' ? item.material_id : ''
    const batchId = typeof item.batch_id === 'string' && item.batch_id.trim() ? item.batch_id : ''
    const quantity = parseFinitePositiveNumber(item.quantity)
    if (!materialId || !batchId) {
      throw new InventoryTransactionError('Original batch allocation is unavailable for reversal')
    }
    if (quantity === null) {
      throw new InventoryTransactionError('Original outbound quantity exceeds the supported numeric range', 'INVALID_PARAMETER')
    }
    const key = `${materialId}\u0000${batchId}`
    const previous = grouped.get(key)
    const groupedQuantity = checkedAdd(previous?.quantity ?? 0, quantity)
    if (groupedQuantity === null) {
      throw new InventoryTransactionError('Batch reversal exceeds the supported numeric range', 'INVALID_PARAMETER')
    }
    grouped.set(key, { materialId, batchId, quantity: groupedQuantity })
  }
  return [...grouped.values()]
}

function groupRestorationsByMaterial(restorations: RestoreAllocation[]): Map<string, RestoreAllocation[]> {
  const grouped = new Map<string, RestoreAllocation[]>()
  for (const restoration of restorations) {
    const materialItems = grouped.get(restoration.materialId) ?? []
    materialItems.push(restoration)
    grouped.set(restoration.materialId, materialItems)
  }
  return grouped
}

function sumRestorationQuantity(restorations: RestoreAllocation[]): number {
  let total = 0
  for (const restoration of restorations) {
    const next = checkedAdd(total, restoration.quantity)
    if (next === null) {
      throw new InventoryTransactionError('Batch reversal exceeds the supported numeric range', 'INVALID_PARAMETER')
    }
    total = next
  }
  return total
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
      const batchId = item.batchId == null || item.batchId === ''
        ? null
        : typeof item.batchId === 'string' && item.batchId.trim()
          ? item.batchId.trim()
          : undefined
      const batchNo = item.batchNo == null || item.batchNo === ''
        ? null
        : typeof item.batchNo === 'string' && item.batchNo.trim()
          ? item.batchNo.trim()
          : undefined
      if (batchId === undefined || batchNo === undefined) {
        error(res, 'Invalid batch selector', 'INVALID_PARAMETER', 400); return
      }
      normalizedItems.push({ ...item, quantity: normalizedQuantity, batchId, batchNo })
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

    // 锁前预演用于零副作用快速拒绝；锁内仍重新预演并由 helper 执行真实分配。
    try {
      previewOutboundAllocations(db, normalizedItems)
    } catch (err) {
      const inventoryError = inventoryTransactionError(err)
      if (!inventoryError) throw err
      error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode)
      return
    }

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + normalizedItems.map(() => '?').join(',') + ')').all(...normalizedItems.map((i: any) => i.materialId)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))

    // 事务保护：出库涉及 records + items + inventory + batches + stock_logs 多表操作
    db.exec('BEGIN IMMEDIATE')
    try {
      if (idemKey) claimIdempotency(db, idemKey, idemScope, idemFingerprint, operator)
      previewOutboundAllocations(db, normalizedItems)
      let totalCost = 0
      const outboundItems: any[] = []
      const stockMutations: Array<{ materialId: string; quantity: number; before: number; after: number }> = []

      // 先兑现显式钉批，再让未指定项在剩余批次上跑 FEFO，避免请求顺序让 FEFO 抢走钉批库存。
      const transactionItems = [
        ...normalizedItems.filter((item) => item.batchId || item.batchNo),
        ...normalizedItems.filter((item) => !item.batchId && !item.batchNo),
      ]
      for (const item of transactionItems) {
        const consumed = consumeBatchStock(
          db,
          item.materialId,
          item.quantity,
          { batchId: item.batchId, batchNo: item.batchNo },
          { lastOutboundId: id },
        )
        stockMutations.push({
          materialId: item.materialId,
          quantity: item.quantity,
          before: consumed.inventory.before,
          after: consumed.inventory.after,
        })

        for (const allocation of consumed.allocations) {
          const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND material_id = ?')
            .get(allocation.batchId, item.materialId) as any
          if (!batch) throw new InventoryTransactionError('Allocated batch disappeared before cost snapshot')
          const costResult = resolveOutboundUnitCost(db, item.materialId, batch)
          const itemCost = checkedMultiply(costResult.unitCost, allocation.quantity)
          const nextTotalCost = itemCost === null ? null : checkedAdd(totalCost, itemCost)
          if (itemCost === null || nextTotalCost === null) {
            throw new InventoryTransactionError('Outbound cost exceeds the supported numeric range', 'INVALID_PARAMETER')
          }
          totalCost = nextTotalCost
          outboundItems.push({
            materialId: item.materialId,
            batchId: allocation.batchId,
            batchNo: allocation.batchNo,
            quantity: allocation.quantity,
            unitCost: costResult.unitCost,
            itemCost,
            usage: item.usage || 'self',
            receiver: item.receiver || null,
            drift: costResult.drift,
            costSource: costResult.source,
            costNote: costResult.note,
          })
        }
      }

      db.prepare(`
        INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, remark)
        VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
      `).run(id, outboundNo, type, projectId || null, totalCost, operator, remark || null)

      for (const oi of outboundItems) {
        const itemId = uuidv4()
        db.prepare(`
          INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, id, oi.materialId, oi.batchId, oi.batchNo, oi.quantity, unitMap.get(oi.materialId) || 'pcs', oi.unitCost, oi.itemCost, oi.usage || 'self', oi.receiver || null)

        if (oi.drift) recordLedgerDrift(db, id, oi, operator)

        // 自用物料创建使用中跟踪记录
        if ((oi.usage || 'self') === 'self' && oi.batchId) {
          const mat = db.prepare('SELECT name, spec FROM materials WHERE id = ? AND is_deleted = 0').get(oi.materialId) as any
          const trkId = `TRK-${uuidv4()}`
          const today = new Date().toISOString().split('T')[0]
          db.prepare(`
            INSERT INTO batch_usage_tracking
            (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
          `).run(trkId, oi.materialId, mat?.name || '', oi.batchNo || '', mat?.spec || '', oi.quantity, oi.quantity, unitMap.get(oi.materialId) || 'pcs', today, 30, 'self', null)
        }

      }

      for (const mutation of stockMutations) {
        const logId = uuidv4()
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
        `).run(logId, mutation.materialId, -mutation.quantity, mutation.before, mutation.after, id, operator)
      }

      responseEnvelope = buildSuccessEnvelope({ id, outboundNo, type, projectId, totalCost, status: 'completed', createdAt: new Date().toISOString() }, 'Outbound created')
      if (idemKey) finalizeIdempotency(db, idemKey, 201, responseEnvelope)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (idemKey && isIdempotencyConflict(err) && tryReplayIdempotency(db, res, idemKey, idemScope, idemFingerprint)) return
      const inventoryError = inventoryTransactionError(err)
      if (inventoryError) {
        error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode)
        return
      }
      throw err
    }

    res.status(201).json(responseEnvelope)
  } catch (err: any) {
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
      const batchId = item.batchId == null || item.batchId === ''
        ? null
        : typeof item.batchId === 'string' && item.batchId.trim()
          ? item.batchId.trim()
          : undefined
      const batchNo = item.batchNo == null || item.batchNo === ''
        ? null
        : typeof item.batchNo === 'string' && item.batchNo.trim()
          ? item.batchNo.trim()
          : undefined
      if (batchId === undefined || batchNo === undefined) {
        error(res, 'Invalid batch selector', 'INVALID_PARAMETER', 400); return
      }
      normalizedNewItems.push({ ...item, quantity: normalizedQuantity, batchId, batchNo })
    }

    const db = getDatabase()
    const record = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    if (record.type === 'bom') {
      error(res, 'Historical BOM outbound records are read-only', 'OUTBOUND_TYPE_RETIRED', 409); return
    }

    const oldItems = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]
    let newTotalCost = 0
    try {
      const restorations = restoreAllocationsFromOutboundItems(oldItems)
      newTotalCost = previewOutboundAllocations(db, normalizedNewItems, restorations).totalCost
    } catch (err) {
      const inventoryError = inventoryTransactionError(err)
      if (!inventoryError) throw err
      error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode)
      return
    }

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + normalizedNewItems.map(() => '?').join(',') + ')').all(...normalizedNewItems.map((i: any) => i.materialId)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))
    const operator = req.body.operator || 'system'

    db.exec('BEGIN IMMEDIATE')
    try {
      const transactionRecord = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
      if (!transactionRecord) {
        db.exec('ROLLBACK')
        error(res, 'Outbound record changed before update', 'CONCURRENT_MODIFICATION', 409)
        return
      }
      if (transactionRecord.type === 'bom') {
        db.exec('ROLLBACK')
        error(res, 'Historical BOM outbound records are read-only', 'OUTBOUND_TYPE_RETIRED', 409)
        return
      }
      const transactionOldItems = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]
      const restorations = restoreAllocationsFromOutboundItems(transactionOldItems)
      previewOutboundAllocations(db, normalizedNewItems, restorations)

      const restorationLogs: Array<{ materialId: string; quantity: number; before: number; after: number }> = []
      for (const [materialId, allocations] of groupRestorationsByMaterial(restorations)) {
        const snapshot = restoreBatchStock(
          db,
          materialId,
          allocations.map(({ batchId, quantity }) => ({ batchId, quantity })),
        )
        const quantity = sumRestorationQuantity(allocations)
        restorationLogs.push({ materialId, quantity, before: snapshot.before, after: snapshot.after })
      }

      // 现有 tracking 表没有 outbound_id；只能沿用“物料 + 批号 + in-use”的最窄可用清理条件。
      for (const item of transactionOldItems) {
        if (item.batch_no) {
          db.prepare("DELETE FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'")
            .run(item.material_id, item.batch_no)
        }
      }
      db.prepare('DELETE FROM outbound_items WHERE outbound_id = ?').run(id)

      const processedItems: any[] = []
      const stockMutations: Array<{ materialId: string; quantity: number; before: number; after: number }> = []
      let transactionTotalCost = 0
      const transactionItems = [
        ...normalizedNewItems.filter((item) => item.batchId || item.batchNo),
        ...normalizedNewItems.filter((item) => !item.batchId && !item.batchNo),
      ]
      for (const item of transactionItems) {
        const consumed = consumeBatchStock(
          db,
          item.materialId,
          item.quantity,
          { batchId: item.batchId, batchNo: item.batchNo },
          { lastOutboundId: id },
        )
        stockMutations.push({
          materialId: item.materialId,
          quantity: item.quantity,
          before: consumed.inventory.before,
          after: consumed.inventory.after,
        })
        for (const allocation of consumed.allocations) {
          const batch = db.prepare('SELECT * FROM batches WHERE id = ? AND material_id = ?')
            .get(allocation.batchId, item.materialId) as any
          if (!batch) throw new InventoryTransactionError('Allocated batch disappeared before cost snapshot')
          const costResult = resolveOutboundUnitCost(db, item.materialId, batch)
          const itemCost = checkedMultiply(costResult.unitCost, allocation.quantity)
          const nextTotalCost = itemCost === null ? null : checkedAdd(transactionTotalCost, itemCost)
          if (itemCost === null || nextTotalCost === null) {
            throw new InventoryTransactionError('Outbound cost exceeds the supported numeric range', 'INVALID_PARAMETER')
          }
          transactionTotalCost = nextTotalCost
          processedItems.push({
            materialId: item.materialId,
            batchId: allocation.batchId,
            batchNo: allocation.batchNo,
            quantity: allocation.quantity,
            unitCost: costResult.unitCost,
            itemCost,
            usage: item.usage || 'self',
            receiver: item.receiver || null,
            drift: costResult.drift,
            costSource: costResult.source,
            costNote: costResult.note,
          })
        }
      }
      newTotalCost = transactionTotalCost

      const updatedType = type ?? transactionRecord.type
      const updatedProjectId = projectId !== undefined ? projectId || null : transactionRecord.project_id
      const updatedRemark = remark !== undefined ? remark || null : transactionRecord.remark
      db.prepare('UPDATE outbound_records SET type = ?, project_id = ?, total_cost = ?, remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(updatedType, updatedProjectId, newTotalCost, updatedRemark, id)

      for (const pi of processedItems) {
        const itemId = uuidv4()
        db.prepare(`
          INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, id, pi.materialId, pi.batchId, pi.batchNo, pi.quantity, unitMap.get(pi.materialId) || 'pcs', pi.unitCost, pi.itemCost, pi.usage || 'self', pi.receiver || null)

        if (pi.drift) recordLedgerDrift(db, id, pi, operator)

        if ((pi.usage || 'self') === 'self' && pi.batchId) {
          const mat = db.prepare('SELECT name, spec FROM materials WHERE id = ? AND is_deleted = 0').get(pi.materialId) as any
          const trkId = `TRK-${uuidv4()}`
          const today = new Date().toISOString().split('T')[0]
          db.prepare(`
            INSERT INTO batch_usage_tracking
            (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
          `).run(trkId, pi.materialId, mat?.name || '', pi.batchNo || '', mat?.spec || '', pi.quantity, pi.quantity, unitMap.get(pi.materialId) || 'pcs', today, 30, 'self', null)
        }
      }

      for (const restoration of restorationLogs) {
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'return', ?, ?, ?, ?, ?, 'outbound_update', ?, '出库修改：回退原明细')
        `).run(uuidv4(), restoration.materialId, restoration.quantity, restoration.before, restoration.after, id, operator)
      }
      for (const mutation of stockMutations) {
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
        `).run(uuidv4(), mutation.materialId, -mutation.quantity, mutation.before, mutation.after, id, operator)
      }

      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      const inventoryError = inventoryTransactionError(err)
      if (inventoryError) {
        error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode)
        return
      }
      throw err
    }

    success(res, { id, totalCost: newTotalCost }, 'Outbound updated')
  } catch (err: any) {
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    if (err?.code === 'LEDGER_DRIFT') { error(res, err.message, 'LEDGER_DRIFT', 409); return }
    error(res, err.message)
  }
})

router.delete('/:id', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, 'Record not found', 'NOT_FOUND', 404); return }
    if (record.type === 'bom') {
      error(res, 'Historical BOM outbound records are read-only', 'OUTBOUND_TYPE_RETIRED', 409); return
    }

    const items = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]
    try {
      const restorations = restoreAllocationsFromOutboundItems(items)
      previewOutboundAllocations(db, [], restorations)
    } catch (err) {
      const inventoryError = inventoryTransactionError(err)
      if (!inventoryError) throw err
      error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode)
      return
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      const transactionRecord = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
      if (!transactionRecord) {
        db.exec('ROLLBACK')
        error(res, 'Outbound record changed before delete', 'CONCURRENT_MODIFICATION', 409)
        return
      }
      if (transactionRecord.type === 'bom') {
        db.exec('ROLLBACK')
        error(res, 'Historical BOM outbound records are read-only', 'OUTBOUND_TYPE_RETIRED', 409)
        return
      }
      const transactionItems = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]
      const restorations = restoreAllocationsFromOutboundItems(transactionItems)
      previewOutboundAllocations(db, [], restorations)

      const restorationLogs: Array<{ materialId: string; quantity: number; before: number; after: number }> = []
      for (const [materialId, allocations] of groupRestorationsByMaterial(restorations)) {
        const snapshot = restoreBatchStock(
          db,
          materialId,
          allocations.map(({ batchId, quantity }) => ({ batchId, quantity })),
        )
        const quantity = sumRestorationQuantity(allocations)
        restorationLogs.push({ materialId, quantity, before: snapshot.before, after: snapshot.after })
      }

      // tracking 表没有 outbound_id，无法精确识别来源；沿用现有最窄条件清理。
      for (const item of transactionItems) {
        if (item.batch_no) {
          db.prepare("DELETE FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'")
            .run(item.material_id, item.batch_no)
        }
      }

      const deleted = db.prepare(`
        UPDATE outbound_records SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND is_deleted = 0
      `).run(id)
      if (Number(deleted.changes) !== 1) {
        throw new InventoryTransactionError('Outbound record changed during delete')
      }

      for (const restoration of restorationLogs) {
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'delete', ?, ?, ?, ?, ?, 'outbound_delete', ?, '删除出库记录')
        `).run(
          uuidv4(),
          restoration.materialId,
          restoration.quantity,
          restoration.before,
          restoration.after,
          id,
          req.body.operator || 'system',
        )
      }

      db.exec('COMMIT')
      success(res, null, '删除成功，库存已同步回退')
    } catch (err) {
      db.exec('ROLLBACK')
      const inventoryError = inventoryTransactionError(err)
      if (inventoryError) {
        error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode)
        return
      }
      throw err
    }
  } catch (err: any) {
    const inventoryError = inventoryTransactionError(err)
    if (inventoryError) { error(res, inventoryError.message, inventoryError.code, inventoryError.statusCode); return }
    if (err?.code === 'LEDGER_DRIFT') { error(res, err.message, 'LEDGER_DRIFT', 409); return }
    error(res, err.message)
  }
})

export default router
