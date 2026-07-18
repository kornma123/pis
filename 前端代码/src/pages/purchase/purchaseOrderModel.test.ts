import { describe, expect, it } from 'vitest'
import {
  PURCHASE_INBOUND_UNAVAILABLE_REASON,
  buildPurchaseInboundContextUrl,
  getPurchaseOrderActions,
  normalizePurchaseOrder,
} from './purchaseOrderModel'

describe('purchaseOrderModel', () => {
  it('normalizes the live snake_case API without turning a real zero into unknown', () => {
    const order = normalizePurchaseOrder({
      id: 'po-1',
      order_no: 'PO20260718-0001',
      material_id: 'mat-1',
      material_name: '试剂 A',
      supplier_id: 'sup-1',
      ordered_qty: 8,
      received_qty: 0,
      remainingQty: 8,
      unit: '盒',
      unit_price: 0,
      total_amount: 0,
      status: 'pending',
      created_at: '2026-07-18T08:00:00Z',
    })

    expect(order).toMatchObject({
      orderNo: 'PO20260718-0001',
      materialId: 'mat-1',
      supplierId: 'sup-1',
      receivedQty: 0,
      unitPrice: 0,
      totalAmount: 0,
      status: 'pending',
    })
  })

  it('keeps an unknown backend status unknown and exposes no mutating action', () => {
    const order = normalizePurchaseOrder({ id: 'po-1', status: 'mystery' })

    expect(order.status).toBe('mystery')
    expect(getPurchaseOrderActions(order, { canWritePurchase: true, canWriteInbound: true })).toEqual({
      canCancel: false,
      canCreateInbound: false,
      inboundUnavailableReason: null,
    })
  })

  it('exposes no mutation or inbound context when an open row has no stable id', () => {
    const order = normalizePurchaseOrder({ status: 'pending', material_id: 'mat-1' })

    expect(getPurchaseOrderActions(order, { canWritePurchase: true, canWriteInbound: true })).toEqual({
      canCancel: false,
      canCreateInbound: false,
      inboundUnavailableReason: null,
    })
  })

  it('never restores the unsafe receive button while the backend cannot validate a linked inbound', () => {
    const order = normalizePurchaseOrder({
      id: 'po-1',
      order_no: 'PO20260718-0001',
      ordered_qty: 8,
      received_qty: 2,
      remainingQty: 6,
      status: 'partial',
    })

    expect(getPurchaseOrderActions(order, { canWritePurchase: true, canWriteInbound: true })).toEqual({
      canCancel: true,
      canCreateInbound: false,
      inboundUnavailableReason: PURCHASE_INBOUND_UNAVAILABLE_REASON,
    })
  })

  it('builds a stable same-app context URL that survives refresh and preserves the return filter', () => {
    const url = buildPurchaseInboundContextUrl(
      normalizePurchaseOrder({
        id: 'po 1',
        material_id: 'mat/1',
        status: 'pending',
      }),
      '/purchase-orders?status=pending&keyword=DNA',
    )
    const params = new URLSearchParams(url.split('?')[1])

    expect(url.startsWith('/inbound?')).toBe(true)
    expect(params.get('purchaseOrderId')).toBe('po 1')
    expect(params.get('materialId')).toBe('mat/1')
    expect(params.get('type')).toBe('purchase')
    expect(params.get('returnTo')).toBe('/purchase-orders?status=pending&keyword=DNA')
  })
})
