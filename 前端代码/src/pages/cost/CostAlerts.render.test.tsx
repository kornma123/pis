import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import CostAlerts from './CostAlerts'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getExceptions: vi.fn(),
    resolveException: vi.fn(),
    ignoreException: vi.fn(),
    retryException: vi.fn(),
  },
}))

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.search}</div>
}

describe('CostAlerts page state', () => {
  beforeEach(() => {
    vi.mocked(abcApi.getExceptions).mockReset()
  })

  it('loads exception records from audit deep link keyword on first render', async () => {
    vi.mocked(abcApi.getExceptions).mockResolvedValueOnce({
      list: [
        {
          id: 'exception-deep-link-1',
          exceptionNo: 'CE-AUDIT-DEEP-001',
          exceptionType: 'missing_fee_mapping',
          outboundNo: 'OUT-AUDIT-DEEP-001',
          projectName: '免疫组化项目',
          severity: 'error',
          status: 'open',
          message: 'BOM 未配置收费映射',
          retryCount: 0,
          outboundId: 'outbound-deep-link-1',
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      summary: {
        total: 1,
        status: { open: 1, resolved: 0, ignored: 0 },
        severity: { error: 1, warning: 0, info: 0 },
      },
      pagination: { total: 1 },
    })

    render(
      <MemoryRouter initialEntries={['/abc/alerts?keyword=CE-AUDIT-DEEP-001']}>
        <CostAlerts />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(abcApi.getExceptions).toHaveBeenCalledWith(expect.objectContaining({
        keyword: 'CE-AUDIT-DEEP-001',
        page: 1,
        pageSize: 20,
      }))
    })
    expect(screen.getByPlaceholderText('异常编号、出库单、项目')).toHaveValue('CE-AUDIT-DEEP-001')
    expect(await screen.findByText('CE-AUDIT-DEEP-001')).toBeInTheDocument()
    expect(screen.getByText('BOM 未配置收费映射')).toBeInTheDocument()
  })

  it('clears stale exception rows and summary when refresh fails', async () => {
    vi.mocked(abcApi.getExceptions)
      .mockResolvedValueOnce({
        list: [
          {
            id: 'exception-1',
            exceptionNo: 'CE-STALE',
            exceptionType: 'abc_calculation_failed',
            outboundNo: 'OUT-STALE',
            projectName: '胃癌筛查项目',
            severity: 'error',
            status: 'open',
            message: '旧异常不能残留',
            retryCount: 0,
            outboundId: 'outbound-1',
            createdAt: '2026-06-20T00:00:00Z',
          },
        ],
        summary: {
          total: 1,
          status: { open: 1, resolved: 0, ignored: 0 },
          severity: { error: 1, warning: 0, info: 0 },
        },
        pagination: { total: 1 },
      })
      .mockRejectedValueOnce(new Error('network down'))

    render(
      <MemoryRouter>
        <CostAlerts />
      </MemoryRouter>
    )

    expect(await screen.findByText('CE-STALE')).toBeInTheDocument()
    expect(screen.getByText('旧异常不能残留')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))

    await waitFor(() => expect(abcApi.getExceptions).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(screen.queryByText('CE-STALE')).not.toBeInTheDocument()
      expect(screen.queryByText('旧异常不能残留')).not.toBeInTheDocument()
      expect(screen.getByText('暂无成本异常')).toBeInTheDocument()
    })
    const summaryCards = screen.getAllByText('0')
    expect(summaryCards.length).toBeGreaterThanOrEqual(4)
  })

  it('blocks resolving an exception until a handling note is provided', async () => {
    vi.mocked(abcApi.getExceptions).mockResolvedValueOnce({
      list: [
        {
          id: 'exception-needs-note',
          exceptionNo: 'CE-NOTE-001',
          exceptionType: 'missing_fee_mapping',
          outboundNo: 'OUT-NOTE-001',
          projectName: '免疫组化项目',
          severity: 'error',
          status: 'open',
          message: 'BOM 未配置收费映射',
          retryCount: 0,
          outboundId: 'outbound-note-1',
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      summary: {
        total: 1,
        status: { open: 1, resolved: 0, ignored: 0 },
        severity: { error: 1, warning: 0, info: 0 },
      },
      pagination: { total: 1 },
    })

    render(
      <MemoryRouter>
        <CostAlerts />
      </MemoryRouter>
    )

    expect(await screen.findByText('CE-NOTE-001')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '解决' }))

    expect(screen.getByText('请填写处理说明，系统才能留下异常处理、成本重算和审计依据。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认' })).toBeDisabled()
    expect(abcApi.resolveException).not.toHaveBeenCalled()
  })

  it('shows the business next step in each exception row before users handle it', async () => {
    vi.mocked(abcApi.getExceptions).mockResolvedValueOnce({
      list: [
        {
          id: 'exception-guidance-1',
          exceptionNo: 'CE-GUIDE-001',
          exceptionType: 'reconciliation_variance',
          outboundNo: 'OUT-GUIDE-001',
          projectName: '免疫组化项目',
          severity: 'warning',
          status: 'open',
          message: '实际出库与BOM理论消耗存在差异',
          retryCount: 0,
          outboundId: 'outbound-guide-1',
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      summary: {
        total: 1,
        status: { open: 1, resolved: 0, ignored: 0 },
        severity: { error: 0, warning: 1, info: 0 },
      },
      pagination: { total: 1 },
    })

    render(
      <MemoryRouter>
        <CostAlerts />
      </MemoryRouter>
    )

    expect(await screen.findByText('CE-GUIDE-001')).toBeInTheDocument()
    expect(screen.getByText('实际出库与BOM理论消耗存在差异')).toBeInTheDocument()
    expect(screen.getByText('下一步：回到消耗对账核对LIS病例、BOM理论消耗和出库批次，修正后重新审计差异。')).toBeInTheDocument()
  })

  it('keeps reconciliation variance exceptions scoped to the project and links back to source reconciliation', async () => {
    vi.mocked(abcApi.getExceptions).mockResolvedValueOnce({
      list: [
        {
          id: 'exception-reconciliation-1',
          exceptionNo: 'CE-RECON-LINK-001',
          exceptionType: 'reconciliation_variance',
          sourceModule: 'reconciliation',
          projectId: 'project-1',
          projectName: 'HE制片',
          severity: 'warning',
          status: 'open',
          message: 'HE制片 / 苏木素 对账差异 -2 ml',
          retryCount: 0,
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      summary: {
        total: 1,
        status: { open: 1, resolved: 0, ignored: 0 },
        severity: { error: 0, warning: 1, info: 0 },
      },
      pagination: { total: 1 },
    })

    render(
      <MemoryRouter initialEntries={['/abc/alerts?projectId=project-1&exceptionType=reconciliation_variance&status=open']}>
        <CostAlerts />
        <LocationProbe />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(abcApi.getExceptions).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-1',
        exceptionType: 'reconciliation_variance',
        status: 'open',
      }))
    })
    expect(await screen.findByText('CE-RECON-LINK-001')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回到消耗对账' }))

    expect(screen.getByTestId('location')).toHaveTextContent('/reconciliation?projectId=project-1')
  })

  it('keeps reconciliation date range when returning from a project variance exception', async () => {
    vi.mocked(abcApi.getExceptions).mockResolvedValueOnce({
      list: [
        {
          id: 'exception-reconciliation-date-1',
          exceptionNo: 'CE-RECON-DATE-001',
          exceptionType: 'reconciliation_variance',
          sourceModule: 'reconciliation',
          projectId: 'project-1',
          projectName: 'HE制片',
          severity: 'warning',
          status: 'open',
          message: 'HE制片 / 苏木素 对账差异 2 ml',
          retryCount: 0,
          createdAt: '2036-06-20T00:00:00Z',
        },
      ],
      summary: {
        total: 1,
        status: { open: 1, resolved: 0, ignored: 0 },
        severity: { error: 0, warning: 1, info: 0 },
      },
      pagination: { total: 1 },
    })

    render(
      <MemoryRouter initialEntries={['/abc/alerts?projectId=project-1&exceptionType=reconciliation_variance&status=open&startDate=2036-06-01&endDate=2036-06-30']}>
        <CostAlerts />
        <LocationProbe />
      </MemoryRouter>
    )

    expect(await screen.findByText('CE-RECON-DATE-001')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回到消耗对账' }))

    expect(screen.getByTestId('location')).toHaveTextContent('/reconciliation?projectId=project-1&startDate=2036-06-01&endDate=2036-06-30')
  })

  it('links missing fee mapping exceptions to the filtered BOM fee mapping source page', async () => {
    vi.mocked(abcApi.getExceptions).mockResolvedValueOnce({
      list: [
        {
          id: 'exception-fee-source-1',
          exceptionNo: 'CE-FEE-SOURCE-001',
          exceptionType: 'missing_fee_mapping',
          sourceModule: 'abc',
          sourceId: 'outbound-fee-1',
          outboundId: 'outbound-fee-1',
          outboundNo: 'OUT-FEE-SOURCE-001',
          projectId: 'project-fee-1',
          projectName: 'IHC检测',
          bomId: 'bom-fee-source-1',
          bomName: 'IHC收费BOM',
          severity: 'error',
          status: 'open',
          message: 'BOM未配置收费映射，出库收费与利润核算不可确认',
          retryCount: 0,
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      summary: {
        total: 1,
        status: { open: 1, resolved: 0, ignored: 0 },
        severity: { error: 1, warning: 0, info: 0 },
      },
      pagination: { total: 1 },
    })

    render(
      <MemoryRouter>
        <CostAlerts />
        <LocationProbe />
      </MemoryRouter>
    )

    expect(await screen.findByText('CE-FEE-SOURCE-001')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '配置收费映射' }))

    expect(screen.getByTestId('location')).toHaveTextContent('/abc/fee-mappings?keyword=bom-fee-source-1&status=missing')
  })

  it('links missing BOM exceptions to the project BOM edit source page', async () => {
    vi.mocked(abcApi.getExceptions).mockResolvedValueOnce({
      list: [
        {
          id: 'exception-bom-source-1',
          exceptionNo: 'CE-BOM-SOURCE-001',
          exceptionType: 'missing_bom',
          sourceModule: 'reconciliation',
          sourceId: 'case-bom-source-1',
          projectId: 'project-bom-source-1',
          projectName: 'HE检测',
          severity: 'error',
          status: 'open',
          message: '检测服务未绑定BOM，无法承接出库、LIS对账和成本核算',
          retryCount: 0,
          createdAt: '2026-06-20T00:00:00Z',
        },
      ],
      summary: {
        total: 1,
        status: { open: 1, resolved: 0, ignored: 0 },
        severity: { error: 1, warning: 0, info: 0 },
      },
      pagination: { total: 1 },
    })

    render(
      <MemoryRouter>
        <CostAlerts />
        <LocationProbe />
      </MemoryRouter>
    )

    expect(await screen.findByText('CE-BOM-SOURCE-001')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '配置项目BOM' }))

    expect(screen.getByTestId('location')).toHaveTextContent('/projects?keyword=project-bom-source-1&bom=unconfigured&action=edit&projectId=project-bom-source-1&tab=bom')
  })
})
