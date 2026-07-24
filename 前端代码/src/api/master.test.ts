import { describe, it, expect, vi, beforeEach } from 'vitest'

// LOC-013：response→parser 边界行为测试。request 传输层被 mock，
// 测试对象 = master.ts 内各 endpoint 专属 exact parser 的真实行为。
vi.mock('./request', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

import request from './request'
import { bomApi, projectApi, materialApi } from './master'

const mockGet = vi.mocked(request.get)

beforeEach(() => {
  vi.clearAllMocks()
})

/** 合同校验失败必须拒绝（fail-closed），且绝不静默折 0/空/放行。 */
async function expectContractRejection(p: Promise<unknown>) {
  await expect(p).rejects.toThrow(/合同校验失败/)
}

function listEnvelope(list: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    list,
    page: 1,
    pageSize: 20,
    total: list.length,
    totalPages: 1,
    pagination: { page: 1, pageSize: 20, total: list.length, totalPages: 1 },
    ...overrides,
  }
}

function bomListItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bom-1',
    code: 'BOM-001',
    name: 'PD-L1 检测',
    version: 'v1.0',
    type: 'IHC',
    serviceId: null,
    materialCount: 3,
    supportableSamples: null,
    unitCost: 12.5,
    status: 'active',
    createdAt: '2026-07-01 00:00:00',
    updatedAt: '2026-07-02 00:00:00',
    ...overrides,
  }
}

function bomDetailPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bom-1',
    code: 'BOM-001',
    name: 'PD-L1 检测',
    version: 'v1.0',
    type: 'IHC',
    serviceId: null,
    supportableSamples: null,
    unitCost: 12.5,
    status: 'active',
    materials: [
      { id: 'mat-1', name: '抗体A', spec: '1ml', usagePerSample: 5, unit: 'ml', price: 2, stock: 100, costRatio: 1 },
    ],
    versionHistory: [{ version: 'v1.0', updatedAt: '2026-07-02 00:00:00', changeLog: 'Current' }],
    ...overrides,
  }
}

function projectListItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    code: 'P-001',
    name: 'PD-L1',
    type: 'IHC',
    cycle: '3天',
    bomId: 'bom-1',
    supportableSamples: null,
    status: 'active',
    manager: '张三',
    description: null,
    createdAt: '2026-07-01 00:00:00',
    ...overrides,
  }
}

function projectDetailPayload(overrides: Record<string, unknown> = {}) {
  return {
    ...projectListItem(),
    costStats: { totalCost: 0, sampleCount: 0, unitCost: 0 },
    ...overrides,
  }
}

function materialListItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mat-1',
    code: 'REA-001',
    name: '抗体A',
    spec: '1ml',
    unit: '瓶',
    specQty: null,
    specUnit: null,
    price: 9.9,
    stock: 5,
    minStock: 0,
    maxStock: 100,
    safetyStock: 10,
    locationId: null,
    locationName: null,
    categoryId: 'cat-1',
    categoryPath: '试剂',
    supplierId: null,
    supplierName: null,
    status: 'active',
    remark: null,
    createdAt: '2026-07-01 00:00:00',
    updatedAt: '2026-07-02 00:00:00',
    ...overrides,
  }
}

function materialDetailPayload(overrides: Record<string, unknown> = {}) {
  return {
    ...materialListItem(),
    batches: [
      { id: 'batch-1', batchNo: 'B20260701', quantity: 3, productionDate: null, expiryDate: '2027-07-01', inboundId: 'in-1' },
    ],
    stockLogs: [
      { id: 'log-1', type: 'inbound', quantity: 3, beforeStock: 2, afterStock: 5, relatedId: 'in-1', operator: 'admin', createdAt: '2026-07-01 00:00:00' },
    ],
    ...overrides,
  }
}

describe('bomApi.getList — BOM list 专属 exact parser', () => {
  it('合法响应原样发布：unitCost=0、materialCount=0 保真，unitCost=null、supportableSamples=null 保持 null 不折 0', async () => {
    mockGet.mockResolvedValue(listEnvelope([
      bomListItem({ unitCost: 0, materialCount: 0, supportableSamples: null }),
      bomListItem({ id: 'bom-2', unitCost: null }),
    ]))
    const res: any = await bomApi.getList({ pageSize: 200 })
    expect(res.list).toHaveLength(2)
    expect(res.list[0].unitCost).toBe(0)
    expect(res.list[0].materialCount).toBe(0)
    expect(res.list[0].supportableSamples).toBeNull()
    // unknown≠0：成本未知(null)绝不折成 0——0 是合法成本，null 是「没有数据」
    expect(res.list[1].unitCost).toBeNull()
    expect(res.pagination.total).toBe(2)
  })

  it('list 端点收到 detail 形状 → 拒绝（形状不得互换套用）', async () => {
    mockGet.mockResolvedValue(bomDetailPayload())
    await expectContractRejection(bomApi.getList())
  })

  it.each([
    ['unitCost 为字符串', { unitCost: '12.5' }],
    ['unitCost 为 NaN', { unitCost: NaN }],
    ['unitCost 为 Infinity', { unitCost: Infinity }],
    ['unitCost 为布尔', { unitCost: false }],
    ['materialCount 为小数', { materialCount: 1.5 }],
    ['materialCount 为负整数', { materialCount: -1 }],
    ['materialCount 为字符串', { materialCount: '3' }],
    ['supportableSamples 为字符串', { supportableSamples: '30' }],
    ['id 缺失', { id: undefined }],
    ['id 为空串', { id: '' }],
    ['id 为数字', { id: 123 }],
    ['name 为 null', { name: null }],
    ['status 为非法枚举', { status: 'deleted' }],
  ])('list 项字段畸形（%s）→ 拒绝，绝不折 0 或放行', async (_label, patch) => {
    mockGet.mockResolvedValue(listEnvelope([bomListItem(patch)]))
    await expectContractRejection(bomApi.getList())
  })

  it('扁平 total 与 pagination.total 矛盾 → 拒绝', async () => {
    mockGet.mockResolvedValue({ ...listEnvelope([bomListItem()]), total: 5 })
    await expectContractRejection(bomApi.getList())
  })

  it('total 小于当前已见行数 → 拒绝（矛盾计数）', async () => {
    mockGet.mockResolvedValue(
      listEnvelope([bomListItem(), bomListItem({ id: 'bom-2' }), bomListItem({ id: 'bom-3' })], {
        total: 2,
        pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
      }),
    )
    await expectContractRejection(bomApi.getList())
  })

  it('totalPages 与 total/pageSize 矛盾 → 拒绝', async () => {
    mockGet.mockResolvedValue(
      listEnvelope([bomListItem()], {
        totalPages: 9,
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 9 },
      }),
    )
    await expectContractRejection(bomApi.getList())
  })

  it('pagination.pageSize 为 0 → 拒绝', async () => {
    mockGet.mockResolvedValue(
      listEnvelope([bomListItem()], {
        pageSize: 0,
        pagination: { page: 1, pageSize: 0, total: 1, totalPages: 1 },
      }),
    )
    await expectContractRejection(bomApi.getList())
  })
})

describe('bomApi.getDetail — BOM detail 专属 exact parser', () => {
  it('合法 detail 原样发布：price=0 免费物料保真', async () => {
    mockGet.mockResolvedValue(bomDetailPayload({
      materials: [{ id: 'mat-1', name: '抗体A', spec: '1ml', usagePerSample: 5, unit: 'ml', price: 0, stock: 100, costRatio: 1 }],
    }))
    const res: any = await bomApi.getDetail('bom-1')
    expect(res.id).toBe('bom-1')
    expect(res.materials[0].price).toBe(0)
    expect(res.versionHistory).toHaveLength(1)
  })

  it('detail 端点收到 list 信封形状 → 拒绝（形状不得互换套用）', async () => {
    mockGet.mockResolvedValue(listEnvelope([bomListItem()]))
    await expectContractRejection(bomApi.getDetail('bom-1'))
  })

  it.each([
    ['materials 缺失', { materials: undefined }],
    ['materials 非数组', { materials: {} }],
    ['versionHistory 为空数组', { versionHistory: [] }],
    ['versionHistory 缺失', { versionHistory: undefined }],
    ['unitCost 为字符串', { unitCost: '12.5' }],
  ])('detail 字段畸形（%s）→ 拒绝', async (_label, patch) => {
    mockGet.mockResolvedValue(bomDetailPayload(patch))
    await expectContractRejection(bomApi.getDetail('bom-1'))
  })

  it.each([
    ['物料 name 为 null（身份断裂）', { name: null }],
    ['物料 price 为 null（成本不可知）', { price: null }],
    ['物料 price 为字符串', { price: '2' }],
    ['物料 usagePerSample 为负', { usagePerSample: -1 }],
    ['物料 usagePerSample 为 NaN', { usagePerSample: NaN }],
    ['物料 costRatio 大于 1（矛盾）', { costRatio: 1.5 }],
    ['物料 id 缺失', { id: undefined }],
  ])('detail 物料畸形（%s）→ 拒绝', async (_label, patch) => {
    mockGet.mockResolvedValue(bomDetailPayload({
      materials: [{ id: 'mat-1', name: '抗体A', spec: '1ml', usagePerSample: 5, unit: 'ml', price: 2, stock: 100, costRatio: 1, ...patch }],
    }))
    await expectContractRejection(bomApi.getDetail('bom-1'))
  })
})

describe('projectApi — 项目响应身份与数值字段校验', () => {
  it('getList 合法响应：supportableSamples=null 保真不折 0，合法 0 保真', async () => {
    mockGet.mockResolvedValue(listEnvelope([projectListItem({ supportableSamples: null }), projectListItem({ id: 'proj-2', supportableSamples: 0 })]))
    const res: any = await projectApi.getList()
    expect(res.list[0].supportableSamples).toBeNull()
    expect(res.list[1].supportableSamples).toBe(0)
  })

  it.each([
    ['supportableSamples 为字符串', { supportableSamples: '30' }],
    ['supportableSamples 为 NaN', { supportableSamples: NaN }],
    ['id 缺失', { id: undefined }],
    ['code 为空串', { code: '' }],
  ])('getList 项畸形（%s）→ 拒绝', async (_label, patch) => {
    mockGet.mockResolvedValue(listEnvelope([projectListItem(patch)]))
    await expectContractRejection(projectApi.getList())
  })

  it('getDetail 合法零值 costStats 放行（无样本=合法 0）', async () => {
    mockGet.mockResolvedValue(projectDetailPayload())
    const res: any = await projectApi.getDetail('proj-1')
    expect(res.costStats).toEqual({ totalCost: 0, sampleCount: 0, unitCost: 0 })
  })

  it('getDetail 收到 list 信封 → 拒绝', async () => {
    mockGet.mockResolvedValue(listEnvelope([projectListItem()]))
    await expectContractRejection(projectApi.getDetail('proj-1'))
  })

  it.each([
    ['costStats 缺失', { costStats: undefined }],
    ['totalCost 为 NaN', { costStats: { totalCost: NaN, sampleCount: 0, unitCost: 0 } }],
    ['sampleCount 为小数', { costStats: { totalCost: 0, sampleCount: 1.5, unitCost: 0 } }],
    ['无样本却有成本（矛盾）', { costStats: { totalCost: 100, sampleCount: 0, unitCost: 0 } }],
    ['unitCost 与 totalCost/sampleCount 矛盾', { costStats: { totalCost: 100, sampleCount: 2, unitCost: 30 } }],
  ])('getDetail costStats 畸形（%s）→ 拒绝', async (_label, patch) => {
    mockGet.mockResolvedValue(projectDetailPayload(patch))
    await expectContractRejection(projectApi.getDetail('proj-1'))
  })
})

describe('materialApi — 物料响应身份与数值字段校验', () => {
  it('getList 合法响应：price=0 保真，price=null 保持 null 不折 0', async () => {
    mockGet.mockResolvedValue(listEnvelope([materialListItem({ price: 0 }), materialListItem({ id: 'mat-2', price: null })]))
    const res: any = await materialApi.getList()
    expect(res.list[0].price).toBe(0)
    expect(res.list[1].price).toBeNull()
  })

  it.each([
    ['price 为字符串', { price: '9.9' }],
    ['price 为 NaN', { price: NaN }],
    ['stock 为 Infinity', { stock: Infinity }],
    ['stock 为字符串', { stock: '5' }],
    ['id 缺失', { id: undefined }],
    ['name 为 null', { name: null }],
  ])('getList 项畸形（%s）→ 拒绝', async (_label, patch) => {
    mockGet.mockResolvedValue(listEnvelope([materialListItem(patch)]))
    await expectContractRejection(materialApi.getList())
  })

  it('getDetail 合法响应放行：批次 quantity=0 保真', async () => {
    mockGet.mockResolvedValue(materialDetailPayload({
      batches: [{ id: 'batch-1', batchNo: 'B1', quantity: 0, productionDate: null, expiryDate: '2027-07-01', inboundId: 'in-1' }],
    }))
    const res: any = await materialApi.getDetail('mat-1')
    expect(res.batches[0].quantity).toBe(0)
    expect(res.stockLogs).toHaveLength(1)
  })

  it.each([
    ['batches 非数组', { batches: null }],
    ['stockLogs 非数组', { stockLogs: {} }],
    ['批次 quantity 为字符串', { batches: [{ id: 'b1', batchNo: 'B1', quantity: '3', productionDate: null, expiryDate: '2027-01-01', inboundId: null }] }],
    ['流水 afterStock 为 NaN', { stockLogs: [{ id: 'l1', type: 'inbound', quantity: 1, beforeStock: 0, afterStock: NaN, relatedId: null, operator: 'admin', createdAt: '2026-07-01' }] }],
  ])('getDetail 畸形（%s）→ 拒绝', async (_label, patch) => {
    mockGet.mockResolvedValue(materialDetailPayload(patch))
    await expectContractRejection(materialApi.getDetail('mat-1'))
  })
})
