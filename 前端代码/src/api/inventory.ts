import request from './request'
import type { ApiResponse, PaginationData, InventoryItem, InventoryStats, InboundRecord, InboundFormData, OutboundRecord, OutboundFormData, PageParams } from '@/types'

export const inventoryApi = {
  getList: (params?: PageParams & { status?: string; categoryId?: string; locationId?: string }) =>
    request.get<PaginationData<InventoryItem>>('/inventory', { params }),

  getStats: () =>
    request.get<InventoryStats>('/inventory/stats'),
}

export const inboundApi = {
  getList: (params?: PageParams & { status?: string; startDate?: string; endDate?: string }) =>
    request.get<PaginationData<InboundRecord>>('/inbound', { params }),

  create: (data: InboundFormData) =>
    request.post<InboundRecord>('/inbound', data),

  update: (id: string, data: Partial<InboundFormData>) =>
    request.put<InboundRecord>(`/inbound/${id}`, data),

  delete: (id: string) =>
    request.delete(`/inbound/${id}`),

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
  getList: (params?: PageParams & { projectId?: string; status?: string }) =>
    request.get<PaginationData<OutboundRecord>>('/outbound', { params }),

  create: (data: OutboundFormData) =>
    request.post<OutboundRecord>('/outbound', data),
}

export const depletionApi = {
  getTracking: (params?: { status?: string }) =>
    request.get<{ list: any[] }>('/depletion/tracking', { params }),
  getDepletion: () =>
    request.get<{ list: any[] }>('/depletion/depletion'),
}
