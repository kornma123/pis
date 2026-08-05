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
    getNumber: vi.fn(() => 20),
    setMultiple: vi.fn(),
  }),
}))

vi.mock('@/api/master', () => ({
  materialApi: {
    getList: vi.fn(),
    getDetail: vi.fn(),
    getNextCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  categoryApi: { getList: vi.fn(), getTree: vi.fn() },
  supplierApi: { getList: vi.fn() },
}))

vi.mock('sonner')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(categoryApi.getList).mockResolvedValue({
    list: [{ id: 'cat-1', name: '染色' }],
  } as never)
  vi.mocked(supplierApi.getList).mockResolvedValue({ list: [] } as never)
  vi.mocked(materialApi.getList).mockResolvedValue({ list: [] } as never)
})

describe('useMaterialsPage 消费者链路（Issue71）', () => {
  it('autoFillCode 使用已解包的 {code} payload，不依赖 res.data 包壳', async () => {
    vi.mocked(materialApi.getNextCode).mockResolvedValue({
      code: 'MAT-00042',
    } as never)
    const { result } = renderHook(() => useMaterialsPage())

    await act(async () => {
      await result.current.autoFillCode('cat-1')
    })

    expect(result.current.form.code).toBe('MAT-00042')
  })

  it('autoFillCode 对未解包的错误 envelope fail-closed：不得把包壳当成功', async () => {
    vi.mocked(materialApi.getNextCode).mockResolvedValue({
      data: { code: 'MAT-00042' },
    } as never)
    const { result } = renderHook(() => useMaterialsPage())

    await act(async () => {
      await result.current.autoFillCode('cat-1')
    })

    expect(result.current.form.code).not.toBe('MAT-00042')
  })
})
