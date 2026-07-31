import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBOMPage } from './useBOMPage'
import { bomApi } from '@/api/master'

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

const bomListRow: any = {
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
}

const bomDetail: any = {
  id: 'bom-1',
  code: 'BOM-001',
  name: 'HE基础套',
  version: 'v1.0',
  type: 'he',
  serviceId: 'svc-9',
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
  versionHistory: [{ version: 'v1.0', updatedAt: '2026-01-01T00:00:00Z', changeLog: 'Current' }],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBOMPage 消费者链路（Issue71）', () => {
  it('openDetail 直接使用已解包的 BOM detail payload，而不是 res.data 包壳', async () => {
    vi.mocked(bomApi.getDetail).mockResolvedValue(bomDetail)
    const { result } = renderHook(() => useBOMPage())

    await act(async () => {
      await result.current.openDetail(bomListRow)
    })

    expect(bomApi.getDetail).toHaveBeenCalledWith('bom-1')
    expect(result.current.detailBom).toEqual(bomDetail)
    expect(result.current.modalType).toBe('detail')
  })

  it('handleCopy 用 detail 真值生成 create payload（materialId/usagePerSample/unit，未知不折 0）', async () => {
    vi.mocked(bomApi.getDetail).mockResolvedValue(bomDetail)
    vi.mocked(bomApi.create).mockResolvedValue({ id: 'bom-new' } as any)
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
        materialCount: 1,
        unitCost: 12.5,
        materials: [{ materialId: 'mat-1', usagePerSample: 0, unit: '瓶' }],
      })
    )
  })
})
