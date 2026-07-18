import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import CostDashboard from './CostDashboard'

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Cell: () => <div />,
  Tooltip: () => <div />,
  Legend: () => <div />,
}))

vi.mock('@/api/abc', () => ({
  abcApi: {
	    getDashboard: vi.fn(),
	    getClosingReadiness: vi.fn(),
	    getPeriods: vi.fn(),
	    getCostRuns: vi.fn(),
    getAdjustments: vi.fn(),
    approveAdjustment: vi.fn(),
    rejectAdjustment: vi.fn(),
    createAdjustment: vi.fn(),
  },
}))

const dashboardResponse = {
  summary: {
    totalCost: 100,
    totalFee: 180,
    totalProfit: 80,
    profitRate: 0.44,
    caseCount: 1,
    sampleCount: 1,
    materialCost: 60,
    activityCost: 40,
    adjustmentAmount: 0,
    pendingAdjustmentCount: 1,
    costChange: 0,
    feeChange: 0,
    profitChange: 0,
  },
  profitByProject: [],
  costByActivity: [],
  alerts: [],
}

const periodResponse = {
  list: [{ id: 'period-1', yearMonth: '2026-06', status: 'calculated' }],
}

const emptyListResponse = { list: [] }

const readyClosingReadiness = {
  yearMonth: '2026-06',
  status: 'ready',
  summary: {
    blockerCount: 0,
    warningCount: 0,
    infoCount: 0,
  },
  blockers: [],
  warnings: [],
  nextActions: [],
  sources: {},
}

describe('CostDashboard adjustment refresh', () => {
  beforeEach(() => {
    // 固定系统时钟到 2026-06，使组件默认取的「当前月」与本用例硬编码的 2026-06 断言/mock 数据一致；
    // 否则默认月随 wall-clock 漂移，仅在 2026 年 6 月能过（见同目录 QuarterlyAdjustment.test.tsx 同款做法）。
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'))
    window.localStorage.setItem('user', JSON.stringify({ role: 'finance', username: 'sunli' }))
	    vi.mocked(abcApi.getDashboard).mockReset()
	    vi.mocked(abcApi.getClosingReadiness).mockReset()
	    vi.mocked(abcApi.getPeriods).mockReset()
    vi.mocked(abcApi.getCostRuns).mockReset()
    vi.mocked(abcApi.getAdjustments).mockReset()
    vi.mocked(abcApi.approveAdjustment).mockReset()
    vi.mocked(abcApi.rejectAdjustment).mockReset()
    vi.mocked(abcApi.createAdjustment).mockReset()
	    vi.mocked(abcApi.getClosingReadiness).mockResolvedValue(readyClosingReadiness)
	  })

  it('starts the summary and workbench requests together instead of waiting for the summary', async () => {
    let resolveDashboard!: (value: typeof dashboardResponse) => void
    const dashboardPending = new Promise<typeof dashboardResponse>((resolve) => {
      resolveDashboard = resolve
    })
    vi.mocked(abcApi.getDashboard).mockReturnValue(dashboardPending as any)
    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(
      <MemoryRouter>
        <CostDashboard />
      </MemoryRouter>
    )

    await waitFor(() => expect(abcApi.getDashboard).toHaveBeenCalledWith('2026-06'))
    const workbenchStartedBeforeSummary =
      vi.mocked(abcApi.getPeriods).mock.calls.length === 1 &&
      vi.mocked(abcApi.getCostRuns).mock.calls.length === 1 &&
      vi.mocked(abcApi.getAdjustments).mock.calls.length === 1 &&
      vi.mocked(abcApi.getClosingReadiness).mock.calls.length === 1

    resolveDashboard(dashboardResponse)
    expect(await screen.findByText('成本看板')).toBeInTheDocument()
    expect(workbenchStartedBeforeSummary).toBe(true)
  })

  it('keeps a failed summary unavailable instead of rendering zero-valued business metrics', async () => {
    vi.mocked(abcApi.getDashboard).mockRejectedValue(new Error('dashboard unavailable'))
    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(
      <MemoryRouter>
        <CostDashboard />
      </MemoryRouter>
    )

    const unavailable = await screen.findByRole('region', { name: '成本汇总数据不可用' })
    expect(unavailable).toHaveTextContent('没有把失败响应解释成 0')
    expect(unavailable).toHaveTextContent('重试成本汇总')
    expect(screen.queryByTestId('cost-summary-zero-fallback')).not.toBeInTheDocument()
  })

  it('ignores a late response from an older month after the filter changes', async () => {
    let resolveJune!: (value: typeof dashboardResponse) => void
    let resolveMay!: (value: typeof dashboardResponse) => void
    const junePending = new Promise<typeof dashboardResponse>((resolve) => { resolveJune = resolve })
    const mayPending = new Promise<typeof dashboardResponse>((resolve) => { resolveMay = resolve })
    vi.mocked(abcApi.getDashboard).mockImplementation((requestedMonth: string) =>
      (requestedMonth === '2026-05' ? mayPending : junePending) as any
    )
    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(<MemoryRouter><CostDashboard /></MemoryRouter>)
    await waitFor(() => expect(abcApi.getDashboard).toHaveBeenCalledWith('2026-06'))

    fireEvent.change(screen.getByLabelText('成本月份'), { target: { value: '2026-05' } })
    await waitFor(() => expect(abcApi.getDashboard).toHaveBeenCalledWith('2026-05'))

    resolveMay({ ...dashboardResponse, summary: { ...dashboardResponse.summary, outboundCount: 505 } })
    expect(await screen.findByText('505 单')).toBeInTheDocument()

    resolveJune({ ...dashboardResponse, summary: { ...dashboardResponse.summary, outboundCount: 606 } })
    await waitFor(() => expect(screen.getByText('505 单')).toBeInTheDocument())
    expect(screen.queryByText('606 单')).not.toBeInTheDocument()
  })

  it('marks an approved adjustment as handled even if the follow-up dashboard refresh fails', async () => {
    vi.mocked(abcApi.getDashboard)
      .mockResolvedValueOnce(dashboardResponse)
      .mockRejectedValueOnce(new Error('refresh failed'))
    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue({
      list: [
        {
          id: 'adjustment-1',
          adjustmentNo: 'ADJ-209906-001',
          yearMonth: '2026-06',
          adjustmentType: 'closed_period_adjustment',
          amount: 128,
          reason: '财务复核调整',
          status: 'pending',
          submittedBy: 'admin',
        },
      ],
    })
    vi.mocked(abcApi.approveAdjustment).mockResolvedValue({
      id: 'adjustment-1',
      adjustmentNo: 'ADJ-209906-001',
      yearMonth: '2026-06',
      adjustmentType: 'closed_period_adjustment',
      amount: 128,
      reason: '财务复核调整',
      status: 'approved',
      submittedBy: 'admin',
      reviewedBy: 'sunli',
    })

    render(
      <MemoryRouter>
        <CostDashboard />
      </MemoryRouter>
    )

    expect(await screen.findByText('ADJ-209906-001')).toBeInTheDocument()
    expect(screen.getByText('待审核')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /通过/ }))

    await waitFor(() => expect(abcApi.approveAdjustment).toHaveBeenCalledWith('adjustment-1', { remark: '成本看板审核' }))
    await waitFor(() => {
      expect(screen.queryByText('待审核')).not.toBeInTheDocument()
      expect(screen.getByText('已通过')).toBeInTheDocument()
      expect(screen.getByText('sunli')).toBeInTheDocument()
    })
  })

  it('keeps a newly created adjustment visible if the follow-up dashboard refresh fails', async () => {
    vi.mocked(abcApi.getDashboard)
      .mockResolvedValueOnce({
        ...dashboardResponse,
        summary: {
          ...dashboardResponse.summary,
          pendingAdjustmentCount: 0,
        },
      })
      .mockRejectedValueOnce(new Error('refresh failed'))
    vi.mocked(abcApi.getPeriods).mockResolvedValue({
      list: [{ id: 'period-1', yearMonth: '2026-06', status: 'closed' }],
    })
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.createAdjustment).mockResolvedValue({
      id: 'adjustment-created',
      adjustmentNo: 'ADJ-209906-002',
      yearMonth: '2026-06',
      adjustmentType: 'closed_period_adjustment',
      amount: 256,
      reason: '关账后折旧补差',
      status: 'pending',
      submittedBy: 'sunli',
    })

    render(
      <MemoryRouter>
        <CostDashboard />
      </MemoryRouter>
    )

    expect(await screen.findByRole('button', { name: /^调整单$/ })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /^调整单$/ }))
    fireEvent.change(screen.getByPlaceholderText('正数增加成本，负数冲减成本'), { target: { value: '256' } })
    fireEvent.change(screen.getByPlaceholderText('例如：关账后发现设备折旧分摊差异，经财务复核调整'), {
      target: { value: '关账后折旧补差' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交调整单' }))

    await waitFor(() => expect(abcApi.createAdjustment).toHaveBeenCalledWith({
      yearMonth: '2026-06',
      adjustmentType: 'closed_period_adjustment',
      amount: 256,
      reason: '关账后折旧补差',
    }))
    await waitFor(() => {
      expect(screen.getByText('ADJ-209906-002')).toBeInTheDocument()
      expect(screen.getByText('待审核')).toBeInTheDocument()
      expect(screen.getByText('关账后折旧补差')).toBeInTheDocument()
      expect(screen.getByText('sunli')).toBeInTheDocument()
      expect(screen.getByText(/\/ 1$/)).toBeInTheDocument()
    })
  })

  it('summarizes post-close adjustment impact before creating an adjustment', async () => {
    vi.mocked(abcApi.getDashboard).mockResolvedValue({
      ...dashboardResponse,
      summary: {
        ...dashboardResponse.summary,
        pendingAdjustmentCount: 0,
      },
    })
    vi.mocked(abcApi.getPeriods).mockResolvedValue({
      list: [{ id: 'period-1', yearMonth: '2026-06', status: 'closed' }],
    })
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(
      <MemoryRouter>
        <CostDashboard />
      </MemoryRouter>
    )

    expect(await screen.findByRole('button', { name: /^调整单$/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /^调整单$/ }))

    expect(screen.getByRole('button', { name: '提交调整单' })).toBeDisabled()
    expect(screen.getByText('请填写非 0 调整金额，系统才能重算调整后成本和利润。')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('正数增加成本，负数冲减成本'), { target: { value: '-128' } })
    fireEvent.change(screen.getByPlaceholderText('例如：关账后发现设备折旧分摊差异，经财务复核调整'), {
      target: { value: '关账后复核冲减折旧' },
    })

    expect(screen.getByText('调整单结果确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：关账后调整、调整额、调整后利润、成本看板、审核记录、审计记录')).toBeInTheDocument()
    expect(screen.getByText('调整期间 2026-06')).toBeInTheDocument()
    expect(screen.getByText('调整金额 ¥-128.00')).toBeInTheDocument()
    expect(screen.getByText('调整原因 关账后复核冲减折旧')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交调整单' })).toBeEnabled()
  })

  it('renders backend cost run processed and succeeded counts', async () => {
    vi.mocked(abcApi.getDashboard).mockResolvedValue(dashboardResponse)
    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
    vi.mocked(abcApi.getCostRuns).mockResolvedValue({
      list: [{
        id: 'run-1',
        yearMonth: '2026-06',
        runType: 'recalculate',
        status: 'completed',
        summary: { processed: 3, succeeded: 2, failed: 1 },
        startedAt: '2026-06-20 10:00:00',
        finishedAt: '2026-06-20 10:05:00',
      }],
    })
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(
      <MemoryRouter>
        <CostDashboard />
      </MemoryRouter>
    )

    const row = (await screen.findByText('重算')).closest('tr')
    expect(row).not.toBeNull()
    expect(row!).toHaveTextContent('成功')
    expect(row!).toHaveTextContent('3')
    expect(row!).toHaveTextContent('2')
    expect(row!).toHaveTextContent('1')
  })

  it('shows failed cost run evidence and a filtered exception link', async () => {
    vi.mocked(abcApi.getDashboard).mockResolvedValue(dashboardResponse)
    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
    vi.mocked(abcApi.getCostRuns).mockResolvedValue({
      list: [{
        id: 'run-failed-1',
        yearMonth: '2026-06',
        runType: 'recalculate',
        status: 'completed',
        summary: {
          processed: 3,
          succeeded: 2,
          failed: 1,
          failures: [{ outboundId: 'out-1', outboundNo: 'OUT-FAIL-001', message: '缺少 BOM，无法重算 ABC 成本' }],
        },
        startedAt: '2026-06-20 10:00:00',
        finishedAt: '2026-06-20 10:05:00',
      }],
    })
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(
      <MemoryRouter>
        <CostDashboard />
      </MemoryRouter>
    )

    const row = (await screen.findByText('run-failed-1')).closest('tr')
    expect(row).not.toBeNull()
    expect(row!).toHaveTextContent('失败出库 OUT-FAIL-001：缺少 BOM，无法重算 ABC 成本')
    expect(row!).toHaveTextContent('修正源数据后重新执行重算')
    expect(screen.getByRole('link', { name: '查看失败异常' })).toHaveAttribute(
      'href',
      '/abc/alerts?keyword=run-failed-1&yearMonth=2026-06&status=open&includeUnassigned=1',
    )
  })

  it('loads adjustment records from audit deep link month and keyword on first render', async () => {
    vi.mocked(abcApi.getDashboard).mockResolvedValue({
      ...dashboardResponse,
      summary: {
        ...dashboardResponse.summary,
        pendingAdjustmentCount: 1,
      },
    })
    vi.mocked(abcApi.getPeriods).mockResolvedValue({
      list: [{ id: 'period-209903', yearMonth: '2099-03', status: 'closed' }],
    })
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue({
      list: [{
        id: 'adjustment-deep-link-1',
        adjustmentNo: 'ADJ-AUDIT-DEEP-001',
        yearMonth: '2099-03',
        adjustmentType: 'closed_period_adjustment',
        amount: 368,
        reason: '审计回跳验证调整单',
        status: 'pending',
        submittedBy: 'sunli',
      }],
    })

    render(
      <MemoryRouter initialEntries={['/abc/dashboard?month=2099-03&keyword=ADJ-AUDIT-DEEP-001']}>
        <CostDashboard />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(abcApi.getDashboard).toHaveBeenCalledWith('2099-03')
      expect(abcApi.getAdjustments).toHaveBeenCalledWith(expect.objectContaining({
        yearMonth: '2099-03',
        keyword: 'ADJ-AUDIT-DEEP-001',
        pageSize: 20,
      }))
    })
    expect(await screen.findByText('ADJ-AUDIT-DEEP-001')).toBeInTheDocument()
    expect(screen.getByText('审计回跳验证调整单')).toBeInTheDocument()
  })

  it('loads cost run records from audit deep link month and keyword on first render', async () => {
    vi.mocked(abcApi.getDashboard).mockResolvedValue(dashboardResponse)
    vi.mocked(abcApi.getPeriods).mockResolvedValue({
      list: [{ id: 'period-209904', yearMonth: '2099-04', status: 'calculated' }],
    })
    vi.mocked(abcApi.getCostRuns).mockResolvedValue({
      list: [{
        id: 'RUN-AUDIT-DEEP-001',
        yearMonth: '2099-04',
        runType: 'recalculate',
        status: 'completed',
        summary: { processed: 7, succeeded: 6, failed: 1 },
        startedAt: '2099-04-09 09:00:00',
        finishedAt: '2099-04-09 09:05:00',
      }],
    })
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(
      <MemoryRouter initialEntries={['/abc/dashboard?month=2099-04&keyword=RUN-AUDIT-DEEP-001']}>
        <CostDashboard />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(abcApi.getDashboard).toHaveBeenCalledWith('2099-04')
      expect(abcApi.getCostRuns).toHaveBeenCalledWith(expect.objectContaining({
        yearMonth: '2099-04',
        keyword: 'RUN-AUDIT-DEEP-001',
        pageSize: 20,
      }))
    })
    const row = (await screen.findByText('RUN-AUDIT-DEEP-001')).closest('tr')
    expect(row).not.toBeNull()
    expect(row!).toHaveTextContent('重算')
    expect(row!).toHaveTextContent('7')
    expect(row!).toHaveTextContent('6')
    expect(row!).toHaveTextContent('1')
  })

	  it('loads cost period status from audit month deep link on first render', async () => {
    vi.mocked(abcApi.getDashboard).mockResolvedValue(dashboardResponse)
    vi.mocked(abcApi.getPeriods).mockResolvedValue({
      list: [{ id: 'period-209905', yearMonth: '2099-05', status: 'closed' }],
    })
    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)

    render(
      <MemoryRouter initialEntries={['/abc/dashboard?month=2099-05']}>
        <CostDashboard />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(abcApi.getDashboard).toHaveBeenCalledWith('2099-05')
      expect(abcApi.getPeriods).toHaveBeenCalledWith(expect.objectContaining({
        yearMonth: '2099-05',
        pageSize: 1,
      }))
    })
    expect(screen.getByDisplayValue('2099-05')).toBeInTheDocument()
	    expect(await screen.findByText('已关账')).toBeInTheDocument()
	  })

	  it('renders closing readiness status and blocking reasons', async () => {
	    vi.mocked(abcApi.getDashboard).mockResolvedValue(dashboardResponse)
	    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
	    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
	    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)
	    vi.mocked(abcApi.getClosingReadiness).mockResolvedValue({
	      yearMonth: '2026-06',
	      status: 'blocked',
	      summary: {
	        blockerCount: 2,
	        warningCount: 1,
	        infoCount: 0,
	      },
	      blockers: [
	        {
	          code: 'OPEN_ERROR_COST_EXCEPTIONS',
	          source: 'cost_exceptions',
	          severity: 'blocker',
	          title: '开放错误级成本异常',
	          message: '存在 1 条未处理的错误级成本异常',
	          count: 1,
	        },
	        {
	          code: 'PENDING_COST_ITEMS',
	          source: 'outbound_records',
	          severity: 'blocker',
	          title: '未补算或成本异常出库',
	          message: '存在 1 单未补算或成本异常的出库记录',
	          count: 1,
	        },
	      ],
	      warnings: [
	        {
	          code: 'OPEN_WARNING_COST_EXCEPTIONS',
	          source: 'cost_exceptions',
	          severity: 'warning',
	          title: '开放警告级成本异常',
	          message: '存在 1 条建议处理的成本异常',
	          count: 1,
	        },
	      ],
	      nextActions: [
	        { action: 'review_cost_exceptions', label: '处理成本异常', href: '/abc/alerts?yearMonth=2026-06&status=open&includeUnassigned=1' },
	        { action: 'review_outbound_costs', label: '查看消耗对账', href: '/abc/alerts?yearMonth=2026-06&status=open' },
	      ],
	      sources: {},
	    })

	    render(
	      <MemoryRouter>
	        <CostDashboard />
	      </MemoryRouter>
	    )

	    expect(await screen.findByText('结账健康检查')).toBeInTheDocument()
	    expect(screen.getAllByText('阻断').length).toBeGreaterThanOrEqual(1)
	    expect(screen.getByText('2 项')).toBeInTheDocument()
	    expect(screen.getByText('警告')).toBeInTheDocument()
	    expect(screen.getByText('1 项')).toBeInTheDocument()
	    expect(screen.getByText('存在 1 条未处理的错误级成本异常')).toBeInTheDocument()
	    expect(screen.getByText('存在 1 单未补算或成本异常的出库记录')).toBeInTheDocument()
	    expect(screen.getByRole('link', { name: '处理成本异常' })).toHaveAttribute('href', '/abc/alerts?yearMonth=2026-06&status=open&includeUnassigned=1')
	  })

	  it('renders a degraded closing readiness message when the health check API fails', async () => {
	    vi.mocked(abcApi.getDashboard).mockResolvedValue(dashboardResponse)
	    vi.mocked(abcApi.getPeriods).mockResolvedValue(periodResponse)
	    vi.mocked(abcApi.getCostRuns).mockResolvedValue(emptyListResponse)
	    vi.mocked(abcApi.getAdjustments).mockResolvedValue(emptyListResponse)
	    vi.mocked(abcApi.getClosingReadiness).mockRejectedValue(new Error('closing readiness unavailable'))

	    render(
	      <MemoryRouter>
	        <CostDashboard />
	      </MemoryRouter>
	    )

	    expect(await screen.findByText('结账健康检查')).toBeInTheDocument()
	    expect(screen.getByText('暂不可用')).toBeInTheDocument()
	    expect(screen.getByText('结账健康检查暂时不可用，请稍后刷新。')).toBeInTheDocument()
	    expect(screen.getByText('成本看板')).toBeInTheDocument()
	  })
	})
