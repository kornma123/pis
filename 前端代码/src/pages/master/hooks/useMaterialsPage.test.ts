import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMaterialsPage } from './useMaterialsPage'
import { materialApi, categoryApi, supplierApi } from '@/api/master'

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
  materialApi: {
    getList: vi.fn(),
    getNextCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  categoryApi: {
    getList: vi.fn().mockResolvedValue({ list: [], pagination: { page: 1, pageSize: 999, total: 0, totalPages: 0 } }),
  },
  supplierApi: {
    getList: vi.fn().mockResolvedValue({ list: [], pagination: { page: 1, pageSize: 999, total: 0, totalPages: 0 } }),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(categoryApi.getList).mockResolvedValue({
    list: [],
    pagination: { page: 1, pageSize: 999, total: 0, totalPages: 0 },
  } as any)
  vi.mocked(supplierApi.getList).mockResolvedValue({
    list: [],
    pagination: { page: 1, pageSize: 999, total: 0, totalPages: 0 },
  } as any)
})

describe('useMaterialsPage 消费者链路（Issue71）', () => {
  it('autoFillCode 直接使用已解包的 next-code payload（res.code），不是 res.data.code', async () => {
    vi.mocked(materialApi.getNextCode).mockResolvedValue({ code: 'MAT-00042' } as any)
    const { result } = renderHook(() => useMaterialsPage())

    await act(async () => {
      await result.current.autoFillCode('cat-1')
    })

    expect(materialApi.getNextCode).toHaveBeenCalledWith('cat-1')
    expect(result.current.form.code).toBe('MAT-00042')
  })
})
