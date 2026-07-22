import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { equipmentApi } from '@/api/master'
import { useEquipmentTypePage } from './useEquipmentTypePage'

vi.mock('@/api/master', () => ({
  equipmentApi: {
    getTypes: vi.fn(),
    getTypeStats: vi.fn(),
    createType: vi.fn(),
    updateType: vi.fn(),
    deleteType: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const equipmentType = {
  id: 'type-1',
  code: 'EQT-001',
  name: '染色设备',
  description: '',
  status: 'active',
  defaultPurchasePrice: 100000,
  defaultDepreciableLifeYears: 5,
  defaultValue: 10000,
  defaultDepreciationMethod: 'straight_line',
  defaultTotalCapacity: 0,
  defaultCapacityUnit: 'minutes',
  equipmentCount: 0,
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
} as const

describe('useEquipmentTypePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    localStorage.setItem('user', JSON.stringify({ role: 'admin', capabilities: { equipment: 'W' } }))
    vi.mocked(equipmentApi.getTypes).mockResolvedValue({ list: [equipmentType], pagination: { total: 1 } } as any)
    vi.mocked(equipmentApi.getTypeStats).mockResolvedValue({ total: 1, active: 1, equipmentCount: 0 } as any)
    vi.mocked(equipmentApi.updateType).mockResolvedValue({ id: 'type-1' } as any)
  })

  // 判据读能力矩阵（后端登录下发），与后端 requirePermission('equipment','W') 对齐。
  //
  // ⚠️ 夹具角色是**刻意挑的**，必须对「能力矩阵 vs 旧角色白名单 ['admin','technician']」有分辨力：
  //   下面两例各自在新旧判据下答案**相反**，故实现一旦退回旧白名单，本 spec 必然变红。
  //   （反例：用 technician 做 W 正例、pathologist 做 R 反例——两者在新旧判据下答案相同 → 整组假绿，
  //    退回旧白名单仍 7/7 passed。这正是本 spec 上一版的缺陷。）
  //
  // W 正例取 lab_director：持 equipment:'W'（rbac-matrix.ts:43）但**不在**旧白名单 → 旧=false / 新=true。
  //   finance 同样可用（equipment:'W'，rbac-matrix.ts:84）。这两个角色正是旧判据误藏的人群。
  it('allows users holding equipment:W capability to manage equipment types', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'lab_director', capabilities: { equipment: 'W' } }))

    const { result } = renderHook(() => useEquipmentTypePage())

    expect(result.current.canManageEquipmentTypes).toBe(true)
  })

  // R 反例取 technician：**在**旧白名单内 → 旧=true；但只持 equipment:'R' → 新=false。
  it('keeps equipment:R-only users read-only for equipment types', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'technician', capabilities: { equipment: 'R' } }))

    const { result } = renderHook(() => useEquipmentTypePage())

    expect(result.current.canManageEquipmentTypes).toBe(false)
  })

  // 能力矩阵存在但无 equipment 键（种子矩阵下 pathologist 的真实形状）→ 藏。
  // 与上一例走不同分支：上一例测「R 不蕴含 W」，本例测「模块缺失即拒」。
  it('keeps users without any equipment capability read-only for equipment types', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'pathologist', capabilities: {} }))

    const { result } = renderHook(() => useEquipmentTypePage())

    expect(result.current.canManageEquipmentTypes).toBe(false)
  })

  it('keeps backend-controlled type code and submits status changes on edit', async () => {
    const { result } = renderHook(() => useEquipmentTypePage())
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    act(() => {
      result.current.openEdit(equipmentType as any)
      result.current.setForm({
        ...result.current.form,
        code: 'EQT-CHANGED-BY-UI',
        name: '停用染色设备',
        status: 'inactive',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(equipmentApi.updateType).toHaveBeenCalledWith('type-1', expect.objectContaining({
      code: 'EQT-001',
      name: '停用染色设备',
      status: 'inactive',
    }))
  })

  it('keeps deleted equipment type review context from audit links', async () => {
    window.history.replaceState(null, '', '/equipment/types?keyword=EQT-DEEP-001&includeDeleted=true')
    vi.mocked(equipmentApi.getTypes).mockResolvedValue({
      list: [{ ...equipmentType, id: 'type-deleted-001', isDeleted: true }],
      pagination: { total: 1 },
    } as any)

    const { result } = renderHook(() => useEquipmentTypePage())

    await waitFor(() => expect(equipmentApi.getTypes).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      keyword: 'EQT-DEEP-001',
      includeDeleted: true,
    })))
    await waitFor(() => expect(equipmentApi.getTypeStats).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'EQT-DEEP-001',
      includeDeleted: true,
    })))
    expect(result.current.keyword).toBe('EQT-DEEP-001')
    expect(result.current.searchInput).toBe('EQT-DEEP-001')
    expect(result.current.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'type-deleted-001', isDeleted: true }),
    ]))
  })

  it('focuses the newly created equipment type so equipment users can confirm the default costing口径', async () => {
    window.history.replaceState(null, '', '/equipment/types?keyword=old-type')
    vi.mocked(equipmentApi.createType).mockResolvedValue({
      id: 'type-created',
      code: 'EQT-CREATED-001',
      name: '新建切片设备',
    } as any)

    const { result } = renderHook(() => useEquipmentTypePage())
    await waitFor(() => expect(equipmentApi.getTypes).toHaveBeenCalled())

    act(() => {
      result.current.handleStatusChange('inactive')
      result.current.openCreate()
      result.current.setForm({
        code: 'EQT-DRAFT-001',
        name: '新建切片设备',
        description: '用于切片设备默认折旧',
        status: 'active',
        defaultPurchasePrice: 120000,
        defaultDepreciableLifeYears: 6,
        defaultValue: 12000,
        defaultDepreciationMethod: 'straight_line',
        defaultTotalCapacity: 0,
        defaultCapacityUnit: 'minutes',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(equipmentApi.createType).toHaveBeenCalledWith(expect.objectContaining({
      code: 'EQT-DRAFT-001',
      name: '新建切片设备',
      defaultPurchasePrice: 120000,
      defaultDepreciableLifeYears: 6,
      defaultValue: 12000,
      defaultDepreciationMethod: 'straight_line',
      status: 'active',
    }))
    expect(result.current.keyword).toBe('EQT-CREATED-001')
    expect(result.current.searchInput).toBe('EQT-CREATED-001')
    expect(result.current.statusFilter).toBe('')
    await waitFor(() => expect(equipmentApi.getTypes).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      keyword: 'EQT-CREATED-001',
    })))
  })

  it('keeps the newly created equipment type visible when the focused refresh fails', async () => {
    vi.mocked(equipmentApi.getTypes)
      .mockResolvedValueOnce({ list: [], pagination: { page: 1, pageSize: 20, total: 0 } } as any)
      .mockRejectedValueOnce(new Error('refresh failed'))
    vi.mocked(equipmentApi.createType).mockResolvedValueOnce({
      id: 'type-visible',
      code: 'EQT-VISIBLE-001',
      name: '可回看包埋设备',
      description: '默认折旧进入设备成本',
      status: 'active',
      defaultPurchasePrice: 90000,
      defaultDepreciableLifeYears: 5,
      defaultValue: 9000,
      defaultDepreciationMethod: 'straight_line',
      defaultTotalCapacity: 0,
      defaultCapacityUnit: 'minutes',
    } as any)

    const { result } = renderHook(() => useEquipmentTypePage())
    await waitFor(() => expect(equipmentApi.getTypes).toHaveBeenCalled())

    act(() => {
      result.current.openCreate()
      result.current.setForm({
        code: 'EQT-DRAFT-VISIBLE',
        name: '可回看包埋设备',
        description: '默认折旧进入设备成本',
        status: 'active',
        defaultPurchasePrice: 90000,
        defaultDepreciableLifeYears: 5,
        defaultValue: 9000,
        defaultDepreciationMethod: 'straight_line',
        defaultTotalCapacity: 0,
        defaultCapacityUnit: 'minutes',
      })
    })

    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(result.current.keyword).toBe('EQT-VISIBLE-001')
    expect(result.current.data).toEqual([
      expect.objectContaining({
        id: 'type-visible',
        code: 'EQT-VISIBLE-001',
        name: '可回看包埋设备',
      }),
    ])
    expect(result.current.total).toBe(1)
  })
})
