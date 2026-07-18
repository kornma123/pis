import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AlertTable } from './components/AlertTable'
import type { AlertItem } from './hooks/useAlertsPage'

const alert: AlertItem = {
  id: 'AL-1', type: 'low-stock', level: 'warning', materialId: 'MAT-1',
  materialName: '试剂A', currentStock: 3, threshold: 10, message: '低库存',
  status: 'pending', createdAt: '2026-07-18T00:00:00.000Z',
} as AlertItem

function props(overrides: Record<string, unknown> = {}) {
  return {
    data: [], loading: false, error: null, total: 0, page: 1, pageSize: 10,
    filter: { keyword: '', type: 'all' as const, status: 'all' as const, dateRange: ['', ''] as [string, string] },
    quickFilter: 'all' as const, selectedIds: new Set<string>(),
    onFilterChange: vi.fn(), onQuickFilterChange: vi.fn(), onSelect: vi.fn(), onSelectAll: vi.fn(),
    onClearSelection: vi.fn(), onPageChange: vi.fn(), onPageSizeChange: vi.fn(),
    onBatchProcess: vi.fn(), onOpenModal: vi.fn(), onIgnore: vi.fn(), onGenerate: vi.fn(),
    onRetry: vi.fn(), hasActiveFilters: false,
    getAlertTypeInfo: () => ({ label: '库存不足', bg: '', text: '' }),
    getStatusInfo: () => ({ label: '待处理', bg: '', text: '' }),
    formatDate: (value: string) => value,
    ...overrides,
  }
}

describe('alerts truthful states', () => {
  it('renders request failure with retry instead of an empty or zero-success state', () => {
    const onRetry = vi.fn()
    render(<AlertTable {...props({ error: '预警服务暂时不可用', onRetry })} />)

    expect(screen.getByRole('alert')).toHaveTextContent('预警服务暂时不可用')
    expect(screen.queryByText('当前没有已记录的预警')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows absent rule identity as unavailable rather than inventing RULE-001', () => {
    render(<AlertTable {...props({ data: [alert], total: 1 })} />)
    expect(screen.getByText('未提供')).toBeInTheDocument()
    expect(screen.queryByText('RULE-001')).not.toBeInTheDocument()
  })
})
