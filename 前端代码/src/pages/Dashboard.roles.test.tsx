/**
 * 待办③ 角色仪表盘：能力驱动的 KPI / 快捷操作 / 板块按权限显隐（RBAC §4）。
 */
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'

const getAbcDashboard = vi.hoisted(() => vi.fn().mockResolvedValue({
  summary: { totalCost: 100, totalFee: 180, totalProfit: 80 },
}))

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => <div />, XAxis: () => <div />, YAxis: () => <div />,
  Tooltip: () => <div />, Cell: () => <div />, PieChart: ({ children }: any) => <div>{children}</div>,
  Pie: ({ children }: any) => <div>{children}</div>, Legend: () => <div />,
}))

vi.mock('@/api/inventory', () => ({
  inventoryApi: { getStats: vi.fn().mockResolvedValue({ totalMaterials: 10, lowStockCount: 1, expiringCount: 0, expiredCount: 0 }) },
  inboundApi: { getList: vi.fn().mockResolvedValue({ list: [] }) },
  outboundApi: { getList: vi.fn().mockResolvedValue({ list: [] }) },
  purchaseOrderApi: { getList: vi.fn().mockResolvedValue({ pagination: { total: 3 } }) },
}))
vi.mock('@/api/master', () => ({ projectApi: { getList: vi.fn().mockResolvedValue({ pagination: { total: 5 } }) } }))
vi.mock('@/api/abc', () => ({ abcApi: { getDashboard: getAbcDashboard } }))

function setUser(capabilities: Record<string, 'R' | 'W'>, canSeeCost: boolean, roles: string[]) {
  localStorage.setItem('user', JSON.stringify({ role: roles[0], roles, capabilities, canSeeCost }))
}
const renderDash = () => render(<MemoryRouter><Dashboard /></MemoryRouter>)

beforeEach(() => {
  localStorage.clear()
  getAbcDashboard.mockClear()
})

describe('角色仪表盘（能力驱动）', () => {
  it('病理：检测项目+库存+预警；无成本/入库/出库', async () => {
    setUser({ inventory: 'R', bom: 'R', projects: 'W', alerts: 'R' }, false, ['pathologist'])
    renderDash()
    await waitFor(() => expect(screen.getByText('检测项目数')).toBeInTheDocument())
    expect(screen.getByText('库存物料')).toBeInTheDocument()
    expect(screen.getByText('预警数量')).toBeInTheDocument()
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(screen.queryByText('成本看板')).not.toBeInTheDocument()
    expect(screen.queryByText('入库登记')).not.toBeInTheDocument()
    expect(screen.queryByText('出库领用')).not.toBeInTheDocument()
  })

  it('财务：保留材料对账，但旧 ABC 可见标记也不能恢复成本卡片或请求', async () => {
    setUser({ inventory: 'R', cost_analysis: 'W', abc_dashboard: 'W', slide_cost: 'W', profitability: 'W', reconciliation: 'W', alerts: 'R' }, true, ['finance'])
    renderDash()
    await waitFor(() => expect(screen.getByText('消耗对账')).toBeInTheDocument())
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(screen.queryByText('利润率')).not.toBeInTheDocument()
    expect(screen.queryByText('成本看板')).not.toBeInTheDocument()
    expect(getAbcDashboard).not.toHaveBeenCalled()
    expect(screen.getByText('消耗对账')).toBeInTheDocument()
    expect(screen.queryByText('入库登记')).not.toBeInTheDocument()
    expect(screen.queryByText('库存盘点')).not.toBeInTheDocument()
  })

  it('仓管：入库/出库/盘点写操作；无成本', async () => {
    setUser({ inventory: 'W', inbound: 'W', outbound: 'W', stocktaking: 'W', alerts: 'R' }, false, ['warehouse_manager'])
    renderDash()
    await waitFor(() => expect(screen.getByText('入库登记')).toBeInTheDocument())
    expect(screen.getByText('出库领用')).toBeInTheDocument()
    expect(screen.getByText('库存盘点')).toBeInTheDocument()
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
    expect(screen.queryByText('成本看板')).not.toBeInTheDocument()
  })

  it('采购：采购订单 KPI + 快捷操作；无出库/成本', async () => {
    setUser({ inventory: 'R', inbound: 'W', purchase_orders: 'W', suppliers: 'W', cost_analysis: 'R', alerts: 'R' }, false, ['procurement'])
    renderDash()
    await waitFor(() => expect(screen.getByText('采购订单数')).toBeInTheDocument())
    expect(screen.getByText('入库登记')).toBeInTheDocument()
    expect(screen.queryByText('出库领用')).not.toBeInTheDocument()
    expect(screen.queryByText('本月成本')).not.toBeInTheDocument()
  })
})
