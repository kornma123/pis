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
  permissions: string[]
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
