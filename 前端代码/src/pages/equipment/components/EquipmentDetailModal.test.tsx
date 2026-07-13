import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { equipmentApi } from '@/api/master'
import { EquipmentDetailModal } from './EquipmentDetailModal'
import type { Equipment } from '@/types'

vi.mock('@/api/master', () => ({
  equipmentApi: {
    getDetail: vi.fn(),
    getUsage: vi.fn(),
    recordUsage: vi.fn(),
  },
  // P1-05：EquipmentDetailModal 新增可选「关联项目」选择器，需要项目列表
  projectApi: {
    getList: vi.fn().mockResolvedValue({ list: [], pagination: { total: 0 } }),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const mockEquipment: Equipment = {
  id: 'eq-1',
  code: 'EQ-001',
  name: '组织脱水机',
  model: 'TP-100',
  manufacturer: 'Leica',
  purchasePrice: 100000,
  purchaseDate: '2026-01-01',
  depreciableLifeYears: 5,
  residualValue: 10000,
  depreciationMethod: 'straight_line',
  totalCapacity: 0,
  capacityUnit: 'minutes',
  status: 'active',
  locationId: 'LOC-1',
  typeId: null,
  typeName: null,
  annualDepreciation: 18000,
  accumulatedDepreciation: 300,
  netBookValue: 99700,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-06-16T00:00:00Z',
}

describe('EquipmentDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(equipmentApi.getDetail).mockResolvedValue(mockEquipment as any)
    vi.mocked(equipmentApi.getUsage).mockResolvedValue({
      list: [
        {
          id: 'usage-1',
          equipmentId: 'eq-1',
          usageMinutes: 60,
          usageCount: 1,
          depreciationCost: 2.05,
          operator: 'admin',
          usageDate: '2026-06-16',
          createdAt: '2026-06-16T10:00:00Z',
        },
      ],
      pagination: { page: 1, pageSize: 5, total: 1 },
    } as any)
    vi.mocked(equipmentApi.recordUsage).mockResolvedValue({
      id: 'usage-2',
      depreciationCost: 1.03,
    } as any)
  })

  it('renders equipment depreciation detail and recent usage records', async () => {
    render(
      <EquipmentDetailModal
        open
        row={mockEquipment}
        onClose={vi.fn()}
        onEdit={vi.fn()}
      />
    )

    expect(screen.getByRole('dialog', { name: '设备详情 - 组织脱水机' })).toBeInTheDocument()
    expect(screen.getByText('EQ-001')).toBeInTheDocument()
    expect(screen.getByText('未分类')).toBeInTheDocument()
    expect(screen.getByText('直线法')).toBeInTheDocument()
    expect(screen.getByText('¥18,000.00')).toBeInTheDocument()
    expect(screen.getByText('¥300.00')).toBeInTheDocument()

    await waitFor(() => expect(equipmentApi.getDetail).toHaveBeenCalledWith('eq-1'))
    await waitFor(() => expect(equipmentApi.getUsage).toHaveBeenCalledWith('eq-1', { page: 1, pageSize: 5 }))
    expect(await screen.findByText('60 分钟')).toBeInTheDocument()
    expect(screen.getByText('¥2.05')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
  })

  it('records equipment usage and refreshes detail and usage list', async () => {
    render(
      <EquipmentDetailModal
        open
        row={mockEquipment}
        onClose={vi.fn()}
        onEdit={vi.fn()}
      />
    )

    await waitFor(() => expect(equipmentApi.getUsage).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText('使用时长'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('使用次数'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '登记使用' }))

    await waitFor(() => expect(equipmentApi.recordUsage).toHaveBeenCalledWith('eq-1', expect.objectContaining({
      usageMinutes: 30,
      usageCount: 2,
    })))
    await waitFor(() => expect(equipmentApi.getDetail).toHaveBeenCalledTimes(2))
    expect(equipmentApi.getUsage).toHaveBeenCalledTimes(2)
  })

  // #138：登记使用是写操作（后端 POST /equipment/:id/usage 要求 equipment:W）。前端与之对齐——
  // 只读用户（canEdit=false）既看不到「编辑设备」也看不到「登记使用」写表单，但使用记录（读）不回归。
  it('hides both edit and usage registration for read-only viewers, keeps usage history', async () => {
    render(
      <EquipmentDetailModal
        open
        row={mockEquipment}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        canEdit={false}
      />
    )

    await waitFor(() => expect(equipmentApi.getUsage).toHaveBeenCalledTimes(1))
    // 写操作入口对只读用户隐藏（与后端 equipment:W 守卫一致）
    expect(screen.queryByRole('button', { name: '编辑设备' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登记使用' })).not.toBeInTheDocument()
    // 读不回归：使用记录历史仍可查看
    expect(await screen.findByText('60 分钟')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
  })
})
