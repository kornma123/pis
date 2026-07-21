import { v4 as uuidv4 } from 'uuid'
import { checkedAdd, checkedSubtract, parseFiniteNumber } from '../utils/numeric-input.js'

/**
 * 库存事务唯一写入口。
 *
 * `batches.remaining` 是库存事实；`inventory.stock` 只在同一事务内由批次汇总派生。
 * 调用方必须已经开启写事务，避免批次分配与派生缓存之间出现并发窗口。
 */

export class InventoryTransactionError extends Error {
  constructor(
    message: string,
    readonly code: 'STOCK_INSUFFICIENT' | 'INVALID_PARAMETER' | 'LEDGER_DRIFT' = 'LEDGER_DRIFT',
    readonly statusCode = code === 'STOCK_INSUFFICIENT' ? 422 : code === 'INVALID_PARAMETER' ? 400 : 409,
  ) {
    super(message)
    this.name = 'InventoryTransactionError'
  }
}

export interface InventorySyncOptions {
  locationId?: string | null
  lastInboundId?: string | null
  lastOutboundId?: string | null
  allowDriftReconciliation?: boolean
}

export interface InventorySnapshot {
  before: number
  after: number
}

export interface BatchAllocation {
  batchId: string
  batchNo: string
  quantity: number
  unitCost: number
}

export interface BatchStockAllocation extends BatchAllocation {
  remainingBefore: number
  remainingAfter: number
}

export interface AddBatchStockInput {
  materialId: string
  quantity: number
  sourceType: 'inbound' | 'return' | 'stocktaking' | 'reversal'
  sourceId: string
  batchId?: string | null
  batchNo?: string | null
  productionDate?: string | null
  expiryDate?: string | null
  inboundPrice?: number | null
  supplierId?: string | null
  inventory?: InventorySyncOptions
  allowDriftReconciliation?: boolean
}

function finite(value: unknown, label: string): number {
  const parsed = parseFiniteNumber(value)
  if (parsed === null) {
    throw new InventoryTransactionError(`${label} exceeds the supported numeric range`, 'INVALID_PARAMETER')
  }
  return parsed
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label)
  if (parsed <= 0) throw new InventoryTransactionError(`${label} must be positive`, 'INVALID_PARAMETER')
  return parsed
}

function batchTotal(db: any, materialId: string): number {
  const rows = db.prepare('SELECT quantity, remaining, status FROM batches WHERE material_id = ?').all(materialId) as any[]
  let total = 0
  for (const row of rows) {
    const quantity = finite(row.quantity, 'Batch quantity')
    const remaining = finite(row.remaining, 'Batch remaining')
    if (quantity < 0 || remaining < 0 || remaining > quantity + 1e-9) {
      throw new InventoryTransactionError('Batch quantity and remaining are inconsistent')
    }
    const status = finite(row.status, 'Batch status')
    const expectedStatus = remaining === 0 ? 0 : 1
    if (status !== expectedStatus) {
      throw new InventoryTransactionError('Batch status is inconsistent with its remaining quantity')
    }
    const next = checkedAdd(total, remaining)
    if (next === null) throw new InventoryTransactionError('Batch total exceeds the supported numeric range', 'INVALID_PARAMETER')
    total = next
  }
  return total
}

export function assertInventoryMatchesBatches(db: any, materialId: string): InventorySnapshot {
  const inventory = currentInventory(db, materialId)
  const batchStock = batchTotal(db, materialId)
  if (Math.abs(inventory.stock - batchStock) > 1e-9) {
    throw new InventoryTransactionError('Inventory cache does not match batch facts')
  }
  return { before: inventory.stock, after: batchStock }
}

function currentInventory(db: any, materialId: string): { row: any | null; stock: number } {
  const row = db.prepare('SELECT * FROM inventory WHERE material_id = ?').get(materialId) as any
  if (!row) return { row: null, stock: 0 }
  return { row, stock: finite(row.stock, 'Inventory stock') }
}

function fallbackUnitCost(db: any, materialId: string): number {
  const average = db.prepare('SELECT AVG(inbound_price) AS value FROM batches WHERE material_id = ? AND inbound_price > 0')
    .get(materialId) as any
  const material = db.prepare('SELECT price FROM materials WHERE id = ?').get(materialId) as any
  const averagePrice = parseFiniteNumber(average?.value)
  const materialPrice = parseFiniteNumber(material?.price)
  return averagePrice !== null && averagePrice > 0
    ? averagePrice
    : materialPrice !== null && materialPrice > 0 ? materialPrice : 0
}

export function syncInventoryFromBatches(
  db: any,
  materialId: string,
  options: InventorySyncOptions = {},
): InventorySnapshot {
  const inventory = currentInventory(db, materialId)
  const after = batchTotal(db, materialId)

  if (inventory.row) {
    db.prepare(`
      UPDATE inventory
      SET stock = ?,
          location_id = COALESCE(?, location_id),
          last_inbound_id = COALESCE(?, last_inbound_id),
          last_inbound_date = CASE WHEN ? IS NULL THEN last_inbound_date ELSE date('now','localtime') END,
          last_outbound_id = COALESCE(?, last_outbound_id),
          last_outbound_date = CASE WHEN ? IS NULL THEN last_outbound_date ELSE date('now','localtime') END,
          update_time = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE material_id = ?
    `).run(
      after,
      options.locationId ?? null,
      options.lastInboundId ?? null,
      options.lastInboundId ?? null,
      options.lastOutboundId ?? null,
      options.lastOutboundId ?? null,
      materialId,
    )
  } else {
    db.prepare(`
      INSERT INTO inventory
        (id, material_id, stock, locked_stock, location_id, last_inbound_id, last_inbound_date, last_outbound_id, last_outbound_date, update_time)
      VALUES (?, ?, ?, 0, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE date('now','localtime') END,
              ?, CASE WHEN ? IS NULL THEN NULL ELSE date('now','localtime') END, CURRENT_TIMESTAMP)
    `).run(
      uuidv4(),
      materialId,
      after,
      options.locationId ?? null,
      options.lastInboundId ?? null,
      options.lastInboundId ?? null,
      options.lastOutboundId ?? null,
      options.lastOutboundId ?? null,
    )
  }

  return { before: inventory.stock, after }
}

function syntheticBatchNo(sourceType: AddBatchStockInput['sourceType'], sourceId: string): string {
  return `SYS-${sourceType.toUpperCase()}-${sourceId}`
}

export function addBatchStock(db: any, input: AddBatchStockInput): { batchId: string; batchNo: string; inventory: InventorySnapshot } {
  const quantity = positive(input.quantity, 'Quantity')
  if (!input.allowDriftReconciliation) assertInventoryMatchesBatches(db, input.materialId)
  let batch: any | null = null

  if (input.batchId) {
    batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(input.batchId) as any
    if (!batch || batch.material_id !== input.materialId) {
      throw new InventoryTransactionError('Specified batch does not belong to the material', 'INVALID_PARAMETER')
    }
  } else if (input.batchNo) {
    batch = db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ?')
      .get(input.materialId, input.batchNo) as any
  }

  const batchNo = batch?.batch_no || input.batchNo || syntheticBatchNo(input.sourceType, input.sourceId)
  if (!batch) {
    batch = db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ?')
      .get(input.materialId, batchNo) as any
  }

  let batchId: string
  if (batch) {
    const nextQuantity = checkedAdd(finite(batch.quantity, 'Batch quantity'), quantity)
    const nextRemaining = checkedAdd(finite(batch.remaining, 'Batch remaining'), quantity)
    if (nextQuantity === null || nextRemaining === null) {
      throw new InventoryTransactionError('Batch stock exceeds the supported numeric range', 'INVALID_PARAMETER')
    }
    batchId = batch.id
    db.prepare(`
      UPDATE batches
      SET quantity = ?, remaining = ?, status = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextQuantity, nextRemaining, batchId)
  } else {
    batchId = uuidv4()
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, production_date, expiry_date,
         inbound_id, inbound_price, supplier_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      batchId,
      input.materialId,
      batchNo,
      quantity,
      quantity,
      input.productionDate ?? null,
      input.expiryDate ?? null,
      input.sourceId,
      input.inboundPrice ?? fallbackUnitCost(db, input.materialId),
      input.supplierId ?? null,
    )
  }

  const inventory = syncInventoryFromBatches(db, input.materialId, input.inventory)
  return { batchId, batchNo, inventory }
}

function selectorBatchId(db: any, materialId: string, batchId?: string | null, batchNo?: string | null): string | undefined {
  if (batchId) return batchId
  if (!batchNo) return undefined
  const batch = db.prepare('SELECT id FROM batches WHERE material_id = ? AND batch_no = ?')
    .get(materialId, batchNo) as any
  if (!batch) throw new InventoryTransactionError('Specified batch is unavailable', 'STOCK_INSUFFICIENT')
  return batch.id
}

function planBatchAllocations(db: any, materialId: string, quantity: number, batchId?: string): BatchAllocation[] {
  if (batchId) {
    const batch = db.prepare(`
      SELECT b.* FROM batches b
      JOIN materials m ON b.material_id = m.id
      WHERE b.id = ? AND b.material_id = ? AND b.remaining > 0 AND b.status = 1 AND m.is_deleted = 0
    `).get(batchId, materialId) as any
    if (!batch) throw new InventoryTransactionError('Specified batch is unavailable', 'STOCK_INSUFFICIENT')
    const available = finite(batch.remaining, 'Batch remaining')
    if (available < quantity) throw new InventoryTransactionError('Insufficient specified batch stock', 'STOCK_INSUFFICIENT')
    return [{
      batchId: batch.id,
      batchNo: batch.batch_no,
      quantity,
      unitCost: finite(batch.inbound_price ?? 0, 'Batch unit cost'),
    }]
  }

  const batches = db.prepare(`
    SELECT b.* FROM batches b
    JOIN materials m ON b.material_id = m.id
    WHERE b.material_id = ? AND b.remaining > 0 AND b.status = 1 AND m.is_deleted = 0
    ORDER BY CASE WHEN b.expiry_date IS NULL OR TRIM(b.expiry_date) = '' THEN 1 ELSE 0 END,
             b.expiry_date ASC, b.created_at ASC, b.id ASC
  `).all(materialId) as any[]

  let totalAvailable = 0
  for (const batch of batches) {
    const next = checkedAdd(totalAvailable, finite(batch.remaining, 'Batch remaining'))
    if (next === null) throw new InventoryTransactionError('Batch total exceeds the supported numeric range', 'INVALID_PARAMETER')
    totalAvailable = next
  }
  if (totalAvailable < quantity) throw new InventoryTransactionError('Insufficient batch stock', 'STOCK_INSUFFICIENT')

  let needed = quantity
  const allocations: BatchAllocation[] = []
  for (const batch of batches) {
    if (needed <= 0) break
    const take = Math.min(finite(batch.remaining, 'Batch remaining'), needed)
    allocations.push({
      batchId: batch.id,
      batchNo: batch.batch_no,
      quantity: take,
      unitCost: finite(batch.inbound_price ?? 0, 'Batch unit cost'),
    })
    const nextNeeded = checkedSubtract(needed, take)
    if (nextNeeded === null) throw new InventoryTransactionError('Batch allocation exceeds the supported numeric range', 'INVALID_PARAMETER')
    needed = nextNeeded
  }
  if (needed > 0) throw new InventoryTransactionError('Insufficient batch stock', 'STOCK_INSUFFICIENT')
  return allocations
}

export function consumeBatchStock(
  db: any,
  materialId: string,
  quantityValue: number,
  selector: { batchId?: string | null; batchNo?: string | null } = {},
  inventoryOptions: InventorySyncOptions = {},
): { allocations: BatchStockAllocation[]; inventory: InventorySnapshot } {
  const quantity = positive(quantityValue, 'Quantity')
  const batchStockBefore = batchTotal(db, materialId)
  let planned: BatchAllocation[]
  planned = planBatchAllocations(db, materialId, quantity, selectorBatchId(db, materialId, selector.batchId, selector.batchNo))
  if (!inventoryOptions.allowDriftReconciliation) assertInventoryMatchesBatches(db, materialId)

  const allocations: BatchStockAllocation[] = []
  for (const allocation of planned) {
    const batch = db.prepare('SELECT remaining FROM batches WHERE id = ? AND material_id = ?')
      .get(allocation.batchId, materialId) as any
    if (!batch) throw new InventoryTransactionError('Allocated batch disappeared before mutation')
    const remainingBefore = finite(batch.remaining, 'Batch remaining')
    const remainingAfter = checkedSubtract(remainingBefore, allocation.quantity)
    if (remainingAfter === null) {
      throw new InventoryTransactionError('Batch subtraction exceeds the supported numeric range', 'INVALID_PARAMETER')
    }
    if (remainingAfter < 0) throw new InventoryTransactionError('Insufficient batch stock', 'STOCK_INSUFFICIENT')
    const changed = db.prepare(`
      UPDATE batches
      SET remaining = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND material_id = ? AND remaining = ?
    `).run(remainingAfter, remainingAfter === 0 ? 0 : 1, allocation.batchId, materialId, remainingBefore)
    if (Number(changed.changes) !== 1) throw new InventoryTransactionError('Batch changed during allocation')
    allocations.push({ ...allocation, remainingBefore, remainingAfter })
  }

  const inventory = syncInventoryFromBatches(db, materialId, inventoryOptions)
  return { allocations, inventory: { before: batchStockBefore, after: inventory.after } }
}

export function restoreBatchStock(
  db: any,
  materialId: string,
  allocations: Array<{ batchId: string; quantity: number }>,
  inventoryOptions: InventorySyncOptions = {},
): InventorySnapshot {
  assertInventoryMatchesBatches(db, materialId)
  for (const allocation of allocations) {
    const quantity = positive(allocation.quantity, 'Quantity')
    const batch = db.prepare('SELECT quantity, remaining FROM batches WHERE id = ? AND material_id = ?')
      .get(allocation.batchId, materialId) as any
    if (!batch) throw new InventoryTransactionError('Original batch is unavailable for reversal')
    const remainingAfter = checkedAdd(finite(batch.remaining, 'Batch remaining'), quantity)
    const batchQuantity = finite(batch.quantity, 'Batch quantity')
    if (remainingAfter === null) {
      throw new InventoryTransactionError('Batch reversal exceeds the supported numeric range', 'INVALID_PARAMETER')
    }
    if (remainingAfter > batchQuantity) throw new InventoryTransactionError('Batch reversal would exceed its received quantity')
    db.prepare('UPDATE batches SET remaining = ?, status = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(remainingAfter, allocation.batchId)
  }
  return syncInventoryFromBatches(db, materialId, inventoryOptions)
}

export interface SubtractBatchStockInput {
  materialId: string
  quantity: number
  batchId?: string | null
  batchNo?: string | null
  inventory?: InventorySyncOptions
  allowDriftReconciliation?: boolean
}

/**
 * 入库撤销语义：同时扣减指定批次的 quantity 与 remaining（区别于出库只动 remaining）。
 * quantity/remaining/status 在单条条件 UPDATE 内原子落库，杜绝瞬态矛盾事实；
 * 结果为负一律 LEDGER_DRIFT fail-closed，绝不静默写负库存。
 */
export function subtractBatchStock(db: any, input: SubtractBatchStockInput): { batchId: string; inventory: InventorySnapshot } {
  const quantity = positive(input.quantity, 'Quantity')
  if (!input.allowDriftReconciliation) assertInventoryMatchesBatches(db, input.materialId)

  let batch: any | null = null
  if (input.batchId) {
    batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(input.batchId) as any
    if (!batch || batch.material_id !== input.materialId) {
      throw new InventoryTransactionError('Specified batch does not belong to the material', 'INVALID_PARAMETER')
    }
  } else if (input.batchNo) {
    batch = db.prepare('SELECT * FROM batches WHERE material_id = ? AND batch_no = ?')
      .get(input.materialId, input.batchNo) as any
  }
  if (!batch) throw new InventoryTransactionError('Batch fact is unavailable for reversal')

  const quantityBefore = finite(batch.quantity, 'Batch quantity')
  const remainingBefore = finite(batch.remaining, 'Batch remaining')
  const quantityAfter = checkedSubtract(quantityBefore, quantity)
  const remainingAfter = checkedSubtract(remainingBefore, quantity)
  if (quantityAfter === null || remainingAfter === null) {
    throw new InventoryTransactionError('Batch reversal exceeds the supported numeric range', 'INVALID_PARAMETER')
  }
  if (quantityAfter < 0 || remainingAfter < 0) {
    throw new InventoryTransactionError('Batch reversal would exceed its recorded stock')
  }
  const statusAfter = remainingAfter === 0 ? 0 : 1
  const changed = db.prepare(`
    UPDATE batches
    SET quantity = ?, remaining = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND material_id = ? AND quantity = ? AND remaining = ?
  `).run(quantityAfter, remainingAfter, statusAfter, batch.id, input.materialId, quantityBefore, remainingBefore)
  if (Number(changed.changes) !== 1) throw new InventoryTransactionError('Batch changed during reversal')

  const inventory = syncInventoryFromBatches(db, input.materialId, input.inventory)
  return { batchId: batch.id, inventory }
}

export function setMaterialStock(
  db: any,
  materialId: string,
  targetValue: number,
  sourceId: string,
  inventoryOptions: InventorySyncOptions = {},
): InventorySnapshot {
  const target = finite(targetValue, 'Target stock')
  if (target < 0) throw new InventoryTransactionError('Target stock cannot be negative', 'INVALID_PARAMETER')
  const before = batchTotal(db, materialId)
  if (target < before) {
    const delta = checkedSubtract(before, target)
    if (delta === null) throw new InventoryTransactionError('Stock adjustment exceeds the supported numeric range', 'INVALID_PARAMETER')
    consumeBatchStock(db, materialId, delta, {}, { ...inventoryOptions, allowDriftReconciliation: true })
  } else if (target > before) {
    const delta = checkedSubtract(target, before)
    if (delta === null) throw new InventoryTransactionError('Stock adjustment exceeds the supported numeric range', 'INVALID_PARAMETER')
    addBatchStock(db, {
      materialId,
      quantity: delta,
      sourceType: 'stocktaking',
      sourceId,
      inventory: inventoryOptions,
      allowDriftReconciliation: true,
    })
  } else {
    syncInventoryFromBatches(db, materialId, inventoryOptions)
  }
  return { before, after: target }
}

export function inventoryTransactionError(value: unknown): InventoryTransactionError | null {
  return value instanceof InventoryTransactionError ? value : null
}
