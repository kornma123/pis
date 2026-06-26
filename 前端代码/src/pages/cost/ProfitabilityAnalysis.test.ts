import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import { downloadTextFile } from '@/lib/utils'
import { aggregateProfitabilityRows, ProfitabilityAnalysis } from './ProfitabilityAnalysis'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getProfitability: vi.fn(),
    exportData: vi.fn(),
  },
}))

vi.mock('@/lib/utils', () => ({
  downloadTextFile: vi.fn(),
  formatCurrency: (num: number | undefined) => {
    if (num === undefined || num === null) return '-'
    return '¥' + num.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  },
}))

describe('aggregateProfitabilityRows', () => {
  it('按项目汇总同月同类型盈利数据', () => {
    const result = aggregateProfitabilityRows([
      {
        outboundId: 'out-1',
        projectId: 'proj-he',
        projectName: 'HE检测',
        projectType: 'he',
        costMonth: '2026-06',
        sampleCount: 2,
        materialCost: 40,
        activityCost: 20,
        totalCost: 60,
        feeAmount: 120,
        profit: 60,
      },
      {
        outboundId: 'out-2',
        projectId: 'proj-he',
        projectName: 'HE检测',
        projectType: 'he',
        costMonth: '2026-06',
        sampleCount: 3,
        materialCost: 90,
        activityCost: 30,
        totalCost: 120,
        feeAmount: 180,
        profit: 60,
      },
      {
        outboundId: 'out-other',
        projectId: 'proj-ihc',
        projectName: 'IHC检测',
        projectType: 'ihc',
        costMonth: '2026-06',
        sampleCount: 9,
        totalCost: 999,
        feeAmount: 999,
        profit: 0,
      },
    ], '2026-06', 'he')

    expect(result).toEqual([
      {
        projectId: 'proj-he',
        projectName: 'HE检测',
        projectType: 'he',
        caseCount: 2,
        sampleCount: 5,
        materialCost: 130,
        activityCost: 50,
        totalCost: 180,
        feeAmount: 300,
        profit: 120,
        profitRate: 0.4,
      },
    ])
  })
})

describe('ProfitabilityAnalysis', () => {
  beforeEach(() => {
    vi.mocked(abcApi.getProfitability).mockReset()
    vi.mocked(abcApi.exportData).mockReset()
    vi.mocked(downloadTextFile).mockReset()
  })

  it('exports with the month currently selected on the page', async () => {
    vi.mocked(abcApi.getProfitability).mockResolvedValue({ list: [] } as any)
    vi.mocked(abcApi.exportData).mockResolvedValue({
      filename: 'abc-profitability.csv',
      content: 'ok',
      mimeType: 'text/csv;charset=utf-8',
    } as any)

    render(React.createElement(ProfitabilityAnalysis))

    await waitFor(() => expect(abcApi.getProfitability).toHaveBeenCalled())

    fireEvent.change(screen.getByDisplayValue(new Date().toISOString().slice(0, 7)), {
      target: { value: '2026-05' },
    })

    await waitFor(() => expect(abcApi.getProfitability).toHaveBeenLastCalledWith({
      dimension: 'project',
      startDate: '2026-05',
      endDate: '2026-05',
      projectType: undefined,
      pageSize: 1000,
    }))

    fireEvent.click(screen.getByRole('button', { name: /导出报表/ }))

    await waitFor(() => expect(abcApi.exportData).toHaveBeenCalled())
    expect(abcApi.exportData).toHaveBeenCalledWith({
      month: '2026-05',
      projectType: undefined,
    })
    expect(downloadTextFile).toHaveBeenCalledWith(
      'abc-profitability.csv',
      'ok',
      'text/csv;charset=utf-8',
    )
  })

  it('displays project type labels in the table instead of internal enum values', async () => {
    vi.mocked(abcApi.getProfitability).mockResolvedValue({
      list: [
        {
          outboundId: 'out-he-1',
          projectId: 'proj-he',
          projectName: 'HE检测',
          projectType: 'he',
          costMonth: new Date().toISOString().slice(0, 7),
          sampleCount: 2,
          totalCost: 60,
          feeAmount: 120,
          profit: 60,
        },
      ],
    } as any)

    render(React.createElement(ProfitabilityAnalysis))

    await waitFor(() => expect(screen.getByText('HE检测')).toBeInTheDocument())

    const row = screen.getByText('HE检测').closest('tr')
    expect(row).not.toBeNull()
    expect(within(row!).getByText('HE染色')).toBeInTheDocument()
    expect(within(row!).queryByText('he')).not.toBeInTheDocument()
  })

  it('shows insight quality so managers do not treat draft profitability as final', async () => {
    vi.mocked(abcApi.getProfitability).mockResolvedValue({
      list: [
        {
          outboundId: 'out-he-1',
          projectId: 'proj-he',
          projectName: 'HE检测',
          projectType: 'he',
          costMonth: new Date().toISOString().slice(0, 7),
          sampleCount: 2,
          totalCost: 60,
          feeAmount: 120,
          profit: 60,
        },
      ],
      insightQuality: {
        yearMonth: new Date().toISOString().slice(0, 7),
        periodStatus: 'calculated',
        isClosed: false,
        isFinal: false,
        openExceptionCount: 1,
        pendingCostCount: 1,
        abcSnapshotCount: 1,
        outboundCount: 2,
        reliability: 'attention',
        message: '成本期间未关账；1 条开放成本异常；1 单未补算或成本异常，当前数据仅适合作为过程观察，不能作为最终经营判断。',
      },
    } as any)

    render(React.createElement(ProfitabilityAnalysis))

    expect(await screen.findByText('口径待确认')).toBeInTheDocument()
    expect(screen.getByText(/成本期间未关账/)).toBeInTheDocument()
    expect(screen.getByText(/开放成本异常/)).toBeInTheDocument()
    expect(screen.getAllByText(/未补算/).length).toBeGreaterThan(0)
  })
})
