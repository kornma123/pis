import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import EquipmentList from './EquipmentList'
import { useEquipmentPage } from './hooks/useEquipmentPage'

vi.mock('./hooks/useEquipmentPage', () => ({
  useEquipmentPage: vi.fn(),
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
  typeName: '染色设备',
  annualDepreciation: 18000,
  accumulatedDepreciation: 0,
  netBookValue: 100000,
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
}

function renderPage(pageOverrides = {}) {
  vi.mocked(useEquipmentPage).mockReturnValue({
    canManageEquipmentAssets: true,
    data: [equipment],
    loading: false,
    page: 1,
    pageSize: 20,
    total: 1,
    setPage: vi.fn(),
    setPageSize: vi.fn(),
    refresh: vi.fn(),
    stats: { total: 1, active: 1, inactive: 0, scrapped: 0, totalValue: 100000 },
    keyword: '',
    searchInput: '',
    setSearchInput: vi.fn(),
    filterStatus: '',
    setFilterStatus: vi.fn(),
    filterTypeId: '',
    setFilterTypeId: vi.fn(),
    handleStatusChange: vi.fn(),
    handleTypeChange: vi.fn(),
    typeOptions: [],
    modalType: null,
    setModalType: vi.fn(),
    editingId: null,
    detailRow: null,
    form: {
      code: '',
      name: '',
      model: '',
      manufacturer: '',
      purchasePrice: 0,
      purchaseDate: '',
      depreciableLifeYears: 5,
      residualValue: 0,
      depreciationMethod: 'straight_line',
      totalCapacity: 0,
      capacityUnit: '',
      status: 'active',
      locationId: '',
      typeId: '',
    },
    setForm: vi.fn(),
    handleSearch: vi.fn(),
    handleReset: vi.fn(),
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    openDetail: vi.fn(),
    openDelete: vi.fn(),
    handleSubmit: vi.fn(),
    handleDelete: vi.fn(),
    ...pageOverrides,
  } as ReturnType<typeof useEquipmentPage>)

  return render(
    <MemoryRouter>
      <EquipmentList />
    </MemoryRouter>
  )
}

describe('EquipmentList', () => {
  it('explains equipment delete impact before users remove a cost input', () => {
    renderPage({
      modalType: 'delete',
      detailRow: equipment,
    })

    expect(screen.getByRole('heading', { name: '确认删除' })).toBeInTheDocument()
    expect(screen.getByText('确定要删除设备「染色机」吗？删除后不会再进入新 BOM 设备选择、设备使用登记、折旧统计和月度成本计算；历史 BOM、使用记录、成本明细和审计记录仍保留可回看。')).toBeInTheDocument()
  })
})
