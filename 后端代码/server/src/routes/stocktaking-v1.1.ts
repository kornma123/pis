import { Router, type Request } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { error, success, successList } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  InventoryTransactionError,
  applyInventoryPlan,
  assertInventoryConserved,
  inventoryErrorResponse,
  inventoryQuantityDelta,
  parseInventoryQuantity,
  planExactPositionDelta,
  replaceAllocationFacts,
  type InventoryPlan,
} from '../services/inventory-transactions.js'

const router = Router()
const requireStocktakingRecord = requirePermission('stocktaking', 'W')
const requireStocktakingAdjust = requirePermission('stocktaking_adjust', 'W')
const requireStocktakingReverse = requirePermission('stocktaking_reverse', 'W')

type StocktakingActorRequest = Request & {
  user?: { username?: string }
}

type PositionSnapshot = {
  resolutionState: 'resolved' | 'unresolved' | 'legacy_material'
  materialId: string
  positionId: string | null
  batchId: string | null
  locationId: string | null
  systemStock: number
  snapshotVersion: number | null
}

type InventoryEventWrite = {
  eventId: string
  recordId: string
  eventKind: 'adjustment' | 'compensation'
  parentEventId: string | null
  rootEventId: string
  chainDepth: number
  materialId: string
  positionId: string
  batchId: string | null
  locationId: string
  quantityDelta: number
  batchQuantityDelta: number
  operator: string
  reason: string
  plan: InventoryPlan
}

function generateNo(prefix = 'ST'): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `${prefix}-${date}-${timestamp}-${random}`
}

function fail(message: string, code: string, status: number): never {
  throw new InventoryTransactionError(message, code, status)
}

function actorName(req: StocktakingActorRequest): string {
  const username = req.user?.username
  if (typeof username !== 'string' || !username.trim()) fail('Authenticated actor is missing', 'UNAUTHORIZED', 401)
  return username
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim()) fail('Text value is invalid', 'INVALID_PARAMETER', 400)
  return value.trim()
}

function rowIdentityMatches(row: any, body: any): boolean {
  return row.material_id === body.materialId
    && row.batch_id === (body.batchId ?? null)
    && row.location_id === body.locationId
}

function loadPositionSnapshot(db: any, body: any): PositionSnapshot {
  const material = db.prepare(`
    SELECT id, batch_managed FROM materials WHERE id = ? AND is_deleted = 0
  `).get(body.materialId) as any
  if (!material) fail('Material not found', 'NOT_FOUND', 404)
  const materialStock = assertInventoryConserved(db, body.materialId)
  if (body.positionId !== undefined && body.positionId !== null) {
    const position = db.prepare(`
      SELECT id, material_id, batch_id, location_id, quantity, version
      FROM inventory_positions WHERE id = ?
    `).get(body.positionId) as any
    if (!position) fail('Position not found', 'POSITION_NOT_FOUND', 404)
    if (!rowIdentityMatches(position, body)) {
      fail('Position identity does not match material, batch, and location', 'POSITION_IDENTITY_MISMATCH', 409)
    }
    return {
      resolutionState: 'resolved',
      materialId: position.material_id,
      positionId: position.id,
      batchId: position.batch_id,
      locationId: position.location_id,
      systemStock: parseInventoryQuantity(position.quantity, { positive: true }),
      snapshotVersion: Number(position.version),
    }
  }

  const hasLocation = typeof body.locationId === 'string' && body.locationId.trim().length > 0
  const hasApplicableBatch = material.batch_managed === 1
    ? typeof body.batchId === 'string' && body.batchId.trim().length > 0
    : body.batchId === null || body.batchId === undefined
  if (!hasLocation && body.batchId === undefined) {
    return {
      resolutionState: 'legacy_material',
      materialId: body.materialId,
      positionId: null,
      batchId: null,
      locationId: null,
      systemStock: materialStock,
      snapshotVersion: null,
    }
  }
  if (hasLocation && hasApplicableBatch) {
    const position = db.prepare(`
      SELECT id, material_id, batch_id, location_id, quantity, version
      FROM inventory_positions
      WHERE material_id = ? AND batch_id IS ? AND location_id = ?
    `).get(body.materialId, body.batchId, body.locationId) as any
    if (position) {
      return {
        resolutionState: 'resolved',
        materialId: position.material_id,
        positionId: position.id,
        batchId: position.batch_id,
        locationId: position.location_id,
        systemStock: parseInventoryQuantity(position.quantity, { positive: true }),
        snapshotVersion: Number(position.version),
      }
    }
  }
  return {
    resolutionState: 'unresolved',
    materialId: body.materialId,
    positionId: null,
    batchId: body.batchId ?? null,
    locationId: hasLocation ? body.locationId : null,
    systemStock: 0,
    snapshotVersion: null,
  }
}

function insertStocktakingRecord(
  db: any,
  snapshot: PositionSnapshot,
  actualStock: number,
  actor: string,
  reason: string | null,
  remark: string | null,
): { id: string; status: string; difference: number } {
  const difference = inventoryQuantityDelta(actualStock, snapshot.systemStock)
  const status = snapshot.resolutionState === 'unresolved'
    ? 'unresolved'
    : difference === 0 ? 'completed' : 'pending'
  const id = uuidv4()
  db.prepare(`
    INSERT INTO stocktaking_records
      (id, stocktaking_no, material_id, position_id, batch_id, location_id,
       snapshot_position_version, resolution_state, system_stock, actual_stock,
       difference, operator, status, reason, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    generateNo(),
    snapshot.materialId,
    snapshot.positionId,
    snapshot.batchId,
    snapshot.locationId,
    snapshot.snapshotVersion,
    snapshot.resolutionState,
    snapshot.systemStock,
    actualStock,
    difference,
    actor,
    status,
    reason,
    remark,
  )
  return { id, status, difference }
}

function ensureSnapshotCurrent(db: any, record: any): void {
  assertInventoryConserved(db, record.material_id)
  const position = db.prepare(`
    SELECT material_id, batch_id, location_id, quantity, version
    FROM inventory_positions WHERE id = ?
  `).get(record.position_id) as any
  if (
    !position
    || position.material_id !== record.material_id
    || position.batch_id !== record.batch_id
    || position.location_id !== record.location_id
    || Number(position.version) !== Number(record.snapshot_position_version)
    || inventoryQuantityDelta(position.quantity, record.system_stock) !== 0
  ) {
    fail('Inventory changed after the stocktaking snapshot', 'STOCK_CHANGED', 409)
  }
}

function persistInventoryEvent(db: any, input: InventoryEventWrite): void {
  const allocation = input.plan.allocations[0]
  if (!allocation || input.plan.allocations.length !== 1) {
    fail('Stocktaking event must have one exact allocation', 'INVENTORY_LEDGER_CORRUPT', 409)
  }
  applyInventoryPlan(db, input.plan)
  replaceAllocationFacts(db, {
    operationKind: 'stocktaking',
    ownerId: input.eventId,
    direction: input.quantityDelta > 0 ? 'in' : 'out',
    allocations: input.plan.allocations,
  })
  db.prepare(`
    INSERT INTO stock_logs
      (id, type, material_id, quantity, before_stock, after_stock,
       related_id, related_type, operator, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'stocktaking', ?, ?)
  `).run(
    uuidv4(),
    input.eventKind === 'adjustment' ? 'stocktaking_adjustment' : 'stocktaking_compensation',
    input.materialId,
    input.quantityDelta,
    allocation.inventoryBefore,
    allocation.inventoryAfter,
    input.eventId,
    input.operator,
    input.reason,
  )
  db.prepare(`
    INSERT INTO stocktaking_adjustment_events
      (id, stocktaking_record_id, event_kind, parent_event_id, root_event_id,
       chain_depth, material_id, position_id, batch_id, location_id,
       quantity_delta, batch_quantity_delta, inventory_before, inventory_after,
       operator, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventId,
    input.recordId,
    input.eventKind,
    input.parentEventId,
    input.rootEventId,
    input.chainDepth,
    input.materialId,
    input.positionId,
    input.batchId,
    input.locationId,
    input.quantityDelta,
    input.batchQuantityDelta,
    allocation.inventoryBefore,
    allocation.inventoryAfter,
    input.operator,
    input.reason,
  )
}

function handleInventoryFailure(res: any, caught: unknown): void {
  const failure = inventoryErrorResponse(caught)
  if (failure) {
    error(res, failure.message, failure.code, failure.status)
    return
  }
  error(res, 'Stocktaking failed')
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, keyword } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) {
      where += ' AND stocktaking_no LIKE ?'
      params.push(`%${keyword}%`)
    }
    const db = getDatabase()
    const count = Number((db.prepare(`SELECT COUNT(*) AS total FROM stocktaking_records WHERE ${where}`).get(...params) as any)?.total || 0)
    const rows = db.prepare(`
      SELECT * FROM stocktaking_records WHERE ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)) as any[]
    successList(res, rows.map(row => ({
      id: row.id,
      stocktakingNo: row.stocktaking_no,
      sheetNo: row.sheet_no,
      materialId: row.material_id,
      positionId: row.position_id,
      batchId: row.batch_id,
      locationId: row.location_id,
      systemStock: row.system_stock,
      actualStock: row.actual_stock,
      difference: row.difference,
      operator: row.operator,
      status: row.status,
      reason: row.reason,
      remark: row.remark,
      createdAt: row.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (caught) {
    handleInventoryFailure(res, caught)
  }
})

router.post('/', requireStocktakingRecord, (req: StocktakingActorRequest, res) => {
  const { materialId, actualStock } = req.body ?? {}
  if (typeof materialId !== 'string' || !materialId.trim() || actualStock === undefined) {
    error(res, 'Missing fields', 'INVALID_PARAMETER', 400)
    return
  }
  let transactionStarted = false
  try {
    const actual = parseInventoryQuantity(actualStock)
    const reason = optionalText(req.body.reason)
    const remark = optionalText(req.body.remark)
    const db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const snapshot = loadPositionSnapshot(db, req.body)
    const saved = insertStocktakingRecord(db, snapshot, actual, actorName(req), reason, remark)
    db.exec('COMMIT')
    transactionStarted = false
    success(res, {
      id: saved.id,
      status: saved.status,
      materialId: snapshot.materialId,
      positionId: snapshot.positionId,
      batchId: snapshot.batchId,
      locationId: snapshot.locationId,
      snapshotVersion: snapshot.snapshotVersion,
    }, 'Stocktaking evidence recorded')
  } catch (caught) {
    if (transactionStarted) getDatabase().exec('ROLLBACK')
    handleInventoryFailure(res, caught)
  }
})

router.post('/batch', requireStocktakingRecord, (req: StocktakingActorRequest, res) => {
  try {
    const { items, remark } = req.body ?? {}
    if (!Array.isArray(items) || items.length === 0) {
      error(res, 'Stocktaking items cannot be empty', 'INVALID_PARAMETER', 400)
      return
    }
    const db = getDatabase()
    const seen = new Set<string>()
    const plan: Array<{ materialId: string; actualStock: number; systemStock: number; remark?: string }> = []
    for (const item of items) {
      if (!item || typeof item !== 'object' || !item.materialId || item.actualStock === undefined || seen.has(item.materialId)) {
        error(res, 'Invalid or duplicate stocktaking item', 'INVALID_PARAMETER', 422)
        return
      }
      seen.add(item.materialId)
      if (!db.prepare('SELECT id FROM materials WHERE id = ? AND is_deleted = 0').get(item.materialId)) {
        error(res, 'Material not found', 'NOT_FOUND', 422)
        return
      }
      const actual = parseInventoryQuantity(item.actualStock)
      const system = assertInventoryConserved(db, item.materialId)
      if (inventoryQuantityDelta(actual, system) !== 0) {
        error(res, 'Position detail is required for an inventory adjustment', 'BATCH_DETAIL_REQUIRED', 422)
        return
      }
      plan.push({ materialId: item.materialId, actualStock: actual, systemStock: system, remark: item.remark })
    }
    const sheetNo = generateNo('STS')
    const ids: string[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of plan) {
        if (inventoryQuantityDelta(assertInventoryConserved(db, item.materialId), item.systemStock) !== 0) {
          fail('Inventory changed before stocktaking was recorded', 'STOCK_CHANGED', 409)
        }
        const id = uuidv4()
        ids.push(id)
        db.prepare(`
          INSERT INTO stocktaking_records
            (id, stocktaking_no, sheet_no, material_id, resolution_state,
             system_stock, actual_stock, difference, operator, status, remark)
          VALUES (?, ?, ?, ?, 'legacy_material', ?, ?, 0, ?, 'completed', ?)
        `).run(
          id,
          generateNo(),
          sheetNo,
          item.materialId,
          item.systemStock,
          item.actualStock,
          actorName(req),
          optionalText(item.remark ?? remark),
        )
      }
      db.exec('COMMIT')
      success(res, { sheetNo, count: ids.length, ids }, 'Stocktaking batch recorded', 201)
    } catch (caught) {
      db.exec('ROLLBACK')
      throw caught
    }
  } catch (caught) {
    handleInventoryFailure(res, caught)
  }
})

router.post('/:id/adjust', requireStocktakingAdjust, (req: StocktakingActorRequest, res) => {
  const db = getDatabase()
  let transactionStarted = false
  try {
    db.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0')
      .get(req.params.id) as any
    if (!record) fail('Stocktaking record not found', 'NOT_FOUND', 404)
    if (record.resolution_state === 'legacy_material') {
      fail('Position detail is required before this adjustment can be applied', 'BATCH_DETAIL_REQUIRED', 422)
    }
    if (record.resolution_state !== 'resolved' || !record.position_id || !record.location_id) {
      fail('Stocktaking evidence is not linked to an existing position', 'POSITION_UNRESOLVED', 422)
    }
    if (record.status !== 'pending') fail('Stocktaking record is not pending', 'ALREADY_ADJUSTED', 400)
    const reason = optionalText(record.reason) ?? optionalText(req.body?.reason)
    if (!reason) fail('Adjustment reason is required', 'REASON_REQUIRED', 400)
    ensureSnapshotCurrent(db, record)
    const quantityDelta = parseInventoryQuantity(record.difference, { allowNegative: true })
    const batchQuantityDelta = record.batch_id && quantityDelta > 0 ? quantityDelta : 0
    const eventId = uuidv4()
    const plan = planExactPositionDelta(db, {
      materialId: record.material_id,
      positionId: record.position_id,
      batchId: record.batch_id,
      locationId: record.location_id,
      quantityDelta,
      batchQuantityDelta,
      ownerLineId: record.id,
    })
    persistInventoryEvent(db, {
      eventId,
      recordId: record.id,
      eventKind: 'adjustment',
      parentEventId: null,
      rootEventId: eventId,
      chainDepth: 0,
      materialId: record.material_id,
      positionId: record.position_id,
      batchId: record.batch_id,
      locationId: record.location_id,
      quantityDelta,
      batchQuantityDelta,
      operator: actorName(req),
      reason,
      plan,
    })
    db.prepare(`
      UPDATE stocktaking_records
      SET status = 'adjusted', adjustment_event_id = ?, reason = COALESCE(reason, ?)
      WHERE id = ?
    `).run(eventId, reason, record.id)
    db.exec('COMMIT')
    transactionStarted = false
    success(res, { id: record.id, eventId, status: 'adjusted' }, 'Stocktaking adjustment applied')
  } catch (caught) {
    if (transactionStarted) db.exec('ROLLBACK')
    handleInventoryFailure(res, caught)
  }
})

router.post('/:id/explanations', requireStocktakingAdjust, (req: StocktakingActorRequest, res) => {
  try {
    const explanation = optionalText(req.body?.explanation)
    if (!explanation || explanation.length > 2000) fail('Explanation is invalid', 'INVALID_PARAMETER', 400)
    const db = getDatabase()
    const record = db.prepare(`
      SELECT id, adjustment_event_id FROM stocktaking_records
      WHERE id = ? AND is_deleted = 0
    `).get(req.params.id) as any
    if (!record) fail('Stocktaking record not found', 'NOT_FOUND', 404)
    if (!record.adjustment_event_id) fail('Stocktaking adjustment does not exist', 'ADJUSTMENT_NOT_FOUND', 409)
    const id = uuidv4()
    db.prepare(`
      INSERT INTO stocktaking_explanations
        (id, stocktaking_record_id, adjustment_event_id, sequence, explanation, operator)
      VALUES (
        ?, ?, ?,
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM stocktaking_explanations WHERE stocktaking_record_id = ?),
        ?, ?
      )
    `).run(id, record.id, record.adjustment_event_id, record.id, explanation, actorName(req))
    success(res, { id }, 'Stocktaking explanation appended', 201)
  } catch (caught) {
    handleInventoryFailure(res, caught)
  }
})

router.post('/:id/reverse', requireStocktakingReverse, (req: StocktakingActorRequest, res) => {
  const db = getDatabase()
  let transactionStarted = false
  try {
    const reason = optionalText(req.body?.reason)
    if (!reason) fail('Compensation reason is required', 'REASON_REQUIRED', 400)
    db.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0')
      .get(req.params.id) as any
    if (!record) fail('Stocktaking record not found', 'NOT_FOUND', 404)
    const targetEventId = req.body?.eventId ?? record.adjustment_event_id
    if (typeof targetEventId !== 'string' || !targetEventId) fail('Adjustment event is required', 'ADJUSTMENT_NOT_FOUND', 409)
    const target = db.prepare(`
      SELECT * FROM stocktaking_adjustment_events
      WHERE id = ? AND stocktaking_record_id = ?
    `).get(targetEventId, record.id) as any
    if (!target) fail('Adjustment event not found', 'ADJUSTMENT_NOT_FOUND', 404)
    if (db.prepare('SELECT 1 FROM stocktaking_adjustment_events WHERE parent_event_id = ?').get(target.id)) {
      fail('This event has already been compensated', 'ALREADY_REVERSED', 409)
    }
    const sourceAllocation = db.prepare(`
      SELECT id FROM inventory_transaction_allocations
      WHERE operation_kind = 'stocktaking' AND owner_id = ?
      ORDER BY created_at, id LIMIT 1
    `).get(target.id) as any
    if (!sourceAllocation) fail('Adjustment allocation fact not found', 'ALLOCATION_NOT_FOUND', 409)
    assertInventoryConserved(db, target.material_id)
    const quantityDelta = inventoryQuantityDelta(0, target.quantity_delta)
    const batchQuantityDelta = inventoryQuantityDelta(0, target.batch_quantity_delta)
    const eventId = uuidv4()
    const plan = planExactPositionDelta(db, {
      materialId: target.material_id,
      positionId: target.position_id,
      batchId: target.batch_id,
      locationId: target.location_id,
      quantityDelta,
      batchQuantityDelta,
      ownerLineId: record.id,
      sourceAllocationId: sourceAllocation.id,
    })
    persistInventoryEvent(db, {
      eventId,
      recordId: record.id,
      eventKind: 'compensation',
      parentEventId: target.id,
      rootEventId: target.root_event_id,
      chainDepth: Number(target.chain_depth) + 1,
      materialId: target.material_id,
      positionId: target.position_id,
      batchId: target.batch_id,
      locationId: target.location_id,
      quantityDelta,
      batchQuantityDelta,
      operator: actorName(req),
      reason,
      plan,
    })
    const status = (Number(target.chain_depth) + 1) % 2 === 0 ? 'adjusted' : 'compensated'
    db.prepare('UPDATE stocktaking_records SET status = ? WHERE id = ?').run(status, record.id)
    db.exec('COMMIT')
    transactionStarted = false
    success(res, { id: record.id, eventId, parentEventId: target.id, status }, 'Stocktaking compensation applied')
  } catch (caught) {
    if (transactionStarted) db.exec('ROLLBACK')
    handleInventoryFailure(res, caught)
  }
})

router.delete('/:id', requireStocktakingReverse, (req: StocktakingActorRequest, res) => {
  try {
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0')
      .get(req.params.id) as any
    if (!record) fail('Stocktaking record not found', 'NOT_FOUND', 404)
    if (record.adjustment_event_id) {
      fail('Adjusted stocktaking requires an append-only compensation', 'COMPENSATION_CHAIN_REQUIRED', 409)
    }
    if (Number(record.difference) !== 0 && record.status !== 'pending' && record.status !== 'unresolved') {
      fail('Historical stocktaking adjustment has no allocation fact', 'ALLOCATION_NOT_FOUND', 409)
    }
    if (record.status === 'cancelled') fail('Stocktaking record is already cancelled', 'ALREADY_CANCELLED', 409)
    db.prepare(`
      UPDATE stocktaking_records
      SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ?
      WHERE id = ?
    `).run(actorName(req), record.id)
    success(res, null, 'Stocktaking record cancelled')
  } catch (caught) {
    handleInventoryFailure(res, caught)
  }
})

export default router
