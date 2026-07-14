import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { equipmentApi } from '@/api/master'
import { useEquipmentPage } from './useEquipmentPage'

vi.mock('@/api/master', () => ({
  equipmentApi: {
    getTypes: vi.fn(),
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

const equipment = {
  id: 'eq-1',
  code: 'EQ-001',
  name: '染色机',
  model: 'D-1',
  manufacturer: 'DAKO',
  purchasePrice: 100000,
  purchaseDate: '2026-01-01',
  depreciableLifeYears: 5,
  residualValue: 10000,
  depreciationMethod: 'straight_line',
  totalCapacity: 0,
  capacityUnit: 'minutes',
  status: 'active',
  locationId: '',
  typeId: '',
  typeName: null,
  annualDepreciation: 18000,
  accumulatedDepreciation: 0,
  netBookValue: 100000,
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
} as const

describe('useEquipmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    localStorage.setItem('user', JSON.stringify({ role: 'admin', capabilities: { equipment: 'W' } }))
    vi.mocked(equipmentApi.getTypes).mockResolvedValue({ list: [], pagination: { total: 0 } } as any)
    vi.mocked(equipmentApi.getList).mockResolvedValue({ list: [equipment], pagination: { total: 1 } } as any)
    vi.mocked(equipmentApi.getStats).mockResolvedValue({ total: 1, active: 1, inactive: 0, scrapped: 0, totalValue: 100000 } as any)
    vi.mocked(equipmentApi.update).mockResolvedValue({ id: 'eq-1' } as any)
  })

  it('allows users holding equipment:W capability to manage assets', () => {
    // 判据读能力矩阵（后端登录下发），与后端 requirePermission('equipment','W') 对齐——
    // 不再硬编码 role∈{admin,technician}，故 technician/finance/lab_director 等任何持 equipment:W 者一致放行。
    localStorage.setItem('user', JSON.stringify({ role: 'technician', capabilities: { equipment: 'W' } }))

    const { result } = renderHook(() => useEquipmentPage())

    expect(result.current.canManageEquipmentAssets).toBe(true)
  })

  it('keeps equipment:R-only users read-only for equipment assets', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'pathologist', capabilities: { equipment: 'R' } }))

    const { result } = renderHook(() => useEquipmentPage())

    expect(result.current.canManageEquipmentAssets).toBe(false)
  })

  it('keeps backend-controlled equipment code out of edit updates', async () => {
    const { result } = renderHook(() => useEquipmentPage())
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    act(() => {
      result.current.openEdit(equipment as any)
      result.current.setForm({
        ...result.current.form,
        code: 'EQ-CHANGED-BY-UI',
        name: '更新后的染色机',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(equipmentApi.update).toHaveBeenCalledWith('eq-1', expect.objectContaining({
      code: 'EQ-001',
      name: '更新后的染色机',
    }))
  })

  it('keeps deleted equipment review context from audit links', async () => {
    window.history.replaceState(null, '', '/equipment?keyword=EQ-DEEP-001&includeDeleted=true')
    vi.mocked(equipmentApi.getList).mockResolvedValue({
      list: [{ ...equipment, id: 'eq-deleted-001', isDeleted: true }],
      pagination: { total: 1 },
    } as any)

    const { result } = renderHook(() => useEquipmentPage())

    await waitFor(() => expect(equipmentApi.getList).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      keyword: 'EQ-DEEP-001',
      includeDeleted: true,
    })))
    await waitFor(() => expect(equipmentApi.getStats).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'EQ-DEEP-001',
      includeDeleted: true,
    })))
    expect(result.current.keyword).toBe('EQ-DEEP-001')
    expect(result.current.searchInput).toBe('EQ-DEEP-001')
    expect(result.current.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'eq-deleted-001', isDeleted: true }),
    ]))
  })

  it('focuses the newly created equipment so costing users can confirm the depreciation input', async () => {
    window.history.replaceState(null, '', '/equipment?keyword=old-equipment')
    vi.mocked(equipmentApi.create).mockResolvedValue({
      id: 'eq-created',
      code: 'EQ-CREATED-001',
      name: '新建切片机',
    } as any)

    const { result } = renderHook(() => useEquipmentPage())
    await waitFor(() => expect(equipmentApi.getList).toHaveBeenCalled())

    act(() => {
      result.current.handleStatusChange('inactive')
      result.current.handleTypeChange('type-old')
      result.current.openCreate()
      result.current.setForm({
        code: 'EQ-DRAFT-001',
        name: '新建切片机',
        model: 'S-1',
        manufacturer: 'Leica',
        purchasePrice: 120000,
        purchaseDate: '2026-06-20',
        depreciableLifeYears: 6,
        residualValue: 12000,
        depreciationMethod: 'straight_line',
        totalCapacity: 0,
        capacityUnit: '',
        status: 'active',
        locationId: '',
        typeId: 'type-new',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(equipmentApi.create).toHaveBeenCalledWith(expect.objectContaining({
      code: 'EQ-DRAFT-001',
      name: '新建切片机',
      purchasePrice: 120000,
      depreciableLifeYears: 6,
      residualValue: 12000,
      depreciationMethod: 'straight_line',
      status: 'active',
      typeId: 'type-new',
    }))
    expect(result.current.keyword).toBe('EQ-CREATED-001')
    expect(result.current.searchInput).toBe('EQ-CREATED-001')
    expect(result.current.filterStatus).toBe('')
    expect(result.current.filterTypeId).toBe('')
    await waitFor(() => expect(equipmentApi.getList).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      keyword: 'EQ-CREATED-001',
    })))
  })

  it('keeps the newly created equipment visible when the focused refresh fails', async () => {
    vi.mocked(equipmentApi.getList)
      .mockResolvedValueOnce({ list: [], pagination: { page: 1, pageSize: 20, total: 0 } } as any)
      .mockRejectedValueOnce(new Error('refresh failed'))
    vi.mocked(equipmentApi.create).mockResolvedValueOnce({
      id: 'eq-visible',
      code: 'EQ-VISIBLE-001',
      name: '可回看包埋机',
      model: 'E-1',
      manufacturer: 'Sakura',
      purchasePrice: 90000,
      purchaseDate: '2026-06-20',
      depreciableLifeYears: 5,
      residualValue: 9000,
      depreciationMethod: 'straight_line',
      totalCapacity: 0,
      capacityUnit: '',
      status: 'active',
      typeId: 'type-visible',
    } as any)

    const { result } = renderHook(() => useEquipmentPage())
    await waitFor(() => expect(equipmentApi.getList).toHaveBeenCalled())

    act(() => {
      result.current.openCreate()
      result.current.setForm({
        code: 'EQ-DRAFT-VISIBLE',
        name: '可回看包埋机',
        model: 'E-1',
        manufacturer: 'Sakura',
        purchasePrice: 90000,
        purchaseDate: '2026-06-20',
        depreciableLifeYears: 5,
        residualValue: 9000,
        depreciationMethod: 'straight_line',
        totalCapacity: 0,
        capacityUnit: '',
        status: 'active',
        locationId: '',
        typeId: 'type-visible',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(result.current.keyword).toBe('EQ-VISIBLE-001')
    expect(result.current.data).toEqual([
      expect.objectContaining({
        id: 'eq-visible',
        code: 'EQ-VISIBLE-001',
        name: '可回看包埋机',
        annualDepreciation: 16200,
      }),
    ])
    expect(result.current.total).toBe(1)
  })
})
