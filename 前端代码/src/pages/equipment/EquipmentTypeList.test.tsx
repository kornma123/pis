import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import EquipmentTypeList from './EquipmentTypeList'
import { useEquipmentTypePage } from './hooks/useEquipmentTypePage'

vi.mock('./hooks/useEquipmentTypePage', () => ({
  useEquipmentTypePage: vi.fn(),
}))

const equipmentType = {
  id: 'type-1',
  code: 'EQT-001',
  name: '染色设备',
  description: '染色相关设备',
  status: 'active',
  defaultPurchasePrice: 100000,
  defaultDepreciableLifeYears: 5,
  defaultValue: 10000,
  defaultDepreciationMethod: 'straight_line',
  defaultTotalCapacity: 0,
  defaultCapacityUnit: 'minutes',
  equipmentCount: 3,
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
}

function renderPage(pageOverrides = {}) {
  vi.mocked(useEquipmentTypePage).mockReturnValue({
    canManageEquipmentTypes: true,
    data: [equipmentType],
    loading: false,
    page: 1,
    pageSize: 20,
    total: 1,
    setPage: vi.fn(),
    setPageSize: vi.fn(),
    refresh: vi.fn(),
    stats: { total: 1, active: 1, equipmentCount: 3 },
    searchInput: '',
    setSearchInput: vi.fn(),
    keyword: '',
    statusFilter: '',
    setStatusFilter: vi.fn(),
    handleStatusChange: vi.fn(),
    modalType: null,
    form: {
      code: '',
      name: '',
      description: '',
      status: 'active',
      defaultPurchasePrice: 0,
      defaultDepreciableLifeYears: 5,
      defaultValue: 0,
      defaultDepreciationMethod: 'straight_line',
      defaultTotalCapacity: 0,
      defaultCapacityUnit: 'minutes',
    },
    setForm: vi.fn(),
    editingId: null,
    deleteTarget: null,
    setDeleteTarget: vi.fn(),
    submitting: false,
    handleSearch: vi.fn(),
    handleReset: vi.fn(),
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    closeModal: vi.fn(),
    handleSubmit: vi.fn(),
    handleDelete: vi.fn(),
    ...pageOverrides,
  } as ReturnType<typeof useEquipmentTypePage>)

  return render(<EquipmentTypeList />)
}

describe('EquipmentTypeList', () => {
  it('explains equipment type delete impact before users remove a costing category', () => {
    renderPage({
      deleteTarget: equipmentType,
    })

    expect(screen.getByRole('heading', { name: '删除设备类型' })).toBeInTheDocument()
    expect(screen.getByText('确定要删除设备类型“染色设备”吗？删除后不会再用于新建设备的类型选择、默认折旧口径、BOM 成本计算和折旧统计；已有设备、历史 BOM 成本、使用记录和审计记录仍保留可回看。')).toBeInTheDocument()
  })
})
