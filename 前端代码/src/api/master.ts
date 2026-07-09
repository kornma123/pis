import request from './request'
import type { PaginationData, Category, Material, Supplier, Location, Project, BOM, PageParams, Equipment, EquipmentType, EquipmentUsage, DepreciationStat, StandardLaborTime, IndirectCostCenter, IndirectCostAllocation, CostAdjustment } from '@/types'

export const categoryApi = {
  getTree: () => request.get<Category[]>('/categories/tree'),
  getList: (params?: PageParams) => request.get<PaginationData<Category>>('/categories', { params }),
  create: (data: Partial<Category>) => request.post('/categories', data),
  update: (id: string, data: Partial<Category>) => request.put(`/categories/${id}`, data),
  delete: (id: string) => request.delete(`/categories/${id}`),
}

export const materialApi = {
  getList: (params?: PageParams & { categoryId?: string; supplierId?: string; status?: string }) =>
    request.get<PaginationData<Material>>('/materials', { params }),
  getDetail: (id: string) => request.get<Material>(`/materials/${id}`),
  getNextCode: (categoryId: string) => request.get<{ code: string }>('/materials/next-code', { params: { categoryId } }),
  create: (data: Partial<Material>) => request.post('/materials', data),
  update: (id: string, data: Partial<Material>) => request.put(`/materials/${id}`, data),
  delete: (id: string) => request.delete(`/materials/${id}`),
  batchStatus: (ids: string[], status: string) => request.patch('/materials/batch-status', { ids, status }),
}

export const supplierApi = {
  getList: (params?: PageParams & { status?: string }) =>
    request.get<PaginationData<Supplier>>('/suppliers', { params }),
  create: (data: Partial<Supplier>) => request.post('/suppliers', data),
  update: (id: string, data: Partial<Supplier>) => request.put(`/suppliers/${id}`, data),
  delete: (id: string) => request.delete(`/suppliers/${id}`),
}

export const locationApi = {
  getList: (params?: PageParams & { zone?: string; status?: string }) =>
    request.get<PaginationData<Location>>('/locations', { params }),
  getTree: () => request.get<Location[]>('/locations/tree'),
  create: (data: Partial<Location>) => request.post('/locations', data),
  update: (id: string, data: Partial<Location>) => request.put(`/locations/${id}`, data),
  delete: (id: string) => request.delete(`/locations/${id}`),
}

export const projectApi = {
  getList: (params?: PageParams & { type?: string; status?: string; bomFilter?: string }) =>
    request.get<PaginationData<Project>>('/projects', { params }),
  getDetail: (id: string) => request.get<Project>(`/projects/${id}`),
  create: (data: Partial<Project>) => request.post('/projects', data),
  update: (id: string, data: Partial<Project>) => request.put(`/projects/${id}`, data),
  delete: (id: string) => request.delete(`/projects/${id}`),
}

export const bomApi = {
  getList: (params?: PageParams & { type?: string; status?: string }) =>
    request.get<PaginationData<BOM>>('/boms', { params }),
  getDetail: (id: string) => request.get<BOM>(`/boms/${id}`),
  create: (data: Partial<BOM>) => request.post('/boms', data),
  update: (id: string, data: Partial<BOM>) => request.put(`/boms/${id}`, data),
  delete: (id: string) => request.delete(`/boms/${id}`),
}

export const userApi = {
  getList: (params?: PageParams & { keyword?: string }) =>
    request.get<PaginationData<any>>('/users', { params }),
}

// ===== ABC 成本核算 API（移植自 abc-productization 分支）=====
export const equipmentApi = {
  getList: (params?: PageParams & { keyword?: string; status?: string; typeId?: string; includeDeleted?: boolean }) =>
    request.get<PaginationData<Equipment>>('/equipment', { params }),
  getStats: (params?: { keyword?: string; status?: string; typeId?: string; includeDeleted?: boolean }) =>
    request.get('/equipment/stats', { params }),
  getDetail: (id: string) => request.get<Equipment>(`/equipment/${id}`),
  create: (data: Partial<Equipment>) => request.post('/equipment', data),
  update: (id: string, data: Partial<Equipment>) => request.put(`/equipment/${id}`, data),
  delete: (id: string) => request.delete(`/equipment/${id}`),
  getUsage: (id: string, params?: PageParams) =>
    request.get<PaginationData<EquipmentUsage>>(`/equipment/${id}/usage`, { params }),
  recordUsage: (id: string, data: Partial<EquipmentUsage>) =>
    request.post(`/equipment/${id}/usage`, data),
  getTypes: (params?: PageParams & { keyword?: string; status?: string; includeDeleted?: boolean }) =>
    request.get<PaginationData<EquipmentType>>('/equipment-types', { params }),
  getTypeStats: (params?: { keyword?: string; status?: string; includeDeleted?: boolean }) =>
    request.get<{ total: number; active: number; equipmentCount: number }>('/equipment-types/stats', { params }),
  getTypeDetail: (id: string) => request.get<EquipmentType>(`/equipment-types/${id}`),
  createType: (data: Partial<EquipmentType>) => request.post('/equipment-types', data),
  updateType: (id: string, data: Partial<EquipmentType>) => request.put(`/equipment-types/${id}`, data),
  deleteType: (id: string) => request.delete(`/equipment-types/${id}`),
  getDepreciationStats: () => request.get<{ summary: any; stats: DepreciationStat[] }>('/equipment/depreciation-stats'),
}

export const laborTimeApi = {
  getList: (params?: PageParams & { projectType?: string; stepCode?: string; keyword?: string; referenceSource?: string }) =>
    request.get<PaginationData<StandardLaborTime>>('/labor-times', { params }),
  getStats: (params?: { projectType?: string; stepCode?: string; keyword?: string; referenceSource?: string }) =>
    request.get('/labor-times/stats', { params }),
  getByProjectType: (type: string) =>
    request.get<StandardLaborTime[]>(`/labor-times/project-type/${type}`),
  getDetail: (id: string) =>
    request.get<StandardLaborTime>(`/labor-times/${id}`),
  create: (data: Partial<StandardLaborTime>) =>
    request.post('/labor-times', data),
  update: (id: string, data: Partial<StandardLaborTime>) =>
    request.put(`/labor-times/${id}`, data),
  delete: (id: string) =>
    request.delete(`/labor-times/${id}`),
}

export const indirectCostApi = {
  getList: (params?: PageParams & { keyword?: string; status?: string }) =>
    request.get<PaginationData<IndirectCostCenter>>('/indirect-costs', { params }),
  getStats: (params?: { keyword?: string; status?: string }) =>
    request.get('/indirect-costs/stats', { params }),
  getDetail: (id: string) =>
    request.get<IndirectCostCenter>(`/indirect-costs/${id}`),
  create: (data: Partial<IndirectCostCenter>) =>
    request.post('/indirect-costs', data),
  update: (id: string, data: Partial<IndirectCostCenter>) =>
    request.put(`/indirect-costs/${id}`, data),
  delete: (id: string) =>
    request.delete(`/indirect-costs/${id}`),
  getAllocations: (id: string, params?: PageParams) =>
    request.get<PaginationData<IndirectCostAllocation>>(`/indirect-costs/${id}/allocations`, { params }),
  recordAllocation: (id: string, data: Partial<IndirectCostAllocation>) =>
    request.post(`/indirect-costs/${id}/allocations`, data),
}

export const costAdjustmentApi = {
  getSuggestions: (params?: { yearQuarter?: string; costCenterId?: string }) =>
    request.get('/cost-adjustments/suggestions', { params }),
  create: (data: Partial<CostAdjustment>) => request.post('/cost-adjustments', data),
  review: (id: string, data: { status: 'approved' | 'rejected'; reason?: string }) =>
    request.post(`/cost-adjustments/${id}/review`, data),
  getList: (params?: PageParams & { yearQuarter?: string; costCenterId?: string; reviewStatus?: string }) =>
    request.get<PaginationData<CostAdjustment>>('/cost-adjustments', { params }),
}
