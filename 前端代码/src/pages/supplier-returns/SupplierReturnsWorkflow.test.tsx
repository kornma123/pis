import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supplierReturnApi, purchaseOrderApi, inboundApi } from '@/api/inventory'
import { materialApi, supplierApi } from '@/api/master'
import { canAccess } from '@/lib/permissions'
import SupplierReturns from './SupplierReturns'

vi.mock('@/api/inventory', () => ({
  supplierReturnApi: { getList: vi.fn(), getById: vi.fn(), create: vi.fn(), updateStatus: vi.fn(), delete: vi.fn() },
  purchaseOrderApi: { getList: vi.fn() },
  inboundApi: { getList: vi.fn() },
}))

vi.mock('@/api/master', () => ({
  materialApi: { getList: vi.fn() },
  supplierApi: { getList: vi.fn() },
}))

vi.mock('@/lib/permissions', () => ({
  canAccess: vi.fn(),
  getUserRole: vi.fn(() => 'finance'),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const baseRecord = {
  id: 'SR-1', returnNo: 'SR-20260718-1', materialId: 'M-1', materialName: '试剂 A',
  quantity: 2, supplierId: 'S-1', supplierName: '供应商 A', reason: 'quality_issue',
  refundAmount: 100, status: 'pending' as const, operator: '仓管', createdAt: '2026-07-18T08:00:00Z', updatedAt: '2026-07-18T08:00:00Z',
}

function renderPage() {
  return render(<MemoryRouter><SupplierReturns /></MemoryRouter>)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(canAccess).mockImplementation((module, level) => module === 'supplier_returns' && (level === 'R' || level === 'W'))
  vi.mocked(materialApi.getList).mockResolvedValue({ list: [] } as never)
  vi.mocked(supplierApi.getList).mockResolvedValue({ list: [] } as never)
  vi.mocked(purchaseOrderApi.getList).mockResolvedValue({ list: [] } as never)
  vi.mocked(inboundApi.getList).mockResolvedValue({ list: [] } as never)
  vi.mocked(supplierReturnApi.getList).mockResolvedValue({ list: [], pagination: { page: 1, pageSize: 20, total: 0 } })
})

describe('Supplier return workflow truth and recovery', () => {
  it('uses the actual write capability instead of a hard-coded role list', async () => {
    renderPage()

    expect(await screen.findByRole('button', { name: '新建供应商退货' })).toBeInTheDocument()
    expect(canAccess).toHaveBeenCalledWith('supplier_returns', 'W')
  })

  it('renders list request failure as unknown rather than an empty result', async () => {
    vi.mocked(supplierReturnApi.getList).mockRejectedValue(new Error('network unavailable'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('供应商退货记录未加载')
    expect(screen.getByRole('button', { name: '重新加载供应商退货' })).toBeInTheDocument()
    expect(screen.queryByText('暂无退货记录')).not.toBeInTheDocument()
  })

  it('does not present a workflow flag as verified refund posting', async () => {
    vi.mocked(supplierReturnApi.getList).mockResolvedValue({
      list: [{ ...baseRecord, status: 'refunded' }],
      pagination: { page: 1, pageSize: 20, total: 1 },
    })
    renderPage()

    expect(await screen.findByText('退款状态已登记（未过账）')).toBeInTheDocument()
    expect(screen.queryByText('已退款')).not.toBeInTheDocument()
  })

  it('confirms a valid transition, locks duplicate submits, and only updates after evidence', async () => {
    const received = { ...baseRecord, status: 'received' as const }
    const pending = deferred<{ id: string; status: string }>()
    vi.mocked(supplierReturnApi.getList).mockResolvedValue({
      list: [received], pagination: { page: 1, pageSize: 20, total: 1 },
    })
    vi.mocked(supplierReturnApi.getById).mockResolvedValue(received)
    vi.mocked(supplierReturnApi.updateStatus).mockReturnValue(pending.promise as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '查看 SR-20260718-1' }))
    const detail = await screen.findByRole('dialog', { name: '供应商退货详情' })
    fireEvent.click(within(detail).getByRole('button', { name: '登记退款结果' }))

    const confirmDialog = screen.getByRole('dialog', { name: '确认登记退款结果？' })
    expect(supplierReturnApi.updateStatus).not.toHaveBeenCalled()
    const confirm = within(confirmDialog).getByRole('button', { name: '确认登记' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(supplierReturnApi.updateStatus).toHaveBeenCalledTimes(1)
    expect(within(confirmDialog).getByRole('button', { name: '提交中…' })).toBeDisabled()
    expect(within(detail).getByText('供应商已收货')).toBeInTheDocument()

    await act(async () => pending.resolve({ id: 'SR-1', status: 'refunded' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认登记退款结果？' })).not.toBeInTheDocument())
    expect(within(detail).getByText('退款状态已登记（未过账）')).toBeInTheDocument()
  })

  it('locks further transitions when a status request loses its response', async () => {
    const received = { ...baseRecord, status: 'received' as const }
    vi.mocked(supplierReturnApi.getList).mockResolvedValue({ list: [received], pagination: { page: 1, pageSize: 20, total: 1 } })
    vi.mocked(supplierReturnApi.getById).mockResolvedValue(received)
    vi.mocked(supplierReturnApi.updateStatus).mockRejectedValue(new Error('response lost'))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '查看 SR-20260718-1' }))
    const detail = await screen.findByRole('dialog', { name: '供应商退货详情' })
    fireEvent.click(within(detail).getByRole('button', { name: '登记退款结果' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认登记退款结果？' })).getByRole('button', { name: '确认登记' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认登记退款结果？' })).not.toBeInTheDocument())
    expect(within(detail).getByRole('alert')).toHaveTextContent('处理结果未知')
    expect(within(detail).queryByRole('button', { name: '登记退款结果' })).not.toBeInTheDocument()
  })
})
