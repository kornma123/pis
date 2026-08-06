import { v4 as uuidv4 } from 'uuid'

const QUANTITY_SCALE = 10_000
const MAX_QUANTITY_UNITS = Number.MAX_SAFE_INTEGER

export type InventoryOperationKind =
  | 'inbound'
  | 'outbound'
  | 'return'
  | 'scrap'
  | 'supplier_return'
  | 'transfer'
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
  /** Kept only so old clients receive a stable rejection instead of silently overriding FEFO. */
  pinnedBatchId?: string | null
  ownerLineId?: string | null
}

export type ExactAllocationInput = {
  materialId: string
  batchId: string | null
  locationId?: string | null
  quantity: unknown
  ownerLineId?: string | null
  sourceAllocationId?: string | null
}

export type PositionAdditionInput = ExactAllocationInput

export type TransferInput = {
  materialId: string
  quantity: unknown
  fromLocationId: string
  toLocationId: string
  ownerLineId?: string | null
}

export type PlannedAllocation = {
  materialId: string
  batchId: string | null
  batchNo: string | null
  locationId: string
  quantity: number
  direction?: InventoryDirection
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

type PositionState = {
  id: string
  materialId: string
  batchId: string | null
  locationId: string
  quantityUnits: number
  existed: boolean
}

type MaterialState = {
  materialId: string
  inventoryExists: boolean
  inventoryUnits: number
  batchManaged: boolean
  unitsPerPackage: number | null
  slotsPerPackage: number | null
  batches: BatchState[]
  positions: PositionState[]
}

type CapacityWarning = {
  operationKind: InventoryOperationKind
  ownerId: string
  materialId: string
  locationId: string
  missingMaterials: string[]
}

export type InventoryPlan = {
  materials: MaterialState[]
  allocations: PlannedAllocation[]
  capacityWarnings?: CapacityWarning[]
  affectedLocations?: string[]
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
  locationId?: string | null
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

function stateTotal(state: MaterialState): number {
  return state.positions.reduce((sum, position) => checkedUnits(sum, position.quantityUnits), 0)
}

function batchTotal(state: MaterialState, batchId: string): number {
  return state.positions
    .filter(position => position.batchId === batchId)
    .reduce((sum, position) => checkedUnits(sum, position.quantityUnits), 0)
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

function assertLocationAvailable(db: any, locationId: string): void {
  if (typeof locationId !== 'string' || !locationId.trim()) {
    throw new InventoryTransactionError('Target location is required', 'LOCATION_REQUIRED', 400)
  }
  const location = db.prepare(`
    SELECT id FROM locations WHERE id = ? AND status = 1 AND is_deleted = 0
  `).get(locationId)
  if (!location) throw new InventoryTransactionError('Location is unavailable', 'LOCATION_NOT_FOUND', 422)
}

function loadMaterialState(db: any, materialId: string): MaterialState {
  if (typeof materialId !== 'string' || !materialId.trim()) corrupt('material identity is missing')
  const material = db.prepare(`
    SELECT id, batch_managed, units_per_package, slots_per_package
    FROM materials WHERE id = ? AND is_deleted = 0
  `).get(materialId) as any
  if (!material) throw new InventoryTransactionError('Material is unavailable', 'MATERIAL_NOT_FOUND', 422)
  if (material.batch_managed !== 0 && material.batch_managed !== 1) corrupt(`material ${materialId} has an invalid batch policy`)
  const inventory = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
  const batchRows = db.prepare(`
    SELECT id, material_id, batch_no, quantity, remaining, status, expiry_date, created_at
    FROM batches WHERE material_id = ? ORDER BY id
  `).all(materialId) as any[]
  const positionRows = db.prepare(`
    SELECT id, material_id, batch_id, location_id, quantity
    FROM inventory_positions WHERE material_id = ? ORDER BY id
  `).all(materialId) as any[]

  const batches: BatchState[] = batchRows.map(row => {
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
  const batchById = new Map(batches.map(batch => [batch.id, batch]))
  const positions: PositionState[] = positionRows.map(row => {
    const units = toUnits(row.quantity, `position ${row.id} quantity`, { positive: true })
    if (!row.location_id) corrupt(`position ${row.id} has no location`)
    if (material.batch_managed === 1) {
      const batch = batchById.get(row.batch_id)
      if (!batch || batch.materialId !== materialId) corrupt(`position ${row.id} has an invalid batch`)
    } else if (row.batch_id !== null) {
      corrupt(`non-batch position ${row.id} has a batch`)
    }
    return {
      id: row.id,
      materialId,
      batchId: row.batch_id ?? null,
      locationId: row.location_id,
      quantityUnits: units,
      existed: true,
    }
  })

  if (material.batch_managed === 0 && batches.length !== 0) {
    corrupt(`non-batch material ${materialId} has batch rows`)
  }
  if (material.batch_managed === 1) {
    for (const batch of batches) {
      if (batchTotal({ positions } as MaterialState, batch.id) !== batch.remainingUnits) {
        corrupt(`batch ${batch.id} does not equal its position total`)
      }
    }
  }
  const positionUnits = positions.reduce((sum, position) => checkedUnits(sum, position.quantityUnits), 0)
  const inventoryUnits = inventory ? toUnits(inventory.stock, `inventory ${materialId} stock`) : 0
  if (!inventory && positionUnits !== 0) corrupt(`inventory ${materialId} is missing`)
  if (inventoryUnits !== positionUnits) corrupt(`inventory ${materialId} does not equal its position total`)

  const optionalPositive = (value: unknown, label: string): number | null => {
    if (value === null || value === undefined) return null
    return toUnits(value, label, { positive: true })
  }
  return {
    materialId,
    inventoryExists: Boolean(inventory),
    inventoryUnits,
    batchManaged: material.batch_managed === 1,
    unitsPerPackage: optionalPositive(material.units_per_package, `material ${materialId} units per package`),
    slotsPerPackage: optionalPositive(material.slots_per_package, `material ${materialId} slots per package`),
    batches,
    positions,
  }
}

function getState(states: Map<string, MaterialState>, db: any, materialId: string): MaterialState {
  const existing = states.get(materialId)
  if (existing) return existing
  const state = loadMaterialState(db, materialId)
  states.set(materialId, state)
  return state
}

function positionFor(
  state: MaterialState,
  batchId: string | null,
  locationId: string,
  create: boolean,
): PositionState | undefined {
  const found = state.positions.find(position =>
    position.batchId === batchId && position.locationId === locationId,
  )
  if (found || !create) return found
  const position: PositionState = {
    id: uuidv4(),
    materialId: state.materialId,
    batchId,
    locationId,
    quantityUnits: 0,
    existed: false,
  }
  state.positions.push(position)
  return position
}

function batchCompare(left: BatchState, right: BatchState): number {
  if (left.expiryDate === null && right.expiryDate !== null) return 1
  if (left.expiryDate !== null && right.expiryDate === null) return -1
  if (left.expiryDate !== right.expiryDate) return String(left.expiryDate).localeCompare(String(right.expiryDate))
  if (left.createdAt !== right.createdAt) return String(left.createdAt).localeCompare(String(right.createdAt))
  if (left.batchNo !== right.batchNo) return left.batchNo.localeCompare(right.batchNo)
  return left.id.localeCompare(right.id)
}

function deductionCandidates(state: MaterialState, fromLocationId?: string): Array<{
  position: PositionState
  batch: BatchState | null
}> {
  const batchById = new Map(state.batches.map(batch => [batch.id, batch]))
  return state.positions
    .filter(position => position.quantityUnits > 0 && (!fromLocationId || position.locationId === fromLocationId))
    .map(position => ({ position, batch: position.batchId ? batchById.get(position.batchId) ?? null : null }))
    .sort((left, right) => {
      if (left.batch && right.batch) {
        const compared = batchCompare(left.batch, right.batch)
        if (compared !== 0) return compared
      } else if (left.batch && !right.batch) return -1
      else if (!left.batch && right.batch) return 1
      return left.position.locationId.localeCompare(right.position.locationId)
    })
}

function makeAllocation(
  state: MaterialState,
  position: PositionState,
  batch: BatchState | null,
  quantityUnits: number,
  direction: InventoryDirection,
  request: Pick<ExactAllocationInput, 'ownerLineId' | 'sourceAllocationId'>,
  beforeUnits: number,
): PlannedAllocation {
  return {
    materialId: state.materialId,
    batchId: batch?.id ?? null,
    batchNo: batch?.batchNo ?? null,
    locationId: position.locationId,
    quantity: fromUnits(quantityUnits),
    direction,
    ownerLineId: request.ownerLineId ?? null,
    sourceAllocationId: request.sourceAllocationId ?? null,
    inventoryBefore: fromUnits(beforeUnits),
    inventoryAfter: fromUnits(stateTotal(state)),
  }
}

function deductFromPosition(
  state: MaterialState,
  position: PositionState,
  batch: BatchState | null,
  quantityUnits: number,
  request: Pick<ExactAllocationInput, 'ownerLineId' | 'sourceAllocationId'>,
): PlannedAllocation {
  const beforeUnits = stateTotal(state)
  if (position.quantityUnits < quantityUnits) corrupt('position deduction exceeds its balance')
  position.quantityUnits -= quantityUnits
  if (batch) {
    batch.remainingUnits -= quantityUnits
    batch.status = batch.remainingUnits === 0 ? 0 : 1
    assertBatchState(batch)
  }
  state.inventoryUnits = stateTotal(state)
  return makeAllocation(state, position, batch, quantityUnits, 'out', request, beforeUnits)
}

function addToPosition(
  state: MaterialState,
  position: PositionState,
  batch: BatchState | null,
  quantityUnits: number,
  request: Pick<ExactAllocationInput, 'ownerLineId' | 'sourceAllocationId'>,
  adjustBatch: boolean,
): PlannedAllocation {
  const beforeUnits = stateTotal(state)
  position.quantityUnits = checkedUnits(position.quantityUnits, quantityUnits)
  if (batch && adjustBatch) {
    batch.remainingUnits = checkedUnits(batch.remainingUnits, quantityUnits)
    if (batch.remainingUnits > batch.quantityUnits) {
      throw new InventoryTransactionError('Return exceeds the source batch capacity', 'BATCH_CAPACITY_EXCEEDED', 422)
    }
    batch.status = 1
    assertBatchState(batch)
  }
  state.inventoryUnits = stateTotal(state)
  return makeAllocation(state, position, batch, quantityUnits, 'in', request, beforeUnits)
}

function currentLocationStates(db: any, states: Map<string, MaterialState>, locationId: string): MaterialState[] {
  const materialIds = new Set<string>(
    (db.prepare('SELECT DISTINCT material_id FROM inventory_positions WHERE location_id = ?').all(locationId) as any[])
      .map(row => row.material_id),
  )
  for (const state of states.values()) {
    if (state.positions.some(position => position.locationId === locationId)) materialIds.add(state.materialId)
  }
  return [...materialIds].map(materialId => states.get(materialId) ?? loadMaterialState(db, materialId))
}

function evaluateCapacity(
  db: any,
  states: Map<string, MaterialState>,
  targets: Array<{ materialId: string; locationId: string }>,
  context: { operationKind: InventoryOperationKind; ownerId: string },
): CapacityWarning[] {
  const warnings: CapacityWarning[] = []
  const uniqueTargets = new Map(targets.map(target => [`${target.materialId}|${target.locationId}`, target]))
  for (const target of uniqueTargets.values()) {
    assertLocationAvailable(db, target.locationId)
    const location = db.prepare('SELECT capacity FROM locations WHERE id = ?').get(target.locationId) as any
    const locationStates = currentLocationStates(db, states, target.locationId)
    const missing = new Set<string>()
    let usedSlots = 0
    for (const state of locationStates) {
      const relevant = state.positions.filter(position =>
        position.locationId === target.locationId && position.quantityUnits > 0,
      )
      if (relevant.length === 0) continue
      if (state.unitsPerPackage === null || state.slotsPerPackage === null) {
        missing.add(state.materialId)
        continue
      }
      for (const position of relevant) {
        usedSlots += Math.ceil(position.quantityUnits / state.unitsPerPackage)
          * (state.slotsPerPackage / QUANTITY_SCALE)
      }
    }
    if (missing.size > 0) {
      warnings.push({
        operationKind: context.operationKind,
        ownerId: context.ownerId,
        materialId: target.materialId,
        locationId: target.locationId,
        missingMaterials: [...missing].sort(),
      })
    } else if (!Number.isFinite(Number(location.capacity)) || usedSlots > Number(location.capacity)) {
      throw new InventoryTransactionError('Target location capacity is exceeded', 'LOCATION_CAPACITY_EXCEEDED', 422)
    }
  }
  return warnings
}

function finalizePlan(
  db: any,
  states: Map<string, MaterialState>,
  allocations: PlannedAllocation[],
  additionTargets: Array<{ materialId: string; locationId: string }>,
  context?: { operationKind: InventoryOperationKind; ownerId: string },
): InventoryPlan {
  const capacityWarnings = context
    ? evaluateCapacity(db, states, additionTargets, context)
    : []
  return {
    materials: [...states.values()],
    allocations,
    capacityWarnings,
    affectedLocations: [...new Set(
      [...states.values()].flatMap(state => state.positions.map(position => position.locationId)),
    )],
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
    if (request.pinnedBatchId !== undefined && request.pinnedBatchId !== null) {
      throw new InventoryTransactionError(
        'Operator batch selection cannot override automatic FEFO',
        'FEFO_OVERRIDE_FORBIDDEN',
        400,
      )
    }
    const state = getState(states, db, request.materialId)
    let outstanding = toUnits(request.quantity, 'deduction quantity', { positive: true })
    for (const candidate of deductionCandidates(state)) {
      if (outstanding === 0) break
      const allocated = Math.min(outstanding, candidate.position.quantityUnits)
      allocations.push(deductFromPosition(state, candidate.position, candidate.batch, allocated, request))
      outstanding -= allocated
    }
    if (outstanding !== 0) {
      throw new InventoryTransactionError('Insufficient eligible position stock', 'STOCK_INSUFFICIENT', 422)
    }
  }
  return finalizePlan(db, states, allocations, [])
}

export function planPositionAdditions(
  db: any,
  inputs: PositionAdditionInput[],
  context: { operationKind: InventoryOperationKind; ownerId: string },
): InventoryPlan {
  if (!Array.isArray(inputs) || inputs.length === 0) corrupt('addition plan is empty')
  if (!context.ownerId) corrupt('capacity audit owner is missing')
  const states = new Map<string, MaterialState>()
  const allocations: PlannedAllocation[] = []
  const targets: Array<{ materialId: string; locationId: string }> = []
  for (const input of inputs) {
    const state = getState(states, db, input.materialId)
    const locationId = input.locationId
    if (!locationId) throw new InventoryTransactionError('Target location is required', 'RETURN_LOCATION_REQUIRED', 400)
    assertLocationAvailable(db, locationId)
    const quantityUnits = toUnits(input.quantity, 'addition quantity', { positive: true })
    let batch: BatchState | null = null
    if (state.batchManaged) {
      if (!input.batchId) throw new InventoryTransactionError('Batch is required for this material', 'BATCH_REQUIRED', 400)
      batch = state.batches.find(row => row.id === input.batchId) ?? null
      if (!batch) throw new InventoryTransactionError('Source batch is unavailable', 'BATCH_NOT_FOUND', 422)
    } else if (input.batchId !== null) {
      throw new InventoryTransactionError('Non-batch material cannot use a batch', 'BATCH_FORBIDDEN', 400)
    }
    const position = positionFor(state, batch?.id ?? null, locationId, true)!
    allocations.push(addToPosition(state, position, batch, quantityUnits, input, true))
    targets.push({ materialId: input.materialId, locationId })
  }
  return finalizePlan(db, states, allocations, targets, context)
}

export function planExactInventoryAdditions(db: any, inputs: ExactAllocationInput[]): InventoryPlan {
  return planPositionAdditions(db, inputs, { operationKind: 'return', ownerId: 'legacy-exact-addition' })
}

export function planInventoryTransfers(db: any, inputs: TransferInput[]): InventoryPlan {
  if (!Array.isArray(inputs) || inputs.length === 0) corrupt('transfer plan is empty')
  const states = new Map<string, MaterialState>()
  const allocations: PlannedAllocation[] = []
  const targets: Array<{ materialId: string; locationId: string }> = []
  for (const input of inputs) {
    if (!input.fromLocationId || !input.toLocationId || input.fromLocationId === input.toLocationId) {
      throw new InventoryTransactionError('Transfer locations are invalid', 'TRANSFER_LOCATION_INVALID', 400)
    }
    assertLocationAvailable(db, input.fromLocationId)
    assertLocationAvailable(db, input.toLocationId)
    const state = getState(states, db, input.materialId)
    let outstanding = toUnits(input.quantity, 'transfer quantity', { positive: true })
    for (const candidate of deductionCandidates(state, input.fromLocationId)) {
      if (outstanding === 0) break
      const moved = Math.min(outstanding, candidate.position.quantityUnits)
      const beforeUnits = stateTotal(state)
      candidate.position.quantityUnits -= moved
      const target = positionFor(state, candidate.position.batchId, input.toLocationId, true)!
      target.quantityUnits = checkedUnits(target.quantityUnits, moved)
      state.inventoryUnits = stateTotal(state)
      allocations.push(makeAllocation(state, candidate.position, candidate.batch, moved, 'out', input, beforeUnits))
      allocations.push(makeAllocation(state, target, candidate.batch, moved, 'in', input, beforeUnits))
      outstanding -= moved
    }
    if (outstanding !== 0) {
      throw new InventoryTransactionError('Insufficient source-location stock', 'STOCK_INSUFFICIENT', 422)
    }
    targets.push({ materialId: input.materialId, locationId: input.toLocationId })
  }
  const ownerId = inputs[0].ownerLineId ?? 'transfer-plan'
  return finalizePlan(db, states, allocations, targets, { operationKind: 'transfer', ownerId })
}

export function planBatchDeltas(db: any, inputs: BatchDeltaInput[]): InventoryPlan {
  if (!Array.isArray(inputs) || inputs.length === 0) corrupt('batch delta plan is empty')
  const states = new Map<string, MaterialState>()
  const allocations: PlannedAllocation[] = []
  const targets: Array<{ materialId: string; locationId: string }> = []
  for (const input of inputs) {
    const state = getState(states, db, input.materialId)
    if (!state.batchManaged) {
      throw new InventoryTransactionError('Non-batch inbound must use position additions', 'BATCH_FORBIDDEN', 400)
    }
    const inferredInbound = input.create?.inboundId
      ? db.prepare(`
        SELECT location_id FROM inbound_records
        WHERE id = ? AND material_id = ? AND is_deleted = 0 AND status = 'completed'
      `).get(input.create.inboundId, input.materialId) as any
      : null
    const locationId = input.locationId ?? inferredInbound?.location_id
    if (!locationId) throw new InventoryTransactionError('Inbound location is required', 'LOCATION_REQUIRED', 400)
    assertLocationAvailable(db, locationId)
    let batch = state.batches.find(row => row.id === input.batchId)
    if (!batch) {
      if (!input.create) throw new InventoryTransactionError('Batch is unavailable', 'BATCH_NOT_FOUND', 422)
      if (input.create.id !== input.batchId || input.create.materialId !== input.materialId) corrupt('new batch identity mismatch')
      batch = {
        id: input.create.id,
        materialId: input.materialId,
        batchNo: input.create.batchNo,
        quantityUnits: 0,
        remainingUnits: 0,
        status: 0,
        expiryDate: input.create.expiryDate ?? null,
        createdAt: new Date().toISOString(),
        isNew: true,
        create: input.create,
      }
      state.batches.push(batch)
    }
    const quantityDelta = toUnits(input.quantityDelta, 'batch quantity delta', { allowNegative: true })
    const remainingDelta = toUnits(input.remainingDelta, 'batch remaining delta', { allowNegative: true })
    batch.quantityUnits = checkedUnits(batch.quantityUnits, quantityDelta)
    const position = positionFor(state, batch.id, locationId, remainingDelta > 0)
    if (!position && remainingDelta !== 0) {
      throw new InventoryTransactionError('Position is unavailable for a negative delta', 'POSITION_NOT_FOUND', 422)
    }
    if (remainingDelta > 0) {
      allocations.push(addToPosition(state, position!, batch, remainingDelta, input, true))
      targets.push({ materialId: input.materialId, locationId })
    } else if (remainingDelta < 0) {
      allocations.push(deductFromPosition(state, position!, batch, -remainingDelta, input))
    }
    assertBatchState(batch)
  }
  const ownerId = inputs[0].ownerLineId ?? inputs[0].create?.inboundId ?? 'inbound-plan'
  return finalizePlan(db, states, allocations, targets, { operationKind: 'inbound', ownerId })
}

function recomputeLocationUsed(db: any, locationId: string): void {
  const rows = db.prepare(`
    SELECT p.quantity, m.units_per_package, m.slots_per_package
    FROM inventory_positions p
    JOIN materials m ON m.id = p.material_id
    WHERE p.location_id = ? AND p.quantity > 0
  `).all(locationId) as any[]
  let used: number | null = 0
  for (const row of rows) {
    if (row.units_per_package === null || row.slots_per_package === null) {
      used = null
      break
    }
    used += Math.ceil(Number(row.quantity) / Number(row.units_per_package)) * Number(row.slots_per_package)
  }
  db.prepare('UPDATE locations SET used = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(used, locationId)
}

export function applyInventoryPlan(db: any, plan: InventoryPlan): void {
  for (const material of plan.materials) {
    for (const batch of material.batches) {
      assertBatchState(batch)
      if (batch.isNew) {
        const create = batch.create!
        const inboundPrice = create.inboundPrice === undefined
          ? 0
          : fromUnits(toUnits(create.inboundPrice, 'inbound price'))
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
        const result = db.prepare(`
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
        if (Number(result.changes) !== 1) corrupt(`batch ${batch.id} disappeared during apply`)
      }
    }

    for (const position of material.positions) {
      if (position.quantityUnits === 0) {
        if (position.existed) db.prepare('DELETE FROM inventory_positions WHERE id = ?').run(position.id)
        continue
      }
      if (position.existed) {
        const result = db.prepare(`
          UPDATE inventory_positions
          SET quantity = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND material_id = ? AND location_id = ?
        `).run(fromUnits(position.quantityUnits), position.id, material.materialId, position.locationId)
        if (Number(result.changes) !== 1) corrupt(`position ${position.id} disappeared during apply`)
      } else {
        db.prepare(`
          INSERT INTO inventory_positions (id, material_id, batch_id, location_id, quantity)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          position.id,
          material.materialId,
          position.batchId,
          position.locationId,
          fromUnits(position.quantityUnits),
        )
      }
    }

    const stock = fromUnits(stateTotal(material))
    const result = db.prepare(`
      UPDATE inventory
      SET stock = ?, location_id = NULL, update_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE material_id = ?
    `).run(stock, material.materialId)
    if (Number(result.changes) !== 1) {
      if (material.inventoryExists) corrupt(`inventory ${material.materialId} disappeared during apply`)
      db.prepare(`
        INSERT INTO inventory (id, material_id, stock, locked_stock, location_id, update_time)
        VALUES (?, ?, ?, 0, NULL, CURRENT_TIMESTAMP)
      `).run(uuidv4(), material.materialId, stock)
    }
  }

  for (const warning of plan.capacityWarnings ?? []) {
    db.prepare(`
      INSERT OR IGNORE INTO inventory_capacity_audits
        (id, decision, operation_kind, owner_id, material_id, location_id, details_json)
      VALUES (?, 'allowed_missing_conversion', ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      warning.operationKind,
      warning.ownerId,
      warning.materialId,
      warning.locationId,
      JSON.stringify({ missingMaterials: warning.missingMaterials }),
    )
  }
  for (const locationId of plan.affectedLocations ?? []) recomputeLocationUsed(db, locationId)
}

export function replaceAllocationFacts(db: any, input: AllocationFactWrite): void {
  if (!input.ownerId) corrupt('allocation owner is missing')
  const existing = db.prepare(`
    SELECT 1 AS ok FROM inventory_transaction_allocations
    WHERE operation_kind = ? AND owner_id = ? LIMIT 1
  `).get(input.operationKind, input.ownerId)
  if (existing) {
    throw new InventoryTransactionError(
      'Allocation facts are append-only and already exist for this owner',
      'ALLOCATION_FACTS_IMMUTABLE',
      409,
    )
  }
  const insert = db.prepare(`
    INSERT INTO inventory_transaction_allocations
      (id, operation_kind, owner_id, owner_line_id, material_id, batch_id, location_id, direction, quantity, source_allocation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const [index, allocation] of input.allocations.entries()) {
    if (!allocation.locationId) corrupt('allocation location is missing')
    const quantity = fromUnits(toUnits(allocation.quantity, 'allocation quantity', { positive: true }))
    insert.run(
      `${input.ownerId}:${String(index).padStart(6, '0')}:${uuidv4()}`,
      input.operationKind,
      input.ownerId,
      allocation.ownerLineId ?? null,
      allocation.materialId,
      allocation.batchId ?? null,
      allocation.locationId,
      'direction' in allocation && allocation.direction ? allocation.direction : input.direction,
      quantity,
      allocation.sourceAllocationId ?? null,
    )
  }
}

export function listActiveAllocationFacts(db: any, operationKind: InventoryOperationKind, ownerId: string): any[] {
  return db.prepare(`
    SELECT * FROM inventory_transaction_allocations
    WHERE operation_kind = ? AND owner_id = ?
    ORDER BY created_at, id
  `).all(operationKind, ownerId) as any[]
}

export function markAllocationFactsReversed(_db: any, _operationKind: InventoryOperationKind, _ownerId: string): void {
  throw new InventoryTransactionError(
    'Cancellation requires an append-only compensation chain',
    'COMPENSATION_CHAIN_REQUIRED',
    409,
  )
}

export function inventoryErrorResponse(error: unknown): { message: string; code: string; status: number } | null {
  return error instanceof InventoryTransactionError
    ? { message: error.message, code: error.code, status: error.status }
    : null
}
