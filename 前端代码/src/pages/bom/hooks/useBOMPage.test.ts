import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBOMPage } from './useBOMPage'
import { bomApi } from '@/api/master'
import type { BOM } from '@/types'
import type { BomDetail } from '@/api/master-parsers'

vi.mock('@/hooks/usePagination', () => ({
  usePagination: () => ({
    data: [],
    loading: false,
    error: null,
    page: 1,
    pageSize: 20,
    total: 0,
    setPage: vi.fn(),
    setPageSize: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock('@/hooks/useUrlParams', () => ({
  useUrlParams: () => ({
    get: vi.fn(() => ''),
    getNumber: vi.fn(() => 1),
    setMultiple: vi.fn(),
  }),
}))

vi.mock('@/api/master', () => ({
  bomApi: {
    getList: vi.fn(),
    getDetail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('sonner')

const bomListRow = {
  id: 'bom-1',
  code: 'BOM-001',
  name: 'HE基础套',
  version: 'v1.0',
  type: 'he',
  serviceId: null,
  materialCount: 2,
  supportableSamples: null,
  unitCost: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as BOM

const bomDetail = {
  id: 'bom-1',
  code: 'BOM-001',
  name: 'HE基础套',
  version: 'v1.0',
  type: 'he',
  serviceId: 'svc-9',
  description: '基础套餐',
  supportableSamples: 30,
  unitCost: 12.5,
  status: 'active',
  materials: [
    {
      id: 'mat-1',
      name: '苏木素',
      spec: '100ml',
      usagePerSample: 0,
      unit: '瓶',
      price: null,
      stock: 0,
      costRatio: 0,
    },
  ],
  versionHistory: [
    { version: 'v1.0', updatedAt: '2026-01-01T00:00:00Z', changeLog: null },
  ],
  // live contract：bom detail 不返回 createdAt/updatedAt，parser 输出 null，hook 用列表行真值补齐（F-2）
  createdAt: null,
  updatedAt: null,
} as unknown as BomDetail

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(bomApi.getList).mockResolvedValue({
    list: [bomListRow],
    pagination: { total: 1, page: 1, pageSize: 20, totalPages: 1 },
  } as never)
})

describe('useBOMPage 消费者链路（Issue71）', () => {
  it('openDetail 直接使用已解包的 BOM detail payload，而不是 res.data 包壳', async () => {
    vi.mocked(bomApi.getDetail).mockResolvedValue(bomDetail)
    const { result } = renderHook(() => useBOMPage())

    await act(async () => {
      await result.current.openDetail(bomListRow)
    })

    expect(bomApi.getDetail).toHaveBeenCalledWith('bom-1')
    expect(result.current.detailBom).toEqual({
      ...bomDetail,
      createdAt: bomListRow.createdAt,
      updatedAt: bomListRow.updatedAt,
    })
    expect(result.current.modalType).toBe('detail')
  })

  it('openDetail 失败时 fail-closed：不把列表行冒充详情、不打开详情弹窗', async () => {
    vi.mocked(bomApi.getDetail).mockRejectedValue(new Error('parse failed'))
    const { result } = renderHook(() => useBOMPage())

    await act(async () => {
      await result.current.openDetail(bomListRow)
    })

    expect(result.current.detailBom).toBeNull()
    expect(result.current.modalType).toBeNull()
  })

  it('openDetail 合并列表行真值时间：detail 缺时间字段时不显示 "-"（F-2）', async () => {
    vi.mocked(bomApi.getDetail).mockResolvedValue(bomDetail)
    const { result } = renderHook(() => useBOMPage())

    await act(async () => {
      await result.current.openDetail(bomListRow)
    })

    expect(result.current.detailBom?.createdAt).toBe(bomListRow.createdAt)
    expect(result.current.detailBom?.updatedAt).toBe(bomListRow.updatedAt)
  })

  it('handleCopy 用 detail 真值生成 create payload（未知不折 0、合法 0 保真）', async () => {
    vi.mocked(bomApi.getDetail).mockResolvedValue(bomDetail)
    vi.mocked(bomApi.create).mockResolvedValue({ id: 'bom-new' } as never)
    const { result } = renderHook(() => useBOMPage())

    act(() => result.current.openCopy(bomListRow))
    await act(async () => {
      await result.current.handleCopy()
    })

    expect(bomApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'HE基础套(副本)',
        type: 'he',
        serviceId: 'svc-9',
        description: '基础套餐',
        materialCount: 1,
        unitCost: 12.5,
        materials: [{ materialId: 'mat-1', usagePerSample: 0, unit: '瓶' }],
      })
    )
  })

  it('handleCopy 对 null 的 unitCost 不折成 0', async () => {
    vi.mocked(bomApi.getDetail).mockResolvedValue({
      ...bomDetail,
      unitCost: null,
    } as unknown as BomDetail)
    vi.mocked(bomApi.create).mockResolvedValue({ id: 'bom-new' } as never)
    const { result } = renderHook(() => useBOMPage())

    act(() => result.current.openCopy(bomListRow))
    await act(async () => {
      await result.current.handleCopy()
    })

    const payload = vi.mocked(bomApi.create).mock.calls[0][0] as Record<string, unknown>
    expect(payload.unitCost).toBeUndefined()
    expect(payload.unitCost).not.toBe(0)
  })
})
