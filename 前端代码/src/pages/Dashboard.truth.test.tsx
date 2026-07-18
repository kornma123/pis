import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'

const api = vi.hoisted(() => ({
  inventoryStats: vi.fn(),
  inboundList: vi.fn(),
  outboundList: vi.fn(),
  projectList: vi.fn(),
  purchaseOrderList: vi.fn(),
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

const inventoryStats = {
  totalMaterials: 10,
  totalStockValue: 1250,
  totalStockCount: 12,
  normalCount: 8,
  lowStockCount: 1,
  expiringCount: 1,
  expiredCount: 0,
  categoryDistribution: [],
}

const page = (total: number, list: unknown[] = []) => ({
  list,
  pagination: { page: 1, pageSize: 5, total, totalPages: total > 0 ? 1 : 0 },
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setUser(capabilities: Record<string, 'R' | 'W'>, seeCost = false) {
  localStorage.setItem('user', JSON.stringify({
    role: 'admin',
    roles: ['admin'],
    capabilities,
    canSeeCost: seeCost,
  }))
}

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><Dashboard /></MemoryRouter>
    </QueryClientProvider>,
  )
}

function card(title: string) {
  return screen.getByRole('region', { name: title })
}

beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset())
  api.inventoryStats.mockResolvedValue(inventoryStats)
  api.inboundList.mockImplementation((params?: { startDate?: string }) =>
    Promise.resolve(params?.startDate ? page(2) : page(0)),
  )
  api.outboundList.mockImplementation((params?: { startDate?: string }) =>
    Promise.resolve(params?.startDate ? page(3) : page(0)),
  )
  api.projectList.mockResolvedValue(page(5))
  api.purchaseOrderList.mockResolvedValue(page(4))
  api.costDashboard.mockResolvedValue({
    summary: { totalCost: 100, totalFee: 180, totalProfit: 80 },
    insightQuality: { isFinal: true, pendingCostCount: 0, openExceptionCount: 0 },
  })
})

describe('Dashboard 数据诚实边界', () => {
  it.each([
    {
      name: '库存统计',
      title: '库存物料',
      expected: '10',
      callsAfterRetry: 2,
      mock: api.inventoryStats,
      fail: () => api.inventoryStats.mockRejectedValueOnce(new Error('inventory failed')),
    },
    {
      name: '检测项目',
      title: '检测项目数',
      expected: '5',
      callsAfterRetry: 2,
      mock: api.projectList,
      fail: () => api.projectList.mockRejectedValueOnce(new Error('projects failed')),
    },
    {
      name: '本月入库',
      title: '本月入库',
      expected: '2',
      callsAfterRetry: 3,
      mock: api.inboundList,
      fail: () => {
        let failed = false
        api.inboundList.mockImplementation((params?: { startDate?: string }) => {
          if (params?.startDate && !failed) {
            failed = true
            return Promise.reject(new Error('monthly inbound failed'))
          }
          return Promise.resolve(params?.startDate ? page(2) : page(0))
        })
      },
    },
    {
      name: '本月出库',
      title: '本月出库',
      expected: '3',
      callsAfterRetry: 3,
      mock: api.outboundList,
      fail: () => {
        let failed = false
        api.outboundList.mockImplementation((params?: { startDate?: string }) => {
          if (params?.startDate && !failed) {
            failed = true
            return Promise.reject(new Error('monthly outbound failed'))
          }
          return Promise.resolve(params?.startDate ? page(3) : page(0))
        })
      },
    },
    {
      name: '采购订单',
      title: '采购订单数',
      expected: '4',
      callsAfterRetry: 2,
      mock: api.purchaseOrderList,
      fail: () => api.purchaseOrderList.mockRejectedValueOnce(new Error('purchase orders failed')),
    },
    {
      name: '成本看板',
      title: '本月成本',
      expected: '¥100',
      callsAfterRetry: 2,
      mock: api.costDashboard,
      fail: () => api.costDashboard.mockRejectedValueOnce(new Error('cost failed')),
    },
  ])('$name 请求失败时只把相关指标标成不可用并可重试', async ({
    title, expected, callsAfterRetry, mock, fail,
  }) => {
    setUser({
      inventory: 'W', inbound: 'W', outbound: 'W', projects: 'W',
      purchase_orders: 'W', alerts: 'R', logs: 'R',
      cost_analysis: 'W', abc_dashboard: 'W', profitability: 'W',
    }, true)
    fail()

    renderDashboard()

    const failedCard = await screen.findByRole('region', { name: title })
    expect(within(failedCard).getByText('不可用')).toBeInTheDocument()
    expect(within(failedCard).getByText('数据没能加载')).toBeInTheDocument()
    const statusAlert = screen.getByRole('alert', { name: '仪表盘数据状态' })
    expect(statusAlert).toHaveAttribute('aria-live', 'assertive')
    expect(statusAlert).toHaveTextContent(`${title}加载失败`)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    const retryButton = within(failedCard).getByRole('button', { name: `重试${title}` })
    expect(retryButton.tagName).toBe('BUTTON')
    expect(retryButton).toHaveClass('focus-visible:outline')
    expect(within(failedCard).queryByText(/^(?:0|¥0|0%)$/)).not.toBeInTheDocument()

    if (title !== '库存物料') {
      expect(within(card('库存物料')).getByText('10')).toBeInTheDocument()
    }
    if (title === '库存物料') {
      expect(screen.queryByText('暂无预警信息')).not.toBeInTheDocument()
      expect(screen.queryByText('暂无数据')).not.toBeInTheDocument()
      expect(within(screen.getByRole('region', { name: '分类分布' })).getByText('不可用')).toBeInTheDocument()
    }
    if (title === '本月成本') {
      expect(within(card('利润率')).getByText('不可用')).toBeInTheDocument()
    }

    retryButton.focus()
    expect(retryButton).toHaveFocus()
    fireEvent.click(retryButton)
    await waitFor(() => {
      expect(within(card(title)).getByText(expected)).toBeInTheDocument()
    })
    expect(retryButton).toBeInTheDocument()
    expect(retryButton).toHaveFocus()
    expect(mock).toHaveBeenCalledTimes(callsAfterRetry)
  })

  it('每个真实数值资源的 0 都保持为 0，不与 unknown 混为一谈', async () => {
    setUser({
      inventory: 'R', alerts: 'R', inbound: 'R', outbound: 'R', projects: 'R',
      purchase_orders: 'R', cost_analysis: 'R', abc_dashboard: 'R', profitability: 'R',
    }, true)
    api.inventoryStats.mockResolvedValue({
      ...inventoryStats,
      totalMaterials: 0,
      totalStockValue: 0,
      totalStockCount: 0,
      normalCount: 0,
      lowStockCount: 0,
      expiringCount: 0,
      expiredCount: 0,
    })
    api.inboundList.mockImplementation((params?: { startDate?: string }) =>
      Promise.resolve(params?.startDate ? page(0) : page(0)),
    )
    api.outboundList.mockImplementation((params?: { startDate?: string }) =>
      Promise.resolve(params?.startDate ? page(0) : page(0)),
    )
    api.projectList.mockResolvedValue(page(0))
    api.purchaseOrderList.mockResolvedValue(page(0))
    api.costDashboard.mockResolvedValue({
      summary: { totalCost: 0, totalFee: 100, totalProfit: 0 },
      insightQuality: { isFinal: true, pendingCostCount: 0, openExceptionCount: 0 },
    })

    renderDashboard()

    const expectedZeros = [
      ['库存物料', '0'],
      ['预警数量', '0'],
      ['本月入库', '0'],
      ['本月出库', '0'],
      ['检测项目数', '0'],
      ['采购订单数', '0'],
      ['本月成本', '¥0'],
      ['利润率', '0%'],
    ] as const
    await screen.findByRole('region', { name: '库存物料' })
    expectedZeros.forEach(([title, value]) => {
      expect(within(card(title)).getByText(value)).toBeInTheDocument()
      expect(within(card(title)).queryByText('不可用')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('数据没能加载')).not.toBeInTheDocument()
  })

  it('KPI 重试期间保持失败态、稳定控件和键盘焦点', async () => {
    setUser({ inventory: 'R' })
    const retryResult = deferred<typeof inventoryStats>()
    api.inventoryStats
      .mockRejectedValueOnce(new Error('inventory failed'))
      .mockImplementationOnce(() => retryResult.promise)

    renderDashboard()

    const retryButton = await screen.findByRole('button', { name: '重试库存物料' })
    retryButton.focus()
    fireEvent.click(retryButton)

    await waitFor(() => expect(retryButton).toHaveAccessibleName('正在重试库存物料'))
    expect(retryButton).toHaveAttribute('aria-disabled', 'true')
    expect(retryButton).toHaveFocus()
    expect(within(card('库存物料')).getByText('不可用')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '正在加载仪表盘' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert', { name: '仪表盘数据状态' })).toHaveTextContent('库存物料正在重试')

    await act(async () => {
      retryResult.resolve({ ...inventoryStats, totalMaterials: 12 })
      await retryResult.promise
    })
    await waitFor(() => expect(within(card('库存物料')).getByText('12')).toBeInTheDocument())
    expect(retryButton).toHaveFocus()
    expect(retryButton).not.toHaveAttribute('aria-disabled')
  })

  it('成功响应缺少真实成本字段时显示不可用，不补成业务 0', async () => {
    setUser({ cost_analysis: 'R', abc_dashboard: 'R', profitability: 'R' }, true)
    api.costDashboard.mockResolvedValue({
      summary: { totalFee: 0, totalProfit: 0 },
      insightQuality: { isFinal: true, pendingCostCount: 0, openExceptionCount: 0 },
    })

    renderDashboard()

    expect(within(await screen.findByRole('region', { name: '本月成本' })).getByText('不可用')).toBeInTheDocument()
    expect(within(card('本月成本')).queryByText('¥0')).not.toBeInTheDocument()
    expect(within(card('利润率')).getByText('不可用')).toBeInTheDocument()
  })

  it('成本数据未定版时显式阻断经营指标，不展示部分结果', async () => {
    setUser({ cost_analysis: 'R', abc_dashboard: 'R', profitability: 'R' }, true)
    api.costDashboard.mockResolvedValue({
      summary: { totalCost: 90, totalFee: 180, totalProfit: 90 },
      insightQuality: { isFinal: false, pendingCostCount: 2, openExceptionCount: 0 },
    })

    renderDashboard()

    const costCard = await screen.findByRole('region', { name: '本月成本' })
    const coverage = screen.getByRole('region', { name: '数据覆盖与口径' })
    expect(coverage).toHaveTextContent('成本口径不可用于经营判断')
    expect(coverage).toHaveTextContent('仍有 2 单未补算或成本异常')
    expect(within(costCard).getByText('不可用')).toBeInTheDocument()
    expect(within(costCard).getByText('仍有 2 单未补算或成本异常')).toBeInTheDocument()
    expect(within(costCard).queryByText('¥90')).not.toBeInTheDocument()
    expect(within(card('利润率')).queryByText('50%')).not.toBeInTheDocument()
  })

  it('按真实利润和收入计算百分数，不把后端 0–1 比率直接加百分号', async () => {
    setUser({ cost_analysis: 'R', abc_dashboard: 'R', profitability: 'R' }, true)
    api.costDashboard.mockResolvedValue({
      summary: { totalCost: 100, totalFee: 180, totalProfit: 80, profitRate: 80 / 180 },
      insightQuality: { isFinal: true, pendingCostCount: 0, openExceptionCount: 0 },
    })

    renderDashboard()

    expect(within(await screen.findByRole('region', { name: '利润率' })).getByText('44.4%')).toBeInTheDocument()
  })

  it('最近活动部分失败时保留成功来源并显式提示部分数据', async () => {
    setUser({ inbound: 'R', outbound: 'R' })
    api.inboundList.mockImplementation((params?: { startDate?: string }) =>
      params?.startDate ? Promise.resolve(page(1)) : Promise.reject(new Error('recent inbound failed')),
    )
    api.outboundList.mockImplementation((params?: { startDate?: string }) =>
      Promise.resolve(params?.startDate ? page(1) : page(1, [{
        id: 'out-1', outboundNo: 'OUT-001', projectName: '项目 A', operator: '张三',
        createdAt: '2026-07-18T10:00:00.000Z',
      }])),
    )

    renderDashboard()

    expect(await screen.findAllByText('部分活动加载失败')).toHaveLength(2)
    expect(screen.getByText('出库：OUT-001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试最近活动' })).toBeInTheDocument()
    expect(screen.queryByText('暂无最近活动')).not.toBeInTheDocument()
  })

  it('最近活动重试期间不伪装为空，并保持稳定控件和键盘焦点', async () => {
    setUser({ inbound: 'R', outbound: 'R' })
    const retryResult = deferred<ReturnType<typeof page>>()
    let recentInboundCalls = 0
    api.inboundList.mockImplementation((params?: { startDate?: string }) => {
      if (params?.startDate) return Promise.resolve(page(0))
      recentInboundCalls += 1
      return recentInboundCalls === 1
        ? Promise.reject(new Error('recent inbound failed'))
        : retryResult.promise
    })
    api.outboundList.mockResolvedValue(page(0))

    renderDashboard()

    expect(await screen.findAllByText('部分活动加载失败')).toHaveLength(2)
    const retryButton = screen.getByRole('button', { name: '重试最近活动' })
    retryButton.focus()
    fireEvent.click(retryButton)

    await waitFor(() => expect(retryButton).toHaveAccessibleName('正在重试最近活动'))
    expect(retryButton).toHaveAttribute('aria-disabled', 'true')
    expect(retryButton).toHaveFocus()
    expect(screen.getAllByText('部分活动正在重试')).toHaveLength(2)
    expect(screen.queryByText('暂无最近活动')).not.toBeInTheDocument()
    expect(screen.getByRole('alert', { name: '仪表盘数据状态' })).toHaveTextContent('部分活动正在重试')

    await act(async () => {
      retryResult.resolve(page(0))
      await retryResult.promise
    })
    expect(await screen.findByText('暂无最近活动')).toBeInTheDocument()
    expect(retryButton).toHaveAccessibleName('刷新最近活动')
    expect(retryButton).toHaveFocus()
  })

  it('没有真实月度序列时不绘制任何趋势图', async () => {
    setUser({ inventory: 'R', outbound: 'R' })

    renderDashboard()

    await screen.findByRole('region', { name: '库存物料' })
    expect(screen.queryAllByTestId('dashboard-trend-chart')).toHaveLength(0)
    expect(screen.getAllByText('月度趋势数据尚未接通')).toHaveLength(2)
  })

  it('月度单据与在用项目请求锁定真实筛选口径', async () => {
    setUser({ inbound: 'R', outbound: 'R', projects: 'R' })

    renderDashboard()

    await screen.findByRole('region', { name: '本月入库' })
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const pad = (value: number) => String(value).padStart(2, '0')
    const startDate = `${year}-${pad(month)}-01`
    const endDate = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`

    expect(api.inboundList).toHaveBeenCalledWith(expect.objectContaining({
      page: 1, pageSize: 1, status: 'completed', startDate, endDate,
    }))
    expect(api.outboundList).toHaveBeenCalledWith(expect.objectContaining({
      page: 1, pageSize: 1, status: 'completed', startDate, endDate,
    }))
    expect(api.projectList).toHaveBeenCalledWith({ page: 1, pageSize: 1, status: 'active' })
  })

  it('跨本地月界时统一刷新月度口径并显式传递成本月份', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 31, 23, 59, 59, 900))
    setUser({ inbound: 'R', outbound: 'R', abc_dashboard: 'R' }, true)
    const view = renderDashboard()

    try {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(api.costDashboard).toHaveBeenCalledWith('2026-07')
      expect(api.inboundList).toHaveBeenCalledWith(expect.objectContaining({
        startDate: '2026-07-01', endDate: '2026-07-31', status: 'completed',
      }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(api.costDashboard).toHaveBeenCalledWith('2026-08')
      expect(api.inboundList).toHaveBeenCalledWith(expect.objectContaining({
        startDate: '2026-08-01', endDate: '2026-08-31', status: 'completed',
      }))
      expect(api.outboundList).toHaveBeenCalledWith(expect.objectContaining({
        startDate: '2026-08-01', endDate: '2026-08-31', status: 'completed',
      }))
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })
})
