import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import AuditTrail from './AuditTrail'
import { buildAuditBusinessReviewLink } from './AuditTrail'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getAuditLogs: vi.fn(),
  },
}))

describe('AuditTrail page', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/abc/audit')
    vi.mocked(abcApi.getAuditLogs).mockReset()
  })

  it('renders current audit log response shape and shows detail payload', async () => {
    vi.mocked(abcApi.getAuditLogs).mockResolvedValueOnce({
      list: [
        {
          id: 'audit-1',
          module: 'cost_adjustment',
          targetType: 'cost_adjustment',
          action: 'approve',
          targetId: 'adjustment-1',
          detail: JSON.stringify({
            adjustmentNo: 'ADJ-209902-001',
            yearMonth: '2099-02',
            amount: 128.5,
            remark: '财务复核通过',
          }),
          operator: 'sunli',
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      pagination: { total: 1, page: 1, pageSize: 20, totalPages: 1 },
      total: 1,
    })

    render(<AuditTrail />)

    expect(await screen.findByText('审核通过')).toBeInTheDocument()
    const adjustmentLabels = screen.getAllByText('关账后调整单')
    expect(adjustmentLabels.some((el) => el.closest('td'))).toBe(true)
    expect(screen.getByText('sunli')).toBeInTheDocument()
    expect(screen.queryByText('暂无审计日志')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTitle('查看详情'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('adjustment-1')).toBeInTheDocument()
    expect(within(dialog).getByText(/ADJ-209902-001/)).toBeInTheDocument()
    expect(within(dialog).getAllByText(/财务复核通过/).length).toBeGreaterThan(0)
    expect(within(dialog).getByText('审计证据回看')).toBeInTheDocument()
    expect(within(dialog).getByText('先回成本业务页面核对原始事实，再用同一业务标识继续查看审计日志。')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: '回到成本业务页面' })).toHaveAttribute(
      'href',
      '/abc/dashboard?month=2099-02&keyword=ADJ-209902-001',
    )
    expect(within(dialog).getByRole('link', { name: '查看同一标识审计日志' })).toHaveAttribute(
      'href',
      '/abc/audit?keyword=ADJ-209902-001',
    )

    await waitFor(() => expect(abcApi.getAuditLogs).toHaveBeenCalledWith({ page: 1, pageSize: 20 }))
  })

  it('uses URL keyword so finance users can open the exact audit evidence without manual paging', async () => {
    window.history.replaceState(null, '', '/abc/audit?keyword=ADJ-AUDIT-DEEP-001')
    vi.mocked(abcApi.getAuditLogs).mockResolvedValueOnce({
      list: [
        {
          id: 'audit-keyword-1',
          module: 'cost_adjustment',
          targetType: 'cost_adjustment',
          action: 'approve',
          targetId: 'adjustment-keyword-1',
          detail: JSON.stringify({
            adjustmentNo: 'ADJ-AUDIT-DEEP-001',
            yearMonth: '2099-03',
            reason: '按财务复核单调整',
          }),
          operator: 'sunli',
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      pagination: { total: 1, page: 1, pageSize: 20, totalPages: 1 },
      total: 1,
    })

    render(<AuditTrail />)

    expect(await screen.findByDisplayValue('ADJ-AUDIT-DEEP-001')).toBeInTheDocument()
    expect(screen.getByText('按财务复核单调整')).toBeInTheDocument()
    expect(screen.getByText('当前按关键字检索：ADJ-AUDIT-DEEP-001')).toBeInTheDocument()

    await waitFor(() => expect(abcApi.getAuditLogs).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      keyword: 'ADJ-AUDIT-DEEP-001',
    }))
  })

  it('explains an empty keyword audit result instead of leaving finance users to verify offline', async () => {
    window.history.replaceState(null, '', '/abc/audit?keyword=ADJ-MISSING-001')
    vi.mocked(abcApi.getAuditLogs).mockResolvedValueOnce({
      list: [],
      pagination: { total: 0, page: 1, pageSize: 20, totalPages: 0 },
      total: 0,
    })

    render(<AuditTrail />)

    expect(await screen.findByText('未找到 ADJ-MISSING-001 的成本审计证据')).toBeInTheDocument()
    expect(screen.getByText('请确认调整单号、异常号或任务号是否正确；也可以返回成本看板或异常中心确认该业务动作是否已经生成审计记录。')).toBeInTheDocument()
  })

  it('builds cost exception review links without status filters so resolved exceptions remain reachable', () => {
    expect(buildAuditBusinessReviewLink({
      targetType: 'exception',
      targetId: 'exception-1',
      detail: JSON.stringify({ exceptionNo: 'CE-RESOLVED-001' }),
    })).toBe('/abc/alerts?keyword=CE-RESOLVED-001')
  })
})
