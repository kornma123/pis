import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useProjectsPage } from './useProjectsPage'
import { projectApi, bomApi } from '@/api/master'

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
  projectApi: {
    getList: vi.fn(),
    getDetail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  bomApi: {
    getList: vi.fn(),
    getDetail: vi.fn(),
  },
}))

vi.mock('sonner')

const bom1 = {
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
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectApi.getList).mockResolvedValue({ list: [] } as never)
  vi.mocked(bomApi.getList).mockResolvedValue({ list: [] } as never)
})

describe('useProjectsPage 消费者链路（Issue71）', () => {
  it('fetchBoms 直接使用解析后的 BOM 列表，合法空列表保真', async () => {
    vi.mocked(bomApi.getList).mockResolvedValue({ list: [bom1] } as never)
    const { result } = renderHook(() => useProjectsPage())

    await act(async () => {
      await result.current.fetchBoms()
    })

    expect(result.current.boms).toEqual([bom1])

    vi.mocked(bomApi.getList).mockResolvedValue({ list: [] } as never)
    await act(async () => {
      await result.current.fetchBoms()
    })
    expect(result.current.boms).toEqual([])
  })
})
