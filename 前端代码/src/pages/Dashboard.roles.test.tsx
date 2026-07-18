/**
 * 待办③ 角色仪表盘：能力驱动的 KPI / 快捷操作 / 板块按权限显隐（RBAC §4）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'

const api = vi.hoisted(() => ({
  inventoryStats: vi.fn(),
  inboundList: vi.fn(),
  outboundList: vi.fn(),
  purchaseOrderList: vi.fn(),
  projectList: vi.fn(),
  costDashboard: vi.fn(),
}))

vi.mock('@/api/inventory', () => ({
  inventoryApi: { getStats: api.inventoryStats },
  inboundApi: { getList: api.inboundList },
  outboundApi: { getList: api.outboundList },
  purchaseOrderApi: { getList: api.purchaseOrderList },
}))
vi.mock('@/api/master', () => ({ projectApi: { getList: api.projectList } }))
vi.mock('@/api/abc', () => ({ abcApi: { getDashboard: api.costDashboard } }))

const page = (total: number) => ({
  list: [],
  pagination: { page: 1, pageSize: 5, total, totalPages: total > 0 ? 1 : 0 },
})

function setUser(capabilities: Record<string, 'R' | 'W'>, canSeeCost: boolean, roles: string[]) {
  localStorage.setItem('user', JSON.stringify({ role: roles[0], roles, capabilities, canSeeCost }))
}
const renderDash = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><Dashboard /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  Object.values(api).forEach(mock => mock.mockReset())
  api.inventoryStats.mockResolvedValue({
    totalMaterials: 10,
    totalStockValue: 1250,
    totalStockCount: 12,
    normalCount: 9,
    lowStockCount: 1,
    expiringCount: 0,
    expiredCount: 0,
    categoryDistribution: [],
  })
  api.inboundList.mockImplementation((params?: { startDate?: string }) =>
    Promise.resolve(params?.startDate ? page(2) : page(0)),
  )
  api.outboundList.mockImplementation((params?: { startDate?: string }) =>
    Promise.resolve(params?.startDate ? page(3) : page(0)),
  )
  api.purchaseOrderList.mockResolvedValue(page(3))
  api.projectList.mockResolvedValue(page(5))
  api.costDashboard.mockResolvedValue({
    summary: { totalCost: 100, totalFee: 180, totalProfit: 80, profitRate: 80 / 180 },
    insightQuality: { isFinal: true, pendingCostCount: 0, openExceptionCount: 0 },
  })
})

describe('角色仪表盘（能力驱动）', () => {
  it('病理：检测项目+库存+预警；无成本/入库/出库', async () => {
    setUser({ inventory: 'R', bom: 'R', projects: 'W', alerts: 'R' }, false, ['pathologist'])
    renderDash()
    await waitFor(() => expect(screen.getByText('检测项目数')).toBeInTheDocument())
    expect(screen.getByText('库存物料')).toBeInTheDocument()
    expect(screen.getByText('预警数量')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '库存物料' })).getByText('10')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '检测项目数' })).getByText('5')).toBeInTheDocument()
    expect(screen.queryByText('不可用')).not.toBeInTheDocument()
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(screen.queryByText('成本看板')).not.toBeInTheDocument()
    expect(screen.queryByText('入库登记')).not.toBeInTheDocument()
    expect(screen.queryByText('出库领用')).not.toBeInTheDocument()
    expect(api.inboundList).not.toHaveBeenCalled()
    expect(api.outboundList).not.toHaveBeenCalled()
    expect(api.costDashboard).not.toHaveBeenCalled()
  })

  it('财务：成本/利润率/对账；无入库登记/盘点写操作', async () => {
    setUser({ inventory: 'R', cost_analysis: 'W', abc_dashboard: 'W', slide_cost: 'W', profitability: 'W', reconciliation: 'W', alerts: 'R' }, true, ['finance'])
    renderDash()
    await waitFor(() => expect(screen.getByText('本月成本')).toBeInTheDocument())
    expect(screen.getByText('利润率')).toBeInTheDocument()
    expect(screen.getByText('成本看板')).toBeInTheDocument()
    expect(screen.getByText('消耗对账')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '本月成本' })).getByText('¥100')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '利润率' })).getByText('44.4%')).toBeInTheDocument()
    expect(screen.queryByText('不可用')).not.toBeInTheDocument()
    expect(screen.queryByText('入库登记')).not.toBeInTheDocument()
    expect(screen.queryByText('库存盘点')).not.toBeInTheDocument()
    expect(api.inboundList).not.toHaveBeenCalled()
    expect(api.outboundList).not.toHaveBeenCalled()
    expect(api.projectList).not.toHaveBeenCalled()
  })

  it('仓管：入库/出库/盘点写操作；无成本', async () => {
    setUser({ inventory: 'W', inbound: 'W', outbound: 'W', stocktaking: 'W', alerts: 'R' }, false, ['warehouse_manager'])
    renderDash()
    await waitFor(() => expect(screen.getByText('入库登记')).toBeInTheDocument())
    expect(screen.getByText('出库领用')).toBeInTheDocument()
    expect(screen.getByText('库存盘点')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '本月入库' })).getByText('2')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '本月出库' })).getByText('3')).toBeInTheDocument()
    expect(screen.queryByText('不可用')).not.toBeInTheDocument()
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(screen.queryByText('成本看板')).not.toBeInTheDocument()
    expect(api.costDashboard).not.toHaveBeenCalled()
    expect(api.projectList).not.toHaveBeenCalled()
  })

  it('采购：采购订单 KPI + 快捷操作；无出库/成本', async () => {
    setUser({ inventory: 'R', inbound: 'W', purchase_orders: 'W', suppliers: 'W', cost_analysis: 'R', alerts: 'R' }, false, ['procurement'])
    renderDash()
    await waitFor(() => expect(screen.getByText('采购订单数')).toBeInTheDocument())
    expect(screen.getByText('入库登记')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '采购订单数' })).getByText('3')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '本月入库' })).getByText('2')).toBeInTheDocument()
    expect(screen.queryByText('不可用')).not.toBeInTheDocument()
    expect(screen.queryByText('出库领用')).not.toBeInTheDocument()
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(api.outboundList).not.toHaveBeenCalled()
    expect(api.costDashboard).not.toHaveBeenCalled()
  })

  it('成本可见标记与 API capability 漂移时 fail-closed，不请求或展示成本', async () => {
    setUser({ inventory: 'R', profitability: 'R' }, true, ['finance'])

    renderDash()

    await waitFor(() => expect(screen.getByText('库存物料')).toBeInTheDocument())
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(screen.queryByText('利润率')).not.toBeInTheDocument()
    expect(api.costDashboard).not.toHaveBeenCalled()
  })

  it('有 ABC capability 但成本可见标记为 false 时 fail-closed', async () => {
    setUser({ inventory: 'R', abc_dashboard: 'R', profitability: 'R' }, false, ['finance'])

    renderDash()

    await waitFor(() => expect(screen.getByText('库存物料')).toBeInTheDocument())
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(screen.queryByText('利润率')).not.toBeInTheDocument()
    expect(api.costDashboard).not.toHaveBeenCalled()
  })

  it('成本已授权但无 profitability capability 时只展示成本', async () => {
    setUser({ abc_dashboard: 'R' }, true, ['finance'])

    renderDash()

    await waitFor(() => expect(screen.getByText('本月成本')).toBeInTheDocument())
    expect(within(screen.getByRole('region', { name: '本月成本' })).getByText('¥100')).toBeInTheDocument()
    expect(screen.queryByText('利润率')).not.toBeInTheDocument()
    expect(api.costDashboard).toHaveBeenCalledTimes(1)
    expect(api.costDashboard).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}$/))
  })
})
