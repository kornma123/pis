/**
 * Issue71 — 非 ABC 的 BOM / project / material master-data 响应真值解析。
 *
 * 规则（对应 Issue71 验收）：
 * - 每个 endpoint 使用独立 parser，禁止一个宽松 parser 假设所有响应同形；
 * - missing identity / null / malformed / unsafe / 矛盾字段 fail-closed；
 * - 合法显式 0 与合法空集合保真；
 * - 解析失败的错误不携带任何响应原文，避免敏感值进入 UI / 日志。
 *
 * 形状以 后端代码/server/src/routes/{materials,projects-v1.1,bom-v1.1}.ts
 * 的 live contract 为准（2026-08-05，origin/master=d89323d3）。
 */

export interface PaginationInfo {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface MaterialListRow {
  id: string
  code: string
  name: string
  spec: string | null
  unit: string
  specQty: number | null
  specUnit: string | null
  price: number
  stock: number
  minStock: number
  maxStock: number
  safetyStock: number
  locationId: string | null
  locationName: string | null
  categoryId: string
  categoryPath: string | null
  supplierId: string | null
  supplierName: string | null
  status: 'active' | 'inactive'
  remark: string | null
  createdAt: string
  updatedAt: string
}

export interface MaterialBatchRow {
  id: string
  batchNo: string | null
  quantity: number
  productionDate: string | null
  expiryDate: string | null
  inboundId: string | null
}

export interface MaterialStockLogRow {
  id: string
  type: string
  quantity: number
  beforeStock: number
  afterStock: number
  relatedId: string | null
  operator: string | null
  createdAt: string
}

export interface MaterialDetail extends MaterialListRow {
  batches: MaterialBatchRow[]
  stockLogs: MaterialStockLogRow[]
}

export interface ProjectListRow {
  id: string
  code: string
  name: string
  type: string
  typeName: string | null
  cycle: string | null
  bomId: string | null
  bomName: string | null
  supportableSamples: number | null
  status: 'active' | 'inactive'
  manager: string | null
  description: string | null
  createdAt: string
}

export interface ProjectDetail extends ProjectListRow {
  costStats: {
    totalCost: number
    sampleCount: number
    unitCost: number
  }
}

export interface BomListRow {
  id: string
  code: string
  name: string
  version: string
  type: string
  serviceId: string | null
  serviceName: string | null
  description: string | null
  materialCount: number
  supportableSamples: number | null
  unitCost: number | null
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
}

export interface BomMaterialRow {
  id: string
  code: string | null
  name: string | null
  spec: string | null
  usagePerSample: number
  unit: string | null
  price: number | null
  stock: number
  costRatio: number
}

export interface BomVersionRow {
  version: string
  updatedAt: string
  changeLog: string | null
}

export interface BomDetail {
  id: string
  code: string
  name: string
  version: string
  type: string
  serviceId: string | null
  serviceName: string | null
  description: string | null
  materialCount: number
  supportableSamples: number | null
  unitCost: number | null
  status: 'active' | 'inactive'
  materials: BomMaterialRow[]
  versionHistory: BomVersionRow[]
  createdAt: string | null
  updatedAt: string | null
}

export class MasterDataParseError extends Error {
  constructor(endpoint: string) {
    super(`服务器响应数据格式异常（${endpoint}）`)
    this.name = 'MasterDataParseError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function fail(endpoint: string): never {
  throw new MasterDataParseError(endpoint)
}

function requiredString(endpoint: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(endpoint)
  return value
}

function nullableString(endpoint: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail(endpoint)
  return value
}

function nullableKey(endpoint: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0) fail(endpoint)
  return value
}

function requiredNonNegativeNumber(endpoint: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(endpoint)
  return value
}

function nullableNonNegativeNumber(endpoint: string, value: unknown): number | null {
  if (value === undefined || value === null) return null
  return requiredNonNegativeNumber(endpoint, value)
}

function requiredNonNegativeInteger(endpoint: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(endpoint)
  return value as number
}

function nullableNonNegativeInteger(endpoint: string, value: unknown): number | null {
  if (value === undefined || value === null) return null
  return requiredNonNegativeInteger(endpoint, value)
}

function statusValue(endpoint: string, value: unknown): 'active' | 'inactive' {
  if (value !== 'active' && value !== 'inactive') fail(endpoint)
  return value
}

function parsePagination(endpoint: string, value: unknown): PaginationInfo {
  if (!isRecord(value)) fail(endpoint)
  const page = requiredNonNegativeInteger(endpoint, value.page)
  const pageSize = requiredNonNegativeInteger(endpoint, value.pageSize)
  const total = requiredNonNegativeInteger(endpoint, value.total)
  const totalPages = requiredNonNegativeInteger(endpoint, value.totalPages)
  if (page < 1 || pageSize < 1) fail(endpoint)
  if (totalPages !== Math.ceil(total / pageSize)) fail(endpoint)
  return { page, pageSize, total, totalPages }
}

function parseListPage<T>(
  endpoint: string,
  payload: unknown,
  parseRow: (endpoint: string, value: unknown) => T
): { list: T[]; pagination: PaginationInfo } {
  if (!isRecord(payload)) fail(endpoint)
  const { list, pagination } = payload
  if (!Array.isArray(list)) fail(endpoint)
  const rows = list.map((row) => parseRow(endpoint, row))
  const page = parsePagination(endpoint, pagination)
  if (page.total < rows.length) fail(endpoint)
  return { list: rows, pagination: page }
}

function parseMaterialListRow(endpoint: string, value: unknown): MaterialListRow {
  if (!isRecord(value)) fail(endpoint)
  return {
    id: requiredString(endpoint, value.id),
    code: requiredString(endpoint, value.code),
    name: requiredString(endpoint, value.name),
    spec: nullableString(endpoint, value.spec),
    unit: requiredString(endpoint, value.unit),
    specQty: nullableNonNegativeNumber(endpoint, value.specQty),
    specUnit: nullableString(endpoint, value.specUnit),
    price: requiredNonNegativeNumber(endpoint, value.price),
    stock: requiredNonNegativeNumber(endpoint, value.stock),
    minStock: requiredNonNegativeNumber(endpoint, value.minStock),
    maxStock: requiredNonNegativeNumber(endpoint, value.maxStock),
    safetyStock: requiredNonNegativeNumber(endpoint, value.safetyStock),
    locationId: nullableString(endpoint, value.locationId),
    locationName: nullableString(endpoint, value.locationName),
    categoryId: requiredString(endpoint, value.categoryId),
    categoryPath: nullableString(endpoint, value.categoryPath),
    supplierId: nullableString(endpoint, value.supplierId),
    supplierName: nullableString(endpoint, value.supplierName),
    status: statusValue(endpoint, value.status),
    remark: nullableString(endpoint, value.remark),
    createdAt: requiredString(endpoint, value.createdAt),
    updatedAt: requiredString(endpoint, value.updatedAt),
  }
}

function parseMaterialBatchRow(endpoint: string, value: unknown): MaterialBatchRow {
  if (!isRecord(value)) fail(endpoint)
  return {
    id: requiredString(endpoint, value.id),
    // live contract：materials detail 的 batches 来自 `SELECT *`，字段为 snake_case
    batchNo: nullableString(endpoint, value.batch_no),
    quantity: requiredNonNegativeNumber(endpoint, value.quantity),
    productionDate: nullableString(endpoint, value.production_date),
    expiryDate: nullableString(endpoint, value.expiry_date),
    inboundId: nullableString(endpoint, value.inbound_id),
  }
}

function parseMaterialStockLogRow(endpoint: string, value: unknown): MaterialStockLogRow {
  if (!isRecord(value)) fail(endpoint)
  return {
    id: requiredString(endpoint, value.id),
    type: requiredString(endpoint, value.type),
    quantity: requiredNonNegativeNumber(endpoint, value.quantity),
    beforeStock: requiredNonNegativeNumber(endpoint, value.beforeStock),
    afterStock: requiredNonNegativeNumber(endpoint, value.afterStock),
    relatedId: nullableString(endpoint, value.relatedId),
    operator: nullableString(endpoint, value.operator),
    createdAt: requiredString(endpoint, value.createdAt),
  }
}

function parseProjectListRow(endpoint: string, value: unknown): ProjectListRow {
  if (!isRecord(value)) fail(endpoint)
  return {
    id: requiredString(endpoint, value.id),
    code: requiredString(endpoint, value.code),
    name: requiredString(endpoint, value.name),
    type: requiredString(endpoint, value.type),
    typeName: nullableString(endpoint, value.typeName),
    cycle: nullableString(endpoint, value.cycle),
    bomId: nullableKey(endpoint, value.bomId),
    bomName: nullableString(endpoint, value.bomName),
    supportableSamples: nullableNonNegativeInteger(endpoint, value.supportableSamples),
    status: statusValue(endpoint, value.status),
    manager: nullableString(endpoint, value.manager),
    description: nullableString(endpoint, value.description),
    createdAt: requiredString(endpoint, value.createdAt),
  }
}

function parseBomListRow(endpoint: string, value: unknown): BomListRow {
  if (!isRecord(value)) fail(endpoint)
  return {
    id: requiredString(endpoint, value.id),
    code: requiredString(endpoint, value.code),
    name: requiredString(endpoint, value.name),
    version: requiredString(endpoint, value.version),
    type: requiredString(endpoint, value.type),
    serviceId: nullableString(endpoint, value.serviceId),
    serviceName: nullableString(endpoint, value.serviceName),
    description: nullableString(endpoint, value.description),
    materialCount: requiredNonNegativeInteger(endpoint, value.materialCount),
    supportableSamples: nullableNonNegativeInteger(endpoint, value.supportableSamples),
    unitCost: nullableNonNegativeNumber(endpoint, value.unitCost),
    status: statusValue(endpoint, value.status),
    createdAt: requiredString(endpoint, value.createdAt),
    updatedAt: requiredString(endpoint, value.updatedAt),
  }
}

function parseBomMaterialRow(endpoint: string, value: unknown): BomMaterialRow {
  if (!isRecord(value)) fail(endpoint)
  return {
    id: requiredString(endpoint, value.id),
    code: nullableString(endpoint, value.code),
    name: nullableString(endpoint, value.name),
    spec: nullableString(endpoint, value.spec),
    usagePerSample: requiredNonNegativeNumber(endpoint, value.usagePerSample),
    unit: nullableString(endpoint, value.unit),
    price: nullableNonNegativeNumber(endpoint, value.price),
    stock: requiredNonNegativeNumber(endpoint, value.stock),
    costRatio: requiredNonNegativeNumber(endpoint, value.costRatio),
  }
}

function parseBomVersionRow(endpoint: string, value: unknown): BomVersionRow {
  if (!isRecord(value)) fail(endpoint)
  return {
    version: requiredString(endpoint, value.version),
    updatedAt: requiredString(endpoint, value.updatedAt),
    changeLog: nullableString(endpoint, value.changeLog),
  }
}

export function parseMaterialListResponse(payload: unknown): {
  list: MaterialListRow[]
  pagination: PaginationInfo
} {
  return parseListPage('materialList', payload, parseMaterialListRow)
}

export function parseMaterialDetailResponse(payload: unknown): MaterialDetail {
  if (!isRecord(payload)) fail('materialDetail')
  const base = parseMaterialListRow('materialDetail', payload)
  const batches = payload.batches
  if (!Array.isArray(batches)) fail('materialDetail')
  const stockLogs = payload.stockLogs
  if (!Array.isArray(stockLogs)) fail('materialDetail')
  return {
    ...base,
    batches: batches.map((row) => parseMaterialBatchRow('materialDetail', row)),
    stockLogs: stockLogs.map((row) => parseMaterialStockLogRow('materialDetail', row)),
  }
}

export function parseProjectListResponse(payload: unknown): {
  list: ProjectListRow[]
  pagination: PaginationInfo
} {
  return parseListPage('projectList', payload, parseProjectListRow)
}

export function parseProjectDetailResponse(payload: unknown): ProjectDetail {
  if (!isRecord(payload)) fail('projectDetail')
  const base = parseProjectListRow('projectDetail', payload)
  if (!isRecord(payload.costStats)) fail('projectDetail')
  return {
    ...base,
    costStats: {
      totalCost: requiredNonNegativeNumber('projectDetail', payload.costStats.totalCost),
      sampleCount: requiredNonNegativeNumber('projectDetail', payload.costStats.sampleCount),
      unitCost: requiredNonNegativeNumber('projectDetail', payload.costStats.unitCost),
    },
  }
}

export function parseBomListResponse(payload: unknown): {
  list: BomListRow[]
  pagination: PaginationInfo
} {
  return parseListPage('bomList', payload, parseBomListRow)
}

export function parseBomDetailResponse(payload: unknown): BomDetail {
  if (!isRecord(payload)) fail('bomDetail')
  const materials = payload.materials
  if (!Array.isArray(materials)) fail('bomDetail')
  const versionHistory = payload.versionHistory
  if (!Array.isArray(versionHistory)) fail('bomDetail')
  const parsedMaterials = materials.map((row) => parseBomMaterialRow('bomDetail', row))
  return {
    id: requiredString('bomDetail', payload.id),
    code: requiredString('bomDetail', payload.code),
    name: requiredString('bomDetail', payload.name),
    version: requiredString('bomDetail', payload.version),
    type: requiredString('bomDetail', payload.type),
    serviceId: nullableString('bomDetail', payload.serviceId),
    serviceName: nullableString('bomDetail', payload.serviceName),
    description: nullableString('bomDetail', payload.description),
    // live contract：bom detail 不含 materialCount，由实际 materials 数组长度派生（真值，非未知折 0）
    materialCount: parsedMaterials.length,
    supportableSamples: nullableNonNegativeInteger('bomDetail', payload.supportableSamples),
    unitCost: nullableNonNegativeNumber('bomDetail', payload.unitCost),
    status: statusValue('bomDetail', payload.status),
    materials: parsedMaterials,
    versionHistory: versionHistory.map((row) => parseBomVersionRow('bomDetail', row)),
    createdAt: nullableString('bomDetail', payload.createdAt),
    updatedAt: nullableString('bomDetail', payload.updatedAt),
  }
}

export function parseNextCodeResponse(payload: unknown): { code: string } {
  if (!isRecord(payload)) fail('materialNextCode')
  return { code: requiredString('materialNextCode', payload.code) }
}
