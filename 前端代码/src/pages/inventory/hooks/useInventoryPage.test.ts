import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useInventoryPage } from './useInventoryPage'
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
      operator: 'admin',
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
