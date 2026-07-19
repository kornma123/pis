import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, renderHook, waitFor, act, fireEvent, screen } from '@testing-library/react'
import { useInventoryPage } from './useInventoryPage'
import { InventoryTable } from '../components/InventoryTable'
import { inventoryApi, outboundApi, scrapApi } from '@/api/inventory'
import { bomApi, materialApi, projectApi, userApi } from '@/api/master'
import { toast } from 'sonner'

vi.mock('@/api/inventory')
vi.mock('@/api/master')
vi.mock('sonner')

const mockInventoryItem = {
  id: 'inv-1',
  materialId: 'mat-1',
  code: 'M001',
  name: '耗材A',
  spec: '10ml',
  unit: '盒',
  stock: 100,
  minStock: 10,
  maxStock: 500,
  availableStock: 100,
  locationId: 'loc-1',
  locationName: 'A1-01',
  status: 'normal',
}

function inventoryTableProps(
  overrides: Partial<Parameters<typeof InventoryTable>[0]> = {}
): Parameters<typeof InventoryTable>[0] {
  return {
    data: [],
    loading: false,
    error: null,
    total: 0,
    page: 1,
    pageSize: 20,
    keyword: '',
    category: '全部分类',
    location: '全部库位',
    quickFilter: 'all',
    sortField: null,
    sortDirection: 'asc',
    selectedIds: new Set(),
    expandedGroups: new Set(),
    stats: { total: 0, normal: 0, low: 0, warning: 0, expired: 0, outOfStock: 0 },
    quickFilterCounts: {
      all: 0,
      'low-stock': 0,
      'expiring-soon': 0,
      'expiring-month': 0,
      expired: 0,
      'out-of-stock': 0,
    },
    onKeywordChange: vi.fn(),
    onCategoryChange: vi.fn(),
    onLocationChange: vi.fn(),
    onQuickFilter: vi.fn(),
    onSort: vi.fn(),
    onSearch: vi.fn(),
    onReset: vi.fn(),
    onRetry: vi.fn(),
    onToggleSelectAll: vi.fn(),
    onToggleSelectOne: vi.fn(),
    onClearSelection: vi.fn(),
    onToggleGroup: vi.fn(),
    onDetail: vi.fn(),
    onOutbound: vi.fn(),
    onPageChange: vi.fn(),
    onPageSizeChange: vi.fn(),
    onBatchOutbound: vi.fn(),
    onBatchScrap: vi.fn(),
    ...overrides,
  }
}

describe('useInventoryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    window.history.replaceState(null, '', '/')

    vi.mocked(inventoryApi.getList).mockResolvedValue({
      list: [mockInventoryItem],
      pagination: { total: 1, page: 1, pageSize: 20 },
    } as any)
    vi.mocked(inventoryApi.getStats).mockResolvedValue({
      totalMaterials: 1, totalStockValue: 5000, lowStockCount: 0, expiringCount: 0, expiredCount: 0, categoryDistribution: [],
    } as any)

    vi.mocked(outboundApi.create).mockResolvedValue({} as any)
    vi.mocked(scrapApi.create).mockResolvedValue({} as any)
    vi.mocked(projectApi.getList).mockResolvedValue({ list: [] } as any)
    vi.mocked(userApi.getList).mockResolvedValue({ list: [] } as any)
    vi.mocked(materialApi.getList).mockResolvedValue({ list: [] } as any)
    vi.mocked(bomApi.getList).mockResolvedValue({ list: [] } as any)
  })

  it('should fetch inventory list on mount', async () => {
    const { result } = renderHook(() => useInventoryPage())

    await waitFor(() => {
      expect(inventoryApi.getList).toHaveBeenCalled()
      expect(result.current.data.length).toBeGreaterThan(0)
    })
  })

  it('exposes a failed inventory request and recovers after retry succeeds', async () => {
    vi.mocked(inventoryApi.getList).mockRejectedValueOnce(new Error('network unavailable'))

    const { result } = renderHook(() => useInventoryPage())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBe('network unavailable')
      expect(result.current.data).toEqual([])
    })

    vi.mocked(inventoryApi.getList).mockResolvedValueOnce({
      list: [mockInventoryItem],
      pagination: { total: 1, page: 1, pageSize: 20 },
    } as any)

    act(() => result.current.refresh())

    await waitFor(() => {
      expect(result.current.error).toBeNull()
      expect(result.current.data).toHaveLength(1)
    })
  })

  it('coalesces repeated retries while an inventory request is in flight', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    let resolveRetry!: (value: any) => void
    const pendingRetry = new Promise(resolve => { resolveRetry = resolve })
    vi.mocked(inventoryApi.getList).mockImplementationOnce(() => pendingRetry as any)
    const callsBeforeRetry = vi.mocked(inventoryApi.getList).mock.calls.length

    act(() => result.current.refresh())

    await waitFor(() => {
      expect(inventoryApi.getList).toHaveBeenCalledTimes(callsBeforeRetry + 1)
      expect(result.current.loading).toBe(true)
    })

    act(() => result.current.refresh())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(inventoryApi.getList).toHaveBeenCalledTimes(callsBeforeRetry + 1)

    act(() => resolveRetry({
      list: [mockInventoryItem],
      pagination: { total: 1, page: 1, pageSize: 20 },
    }))
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('normalizes an unknown rejection without treating it as empty inventory', async () => {
    vi.mocked(inventoryApi.getList).mockRejectedValueOnce({ unexpected: true })

    const { result } = renderHook(() => useInventoryPage())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBe('加载失败')
      expect(result.current.data).toEqual([])
      expect(result.current.total).toBe(0)
    })
  })

  it('keeps the last successful inventory page visibly stale when refresh fails', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    vi.mocked(inventoryApi.getList).mockRejectedValueOnce(new Error('refresh failed'))
    act(() => result.current.refresh())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBe('refresh failed')
      expect(result.current.data).toEqual([
        expect.objectContaining({ id: mockInventoryItem.id, name: mockInventoryItem.name }),
      ])
    })
  })

  it('blocks inventory writes until a stale page refreshes successfully', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    vi.mocked(inventoryApi.getList).mockRejectedValueOnce(new Error('refresh failed'))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBe('refresh failed'))

    act(() => {
      result.current.setOutboundMaterials([{
        rowId: 1, materialId: 'mat-1', name: '耗材A', spec: '10ml',
        stock: 100, quantity: 1, unit: '盒', project: '', user: 'admin',
        usage: 'self' as 'self' | 'external', receiver: '',
      }])
    })
    await act(async () => result.current.confirmOutbound())

    expect(outboundApi.create).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('库存数据不是最新状态，请刷新成功后再操作')
  })

  it('should reset page to 1 when keyword changes', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setKeyword('test')
    })

    await waitFor(() => {
      expect(result.current.page).toBe(1)
    })
  })

  it('should validate outbound — empty materials', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.confirmOutbound()
    })

    expect(outboundApi.create).not.toHaveBeenCalled()
  })

  it('should validate outbound — quantity exceeds stock', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setOutboundMaterials([{
        rowId: 1, materialId: 'mat-1', name: '耗材A', spec: '10ml',
        stock: 10, quantity: 20, unit: '盒', project: '', user: 'admin',
        usage: 'self' as 'self' | 'external', receiver: '',
      }])
    })

    await act(async () => {
      await result.current.confirmOutbound()
    })

    expect(outboundApi.create).not.toHaveBeenCalled()
  })

  it('should create outbound on valid submit', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setOutboundMaterials([{
        rowId: 1, materialId: 'mat-1', name: '耗材A', spec: '10ml',
        stock: 100, quantity: 5, unit: '盒', project: 'proj-1', user: 'admin',
        usage: 'self' as 'self' | 'external', receiver: '',
      }])
    })

    await act(async () => {
      await result.current.confirmOutbound()
    })

    await waitFor(() => {
      expect(outboundApi.create).toHaveBeenCalled()
    })
  })

  it('loads project options once when opening an empty outbound order repeatedly', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => result.current.openEmptyOutboundModal())
    act(() => result.current.setOutboundModalOpen(false))
    await act(async () => result.current.openEmptyOutboundModal())

    expect(projectApi.getList).toHaveBeenCalledTimes(1)
    expect(result.current.outboundModalOpen).toBe(true)
  })

  it('submits every material in one atomic outbound request', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setOutboundMaterials([
        {
          rowId: 1, materialId: 'mat-1', name: '耗材A', spec: '10ml',
          stock: 100, quantity: 5, unit: '盒', project: 'proj-1', user: 'admin',
          usage: 'self' as const, receiver: '',
        },
        {
          rowId: 2, materialId: 'mat-2', name: '耗材B', spec: '20ml',
          stock: 50, quantity: 3, unit: '瓶', project: 'proj-1', user: 'admin',
          usage: 'external' as const, receiver: '病理组',
        },
      ])
    })

    await act(async () => result.current.confirmOutbound())

    expect(outboundApi.create).toHaveBeenCalledTimes(1)
    expect(vi.mocked(outboundApi.create).mock.calls[0][0]).toEqual(expect.objectContaining({
      type: 'direct',
      projectId: 'proj-1',
      items: [
        expect.objectContaining({ materialId: 'mat-1', quantity: 5, usage: 'self' }),
        expect.objectContaining({ materialId: 'mat-2', quantity: 3, usage: 'external', receiver: '病理组' }),
      ],
    }))
  })

  it('keeps the form recoverable and exposes an honest 422 failure', async () => {
    vi.mocked(outboundApi.create).mockRejectedValueOnce({
      response: {
        status: 422,
        data: { error: { code: 'STOCK_INSUFFICIENT', message: 'Insufficient batch stock' } },
      },
    })
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setOutboundModalOpen(true)
      result.current.setOutboundMaterials([{
        rowId: 1, materialId: 'mat-1', name: '耗材A', spec: '10ml',
        stock: 100, quantity: 5, unit: '盒', project: 'proj-1', user: 'admin',
        usage: 'self' as const, receiver: '',
      }])
    })

    await act(async () => result.current.confirmOutbound())

    expect(result.current.outboundModalOpen).toBe(true)
    expect(result.current.outboundMaterials).toHaveLength(1)
    expect((result.current as any).outboundSubmitError).toContain('整单未出库')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('coalesces duplicate outbound confirmation while the request is pending', async () => {
    let resolveCreate!: (value: unknown) => void
    vi.mocked(outboundApi.create).mockImplementationOnce(() => new Promise(resolve => {
      resolveCreate = resolve
    }) as any)
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setOutboundMaterials([{
        rowId: 1, materialId: 'mat-1', name: '耗材A', spec: '10ml',
        stock: 100, quantity: 5, unit: '盒', project: 'proj-1', user: 'admin',
        usage: 'self' as const, receiver: '',
      }])
    })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.confirmOutbound()
      second = result.current.confirmOutbound()
    })
    expect(outboundApi.create).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCreate({})
      await Promise.all([first, second])
    })
  })

  it('keeps BOM-selected materials on the ordinary direct outbound contract', async () => {
    vi.mocked(bomApi.getDetail).mockResolvedValue({
      materials: [{
        id: 'mat-from-bom',
        code: 'BOM-MAT-001',
        name: 'BOM耗材',
        spec: '1ml',
        unit: '盒',
        stock: 10,
        usagePerSample: 2,
      }],
    } as any)

    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.loadBomDetail('bom-1')
    })
    await waitFor(() => expect(result.current.bomMaterials).toHaveLength(1))

    act(() => {
      result.current.toggleCheckMaterial('mat-from-bom')
    })
    await waitFor(() => expect(result.current.checkedMaterialIds.has('mat-from-bom')).toBe(true))

    act(() => {
      result.current.confirmAddMaterials()
    })
    await waitFor(() => expect(result.current.outboundMaterials).toHaveLength(1))

    act(() => {
      result.current.updateOutboundUser(result.current.outboundMaterials[0].rowId, 'admin')
    })
    await act(async () => {
      await result.current.confirmOutbound()
    })

    expect(outboundApi.create).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(outboundApi.create).mock.calls[0][0] as any
    expect(payload).toEqual({
      type: 'direct',
      projectId: undefined,
      remark: '',
      items: [{
        materialId: 'mat-from-bom',
        quantity: 1,
        usage: 'self',
        receiver: null,
      }],
    })
    expect(payload).not.toHaveProperty('bomId')
    expect(payload).not.toHaveProperty('sampleCount')
  })

  it('should validate batch scrap — no selection', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.confirmBatchScrap()
    })

    expect(toast.error).toHaveBeenCalledWith('请先选择要报废的物料')
    expect(scrapApi.create).not.toHaveBeenCalled()
  })

  it('should validate batch scrap — no reason', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.toggleSelectOne('inv-1')
      result.current.setScrapReason('')
    })

    await act(async () => {
      await result.current.confirmBatchScrap()
    })

    expect(toast.error).toHaveBeenCalledWith('请选择报废原因')
    expect(scrapApi.create).not.toHaveBeenCalled()
  })

  it('should handle reset filters', async () => {
    const { result } = renderHook(() => useInventoryPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setKeyword('test')
      result.current.setCategory('分类A')
    })

    await waitFor(() => expect(result.current.keyword).toBe('test'))

    act(() => {
      result.current.handleReset()
    })

    expect(result.current.keyword).toBe('')
    expect(result.current.category).toBe('全部分类')
  })
})

describe('InventoryTable request states', () => {
  it('renders a retryable error instead of the empty state after an initial failure', () => {
    const onRetry = vi.fn()

    render(createElement(InventoryTable, inventoryTableProps({ error: 'network unavailable', onRetry })))

    expect(screen.getByText('库存数据没能加载')).toBeInTheDocument()
    expect(screen.queryByText('暂无库存数据')).not.toBeInTheDocument()
    expect(screen.queryByText('network unavailable')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('marks retained rows as last successfully loaded data after refresh failure', () => {
    render(createElement(InventoryTable, inventoryTableProps({
      data: [mockInventoryItem],
      total: 1,
      error: 'refresh failed',
    })))

    expect(screen.getByText('当前显示的是上次成功加载的数据')).toBeInTheDocument()
    expect(screen.getByText(mockInventoryItem.name)).toBeInTheDocument()
    expect(screen.queryByText('暂无库存数据')).not.toBeInTheDocument()
    expect(screen.queryByText('refresh failed')).not.toBeInTheDocument()
  })

  it('disables retries and inventory writes while stale data is refreshing', () => {
    const onRetry = vi.fn()
    const onOutbound = vi.fn()
    const { rerender } = render(createElement(InventoryTable, inventoryTableProps({
      data: [mockInventoryItem],
      total: 1,
      loading: true,
      error: 'refresh failed',
      onRetry,
      onOutbound,
    })))

    expect(screen.getByRole('button', { name: '重新加载' })).toBeDisabled()
    rerender(createElement(InventoryTable, inventoryTableProps({
      data: [mockInventoryItem],
      total: 1,
      error: 'refresh failed',
      onRetry,
      onOutbound,
    })))
    const outboundButton = screen.getByRole('button', { name: '出库' })
    expect(outboundButton).toBeDisabled()
    fireEvent.click(outboundButton)
    expect(onOutbound).not.toHaveBeenCalled()
  })

  it('uses the empty state only after a successful empty response', () => {
    render(createElement(InventoryTable, inventoryTableProps()))

    expect(screen.getByText('暂无库存数据')).toBeInTheDocument()
    expect(screen.queryByText('库存数据没能加载')).not.toBeInTheDocument()
  })

  it('labels the API row as a material cache with an FEFO starting batch', () => {
    render(createElement(InventoryTable, inventoryTableProps({
      data: [{ ...mockInventoryItem, batch: 'B-001', expiry: '2026-12-31' }],
      total: 1,
    })))

    expect(screen.getByRole('columnheader', { name: /FEFO 起始批次/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /登记库位/ })).toBeInTheDocument()
    expect(screen.queryByText('1 批次')).not.toBeInTheDocument()
  })

  it.each([
    [{ locationId: undefined, locationName: undefined }, '未登记库位'],
    [{ locationId: 'loc-stale', locationName: '-' }, '库位引用失效'],
    [{ locationId: 'loc-1', locationName: 'A1-01' }, 'A1-01（未按批次验证）'],
  ])('renders truthful location evidence for %o', (locationEvidence, expected) => {
    render(createElement(InventoryTable, inventoryTableProps({
      data: [{ ...mockInventoryItem, ...locationEvidence }],
      total: 1,
    })))

    expect(screen.getByText(expected)).toBeInTheDocument()
  })
})
