// ===== 通用类型 =====
export interface ApiResponse<T> {
  success: boolean
  data: T
  message?: string
}

export interface PaginationData<T> {
  list: T[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

export interface PageParams {
  page?: number
  pageSize?: number
  keyword?: string
  sortField?: string
  sortOrder?: 'asc' | 'desc'
}

// ===== 认证类型 =====
export interface User {
  id: string
  username: string
  realName: string
  role: string
  permissions: string[]
  department?: string
  phone?: string
  email?: string
  status: 'active' | 'inactive'
  createdAt: string
}

export interface LoginForm {
  username: string
  password: string
}

export interface LoginResponse {
  token: string
  refreshToken: string
  expiresIn: number
  user: User
}

// ===== 物料分类 =====
export interface Category {
  id: string
  code: string
  name: string
  parentId?: string | null
  level: number
  sortOrder: number
  status: 'active' | 'inactive'
  children?: Category[]
  count?: number
  isLeaf?: boolean
  createdAt: string
  updatedAt: string
}

// ===== 物料 =====
export interface Material {
  id: string
  code: string
  name: string
  spec: string
  unit: string
  specQty?: number
  specUnit?: string
  price: number
  stock: number
  minStock: number
  maxStock: number
  safetyStock: number
  locationId?: string
  locationName?: string
  categoryId: string
  categoryPath?: string
  supplierId?: string
  supplierName?: string
  status: 'active' | 'inactive'
  remark?: string
  batches?: Batch[]
  stockLogs?: StockLog[]
  createdAt: string
  updatedAt: string
}

// ===== 批次 =====
export interface Batch {
  id: string
  materialId: string
  batchNo: string
  quantity: number
  remaining: number
  productionDate?: string
  expiryDate: string
  inboundId: string
  inboundPrice: number
  supplierId?: string
  status: 'normal' | 'used' | 'expired'
  createdAt: string
}

// ===== 供应商 =====
export interface Supplier {
  id: string
  code: string
  name: string
  contact?: string
  phone?: string
  email?: string
  address?: string
  taxNo?: string
  bankName?: string
  bankAccount?: string
  status: 'active' | 'inactive'
  cooperationCount: number
  totalAmount: number
  rating: number
  createdAt: string
  updatedAt: string
}

// ===== 库位 =====
export interface Location {
  id: string
  code: string
  name: string
  type: 'shelf' | 'fridge' | 'cabinet' | 'counter' | 'other'
  parentId?: string | null
  zone: string
  shelf?: string
  position?: string
  capacity: number
  used: number
  status: 'active' | 'inactive'
  createdAt: string
}

// ===== 库存 =====
export interface InventoryItem {
  id: string
  materialId: string
  code: string
  name: string
  spec: string
  unit: string
  stock: number
  minStock: number
  maxStock: number
  availableStock: number
  locationId?: string
  locationName?: string
  supplierId?: string
  supplierName?: string
  status: 'normal' | 'low-stock' | 'warning' | 'expired'
  lastInbound?: string
  lastOutbound?: string
}

export interface InventoryStats {
  totalMaterials: number
  totalStockValue: number
  totalStockCount?: number
  normalCount?: number
  lowStockCount: number
  expiringCount: number
  expiredCount: number
  categoryDistribution: Array<{
    categoryId: string
    categoryName: string
    count: number
  }>
}

// ===== 入库 =====
export type InboundType = 'direct' | 'purchase' | 'return'

export interface InboundRecord {
  id: string
  inboundNo: string
  type: InboundType
  materialId: string
  materialName: string
  batchNo?: string
  quantity: number
  unit: string
  price: number
  amount: number
  supplierId?: string
  supplierName?: string
  locationId: string
  locationName?: string
  productionDate?: string
  expiryDate?: string
  operator: string
  status: 'completed' | 'cancelled'
  remark?: string
  cancelReason?: string
  purchaseOrderId?: string
  purchaseOrderNo?: string
  createdAt: string
}

export interface InboundFormData {
  type: InboundType
  materialId: string
  batchNo?: string
  quantity: number
  price?: number
  supplierId?: string
  locationId: string
  productionDate?: string
  expiryDate?: string
  remark?: string
}

// ===== 出库 =====
export type OutboundType = 'project' | 'transfer' | 'scrap'

export interface OutboundItem {
  id: string
  outboundId: string
  materialId: string
  materialName?: string
  batchId?: string
  batchNo?: string
  quantity: number
  unit: string
  unitCost: number
  totalCost: number
}

export interface OutboundRecord {
  id: string
  outboundNo: string
  type: OutboundType
  projectId?: string
  projectName?: string
  items: OutboundItem[]
  totalCost: number
  operator: string
  approver?: string
  approvedAt?: string
  status: 'completed' | 'cancelled' | 'pending'
  remark?: string
  createdAt: string
}

export interface OutboundFormData {
  type: OutboundType
  projectId?: string
  items: Array<{
    materialId: string
    quantity: number
  }>
  remark?: string
}

// ===== 检测项目 =====
export interface Project {
  id: string
  code: string
  name: string
  type: string
  typeName?: string
  cycle?: string
  bomId?: string
  bomName?: string
  supportableSamples?: number
  status: 'active' | 'inactive'
  manager?: string
  description?: string
  costStats?: {
    totalCost: number
    sampleCount: number
    unitCost: number
  }
  createdAt: string
}

// ===== BOM =====
export interface BOMMaterial {
  id: string
  name: string
  spec: string
  usagePerSample: number
  unit: string
  price: number
  stock: number
  costRatio: number
}

export interface BOMVersion {
  version: string
  updatedAt: string
  changeLog: string
}

export interface BOM {
  id: string
  code: string
  name: string
  version: string
  type: string
  serviceId?: string
  serviceName?: string
  description?: string
  materialCount: number
  supportableSamples?: number
  unitCost: number
  status: 'active' | 'inactive'
  materials: BOMMaterial[]
  versionHistory: BOMVersion[]
  createdAt: string
  updatedAt: string
}

// ===== 库存流水 =====
export interface StockLog {
  id: string
  type: 'inbound' | 'outbound' | 'scrap' | 'adjust'
  materialId: string
  quantity: number
  beforeStock: number
  afterStock: number
  relatedId?: string
  relatedType?: string
  operator: string
  remark?: string
  createdAt: string
}

// ===== 预警 =====
export interface AlertRule {
  id: string
  type: 'low-stock' | 'expiry' | 'stagnant'
  name: string
  threshold?: number
  thresholdDays?: number
  enabled: boolean
}

export interface Alert {
  id: string
  type: 'low-stock' | 'expiry' | 'stagnant'
  level: 'warning' | 'danger' | 'info'
  materialId: string
  materialName: string
  currentStock?: number
  threshold?: number
  message: string
  status: 'pending' | 'processed' | 'ignored'
  createdAt: string
}

// ===== 报表 =====
export interface ProjectCostReport {
  summary: {
    totalCost: number
    projectCost: number
    publicCost: number
    totalSamples: number
  }
  projects: Array<{
    id: string
    name: string
    category: string
    sampleCount: number
    unitCost: number
    totalCost: number
    ratio: number
    changeRate?: number
    changeDirection?: 'up' | 'down'
  }>
}

export interface MaterialCostReport {
  materials: Array<{
    id: string
    name: string
    spec: string
    consumption: number
    consumptionUnit: string
    totalCost: number
    ratio: number
    changeRate?: number
    changeDirection?: 'up' | 'down'
  }>
  trend: Array<{
    date: string
    cost: number
  }>
}

export interface SupplierCostReport {
  suppliers: Array<{
    id: string
    name: string
    amount: number
    // ABC 移植：供应商退货口径扩展字段（毛额/退款额/退货笔数/退货链接），SupplierCostAnalysis 使用
    grossAmount?: number
    refundedAmount?: number
    refundedReturnCount?: number
    supplierReturnUrl?: string
    ratio: number
    orderCount: number
    status: string
  }>
}

// ===== 系统管理 =====
export interface Role {
  id: string
  code: string
  name: string
  description?: string
  // 数据驱动 RBAC：对象矩阵 {module:'R'|'W'}（兼容旧扁平数组）
  permissions: string[] | Record<string, 'R' | 'W'>
  status: 'active' | 'inactive'
  createdAt: string
}

export interface OperationLog {
  id: string
  userId: string
  username: string
  operation: string
  description: string
  requestData?: Record<string, unknown>
  responseData?: Record<string, unknown>
  ip: string
  userAgent?: string
  createdAt: string
}

// ===== 退货给供应商 =====
export interface SupplierReturnRecord {
  id: string
  returnNo: string
  materialId: string
  materialName?: string
  batchId?: string
  batchNo?: string
  quantity: number
  supplierId?: string
  supplierName?: string
  purchaseOrderId?: string
  purchaseOrderNo?: string
  inboundRecordId?: string
  inboundNo?: string
  reason: string
  refundAmount?: number
  trackingNo?: string
  status: 'pending' | 'shipped' | 'received' | 'refunded' | 'cancelled'
  operator: string
  remark?: string
  createdAt: string
  updatedAt: string
}

export interface SupplierReturnFormData {
  materialId: string
  quantity: number
  supplierId?: string
  purchaseOrderId?: string
  inboundRecordId?: string
  reason: string
  refundAmount?: number
  trackingNo?: string
  remark?: string
  operator?: string
}

// ===== 退库 =====
export interface ReturnRecord {
  id: string
  returnNo: string
  materialId: string
  materialName?: string
  batchId?: string
  quantity: number
  reason: string
  operator: string
  status: string
  remark?: string
  createdAt: string
}

// ===== 报废 =====
export interface ScrapRecord {
  id: string
  scrapNo: string
  materialId: string
  materialName?: string
  batchId?: string
  quantity: number
  reason: string
  operator: string
  status: string
  remark?: string
  createdAt: string
}

// ===== 调拨 =====
export interface TransferRecord {
  id: string
  inboundNo: string
  materialId: string
  materialName?: string
  batchNo?: string
  quantity: number
  fromLocationId?: string
  fromLocationName?: string
  toLocationId: string
  toLocationName?: string
  operator: string
  status: string
  remark?: string
  createdAt: string
}

// ===== 采购订单 =====
export interface PurchaseOrder {
  id: string
  orderNo: string
  materialId: string
  materialName: string
  supplierId?: string
  supplierName?: string
  orderedQty: number
  receivedQty: number
  remainingQty: number
  unit: string
  unitPrice: number
  totalAmount: number
  expectedDate?: string
  status: 'pending' | 'partial' | 'completed' | 'cancelled'
  remark?: string
  createdAt: string
  updatedAt: string
}

// ===== ABC 成本核算（移植自 abc-productization 分支） =====

// ===== 标准工时 =====
export interface StandardLaborTime {
  id: string
  stepCode: string
  stepName: string
  projectType: string
  standardMinutes: number
  laborRatePerMinute: number
  isEquipmentStep: boolean
  description?: string
  sortOrder: number
  referenceSource?: 'supplier' | 'industry' | 'system'
  referenceSourceLabel?: string
  createdAt: string
  updatedAt: string
}

// ===== 间接成本中心 =====
export interface IndirectCostCenter {
  id: string
  code: string
  name: string
  costType: string
  costTypeLabel?: string
  monthlyAmount: number
  allocationBase: string
  description?: string
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
}

export interface IndirectCostAllocation {
  id: string
  costCenterId: string
  yearMonth: string
  totalAmount: number
  allocationBaseValue: number
  allocationRate: number
  createdAt: string
}

// ===== 设备类型 =====
export interface EquipmentType {
  id: string
  code: string
  name: string
  description?: string
  defaultPurchasePrice?: number
  defaultDepreciableLifeYears?: number
  defaultValue?: number
  defaultDepreciationMethod?: string
  defaultTotalCapacity?: number
  defaultCapacityUnit?: string
  status: 'active' | 'inactive'
  equipmentCount?: number
  isDeleted?: boolean
  createdAt: string
  updatedAt: string
}

// ===== 设备 =====
export interface Equipment {
  id: string
  code: string
  name: string
  model?: string
  manufacturer?: string
  purchasePrice: number
  purchaseDate?: string
  depreciableLifeYears: number
  residualValue: number
  depreciationMethod: 'straight_line' | 'units_of_production'
  totalCapacity?: number
  capacityUnit?: string
  status: 'active' | 'inactive' | 'scrapped'
  locationId?: string
  typeId?: string | null
  typeName?: string | null
  annualDepreciation?: number
  accumulatedDepreciation?: number
  netBookValue?: number
  isDeleted?: boolean
  createdAt: string
  updatedAt: string
}

// ===== 设备折旧统计 =====
export interface DepreciationStat {
  typeId: string
  typeCode: string
  typeName: string
  equipmentCount: number
  totalPurchasePrice: number
  totalAnnualDepreciation: number
  totalMonthlyDepreciation: number
}

// ===== 季度成本调整 =====
export interface CostAdjustment {
  id: string
  costCenterId: string
  costCenterName?: string
  yearQuarter: string
  preProvisionAmount: number
  actualAmount: number
  adjustmentAmount: number
  adjustmentReason?: string
  adjustedBy?: string
  adjustedAt?: string
  submittedByName?: string
  reviewStatus: 'pending' | 'approved' | 'rejected'
  reviewedBy?: string
  reviewedAt?: string
  reviewReason?: string
}

// ===== BOM 成本预览 =====
export interface CostPreview {
  bomId: string
  bomName: string
  totalCost: number
  breakdown: {
    materialCost: { amount: number; percentage: number }
    laborCost: { amount: number; percentage: number }
    equipmentCost: { amount: number; percentage: number }
    indirectCost: { amount: number; percentage: number }
  }
}

export interface EquipmentUsage {
  id: string
  equipmentId: string
  projectId?: string
  outboundId?: string
  usageMinutes: number
  usageCount: number
  depreciationCost: number
  operator?: string
  usageDate?: string
  createdAt: string
}

// ===== LOC-013 活响应合同运行时守卫 =====
// 与上方接口对应的运行时边界：live 响应必须先过这些守卫再发布给消费者。
// 铁律：unknown / null / malformed / unsafe / contradictory 绝不折为 0 / [] / 空成功；
// 合法 0 与合法空数组保真；null 保持 null（诚实未知），不得改写为 0。

export class ContractError extends Error {
  readonly endpoint: string

  constructor(endpoint: string, reason: string) {
    // 消息只含字段路径与规则，绝不内插响应原始值（防敏感值借诊断泄漏）
    super(`${endpoint} 响应合同校验失败：${reason}`)
    this.name = 'ContractError'
    this.endpoint = endpoint
  }
}

export function requireObject(endpoint: string, value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(endpoint, `${field} 应为对象`)
  }
}

/** 非空字符串（身份字段：id/code/name 等，缺失即身份断裂，拒绝） */
export function requireIdentity(endpoint: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContractError(endpoint, `${field} 缺失或不是非空字符串`)
  }
  return value
}

/** 字符串（允许空串，但类型必须是 string） */
export function requireString(endpoint: string, value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ContractError(endpoint, `${field} 不是字符串`)
  }
  return value
}

/** 可空字符串：null/undefined → null（未知保真），其他非字符串拒绝 */
export function optionalString(endpoint: string, value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new ContractError(endpoint, `${field} 不是字符串`)
  }
  return value
}

/** 必需有限数：拒绝 null/undefined/NaN/Infinity/非 number；合法 0 通过 */
export function requireFiniteNumber(
  endpoint: string,
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; int?: boolean } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractError(endpoint, `${field} 不是有限数`)
  }
  if (opts.int && !Number.isInteger(value)) {
    throw new ContractError(endpoint, `${field} 不是整数`)
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ContractError(endpoint, `${field} 低于下界`)
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ContractError(endpoint, `${field} 高于上界`)
  }
  return value
}

/** 可空有限数：null → null（未知保真，绝不折 0），其余同 requireFiniteNumber */
export function nullableFiniteNumber(
  endpoint: string,
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; int?: boolean } = {},
): number | null {
  if (value === null) return null
  return requireFiniteNumber(endpoint, value, field, opts)
}

export function requireStatus(endpoint: string, value: unknown, field: string): 'active' | 'inactive' {
  if (value !== 'active' && value !== 'inactive') {
    throw new ContractError(endpoint, `${field} 非法枚举值`)
  }
  return value
}

export interface ListPagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/**
 * successList 信封（后端 utils/response.ts 合同）：data 恒含扁平
 * page/pageSize/total/totalPages 与嵌套 pagination，二者必须一致；
 * totalPages 必须等于 ceil(total/pageSize)；total 不得小于已见行数。
 */
export function requireListEnvelope(
  endpoint: string,
  payload: unknown,
): { list: Record<string, unknown>[]; pagination: ListPagination } {
  requireObject(endpoint, payload, 'data')
  const raw = payload as Record<string, unknown>
  if (!Array.isArray(raw.list)) {
    throw new ContractError(endpoint, 'list 缺失或不是数组')
  }
  const p = raw.pagination
  requireObject(endpoint, p, 'pagination')
  const pagination: ListPagination = {
    page: requireFiniteNumber(endpoint, p.page, 'pagination.page', { min: 1, int: true }),
    pageSize: requireFiniteNumber(endpoint, p.pageSize, 'pagination.pageSize', { min: 1, int: true }),
    total: requireFiniteNumber(endpoint, p.total, 'pagination.total', { min: 0, int: true }),
    totalPages: requireFiniteNumber(endpoint, p.totalPages, 'pagination.totalPages', { min: 0, int: true }),
  }
  for (const key of ['page', 'pageSize', 'total', 'totalPages'] as const) {
    if (raw[key] !== pagination[key]) {
      throw new ContractError(endpoint, `扁平 ${key} 与 pagination.${key} 矛盾`)
    }
  }
  if (pagination.totalPages !== Math.ceil(pagination.total / pagination.pageSize)) {
    throw new ContractError(endpoint, 'totalPages 与 total/pageSize 矛盾')
  }
  if (pagination.total < (pagination.page - 1) * pagination.pageSize + raw.list.length) {
    throw new ContractError(endpoint, 'total 小于当前已见行数')
  }
  return { list: raw.list as Record<string, unknown>[], pagination }
}

// ----- BOM / ABC bom-links 活合同类型（与后端 bom-v1.1.ts、abc-v1.1.ts 对齐） -----

export interface BomListItem {
  id: string
  code: string
  name: string
  version: string
  type: string
  serviceId: string | null
  materialCount: number
  supportableSamples: number | null
  unitCost: number | null
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
}

export interface BomDetailMaterial {
  id: string
  name: string
  spec: string | null
  usagePerSample: number
  unit: string | null
  price: number
  stock: number | null
  costRatio: number
}

export interface BomDetail {
  id: string
  code: string
  name: string
  version: string
  type: string
  serviceId: string | null
  supportableSamples: number | null
  unitCost: number | null
  status: 'active' | 'inactive'
  materials: BomDetailMaterial[]
  versionHistory: BOMVersion[]
}

export interface BomActivityLink {
  id: string
  bomId: string
  activityCenterId: string
  activityCenterName: string | null
  activityCenterCode: string | null
  quantity: number
  unit: string | null
  sortOrder: number
}
