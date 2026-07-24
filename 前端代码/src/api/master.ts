import request from './request'
import type { PaginationData, Category, Material, Supplier, Location, Project, BOM, PageParams, Equipment, EquipmentType, EquipmentUsage, DepreciationStat, StandardLaborTime, IndirectCostCenter, IndirectCostAllocation, CostAdjustment } from '@/types'
import {
  ContractError,
  requireObject,
  requireIdentity,
  requireString,
  optionalString,
  requireFiniteNumber,
  nullableFiniteNumber,
  requireStatus,
  requireListEnvelope,
} from '@/types'
import type { BomListItem, BomDetail, BomDetailMaterial, ListPagination } from '@/types'

// ===== LOC-013：endpoint 专属 exact parser（response→parser→consumer 边界）=====
// 铁律：unknown/null/malformed/unsafe/contradictory 绝不折为 0/[]/空成功；
// 合法 0 与合法空数组保真。list 与 detail 形状不得互套。
// 注意：各 API 方法的静态返回类型保持不变（仓库既有消费者面大，不在本任务收口），
// 运行时一律先过 parser 再发布——parser 才是真值边界。

function parseBomListItem(endpoint: string, raw: Record<string, unknown>, i: number): BomListItem {
  return {
    id: requireIdentity(endpoint, raw.id, `list[${i}].id`),
    code: requireIdentity(endpoint, raw.code, `list[${i}].code`),
    name: requireIdentity(endpoint, raw.name, `list[${i}].name`),
    version: requireIdentity(endpoint, raw.version, `list[${i}].version`),
    type: requireIdentity(endpoint, raw.type, `list[${i}].type`),
    serviceId: optionalString(endpoint, raw.serviceId, `list[${i}].serviceId`),
    materialCount: requireFiniteNumber(endpoint, raw.materialCount, `list[${i}].materialCount`, { min: 0, int: true }),
    supportableSamples: nullableFiniteNumber(endpoint, raw.supportableSamples, `list[${i}].supportableSamples`, { min: 0 }),
    unitCost: nullableFiniteNumber(endpoint, raw.unitCost, `list[${i}].unitCost`, { min: 0 }),
    status: requireStatus(endpoint, raw.status, `list[${i}].status`),
    createdAt: requireIdentity(endpoint, raw.createdAt, `list[${i}].createdAt`),
    updatedAt: requireIdentity(endpoint, raw.updatedAt, `list[${i}].updatedAt`),
  }
}

/** GET /boms — 只认 successList 信封；收到 detail 形状必拒。 */
export function parseBomListResponse(payload: unknown): { list: BomListItem[]; pagination: ListPagination } {
  const endpoint = 'GET /boms'
  const { list, pagination } = requireListEnvelope(endpoint, payload)
  return {
    list: list.map((raw, i) => {
      requireObject(endpoint, raw, `list[${i}]`)
      return parseBomListItem(endpoint, raw, i)
    }),
    pagination,
  }
}

/** GET /boms/:id — 只认 detail 形状（materials + versionHistory）；收到 list 信封必拒。 */
export function parseBomDetailResponse(payload: unknown): BomDetail {
  const endpoint = 'GET /boms/:id'
  requireObject(endpoint, payload, 'data')
  if ('list' in payload || 'pagination' in payload) {
    throw new ContractError(endpoint, '收到 list 信封形状（list/detail 不得互套）')
  }
  const raw = payload as Record<string, unknown>
  if (!Array.isArray(raw.materials)) {
    throw new ContractError(endpoint, 'materials 缺失或不是数组')
  }
  const materials: BomDetailMaterial[] = raw.materials.map((m: unknown, i: number) => {
    requireObject(endpoint, m, `materials[${i}]`)
    const item = m as Record<string, unknown>
    return {
      id: requireIdentity(endpoint, item.id, `materials[${i}].id`),
      name: requireIdentity(endpoint, item.name, `materials[${i}].name`),
      spec: optionalString(endpoint, item.spec, `materials[${i}].spec`),
      usagePerSample: requireFiniteNumber(endpoint, item.usagePerSample, `materials[${i}].usagePerSample`, { min: 0 }),
      unit: optionalString(endpoint, item.unit, `materials[${i}].unit`),
      price: requireFiniteNumber(endpoint, item.price, `materials[${i}].price`, { min: 0 }),
      stock: nullableFiniteNumber(endpoint, item.stock, `materials[${i}].stock`),
      costRatio: requireFiniteNumber(endpoint, item.costRatio, `materials[${i}].costRatio`, { min: 0, max: 1 }),
    }
  })
  if (!Array.isArray(raw.versionHistory) || raw.versionHistory.length === 0) {
    throw new ContractError(endpoint, 'versionHistory 缺失或为空')
  }
  const versionHistory = raw.versionHistory.map((v: unknown, i: number) => {
    requireObject(endpoint, v, `versionHistory[${i}]`)
    const item = v as Record<string, unknown>
    return {
      version: requireIdentity(endpoint, item.version, `versionHistory[${i}].version`),
      updatedAt: requireIdentity(endpoint, item.updatedAt, `versionHistory[${i}].updatedAt`),
      changeLog: requireString(endpoint, item.changeLog, `versionHistory[${i}].changeLog`),
    }
  })
  return {
    id: requireIdentity(endpoint, raw.id, 'id'),
    code: requireIdentity(endpoint, raw.code, 'code'),
    name: requireIdentity(endpoint, raw.name, 'name'),
    version: requireIdentity(endpoint, raw.version, 'version'),
    type: requireIdentity(endpoint, raw.type, 'type'),
    serviceId: optionalString(endpoint, raw.serviceId, 'serviceId'),
    supportableSamples: nullableFiniteNumber(endpoint, raw.supportableSamples, 'supportableSamples', { min: 0 }),
    unitCost: nullableFiniteNumber(endpoint, raw.unitCost, 'unitCost', { min: 0 }),
    status: requireStatus(endpoint, raw.status, 'status'),
    materials,
    versionHistory,
  }
}

function parseProjectListItem(endpoint: string, raw: Record<string, unknown>, i: number) {
  return {
    id: requireIdentity(endpoint, raw.id, `list[${i}].id`),
    code: requireIdentity(endpoint, raw.code, `list[${i}].code`),
    name: requireIdentity(endpoint, raw.name, `list[${i}].name`),
    type: requireIdentity(endpoint, raw.type, `list[${i}].type`),
    cycle: optionalString(endpoint, raw.cycle, `list[${i}].cycle`),
    bomId: optionalString(endpoint, raw.bomId, `list[${i}].bomId`),
    supportableSamples: nullableFiniteNumber(endpoint, raw.supportableSamples, `list[${i}].supportableSamples`, { min: 0 }),
    status: requireStatus(endpoint, raw.status, `list[${i}].status`),
    manager: optionalString(endpoint, raw.manager, `list[${i}].manager`),
    description: optionalString(endpoint, raw.description, `list[${i}].description`),
    createdAt: requireIdentity(endpoint, raw.createdAt, `list[${i}].createdAt`),
  }
}

export function parseProjectListResponse(payload: unknown): unknown {
  const endpoint = 'GET /projects'
  const { list, pagination } = requireListEnvelope(endpoint, payload)
  return {
    list: list.map((raw, i) => {
      requireObject(endpoint, raw, `list[${i}]`)
      return parseProjectListItem(endpoint, raw, i)
    }),
    pagination,
  }
}

export function parseProjectDetailResponse(payload: unknown): unknown {
  const endpoint = 'GET /projects/:id'
  requireObject(endpoint, payload, 'data')
  if ('list' in payload || 'pagination' in payload) {
    throw new ContractError(endpoint, '收到 list 信封形状（list/detail 不得互套）')
  }
  const raw = payload as Record<string, unknown>
  const base = parseProjectListItem(endpoint, raw, 0)
  requireObject(endpoint, raw.costStats, 'costStats')
  const cs = raw.costStats as Record<string, unknown>
  const totalCost = requireFiniteNumber(endpoint, cs.totalCost, 'costStats.totalCost', { min: 0 })
  const sampleCount = requireFiniteNumber(endpoint, cs.sampleCount, 'costStats.sampleCount', { min: 0, int: true })
  const unitCost = requireFiniteNumber(endpoint, cs.unitCost, 'costStats.unitCost', { min: 0 })
  // 矛盾计数（后端自身公式：unitCost = totalCost/sampleCount；无样本则全 0）
  if (sampleCount === 0 && (totalCost !== 0 || unitCost !== 0)) {
    throw new ContractError(endpoint, 'sampleCount=0 但成本非 0（矛盾）')
  }
  if (sampleCount > 0 && Math.abs(unitCost - totalCost / sampleCount) > 1e-9) {
    throw new ContractError(endpoint, 'unitCost 与 totalCost/sampleCount 矛盾')
  }
  return { ...base, costStats: { totalCost, sampleCount, unitCost } }
}

function parseMaterialListItem(endpoint: string, raw: Record<string, unknown>, i: number) {
  return {
    id: requireIdentity(endpoint, raw.id, `list[${i}].id`),
    code: requireIdentity(endpoint, raw.code, `list[${i}].code`),
    name: requireIdentity(endpoint, raw.name, `list[${i}].name`),
    spec: optionalString(endpoint, raw.spec, `list[${i}].spec`),
    unit: optionalString(endpoint, raw.unit, `list[${i}].unit`),
    specQty: nullableFiniteNumber(endpoint, raw.specQty, `list[${i}].specQty`, { min: 0 }),
    specUnit: optionalString(endpoint, raw.specUnit, `list[${i}].specUnit`),
    price: nullableFiniteNumber(endpoint, raw.price, `list[${i}].price`, { min: 0 }),
    stock: nullableFiniteNumber(endpoint, raw.stock, `list[${i}].stock`),
    minStock: nullableFiniteNumber(endpoint, raw.minStock, `list[${i}].minStock`),
    maxStock: nullableFiniteNumber(endpoint, raw.maxStock, `list[${i}].maxStock`),
    safetyStock: nullableFiniteNumber(endpoint, raw.safetyStock, `list[${i}].safetyStock`),
    locationId: optionalString(endpoint, raw.locationId, `list[${i}].locationId`),
    locationName: optionalString(endpoint, raw.locationName, `list[${i}].locationName`),
    categoryId: requireIdentity(endpoint, raw.categoryId, `list[${i}].categoryId`),
    categoryPath: optionalString(endpoint, raw.categoryPath, `list[${i}].categoryPath`),
    supplierId: optionalString(endpoint, raw.supplierId, `list[${i}].supplierId`),
    supplierName: optionalString(endpoint, raw.supplierName, `list[${i}].supplierName`),
    status: requireStatus(endpoint, raw.status, `list[${i}].status`),
    remark: optionalString(endpoint, raw.remark, `list[${i}].remark`),
    createdAt: requireIdentity(endpoint, raw.createdAt, `list[${i}].createdAt`),
    updatedAt: requireIdentity(endpoint, raw.updatedAt, `list[${i}].updatedAt`),
  }
}

export function parseMaterialListResponse(payload: unknown): unknown {
  const endpoint = 'GET /materials'
  const { list, pagination } = requireListEnvelope(endpoint, payload)
  return {
    list: list.map((raw, i) => {
      requireObject(endpoint, raw, `list[${i}]`)
      return parseMaterialListItem(endpoint, raw, i)
    }),
    pagination,
  }
}

export function parseMaterialDetailResponse(payload: unknown): unknown {
  const endpoint = 'GET /materials/:id'
  requireObject(endpoint, payload, 'data')
  if ('list' in payload || 'pagination' in payload) {
    throw new ContractError(endpoint, '收到 list 信封形状（list/detail 不得互套）')
  }
  const raw = payload as Record<string, unknown>
  const base = parseMaterialListItem(endpoint, raw, 0)
  if (!Array.isArray(raw.batches)) {
    throw new ContractError(endpoint, 'batches 缺失或不是数组')
  }
  const batches = raw.batches.map((b: unknown, i: number) => {
    requireObject(endpoint, b, `batches[${i}]`)
    const item = b as Record<string, unknown>
    return {
      id: requireIdentity(endpoint, item.id, `batches[${i}].id`),
      batchNo: requireIdentity(endpoint, item.batchNo, `batches[${i}].batchNo`),
      quantity: requireFiniteNumber(endpoint, item.quantity, `batches[${i}].quantity`),
      productionDate: optionalString(endpoint, item.productionDate, `batches[${i}].productionDate`),
      expiryDate: optionalString(endpoint, item.expiryDate, `batches[${i}].expiryDate`),
      inboundId: optionalString(endpoint, item.inboundId, `batches[${i}].inboundId`),
    }
  })
  if (!Array.isArray(raw.stockLogs)) {
    throw new ContractError(endpoint, 'stockLogs 缺失或不是数组')
  }
  const stockLogs = raw.stockLogs.map((l: unknown, i: number) => {
    requireObject(endpoint, l, `stockLogs[${i}]`)
    const item = l as Record<string, unknown>
    return {
      id: requireIdentity(endpoint, item.id, `stockLogs[${i}].id`),
      type: requireIdentity(endpoint, item.type, `stockLogs[${i}].type`),
      quantity: requireFiniteNumber(endpoint, item.quantity, `stockLogs[${i}].quantity`),
      beforeStock: requireFiniteNumber(endpoint, item.beforeStock, `stockLogs[${i}].beforeStock`),
      afterStock: requireFiniteNumber(endpoint, item.afterStock, `stockLogs[${i}].afterStock`),
      relatedId: optionalString(endpoint, item.relatedId, `stockLogs[${i}].relatedId`),
      operator: requireIdentity(endpoint, item.operator, `stockLogs[${i}].operator`),
      createdAt: requireIdentity(endpoint, item.createdAt, `stockLogs[${i}].createdAt`),
    }
  })
  return { ...base, batches, stockLogs }
}

export const categoryApi = {
  getTree: () => request.get<Category[]>('/categories/tree'),
  getList: (params?: PageParams) => request.get<PaginationData<Category>>('/categories', { params }),
  create: (data: Partial<Category>) => request.post('/categories', data),
  update: (id: string, data: Partial<Category>) => request.put(`/categories/${id}`, data),
  delete: (id: string) => request.delete(`/categories/${id}`),
}

export const materialApi = {
  getList: (params?: PageParams & { categoryId?: string; supplierId?: string; status?: string }) =>
    request.get<unknown>('/materials', { params }).then((payload) => parseMaterialListResponse(payload) as PaginationData<Material>),
  getDetail: (id: string) =>
    request.get<unknown>(`/materials/${id}`).then((payload) => parseMaterialDetailResponse(payload) as Material),
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
    request.get<unknown>('/projects', { params }).then((payload) => parseProjectListResponse(payload) as PaginationData<Project>),
  getDetail: (id: string) =>
    request.get<unknown>(`/projects/${id}`).then((payload) => parseProjectDetailResponse(payload) as Project),
  create: (data: Partial<Project>) => request.post('/projects', data),
  update: (id: string, data: Partial<Project>) => request.put(`/projects/${id}`, data),
  delete: (id: string) => request.delete(`/projects/${id}`),
}

export const bomApi = {
  getList: (params?: PageParams & { type?: string; status?: string }) =>
    request.get<unknown>('/boms', { params }).then((payload) => parseBomListResponse(payload) as unknown as PaginationData<BOM>),
  getDetail: (id: string) =>
    request.get<unknown>(`/boms/${id}`).then((payload) => parseBomDetailResponse(payload) as unknown as BOM),
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
