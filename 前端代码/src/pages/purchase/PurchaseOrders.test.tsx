import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { purchaseOrderApi } from '@/api/inventory'
import { materialApi, supplierApi } from '@/api/master'
import { canAccess } from '@/lib/permissions'
import PurchaseOrders from './PurchaseOrders'

vi.mock('@/api/inventory', () => ({
  purchaseOrderApi: {
    getList: vi.fn(),
    create: vi.fn(),
    cancel: vi.fn(),
    receive: vi.fn(),
  },
}))

vi.mock('@/api/master', () => ({
  materialApi: { getList: vi.fn() },
  supplierApi: { getList: vi.fn() },
}))

vi.mock('@/lib/permissions', () => ({
  canAccess: vi.fn(() => true),
}))

describe('PurchaseOrders truth-preserving actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(canAccess).mockReturnValue(true)
    vi.mocked(materialApi.getList).mockResolvedValue({ list: [] } as never)
    vi.mocked(supplierApi.getList).mockResolvedValue({ list: [] } as never)
  })

  it('does not expose the unsafe receive action and preserves filters in the inbound context link', async () => {
    vi.mocked(purchaseOrderApi.getList).mockResolvedValue({
      list: [{
        id: 'po 1',
        order_no: 'PO20260718-0001',
        material_id: 'mat/1',
        material_name: '试剂 A',
        ordered_qty: 8,
        received_qty: 0,
        remainingQty: 8,
        unit_price: 0,
        total_amount: 0,
        unit: '盒',
        status: 'pending',
      }],
      pagination: { page: 1, pageSize: 20, total: 1 },
    } as never)

    render(
      <MemoryRouter initialEntries={['/purchase-orders?status=pending&keyword=DNA']}>
        <PurchaseOrders />
      </MemoryRouter>,
    )

    expect(await screen.findByText('PO20260718-0001')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '收货' })).not.toBeInTheDocument()
    expect(purchaseOrderApi.receive).not.toHaveBeenCalled()

    const link = screen.getByRole('link', { name: '查看入库限制' })
    const href = link.getAttribute('href') ?? ''
    const params = new URLSearchParams(href.split('?')[1])
    expect(params.get('purchaseOrderId')).toBe('po 1')
    expect(params.get('materialId')).toBe('mat/1')
    expect(params.get('returnTo')).toBe('/purchase-orders?status=pending&keyword=DNA')
    expect(screen.getByText(/后端尚未在同一事务中校验订单状态/)).toBeInTheDocument()
  })

  it('renders a failed load as an error rather than a verified empty list', async () => {
    vi.mocked(purchaseOrderApi.getList).mockRejectedValue(new Error('network unavailable'))

    render(
      <MemoryRouter initialEntries={['/purchase-orders']}>
        <PurchaseOrders />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('network unavailable')
    expect(screen.getByText('数据未加载，不能按空列表处理')).toBeInTheDocument()
    expect(screen.queryByText('当前筛选下没有采购订单')).not.toBeInTheDocument()
    await waitFor(() => expect(purchaseOrderApi.getList).toHaveBeenCalled())
  })

  it('treats a malformed backend response as unknown instead of empty', async () => {
    vi.mocked(purchaseOrderApi.getList).mockResolvedValue({ pagination: { total: 0 } } as never)

    render(
      <MemoryRouter initialEntries={['/purchase-orders']}>
        <PurchaseOrders />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('采购订单响应格式异常')
    expect(screen.getByText('数据未加载，不能按空列表处理')).toBeInTheDocument()
    expect(screen.queryByText('当前筛选下没有采购订单')).not.toBeInTheDocument()
  })

  it('hides purchase mutations without purchase write permission', async () => {
    vi.mocked(canAccess).mockImplementation((module, level) => (
      module === 'inbound' && level === 'R'
    ))
    vi.mocked(purchaseOrderApi.getList).mockResolvedValue({
      list: [{ id: 'po-1', order_no: 'PO-NO-WRITE', material_id: 'mat-1', status: 'pending' }],
      pagination: { page: 1, pageSize: 20, total: 1 },
    } as never)

    render(
      <MemoryRouter initialEntries={['/purchase-orders']}>
        <PurchaseOrders />
      </MemoryRouter>,
    )

    expect(await screen.findByText('PO-NO-WRITE')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建采购订单' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看入库限制' })).toBeInTheDocument()
  })
})
