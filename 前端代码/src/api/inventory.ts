import request, { genIdempotencyKey } from './request'
import type { PaginationData, InventoryItem, InventoryStats, InboundRecord, InboundFormData, OutboundRecord, OutboundFormData, PageParams, SupplierReturnRecord, SupplierReturnFormData } from '@/types'

export const inventoryApi = {
  getList: (params?: PageParams & { status?: string; categoryId?: string; locationId?: string }) =>
    request.get<PaginationData<InventoryItem>>('/inventory', { params }),

  getStats: () =>
    request.get<InventoryStats>('/inventory/stats'),
}

export const inboundApi = {
  getList: (params?: PageParams & { status?: string; type?: string; materialId?: string; startDate?: string; endDate?: string }) =>
    request.get<PaginationData<InboundRecord>>('/inbound', { params }),

  // idempotencyKey：同一次提交动作传同一个 key，可防网络重试/代理重发/双击重复入账；不传则按本次调用自动生成。
  create: (data: InboundFormData, idempotencyKey: string = genIdempotencyKey()) =>
    request.post<InboundRecord>('/inbound', data, { headers: { 'Idempotency-Key': idempotencyKey } }),

  update: (id: string, data: Partial<InboundFormData>) =>
    request.put<InboundRecord>(`/inbound/${id}`, data),

  delete: (id: string) =>
    request.delete(`/inbound/${id}`),

  getStats: () =>
    request.get<{ total: number; completed: number; cancelled: number; amount: number; supplierCount: number; pendingOrders: number }>('/inbound/stats'),

  checkDeletable: (id: string) =>
    request.get<{ canDelete: boolean; reasons: string[]; record: any }>(`/inbound/${id}/check-deletable`),

  cancel: (id: string, reason: string) =>
    request.post(`/inbound/${id}/cancel`, { reason }),

  createTransfer: (data: { materialId: string; quantity: number; fromLocationId: string; toLocationId: string; batchNo?: string; operator?: string; remark?: string; fromLocationName?: string }) =>
    request.post('/transfers/inbound', data),
}

export const purchaseOrderApi = {
  getList: (params?: { status?: string; supplierId?: string; keyword?: string; page?: number; pageSize?: number }) =>
    request.get<PaginationData<any>>('/purchase-orders', { params }),
  getById: (id: string) =>
    request.get<any>(`/purchase-orders/${id}`),
  create: (data: any) =>
    request.post<any>('/purchase-orders', data),
  receive: (id: string, data: { quantity: number }) =>
    request.put<any>(`/purchase-orders/${id}/receive`, data),
  cancel: (id: string) =>
    request.put(`/purchase-orders/${id}/cancel`),
}

export const outboundApi = {
  getList: (params?: PageParams & { projectId?: string; status?: string; keyword?: string; materialId?: string; type?: string; startDate?: string; endDate?: string }) =>
    request.get<PaginationData<OutboundRecord>>('/outbound', { params }),

  getStats: () =>
    request.get<{ total: number; completed: number; pending: number; cancelled: number; totalCost: number }>('/outbound/stats'),

  // idempotencyKey：同一次提交动作传同一个 key，可防网络重试/代理重发/双击重复出库；不传则按本次调用自动生成。
  create: (data: OutboundFormData, idempotencyKey: string = genIdempotencyKey()) =>
    request.post<OutboundRecord>('/outbound', data, { headers: { 'Idempotency-Key': idempotencyKey } }),

  update: (id: string, data: Partial<OutboundFormData>) =>
    request.put<OutboundRecord>(`/outbound/${id}`, data),

  delete: (id: string) =>
    request.delete(`/outbound/${id}`),
}

export const scrapApi = {
  getList: (params?: PageParams) =>
    request.get<PaginationData<any>>('/scraps', { params }),
  create: (data: { materialId: string; quantity: number; reason: string; operator?: string; remark?: string }) =>
    request.post<any>('/scraps', data),
  delete: (id: string) =>
    request.delete(`/scraps/${id}`),
}

export const returnApi = {
  getList: (params?: PageParams) =>
    request.get<PaginationData<any>>('/returns', { params }),
  create: (data: { materialId: string; quantity: number; reason: string; operator?: string; remark?: string }) =>
    request.post<any>('/returns', data),
  delete: (id: string) =>
    request.delete(`/returns/${id}`),
}

export const supplierReturnApi = {
  getList: (params?: PageParams & { supplierId?: string; status?: string; keyword?: string; startDate?: string; endDate?: string }) =>
    request.get<PaginationData<SupplierReturnRecord>>('/supplier-returns', { params }),
  getById: (id: string) =>
    request.get<any>(`/supplier-returns/${id}`),
  create: (data: SupplierReturnFormData) =>
    request.post<any>('/supplier-returns', data),
  updateStatus: (id: string, status: string) =>
    request.put<any>(`/supplier-returns/${id}/status`, { status }),
  delete: (id: string) =>
    request.delete(`/supplier-returns/${id}`),
}

export const transferApi = {
  getList: (params?: PageParams) =>
    request.get<PaginationData<any>>('/transfers', { params }),
  createInbound: (data: { materialId: string; batchNo?: string; quantity: number; fromLocationId?: string; fromLocationName?: string; toLocationId: string; operator?: string; remark?: string }) =>
    request.post<any>('/transfers/inbound', data),
  delete: (id: string) =>
    request.delete(`/transfers/${id}`),
}

export const depletionApi = {
  getTracking: (params?: { status?: string }) =>
    request.get<{ list: any[] }>('/depletion/tracking', { params }),
  getDepletion: () =>
    request.get<{ list: any[] }>('/depletion/depletion'),
}
