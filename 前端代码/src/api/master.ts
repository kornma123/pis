import request from './request'
import type { ApiResponse, PaginationData, Category, Material, Supplier, Location, Project, BOM, PageParams } from '@/types'

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
  getList: (params?: PageParams & { type?: string; status?: string }) =>
    request.get<PaginationData<Project>>('/projects', { params }),
  getDetail: (id: string) => request.get<Project>(`/projects/${id}`),
  create: (data: Partial<Project>) => request.post('/projects', data),
  update: (id: string, data: Partial<Project>) => request.put(`/projects/${id}`, data),
  delete: (id: string) => request.delete(`/projects/${id}`),
}

export const bomApi = {
  getList: (params?: PageParams & { type?: string }) =>
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
