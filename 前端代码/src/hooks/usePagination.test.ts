import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { usePagination } from './usePagination'

describe('usePagination', () => {
  const createMockFetchFn = (delay = 0) =>
    vi.fn().mockImplementation(async ({ page, pageSize }: { page: number; pageSize: number }) => {
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      const list = Array.from({ length: pageSize }, (_, i) => ({
        id: `item-${(page - 1) * pageSize + i}`,
      }))
      return {
        list,
        pagination: { total: 100, page, pageSize },
      }
    })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should call fetchFn on initial mount with default params', async () => {
    const fetchFn = createMockFetchFn()
    renderHook(() => usePagination({ fetchFn }))

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledWith({ page: 1, pageSize: 20 })
    })
  })

  it('should use custom initial page and pageSize', async () => {
    const fetchFn = createMockFetchFn()
    renderHook(() => usePagination({ fetchFn, initialPage: 3, initialPageSize: 50 }))

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledWith({ page: 3, pageSize: 50 })
    })
  })

  it('should update data and total when fetch resolves', async () => {
    const fetchFn = createMockFetchFn()
    const { result } = renderHook(() => usePagination({ fetchFn }))

    await waitFor(() => {
      expect(result.current.data).toHaveLength(20)
      expect(result.current.total).toBe(100)
      expect(result.current.loading).toBe(false)
    })
  })

  it('should show loading state during fetch', async () => {
    const fetchFn = createMockFetchFn(50)
    const { result } = renderHook(() => usePagination({ fetchFn }))

    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('should go to next page and fetch', async () => {
    const fetchFn = createMockFetchFn()
    const { result } = renderHook(() => usePagination({ fetchFn }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setPage(2)
    })

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledWith({ page: 2, pageSize: 20 })
      expect(result.current.page).toBe(2)
    })
  })

  it('should reset page to 1 when pageSize changes', async () => {
    const fetchFn = createMockFetchFn()
    const { result } = renderHook(() => usePagination({ fetchFn }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setPage(3)
    })

    await waitFor(() => expect(result.current.page).toBe(3))

    act(() => {
      result.current.setPageSize(50)
    })

    expect(result.current.page).toBe(1)
    expect(result.current.pageSize).toBe(50)
  })

  it('should refresh with current page', async () => {
    const fetchFn = createMockFetchFn()
    const { result } = renderHook(() => usePagination({ fetchFn }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setPage(2)
    })

    await waitFor(() => expect(result.current.page).toBe(2))
    const callCount = fetchFn.mock.calls.length

    act(() => {
      result.current.refresh()
    })

    await waitFor(() => {
      expect(fetchFn.mock.calls.length).toBeGreaterThan(callCount)
      expect(fetchFn).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 })
    })
  })

  it('should handle fetch error gracefully', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => usePagination({ fetchFn }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.data).toEqual([])
    expect(result.current.total).toBe(0)
  })

  it('should refetch when deps change', async () => {
    let dep = 'initial'
    const fetchFn = vi.fn().mockResolvedValue({
      list: [],
      pagination: { total: 0, page: 1, pageSize: 20 },
    })

    const { result, rerender } = renderHook(() =>
      usePagination({
        fetchFn,
        deps: [dep],
      })
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    const callCount = fetchFn.mock.calls.length

    dep = 'changed'
    rerender()

    await waitFor(() => {
      expect(fetchFn.mock.calls.length).toBeGreaterThan(callCount)
    })
  })
})
