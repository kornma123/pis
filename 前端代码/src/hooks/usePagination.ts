import { useState, useEffect, useCallback } from 'react'

interface UsePaginationOptions<T> {
  fetchFn: (params: { page: number; pageSize: number }) => Promise<{
    list: T[]
    pagination?: { total: number; page: number; pageSize: number }
  }>
  initialPage?: number
  initialPageSize?: number
  deps?: React.DependencyList
}

export function usePagination<T>({
  fetchFn,
  initialPage = 1,
  initialPageSize = 20,
  deps = [],
}: UsePaginationOptions<T>) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(initialPage)
  const [pageSize, setPageSize] = useState(initialPageSize)
  const [total, setTotal] = useState(0)

  const fetchData = useCallback(
    async (targetPage?: number) => {
      setLoading(true)
      try {
        const res = await fetchFn({
          page: targetPage ?? page,
          pageSize,
        })
        setData(res.list || [])
        setTotal(res.pagination?.total || 0)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    },
    [fetchFn, page, pageSize, ...deps]
  )

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const goToPage = useCallback(
    (p: number) => {
      setPage(p)
      fetchData(p)
    },
    [fetchData]
  )

  const changePageSize = useCallback(
    (size: number) => {
      setPageSize(size)
      setPage(1)
    },
    []
  )

  return {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage: goToPage,
    setPageSize: changePageSize,
    refresh: () => fetchData(page),
  }
}
