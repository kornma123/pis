import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { laborTimeApi } from '@/api/master'
import { useLaborTimePage } from './useLaborTimePage'

vi.mock('@/api/master', () => ({
  laborTimeApi: {
    getList: vi.fn(),
    getStats: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const laborTime = {
  id: 'labor-1',
  stepCode: 'LAB-IHC-LOCKED',
  stepName: '抗体孵育',
  projectType: 'ihc',
  standardMinutes: 30,
  laborRatePerMinute: 2,
  isEquipmentStep: false,
  description: '',
  sortOrder: 10,
  referenceSource: 'system',
  referenceSourceLabel: '系统预设',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
} as const

describe('useLaborTimePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    localStorage.setItem('user', JSON.stringify({ role: 'admin' }))
    vi.mocked(laborTimeApi.getList).mockResolvedValue({ list: [laborTime], pagination: { total: 1 } } as any)
    vi.mocked(laborTimeApi.getStats).mockResolvedValue({ total: 1, totalMinutes: 30, avgRate: 2, equipmentSteps: 0 } as any)
    vi.mocked(laborTimeApi.update).mockResolvedValue({ id: 'labor-1' } as any)
  })

  it('allows finance users to manage labor time cost parameters', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'finance' }))

    const { result } = renderHook(() => useLaborTimePage())

    expect(result.current.canManageLaborTimes).toBe(true)
  })

  it('allows technician users to manage standard labor time steps', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'technician' }))

    const { result } = renderHook(() => useLaborTimePage())

    expect(result.current.canManageLaborTimes).toBe(true)
  })

  it('keeps pathologist users read-only for standard labor times', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'pathologist', permissions: ['labor_times:view'] }))

    const { result } = renderHook(() => useLaborTimePage())

    expect(result.current.canManageLaborTimes).toBe(false)
  })

  it('keeps backend-controlled step code and project type out of edit updates', async () => {
    const { result } = renderHook(() => useLaborTimePage())
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    act(() => {
      result.current.openEdit(laborTime as any)
      result.current.setForm({
        standardMinutes: laborTime.standardMinutes,
        laborRatePerMinute: laborTime.laborRatePerMinute,
        isEquipmentStep: laborTime.isEquipmentStep,
        description: laborTime.description,
        sortOrder: laborTime.sortOrder,
        referenceSource: laborTime.referenceSource,
        stepCode: 'LAB-CHANGED-BY-UI',
        projectType: 'he',
        stepName: '更新后的抗体孵育',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(laborTimeApi.update).toHaveBeenCalledWith('labor-1', expect.objectContaining({
      stepCode: 'LAB-IHC-LOCKED',
      projectType: 'ihc',
      stepName: '更新后的抗体孵育',
    }))
  })

  it('uses keyword from URL so audit links open a filtered labor time list', async () => {
    window.history.replaceState(null, '', '/labor-times?keyword=LAB-DEEP-001')

    const { result } = renderHook(() => useLaborTimePage())

    await waitFor(() => expect(laborTimeApi.getList).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      keyword: 'LAB-DEEP-001',
    })))
    await waitFor(() => expect(laborTimeApi.getStats).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'LAB-DEEP-001',
    })))
    expect(result.current.searchInput).toBe('LAB-DEEP-001')
  })

  it('focuses the newly created labor time step so costing users can confirm the labor cost input', async () => {
    window.history.replaceState(null, '', '/labor-times?keyword=old-labor-step')
    vi.mocked(laborTimeApi.create).mockResolvedValue({
      id: 'labor-created',
      stepCode: 'LAB-CREATED-001',
      stepName: '新建切片步骤',
    } as any)

    const { result } = renderHook(() => useLaborTimePage())
    await waitFor(() => expect(laborTimeApi.getList).toHaveBeenCalled())

    act(() => {
      result.current.handleProjectTypeChange('ihc')
      result.current.handleReferenceSourceChange('supplier')
      result.current.openCreate()
    })
    act(() => {
      result.current.setForm({
        ...result.current.form,
        stepCode: 'LAB-DRAFT-001',
        stepName: '新建切片步骤',
        projectType: 'ihc',
        standardMinutes: 18,
        laborRatePerMinute: 2.5,
        isEquipmentStep: false,
        description: '用于人工成本核算',
        sortOrder: 20,
        referenceSource: 'system',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(laborTimeApi.create).toHaveBeenCalledWith(expect.objectContaining({
      stepCode: 'LAB-DRAFT-001',
      stepName: '新建切片步骤',
      projectType: 'ihc',
      standardMinutes: 18,
      laborRatePerMinute: 2.5,
      description: '用于人工成本核算',
      sortOrder: 20,
      referenceSource: 'system',
    }))
    expect(result.current.searchInput).toBe('LAB-CREATED-001')
    expect(result.current.filterProjectType).toBe('')
    expect(result.current.filterReferenceSource).toBe('')
    await waitFor(() => {
      expect(laborTimeApi.getList).toHaveBeenCalledWith(expect.objectContaining({
        page: 1,
        pageSize: 20,
        keyword: 'LAB-CREATED-001',
      }))
    })
  })

  it('keeps the newly created labor time step visible when the follow-up list refresh fails', async () => {
    vi.mocked(laborTimeApi.getList)
      .mockResolvedValueOnce({ list: [], pagination: { total: 0, page: 1, pageSize: 20 } } as any)
      .mockRejectedValueOnce(new Error('refresh failed'))
    vi.mocked(laborTimeApi.create).mockResolvedValueOnce({
      id: 'labor-visible',
      stepCode: 'LAB-VISIBLE-001',
      stepName: '新建包埋步骤',
      projectType: 'he',
      standardMinutes: 22,
      laborRatePerMinute: 2.8,
      isEquipmentStep: false,
      description: '现场确认人工成本输入',
      sortOrder: 30,
      referenceSource: 'system',
    } as any)

    const { result } = renderHook(() => useLaborTimePage())
    await waitFor(() => expect(laborTimeApi.getList).toHaveBeenCalled())

    act(() => {
      result.current.openCreate()
    })
    act(() => {
      result.current.setForm({
        ...result.current.form,
        stepCode: 'LAB-DRAFT-VISIBLE',
        stepName: '新建包埋步骤',
        projectType: 'he',
        standardMinutes: 22,
        laborRatePerMinute: 2.8,
        isEquipmentStep: false,
        description: '现场确认人工成本输入',
        sortOrder: 30,
        referenceSource: 'system',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(result.current.searchInput).toBe('LAB-VISIBLE-001')
    expect(result.current.data).toEqual([
      expect.objectContaining({
        id: 'labor-visible',
        stepCode: 'LAB-VISIBLE-001',
        stepName: '新建包埋步骤',
        projectType: 'he',
        standardMinutes: 22,
        laborRatePerMinute: 2.8,
        description: '现场确认人工成本输入',
      }),
    ])
    expect(result.current.total).toBe(1)
  })

  it('removes an archived labor time step from the current list when the follow-up refresh fails', async () => {
    const keptLaborTime = {
      ...laborTime,
      id: 'labor-kept',
      stepCode: 'LAB-KEPT-001',
      stepName: '保留步骤',
      standardMinutes: 12,
    }
    vi.mocked(laborTimeApi.getList)
      .mockResolvedValueOnce({
        list: [laborTime, keptLaborTime],
        pagination: { total: 2, page: 1, pageSize: 20 },
      } as any)
      .mockRejectedValueOnce(new Error('delete refresh failed'))
    vi.mocked(laborTimeApi.delete).mockResolvedValueOnce({ success: true } as any)

    const { result } = renderHook(() => useLaborTimePage())
    await waitFor(() => expect(result.current.data).toHaveLength(2))

    act(() => {
      result.current.openDelete(result.current.data[0])
    })

    await act(async () => {
      await result.current.handleDelete()
    })

    expect(laborTimeApi.delete).toHaveBeenCalledWith('labor-1')
    expect(result.current.data).toEqual([
      expect.objectContaining({
        id: 'labor-kept',
        stepCode: 'LAB-KEPT-001',
      }),
    ])
    expect(result.current.total).toBe(1)
    expect(result.current.modalType).toBeNull()
  })
})
