import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import IndirectCostCenterList from './IndirectCostCenterList'
import { useCostCenterPage } from './hooks/useCostCenterPage'

vi.mock('./hooks/useCostCenterPage', () => ({
  useCostCenterPage: vi.fn(),
}))

const costCenter = {
  id: 'cc-1',
  code: 'IDC-001',
  name: '房租成本',
  costType: 'rent',
  costTypeLabel: '房租',
  monthlyAmount: 1200,
  allocationBase: 'sample_count',
  description: '用于月度间接成本分摊',
  status: 'active',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
}

function renderPage(pageOverrides = {}) {
  vi.mocked(useCostCenterPage).mockReturnValue({
    data: [costCenter],
    loading: false,
    page: 1,
    pageSize: 20,
    total: 1,
    setPage: vi.fn(),
    setPageSize: vi.fn(),
    refresh: vi.fn(),
    stats: { total: 1, active: 1, totalMonthly: 1200, allocationCount: 0 },
    keyword: '',
    searchInput: '',
    setSearchInput: vi.fn(),
    filterStatus: '',
    setFilterStatus: vi.fn(),
    handleStatusChange: vi.fn(),
    modalType: null,
    setModalType: vi.fn(),
    editingId: null,
    detailRow: null,
    form: {
      code: '',
      name: '',
      costType: 'other',
      monthlyAmount: 0,
      allocationBase: 'sample_count',
      description: '',
      status: 'active',
    },
    setForm: vi.fn(),
    allocationForm: {
      yearMonth: '2026-06',
      totalAmount: 0,
      allocationBaseValue: 1,
    },
    setAllocationForm: vi.fn(),
    allocations: [],
    handleSearch: vi.fn(),
    handleReset: vi.fn(),
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    openDelete: vi.fn(),
    openAllocation: vi.fn(),
    handleSubmit: vi.fn(),
    handleDelete: vi.fn(),
    handleAllocationSubmit: vi.fn(),
    COST_TYPE_OPTIONS: [],
    ALLOCATION_BASE_OPTIONS: [],
    ...pageOverrides,
  } as ReturnType<typeof useCostCenterPage>)

  return render(<IndirectCostCenterList />)
}

describe('IndirectCostCenterList', () => {
  it('explains indirect cost center delete impact before users remove a cost source', () => {
    renderPage({
      modalType: 'delete',
      detailRow: costCenter,
    })

    expect(screen.getByRole('heading', { name: '确认删除' })).toBeInTheDocument()
    expect(screen.getByText('确定要删除成本中心「房租成本」吗？删除后不会再用于新月度分摊、项目成本归集、成本结账和审计筛选；已有分摊记录的成本中心后端会阻止删除，历史分摊、项目成本和审计记录仍保留可回看。')).toBeInTheDocument()
  })
})
