import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportsApi } from '@/api/reports'
import SupplierCostAnalysis from './SupplierCostAnalysis'

vi.mock('@/api/reports', () => ({
  reportsApi: {
    getCostBySupplier: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    formatCurrency: (num: number | undefined) => {
      if (num === undefined || num === null) return '-'
      return `¥${num.toFixed(2)}`
    },
  }
})

describe('SupplierCostAnalysis', () => {
  beforeEach(() => {
    vi.mocked(reportsApi.getCostBySupplier).mockReset()
  })

  it('explains supplier net cost and links refunded return evidence', async () => {
    vi.mocked(reportsApi.getCostBySupplier).mockResolvedValue({
      suppliers: [
        {
          id: 'supplier-1',
          name: '华东试剂供应商',
          grossAmount: 500,
          refundedAmount: 120,
          refundedReturnCount: 1,
          amount: 380,
          ratio: 100,
          orderCount: 1,
          status: 'long-term',
          supplierReturnUrl: '/supplier-returns?supplierId=supplier-1&status=refunded',
        },
      ],
    } as any)

    render(
      <MemoryRouter>
        <SupplierCostAnalysis />
      </MemoryRouter>,
    )

    await waitFor(() => expect(reportsApi.getCostBySupplier).toHaveBeenCalledWith({}))

    expect(screen.getByText('华东试剂供应商')).toBeInTheDocument()
    expect(screen.getAllByText('¥500.00')).toHaveLength(2)
    expect(screen.getAllByText('¥120.00')).toHaveLength(2)
    expect(screen.getAllByText('¥380.00')).toHaveLength(2)
    expect(screen.getAllByText('已退款退供单')[0].parentElement).toHaveTextContent('1')
    expect(screen.getByRole('link', { name: '查看退款退供证据' })).toHaveAttribute(
      'href',
      '/supplier-returns?supplierId=supplier-1&status=refunded',
    )
  })

  it('passes the selected report date range to the backend', async () => {
    vi.mocked(reportsApi.getCostBySupplier).mockResolvedValue({ suppliers: [] } as any)
    render(
      <MemoryRouter>
        <SupplierCostAnalysis />
      </MemoryRouter>,
    )
    await waitFor(() => expect(reportsApi.getCostBySupplier).toHaveBeenCalledWith({}))

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2033-01-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2033-01-31' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() => expect(reportsApi.getCostBySupplier).toHaveBeenLastCalledWith({
      startDate: '2033-01-01',
      endDate: '2033-01-31',
    }))
  })
})
