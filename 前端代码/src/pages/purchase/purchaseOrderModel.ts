export const PURCHASE_INBOUND_UNAVAILABLE_REASON =
  '关联采购单入库暂不可执行：后端尚未在同一事务中校验订单状态、物料一致性和剩余数量。'

export const PURCHASE_INBOUND_PERMISSION_REASON =
  '当前账号没有入库写权限；关联采购单入库也尚未具备后端原子校验。'

export interface NormalizedPurchaseOrder {
  id: string
  orderNo: string | null
  materialId: string | null
  materialName: string | null
  supplierId: string | null
  supplierName: string | null
  orderedQty: number | null
  receivedQty: number | null
  remainingQty: number | null
  unit: string | null
  unitPrice: number | null
  totalAmount: number | null
  expectedDate: string | null
  status: string
  remark: string | null
  createdAt: string | null
  updatedAt: string | null
}

type PurchaseOrderCapabilities = {
  canWritePurchase: boolean
  canWriteInbound: boolean
}

type PurchaseOrderActions = {
  canCancel: boolean
  canCreateInbound: boolean
  inboundUnavailableReason: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function firstDefined(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : null
}

export function normalizePurchaseOrder(value: unknown): NormalizedPurchaseOrder {
  const record = asRecord(value)
  const orderedQty = toFiniteNumberOrNull(firstDefined(record, 'orderedQty', 'ordered_qty'))
  const receivedQty = toFiniteNumberOrNull(firstDefined(record, 'receivedQty', 'received_qty'))
  const explicitRemainingQty = toFiniteNumberOrNull(firstDefined(record, 'remainingQty', 'remaining_qty'))
  const rawStatus = toStringOrNull(firstDefined(record, 'status'))

  return {
    id: toStringOrNull(firstDefined(record, 'id')) ?? '',
    orderNo: toStringOrNull(firstDefined(record, 'orderNo', 'order_no')),
    materialId: toStringOrNull(firstDefined(record, 'materialId', 'material_id')),
    materialName: toStringOrNull(firstDefined(record, 'materialName', 'material_name')),
    supplierId: toStringOrNull(firstDefined(record, 'supplierId', 'supplier_id')),
    supplierName: toStringOrNull(firstDefined(record, 'supplierName', 'supplier_name')),
    orderedQty,
    receivedQty,
    remainingQty: explicitRemainingQty ?? (
      orderedQty !== null && receivedQty !== null ? orderedQty - receivedQty : null
    ),
    unit: toStringOrNull(firstDefined(record, 'unit')),
    unitPrice: toFiniteNumberOrNull(firstDefined(record, 'unitPrice', 'unit_price')),
    totalAmount: toFiniteNumberOrNull(firstDefined(record, 'totalAmount', 'total_amount')),
    expectedDate: toStringOrNull(firstDefined(record, 'expectedDate', 'expected_date')),
    status: rawStatus ?? 'unknown',
    remark: toStringOrNull(firstDefined(record, 'remark')),
    createdAt: toStringOrNull(firstDefined(record, 'createdAt', 'created_at')),
    updatedAt: toStringOrNull(firstDefined(record, 'updatedAt', 'updated_at')),
  }
}

export function getPurchaseOrderActions(
  order: NormalizedPurchaseOrder,
  capabilities: PurchaseOrderCapabilities,
): PurchaseOrderActions {
  const isOpenOrder = order.status === 'pending' || order.status === 'partial'
  if (!isOpenOrder || !order.id) {
    return {
      canCancel: false,
      canCreateInbound: false,
      inboundUnavailableReason: null,
    }
  }

  return {
    canCancel: capabilities.canWritePurchase,
    canCreateInbound: false,
    inboundUnavailableReason: capabilities.canWriteInbound
      ? PURCHASE_INBOUND_UNAVAILABLE_REASON
      : PURCHASE_INBOUND_PERMISSION_REASON,
  }
}

function safeReturnPath(returnTo: string): string {
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/purchase-orders'
}

export function buildPurchaseInboundContextUrl(
  order: NormalizedPurchaseOrder,
  returnTo: string,
): string {
  const params = new URLSearchParams()
  if (order.id) params.set('purchaseOrderId', order.id)
  if (order.materialId) params.set('materialId', order.materialId)
  params.set('type', 'purchase')
  params.set('returnTo', safeReturnPath(returnTo))
  return `/inbound?${params.toString()}`
}
