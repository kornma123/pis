import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { indirectCostApi } from '@/api/master'
import { toast } from 'sonner'
import { useCostCenterPage } from './useCostCenterPage'

vi.mock('@/api/master', () => ({
  indirectCostApi: {
    getList: vi.fn(),
    getStats: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getAllocations: vi.fn(),
    recordAllocation: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const mockCenter = {
  id: 'cc-1',
  code: 'IDC-001',
  name: '房租成本',
  costType: 'rent',
  monthlyAmount: 1000,
  allocationBase: 'sample_count',
  status: 'active',
}

const inactiveCenter = {
  ...mockCenter,
  id: 'cc-inactive',
  code: 'IDC-INACTIVE',
  name: '停用成本',
  status: 'inactive',
}

describe('useCostCenterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    vi.mocked(indirectCostApi.getList).mockResolvedValue({
      list: [mockCenter],
      pagination: { page: 1, pageSize: 20, total: 1 },
    } as any)
    vi.mocked(indirectCostApi.getStats).mockResolvedValue({
      total: 1,
      active: 1,
      totalMonthly: 1000,
      allocationCount: 0,
    } as any)
    vi.mocked(indirectCostApi.getAllocations).mockResolvedValue({ list: [] } as any)
  })

  it('does not submit negative monthly amount', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())

    act(() => {
      result.current.setForm({
        code: 'IDC-002',
        name: '水电成本',
        costType: 'utilities',
        monthlyAmount: -1,
        allocationBase: 'sample_count',
        description: '',
        status: 'active',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(indirectCostApi.create).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('月度金额必须大于等于0')
  })

  it('does not submit allocation when base value is zero', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())

    await act(async () => {
      await result.current.openAllocation(mockCenter as any)
    })
    act(() => {
      result.current.setAllocationForm({
        yearMonth: '2026-06',
        totalAmount: 1000,
        allocationBaseValue: 0,
      })
    })

    await act(async () => {
      await result.current.handleAllocationSubmit()
    })

    expect(indirectCostApi.recordAllocation).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('分摊基础值必须大于0')
  })

  it('does not submit allocation with invalid year month', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())

    await act(async () => {
      await result.current.openAllocation(mockCenter as any)
    })
    act(() => {
      result.current.setAllocationForm({
        yearMonth: '2026-6',
        totalAmount: 1000,
        allocationBaseValue: 100,
      })
    })

    await act(async () => {
      await result.current.handleAllocationSubmit()
    })

    expect(indirectCostApi.recordAllocation).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('年月格式必须为 YYYY-MM')
  })

  it('does not submit allocation for inactive cost centers', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())

    await act(async () => {
      await result.current.openAllocation(inactiveCenter as any)
    })
    act(() => {
      result.current.setAllocationForm({
        yearMonth: '2026-06',
        totalAmount: 1000,
        allocationBaseValue: 100,
      })
    })

    await act(async () => {
      await result.current.handleAllocationSubmit()
    })

    expect(indirectCostApi.recordAllocation).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('停用成本中心不可录入分摊')
  })

  it('keeps a newly recorded allocation visible when the follow-up allocation refresh fails', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    const createdAllocation = {
      id: 'alloc-created',
      yearMonth: '2026-06',
      totalAmount: 1200,
      allocationBaseValue: 300,
      allocationRate: 4,
    }
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())
    vi.mocked(indirectCostApi.getAllocations)
      .mockResolvedValueOnce({ list: [] } as any)
      .mockRejectedValueOnce(new Error('refresh failed'))
    vi.mocked(indirectCostApi.recordAllocation).mockResolvedValueOnce({
      ...createdAllocation,
      rate: 4,
    } as any)

    await act(async () => {
      await result.current.openAllocation(mockCenter as any)
    })
    act(() => {
      result.current.setAllocationForm({
        yearMonth: '2026-06',
        totalAmount: 1200,
        allocationBaseValue: 300,
      })
    })

    await act(async () => {
      await result.current.handleAllocationSubmit()
    })

    expect(indirectCostApi.recordAllocation).toHaveBeenCalledWith(mockCenter.id, {
      yearMonth: '2026-06',
      totalAmount: 1200,
      allocationBaseValue: 300,
    })
    expect(result.current.allocations).toEqual(expect.arrayContaining([
      expect.objectContaining(createdAllocation),
    ]))
    expect(toast.success).toHaveBeenCalledWith('分摊录入成功，单位分摊率：¥4.0000')
    expect(toast.error).not.toHaveBeenCalledWith('分摊录入失败')
  })

  it('shows the backend delete protection reason when deletion fails', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    const reason = '成本中心已有 1 条分摊记录，不可删除'
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())
    vi.mocked(indirectCostApi.delete).mockRejectedValueOnce({
      response: { data: { error: { message: reason } } },
    })

    act(() => {
      result.current.openDelete(mockCenter as any)
    })

    await act(async () => {
      await result.current.handleDelete()
    })

    expect(indirectCostApi.delete).toHaveBeenCalledWith(mockCenter.id)
    expect(toast.error).toHaveBeenCalledWith(reason)
  })

  it('refreshes stats after editing a cost center without changing list total', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getStats).toHaveBeenCalledTimes(1))
    vi.mocked(indirectCostApi.getStats).mockClear()
    vi.mocked(indirectCostApi.update).mockResolvedValueOnce({} as any)
    vi.mocked(indirectCostApi.getStats).mockResolvedValueOnce({
      total: 1,
      active: 0,
      totalMonthly: 2000,
      allocationCount: 0,
    } as any)

    act(() => {
      result.current.openEdit(mockCenter as any)
      result.current.setForm({
        code: mockCenter.code,
        name: mockCenter.name,
        costType: mockCenter.costType,
        monthlyAmount: 2000,
        allocationBase: mockCenter.allocationBase,
        description: '',
        status: 'inactive',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(indirectCostApi.update).toHaveBeenCalledWith(mockCenter.id, expect.objectContaining({
      monthlyAmount: 2000,
      status: 'inactive',
    }))
    await waitFor(() => expect(indirectCostApi.getStats).toHaveBeenCalledTimes(1))
    expect(result.current.stats).toMatchObject({
      total: 1,
      active: 0,
      totalMonthly: 2000,
      allocationCount: 0,
    })
  })

  it('does not send all as a real status filter', async () => {
    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())
    vi.mocked(indirectCostApi.getList).mockClear()

    act(() => {
      result.current.handleStatusChange('all')
    })

    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())
    expect(indirectCostApi.getList).toHaveBeenLastCalledWith(expect.not.objectContaining({
      status: 'all',
    }))
  })

  it('uses keyword from URL so audit links open a filtered indirect cost center list', async () => {
    window.history.replaceState(null, '', '/indirect-costs?keyword=IDC-DEEP-001')

    const { result } = renderHook(() => useCostCenterPage())

    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      keyword: 'IDC-DEEP-001',
    })))
    await waitFor(() => expect(indirectCostApi.getStats).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'IDC-DEEP-001',
    })))
    expect(result.current.keyword).toBe('IDC-DEEP-001')
    expect(result.current.searchInput).toBe('IDC-DEEP-001')
  })

  it('focuses the newly created indirect cost center so allocation users can confirm the cost source', async () => {
    window.history.replaceState(null, '', '/indirect-costs?keyword=old-cost-center')
    vi.mocked(indirectCostApi.create).mockResolvedValue({
      id: 'cc-created',
      code: 'IDC-CREATED-001',
      name: '新建管理费用中心',
    } as any)

    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())

    act(() => {
      result.current.handleStatusChange('inactive')
      result.current.openCreate()
      result.current.setForm({
        code: 'IDC-DRAFT-001',
        name: '新建管理费用中心',
        costType: 'admin',
        monthlyAmount: 3600,
        allocationBase: 'sample_count',
        description: '用于月度间接成本分摊',
        status: 'active',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(indirectCostApi.create).toHaveBeenCalledWith(expect.objectContaining({
      code: 'IDC-DRAFT-001',
      name: '新建管理费用中心',
      costType: 'admin',
      monthlyAmount: 3600,
      allocationBase: 'sample_count',
      description: '用于月度间接成本分摊',
      status: 'active',
    }))
    expect(result.current.keyword).toBe('IDC-CREATED-001')
    expect(result.current.searchInput).toBe('IDC-CREATED-001')
    expect(result.current.filterStatus).toBe('')
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      keyword: 'IDC-CREATED-001',
    })))
  })

  it('keeps the newly created indirect cost center visible when the follow-up list refresh fails', async () => {
    vi.mocked(indirectCostApi.getList)
      .mockResolvedValueOnce({ list: [], pagination: { page: 1, pageSize: 20, total: 0 } } as any)
      .mockRejectedValueOnce(new Error('refresh failed'))
    vi.mocked(indirectCostApi.create).mockResolvedValueOnce({
      id: 'cc-visible',
      code: 'IDC-VISIBLE-001',
      name: '新建信息化费用中心',
      costType: 'it',
      monthlyAmount: 4200,
      allocationBase: 'sample_count',
      description: '用于成本结账分摊',
      status: 'active',
    } as any)

    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(indirectCostApi.getList).toHaveBeenCalled())

    act(() => {
      result.current.openCreate()
      result.current.setForm({
        code: 'IDC-DRAFT-VISIBLE',
        name: '新建信息化费用中心',
        costType: 'it',
        monthlyAmount: 4200,
        allocationBase: 'sample_count',
        description: '用于成本结账分摊',
        status: 'active',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(result.current.keyword).toBe('IDC-VISIBLE-001')
    expect(result.current.data).toEqual([
      expect.objectContaining({
        id: 'cc-visible',
        code: 'IDC-VISIBLE-001',
        name: '新建信息化费用中心',
        costType: 'it',
        monthlyAmount: 4200,
        allocationBase: 'sample_count',
        description: '用于成本结账分摊',
        status: 'active',
      }),
    ])
    expect(result.current.total).toBe(1)
  })

  it('removes a deleted indirect cost center from the current list when the follow-up refresh fails', async () => {
    const keptCenter = {
      ...mockCenter,
      id: 'cc-kept',
      code: 'IDC-KEPT-001',
      name: '保留管理费用',
    }
    vi.mocked(indirectCostApi.getList)
      .mockResolvedValueOnce({
        list: [mockCenter, keptCenter],
        pagination: { page: 1, pageSize: 20, total: 2 },
      } as any)
      .mockRejectedValueOnce(new Error('delete refresh failed'))
    vi.mocked(indirectCostApi.delete).mockResolvedValueOnce({ success: true } as any)

    const { result } = renderHook(() => useCostCenterPage())
    await waitFor(() => expect(result.current.data).toHaveLength(2))

    act(() => {
      result.current.openDelete(result.current.data[0] as any)
    })

    await act(async () => {
      await result.current.handleDelete()
    })

    expect(indirectCostApi.delete).toHaveBeenCalledWith(mockCenter.id)
    expect(result.current.data).toEqual([
      expect.objectContaining({
        id: 'cc-kept',
        code: 'IDC-KEPT-001',
      }),
    ])
    expect(result.current.total).toBe(1)
    expect(result.current.modalType).toBeNull()
  })
})
