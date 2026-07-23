import { v4 as uuidv4 } from 'uuid'

const QUANTITY_SCALE = 10_000
const MAX_QUANTITY_UNITS = Number.MAX_SAFE_INTEGER

export type InventoryOperationKind = 'inbound' | 'outbound' | 'return' | 'scrap' | 'supplier_return'
export type InventoryDirection = 'in' | 'out'

export class InventoryTransactionError extends Error {
  code: string
  status: number

  constructor(message: string, code = 'INVENTORY_LEDGER_CORRUPT', status = 409) {
    super(message)
    this.name = 'InventoryTransactionError'
    this.code = code
    this.status = status
  }
}

export type DeductionRequest = {
  materialId: string
  quantity: unknown
  pinnedBatchId?: string | null
  ownerLineId?: string | null
}

export type ExactAllocationInput = {
  materialId: string
  batchId: string
  quantity: unknown
  ownerLineId?: string | null
  sourceAllocationId?: string | null
}

export type PlannedAllocation = {
  materialId: string
  batchId: string
  batchNo: string
  quantity: number
  ownerLineId: string | null
  sourceAllocationId: string | null
  inventoryBefore: number
  inventoryAfter: number
}

type BatchState = {
  id: string
  materialId: string
  batchNo: string
  quantityUnits: number
  remainingUnits: number
  status: number
  expiryDate: string | null
  createdAt: string
  isNew?: boolean
  create?: NewBatchInput
}

type MaterialState = {
  materialId: string
  inventoryExists: boolean
  inventoryUnits: number
  batches: BatchState[]
}

export type InventoryPlan = {
  materials: MaterialState[]
  allocations: PlannedAllocation[]
}

export type AllocationFactWrite = {
  operationKind: InventoryOperationKind
  ownerId: string
  direction: InventoryDirection
  allocations: Array<PlannedAllocation | ExactAllocationInput>
}

export type NewBatchInput = {
  id: string
  materialId: string
  batchNo: string
  quantity: unknown
  remaining: unknown
  productionDate?: string | null
  expiryDate?: string | null
  inboundId: string
  inboundPrice?: unknown
  supplierId?: string | null
}

export type BatchDeltaInput = {
  materialId: string
  batchId: string
  quantityDelta: unknown
  remainingDelta: unknown
  ownerLineId?: string | null
  sourceAllocationId?: string | null
  create?: NewBatchInput
}

function corrupt(message: string): never {
  throw new InventoryTransactionError(message)
}

function toUnits(value: unknown, label: string, options: { positive?: boolean; allowNegative?: boolean } = {}): number {
  if (typeof value !== 'number' && typeof value !== 'string') corrupt(`${label} is not numeric`)
  if (typeof value === 'string' && value.trim() === '') corrupt(`${label} is empty`)
  const parsed = Number(typeof value === 'string' ? value.trim() : value)
  if (!Number.isFinite(parsed)) corrupt(`${label} is not finite`)
  if (!options.allowNegative && parsed < 0) corrupt(`${label} is negative`)
  if (options.positive && parsed <= 0) corrupt(`${label} must be positive`)
  const scaled = parsed * QUANTITY_SCALE
  const rounded = Math.round(scaled)
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) >= 0.000001 || Math.abs(rounded) > MAX_QUANTITY_UNITS) {
    corrupt(`${label} exceeds the supported four-decimal safe range`)
  }
  return rounded
}

function fromUnits(value: number): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_QUANTITY_UNITS) {
    corrupt('inventory arithmetic exceeds the supported range')
  }
  return value / QUANTITY_SCALE
}

function checkedUnits(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_QUANTITY_UNITS) {
    corrupt('inventory arithmetic exceeds the supported range')
  }
  return result
}

export function parseInventoryQuantity(value: unknown, options: { positive?: boolean; allowNegative?: boolean } = {}): number {
  return fromUnits(toUnits(value, 'inventory quantity', options))
}

export function assertSourceAllocationCapacity(sourceQuantity: unknown, returnedQuantity: unknown, requestedQuantity: unknown): void {
  const sourceUnits = toUnits(sourceQuantity, 'source allocation quantity', { positive: true })
  const returnedUnits = toUnits(returnedQuantity, 'returned allocation quantity')
  const requestedUnits = toUnits(requestedQuantity, 'return quantity', { positive: true })
  if (returnedUnits > sourceUnits || checkedUnits(returnedUnits, requestedUnits) > sourceUnits) {
    throw new InventoryTransactionError('Return exceeds the unreturned source allocation', 'RETURN_SOURCE_EXHAUSTED', 422)
  }
}

export function getSourceAllocationRemaining(sourceQuantity: unknown, returnedQuantity: unknown): number {
  const sourceUnits = toUnits(sourceQuantity, 'source allocation quantity', { positive: true })
  const returnedUnits = toUnits(returnedQuantity, 'returned allocation quantity')
  if (returnedUnits > sourceUnits) corrupt('returned allocation exceeds its source')
  return fromUnits(sourceUnits - returnedUnits)
}

export function inventoryQuantityDelta(left: unknown, right: unknown): number {
  return fromUnits(checkedUnits(
    toUnits(left, 'inventory quantity', { allowNegative: true }),
    -toUnits(right, 'inventory quantity', { allowNegative: true }),
  ))
}

function assertBatchState(batch: BatchState): void {
  if (!batch.id || !batch.materialId || !batch.batchNo) corrupt('batch identity is missing')
  if (batch.quantityUnits < 0 || batch.remainingUnits < 0 || batch.remainingUnits > batch.quantityUnits) {
    corrupt(`batch ${batch.id} violates quantity conservation`)
  }
  if ((batch.remainingUnits === 0 && batch.status !== 0) || (batch.remainingUnits > 0 && batch.status !== 1)) {
    corrupt(`batch ${batch.id} has an illegal status/remaining combination`)
  }
}

function loadMaterialState(db: any, materialId: string): MaterialState {
  if (typeof materialId !== 'string' || !materialId.trim()) corrupt('material identity is missing')
  const inventory = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
  const rows = db.prepare(`
    SELECT id, material_id, batch_no, quantity, remaining, status, expiry_date, created_at
    FROM batches
    WHERE material_id = ?
  `).all(materialId) as any[]

  const batches = rows.map((row) => {
    const batch: BatchState = {
      id: row.id,
      materialId: row.material_id,
      batchNo: row.batch_no,
      quantityUnits: toUnits(row.quantity, `batch ${row.id} quantity`),
      remainingUnits: toUnits(row.remaining, `batch ${row.id} remaining`),
      status: row.status,
      expiryDate: row.expiry_date ?? null,
      createdAt: row.created_at,
    }
    assertBatchState(batch)
    return batch
  })
  const batchUnits = batches.reduce((sum, batch) => checkedUnits(sum, batch.remainingUnits), 0)
  const inventoryUnits = inventory ? toUnits(inventory.stock, `inventory ${materialId} stock`) : 0
  if (!inventory && batchUnits !== 0) corrupt(`inventory ${materialId} is missing`)
  if (inventoryUnits !== batchUnits) {
    corrupt(`inventory ${materialId} does not equal eligible batch remaining`)
  }
  return {
    materialId,
    inventoryExists: Boolean(inventory),
    inventoryUnits,
    batches,
  }
}

function getState(states: Map<string, MaterialState>, db: any, materialId: string): MaterialState {
  const existing = states.get(materialId)
  if (existing) return existing
  const state = loadMaterialState(db, materialId)
  states.set(materialId, state)
  return state
}

function fefoCompare(left: BatchState, right: BatchState): number {
  if (left.expiryDate === null && right.expiryDate !== null) return 1
  if (left.expiryDate !== null && right.expiryDate === null) return -1
  if (left.expiryDate !== right.expiryDate) return String(left.expiryDate).localeCompare(String(right.expiryDate))
  if (left.createdAt !== right.createdAt) return String(left.createdAt).localeCompare(String(right.createdAt))
  return left.id.localeCompare(right.id)
}

function planAllocation(
  state: MaterialState,
  batch: BatchState,
  quantityUnits: number,
  direction: InventoryDirection,
  request: Pick<ExactAllocationInput, 'ownerLineId' | 'sourceAllocationId'>,
): PlannedAllocation {
  const inventoryBeforeUnits = state.batches.reduce((sum, row) => checkedUnits(sum, row.remainingUnits), 0)
  const delta = direction === 'out' ? -quantityUnits : quantityUnits
  const remainingAfter = checkedUnits(batch.remainingUnits, delta)
  if (remainingAfter < 0) {
    throw new InventoryTransactionError('Insufficient batch stock', 'BATCH_STOCK_INSUFFICIENT', 422)
  }
  if (remainingAfter > batch.quantityUnits) {
    throw new InventoryTransactionError('Return exceeds the source batch capacity', 'BATCH_CAPACITY_EXCEEDED', 422)
  }
  batch.remainingUnits = remainingAfter
  batch.status = remainingAfter === 0 ? 0 : 1
  const inventoryAfterUnits = state.batches.reduce((sum, row) => checkedUnits(sum, row.remainingUnits), 0)
  state.inventoryUnits = inventoryAfterUnits
  return {
    materialId: state.materialId,
    batchId: batch.id,
    batchNo: batch.batchNo,
    quantity: fromUnits(quantityUnits),
    ownerLineId: request.ownerLineId ?? null,
    sourceAllocationId: request.sourceAllocationId ?? null,
    inventoryBefore: fromUnits(inventoryBeforeUnits),
    inventoryAfter: fromUnits(inventoryAfterUnits),
  }
}

export function assertInventoryConserved(db: any, materialId: string): number {
  return fromUnits(loadMaterialState(db, materialId).inventoryUnits)
}

export function planInventoryDeductions(db: any, requests: DeductionRequest[]): InventoryPlan {
  if (!Array.isArray(requests) || requests.length === 0) corrupt('deduction plan is empty')
  const states = new Map<string, MaterialState>()
  const allocations: PlannedAllocation[] = []

  for (const request of requests) {
    const quantityUnits = toUnits(request.quantity, 'deduction quantity', { positive: true })
    const state = getState(states, db, request.materialId)
    let outstanding = quantityUnits
    const candidates = request.pinnedBatchId
      ? state.batches.filter((batch) => batch.id === request.pinnedBatchId)
      : state.batches.filter((batch) => batch.status === 1 && batch.remainingUnits > 0).sort(fefoCompare)

    if (request.pinnedBatchId && candidates.length !== 1) {
      throw new InventoryTransactionError('Pinned batch is unavailable', 'BATCH_NOT_ELIGIBLE', 422)
    }
    for (const batch of candidates) {
      if (outstanding === 0) break
      if (batch.status !== 1 || batch.remainingUnits <= 0) {
        if (request.pinnedBatchId) {
          throw new InventoryTransactionError('Pinned batch is unavailable', 'BATCH_NOT_ELIGIBLE', 422)
        }
        continue
      }
      const allocated = Math.min(outstanding, batch.remainingUnits)
      allocations.push(planAllocation(state, batch, allocated, 'out', request))
      outstanding -= allocated
    }
    if (outstanding !== 0) {
      throw new InventoryTransactionError(
        request.pinnedBatchId ? 'Insufficient pinned batch stock' : 'Insufficient eligible batch stock',
        request.pinnedBatchId ? 'BATCH_STOCK_INSUFFICIENT' : 'STOCK_INSUFFICIENT',
        422,
      )
    }
  }

  return { materials: [...states.values()], allocations }
}

export function planExactInventoryAdditions(db: any, inputs: ExactAllocationInput[]): InventoryPlan {
  if (!Array.isArray(inputs) || inputs.length === 0) corrupt('addition plan is empty')
  const states = new Map<string, MaterialState>()
  const allocations: PlannedAllocation[] = []
  for (const input of inputs) {
    const state = getState(states, db, input.materialId)
    const batch = state.batches.find((row) => row.id === input.batchId)
    if (!batch) throw new InventoryTransactionError('Source batch is unavailable', 'BATCH_NOT_FOUND', 422)
    allocations.push(planAllocation(
      state,
      batch,
      toUnits(input.quantity, 'addition quantity', { positive: true }),
      'in',
      input,
    ))
  }
  return { materials: [...states.values()], allocations }
}

export function planBatchDeltas(db: any, inputs: BatchDeltaInput[]): InventoryPlan {
  if (!Array.isArray(inputs) || inputs.length === 0) corrupt('batch delta plan is empty')
  const states = new Map<string, MaterialState>()
  const allocations: PlannedAllocation[] = []
  for (const input of inputs) {
    const state = getState(states, db, input.materialId)
    let batch = state.batches.find((row) => row.id === input.batchId)
    if (!batch) {
      if (!input.create) throw new InventoryTransactionError('Batch is unavailable', 'BATCH_NOT_FOUND', 422)
      const create = input.create
      if (create.id !== input.batchId || create.materialId !== input.materialId) corrupt('new batch identity mismatch')
      batch = {
        id: create.id,
        materialId: create.materialId,
        batchNo: create.batchNo,
        quantityUnits: 0,
        remainingUnits: 0,
        status: 0,
        expiryDate: create.expiryDate ?? null,
        createdAt: new Date().toISOString(),
        isNew: true,
        create,
      }
      state.batches.push(batch)
    }
    const quantityDelta = toUnits(input.quantityDelta, 'batch quantity delta', { allowNegative: true })
    const remainingDelta = toUnits(input.remainingDelta, 'batch remaining delta', { allowNegative: true })
    const beforeUnits = state.batches.reduce((sum, row) => checkedUnits(sum, row.remainingUnits), 0)
    batch.quantityUnits = checkedUnits(batch.quantityUnits, quantityDelta)
    batch.remainingUnits = checkedUnits(batch.remainingUnits, remainingDelta)
    batch.status = batch.remainingUnits === 0 ? 0 : 1
    assertBatchState(batch)
    const afterUnits = state.batches.reduce((sum, row) => checkedUnits(sum, row.remainingUnits), 0)
    state.inventoryUnits = afterUnits
    if (remainingDelta !== 0) {
      allocations.push({
        materialId: state.materialId,
        batchId: batch.id,
        batchNo: batch.batchNo,
        quantity: fromUnits(Math.abs(remainingDelta)),
        ownerLineId: input.ownerLineId ?? null,
        sourceAllocationId: input.sourceAllocationId ?? null,
        inventoryBefore: fromUnits(beforeUnits),
        inventoryAfter: fromUnits(afterUnits),
      })
    }
  }
  return { materials: [...states.values()], allocations }
}

export function applyInventoryPlan(db: any, plan: InventoryPlan): void {
  for (const material of plan.materials) {
    for (const batch of material.batches) {
      assertBatchState(batch)
      if (batch.isNew) {
        const create = batch.create!
        const inboundPrice = create.inboundPrice === undefined ? 0 : fromUnits(toUnits(create.inboundPrice, 'inbound price'))
        db.prepare(`
          INSERT INTO batches
            (id, material_id, batch_no, quantity, remaining, production_date, expiry_date, inbound_id, inbound_price, supplier_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batch.id,
          batch.materialId,
          batch.batchNo,
          fromUnits(batch.quantityUnits),
          fromUnits(batch.remainingUnits),
          create.productionDate ?? null,
          create.expiryDate ?? null,
          create.inboundId,
          inboundPrice,
          create.supplierId ?? null,
          batch.status,
        )
      } else {
        db.prepare(`
          UPDATE batches
          SET quantity = ?, remaining = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND material_id = ?
        `).run(
          fromUnits(batch.quantityUnits),
          fromUnits(batch.remainingUnits),
          batch.status,
          batch.id,
          batch.materialId,
        )
      }
    }
    const stock = fromUnits(material.batches.reduce((sum, row) => checkedUnits(sum, row.remainingUnits), 0))
    const result = db.prepare(`
      UPDATE inventory
      SET stock = ?, update_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE material_id = ?
    `).run(stock, material.materialId)
    if (Number(result.changes) !== 1) {
      if (material.inventoryExists) corrupt(`inventory ${material.materialId} disappeared during apply`)
      db.prepare(`
        INSERT INTO inventory (id, material_id, stock, locked_stock, update_time)
        VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
      `).run(uuidv4(), material.materialId, stock)
    }
  }
}

export function replaceAllocationFacts(db: any, input: AllocationFactWrite): void {
  if (!input.ownerId) corrupt('allocation owner is missing')
  db.prepare(`
    DELETE FROM inventory_transaction_allocations
    WHERE operation_kind = ? AND owner_id = ?
  `).run(input.operationKind, input.ownerId)

  const insert = db.prepare(`
    INSERT INTO inventory_transaction_allocations
      (id, operation_kind, owner_id, owner_line_id, material_id, batch_id, direction, quantity, source_allocation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const allocation of input.allocations) {
    const quantity = fromUnits(toUnits(allocation.quantity, 'allocation quantity', { positive: true }))
    insert.run(
      uuidv4(),
      input.operationKind,
      input.ownerId,
      allocation.ownerLineId ?? null,
      allocation.materialId,
      allocation.batchId,
      input.direction,
      quantity,
      allocation.sourceAllocationId ?? null,
    )
  }
}

export function listActiveAllocationFacts(db: any, operationKind: InventoryOperationKind, ownerId: string): any[] {
  return db.prepare(`
    SELECT *
    FROM inventory_transaction_allocations
    WHERE operation_kind = ? AND owner_id = ? AND is_reversed = 0
    ORDER BY created_at, id
  `).all(operationKind, ownerId) as any[]
}

export function markAllocationFactsReversed(db: any, operationKind: InventoryOperationKind, ownerId: string): void {
  const result = db.prepare(`
    UPDATE inventory_transaction_allocations
    SET is_reversed = 1, reversed_at = CURRENT_TIMESTAMP
    WHERE operation_kind = ? AND owner_id = ? AND is_reversed = 0
  `).run(operationKind, ownerId)
  if (Number(result.changes) === 0) {
    throw new InventoryTransactionError('Active allocation fact is unavailable', 'ALLOCATION_NOT_FOUND', 409)
  }
}

export function inventoryErrorResponse(error: unknown): { message: string; code: string; status: number } | null {
  return error instanceof InventoryTransactionError
    ? { message: error.message, code: error.code, status: error.status }
    : null
}
