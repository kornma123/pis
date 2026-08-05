import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from './request'
import { bomApi, materialApi, projectApi } from './master'

vi.mock('./request', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const get = vi.mocked(request.get)

function pagePayload(list: unknown[], total = list.length, page = 1, pageSize = 20) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize)
  return {
    list,
    pagination: { page, pageSize, total, totalPages },
  }
}

function materialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mat-1',
    code: 'MAT-00001',
    name: '苏木素',
    spec: '100ml/瓶',
    unit: '瓶',
    price: 0,
    stock: 0,
    minStock: 0,
    maxStock: 10,
    safetyStock: 0,
    categoryId: 'cat-1',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    code: 'PROJ-001',
    name: 'HE制片',
    type: 'he',
    bomId: null,
    supportableSamples: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function bomRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bom-1',
    code: 'BOM-001',
    name: 'HE基础套',
    version: 'v1.0',
    type: 'he',
    materialCount: 2,
    supportableSamples: null,
    unitCost: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function bomMaterialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mat-1',
    name: '苏木素',
    spec: '100ml',
    usagePerSample: 0,
    unit: '瓶',
    price: null,
    stock: 0,
    costRatio: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('materialApi 响应真值（Issue71）', () => {
  it('合法零与合法空集合保真：list/price/stock 为 0、空列表通过', async () => {
    get.mockResolvedValue(pagePayload([materialRow()], 1) as never)
    const res = await materialApi.getList({ page: 1, pageSize: 20 })
    expect(res.list[0].price).toBe(0)
    expect(res.list[0].stock).toBe(0)
    expect(res.pagination.total).toBe(1)

    get.mockResolvedValue(pagePayload([], 0) as never)
    const empty = await materialApi.getList({ page: 1, pageSize: 20 })
    expect(empty.list).toEqual([])
    expect(empty.pagination.total).toBe(0)
  })

  it('fail-closed：缺失 list / 行缺 identity / 非数组', async () => {
    get.mockResolvedValue({ pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } } as never)
    await expect(materialApi.getList({})).rejects.toThrow()

    get.mockResolvedValue(pagePayload([materialRow({ id: undefined })]) as never)
    await expect(materialApi.getList({})).rejects.toThrow()

    get.mockResolvedValue({ list: 'not-array', pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } } as never)
    await expect(materialApi.getList({})).rejects.toThrow()
  })

  it.each([
    ['price 为 null', materialRow({ price: null })],
    ['price 为 NaN', materialRow({ price: Number.NaN })],
    ['stock 为负数', materialRow({ stock: -1 })],
    ['status 未知', materialRow({ status: 'pending' })],
    ['unit 缺失', materialRow({ unit: undefined })],
  ])('fail-closed：%s', async (_label, row) => {
    get.mockResolvedValue(pagePayload([row]) as never)
    await expect(materialApi.getList({})).rejects.toThrow()
  })

  it('fail-closed：分页矛盾（total 小于当前页行数）', async () => {
    get.mockResolvedValue(pagePayload([materialRow(), materialRow({ id: 'mat-2' })], 1) as never)
    await expect(materialApi.getList({})).rejects.toThrow()
  })

  it('detail：合法空 batches/stockLogs 与可空字段保真', async () => {
    get.mockResolvedValue({ ...materialRow(), batches: [], stockLogs: [] } as never)
    const res = await materialApi.getDetail('mat-1')
    expect(res.batches).toEqual([])
    expect(res.stockLogs).toEqual([])
    expect(res.spec).toBe('100ml/瓶')
  })

  it('detail：fail-closed（batches 非数组 / stockLogs 行缺 id）', async () => {
    get.mockResolvedValue({ ...materialRow(), batches: 'no' } as never)
    await expect(materialApi.getDetail('mat-1')).rejects.toThrow()

    get.mockResolvedValue({
      ...materialRow(),
      batches: [],
      stockLogs: [{ type: 'inbound', quantity: 1 }],
    } as never)
    await expect(materialApi.getDetail('mat-1')).rejects.toThrow()
  })

  it('detail：batches 按 live contract camelCase 读取，真实字段值保真（含合法 null）', async () => {
    get.mockResolvedValue({
      ...materialRow(),
      batches: [
        {
          id: 'batch-1',
          batchNo: 'B2026-0001',
          quantity: 10,
          productionDate: '2026-01-01',
          expiryDate: '2027-01-01',
          inboundId: 'inbound-1',
        },
        {
          id: 'batch-2',
          batchNo: null,
          quantity: 0,
          productionDate: null,
          expiryDate: null,
          inboundId: null,
        },
      ],
      stockLogs: [],
    } as never)
    const res = await materialApi.getDetail('mat-1')
    expect(res.batches[0]).toEqual({
      id: 'batch-1',
      batchNo: 'B2026-0001',
      quantity: 10,
      productionDate: '2026-01-01',
      expiryDate: '2027-01-01',
      inboundId: 'inbound-1',
    })
    expect(res.batches[1].batchNo).toBeNull()
    expect(res.batches[1].quantity).toBe(0)
  })

  it('detail：batches 出现 snake_case 原始形状必须 fail-closed，不得静默读成 null', async () => {
    get.mockResolvedValue({
      ...materialRow(),
      batches: [
        {
          id: 'batch-1',
          batch_no: 'B2026-0001',
          quantity: 10,
          production_date: '2026-01-01',
          expiry_date: '2027-01-01',
          inbound_id: 'inbound-1',
        },
      ],
      stockLogs: [],
    } as never)
    await expect(materialApi.getDetail('mat-1')).rejects.toThrow()
  })

  it('getNextCode：未解包的错误 envelope 不冒充成功', async () => {
    get.mockResolvedValue({ data: { code: 'MAT-00042' } } as never)
    await expect(materialApi.getNextCode('cat-1')).rejects.toThrow()

    get.mockResolvedValue({ code: 'MAT-00042' } as never)
    await expect(materialApi.getNextCode('cat-1')).resolves.toEqual({ code: 'MAT-00042' })
  })
})

describe('projectApi 响应真值（Issue71）', () => {
  it('合法 null（未配置 BOM）与合法空列表保真', async () => {
    get.mockResolvedValue(pagePayload([projectRow()], 1) as never)
    const res = await projectApi.getList({ page: 1, pageSize: 20 })
    expect(res.list[0].supportableSamples).toBeNull()
    expect(res.list[0].bomId).toBeNull()

    get.mockResolvedValue(pagePayload([], 0) as never)
    const empty = await projectApi.getList({})
    expect(empty.list).toEqual([])
  })

  it.each([
    ['supportableSamples 非整数', projectRow({ supportableSamples: 1.5 })],
    ['supportableSamples 为负数', projectRow({ supportableSamples: -1 })],
    ['status 缺失', projectRow({ status: undefined })],
    ['name 缺失', projectRow({ name: undefined })],
  ])('fail-closed：%s', async (_label, row) => {
    get.mockResolvedValue(pagePayload([row]) as never)
    await expect(projectApi.getList({})).rejects.toThrow()
  })

  it('detail：合法 0 的 costStats 保真', async () => {
    get.mockResolvedValue({
      ...projectRow(),
      costStats: { totalCost: 0, sampleCount: 0, unitCost: 0 },
    } as never)
    const res = await projectApi.getDetail('proj-1')
    expect(res.costStats.totalCost).toBe(0)
    expect(res.costStats.unitCost).toBe(0)
  })

  it('detail：fail-closed（costStats 缺失 / 数值 null）', async () => {
    get.mockResolvedValue(projectRow() as never)
    await expect(projectApi.getDetail('proj-1')).rejects.toThrow()

    get.mockResolvedValue({
      ...projectRow(),
      costStats: { totalCost: null, sampleCount: 0, unitCost: 0 },
    } as never)
    await expect(projectApi.getDetail('proj-1')).rejects.toThrow()
  })
})

describe('bomApi 响应真值（Issue71）', () => {
  it('合法 0 / null / 空列表保真：materialCount 0、unitCost null、supportableSamples null', async () => {
    get.mockResolvedValue(
      pagePayload([
        bomRow({ materialCount: 0, unitCost: null, supportableSamples: null }),
      ]) as never
    )
    const res = await bomApi.getList({ page: 1, pageSize: 20 })
    expect(res.list[0].materialCount).toBe(0)
    expect(res.list[0].unitCost).toBeNull()
    expect(res.list[0].supportableSamples).toBeNull()

    get.mockResolvedValue(pagePayload([], 0) as never)
    const empty = await bomApi.getList({})
    expect(empty.list).toEqual([])
  })

  it.each([
    ['materialCount 缺失', bomRow({ materialCount: undefined })],
    ['materialCount 非整数', bomRow({ materialCount: 1.5 })],
    ['materialCount 为负数', bomRow({ materialCount: -1 })],
    ['status 未知', bomRow({ status: 'draft' })],
    ['id 缺失', bomRow({ id: undefined })],
    ['version 空串', bomRow({ version: '' })],
  ])('list fail-closed：%s', async (_label, row) => {
    get.mockResolvedValue(pagePayload([row]) as never)
    await expect(bomApi.getList({})).rejects.toThrow()
  })

  it('list fail-closed：非数组 / 分页矛盾', async () => {
    get.mockResolvedValue({ list: {}, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } } as never)
    await expect(bomApi.getList({})).rejects.toThrow()

    get.mockResolvedValue(pagePayload([bomRow(), bomRow({ id: 'bom-2' })], 1) as never)
    await expect(bomApi.getList({})).rejects.toThrow()
  })

  it('endpoint-specific：material 形状但缺 BOM materialCount 必须被 BOM parser 拒绝', async () => {
    const materialShaped = {
      ...materialRow(),
      version: 'v1.0',
      type: 'he',
    }
    get.mockResolvedValue(pagePayload([materialShaped]) as never)
    await expect(bomApi.getList({})).rejects.toThrow()
  })

  it('detail：合法空 materials/versionHistory 与合法 0 保真', async () => {
    get.mockResolvedValue({
      ...bomRow({ materialCount: 0 }),
      materials: [],
      versionHistory: [],
    } as never)
    const res = await bomApi.getDetail('bom-1')
    expect(res.materials).toEqual([])
    expect(res.versionHistory).toEqual([])
    expect(res.materialCount).toBe(0)
  })

  it('detail：materials 行合法 0 保真（stock 0 / usagePerSample 0）', async () => {
    get.mockResolvedValue({
      ...bomRow(),
      materials: [bomMaterialRow({ stock: 0, usagePerSample: 0 })],
      versionHistory: [{ version: 'v1.0', updatedAt: '2026-01-01T00:00:00Z', changeLog: null }],
    } as never)
    const res = await bomApi.getDetail('bom-1')
    expect(res.materials[0].stock).toBe(0)
    expect(res.materials[0].usagePerSample).toBe(0)
  })

  it.each([
    ['materials 缺失', { ...bomRow(), versionHistory: [] }],
    ['versionHistory 缺失', { ...bomRow(), materials: [] }],
    ['materials 非数组', { ...bomRow(), materials: 'no', versionHistory: [] }],
    ['material 行 stock 缺失', { ...bomRow(), materials: [bomMaterialRow({ stock: undefined })], versionHistory: [] }],
    ['material 行 usagePerSample 缺失', { ...bomRow(), materials: [bomMaterialRow({ usagePerSample: undefined })], versionHistory: [] }],
    ['versionHistory 行缺 version', { ...bomRow(), materials: [], versionHistory: [{ updatedAt: 'x', changeLog: null }] }],
  ])('detail fail-closed：%s', async (_label, payload) => {
    get.mockResolvedValue(payload as never)
    await expect(bomApi.getDetail('bom-1')).rejects.toThrow()
  })
})
