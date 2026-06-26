import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import { reportsApi } from '@/api/reports'
import { downloadTextFile } from '@/lib/utils'
import CostTrend, { normalizeSlideCostTrendRows } from './CostTrend'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getSlideCostTrend: vi.fn(),
    exportData: vi.fn(),
  },
}))

vi.mock('@/api/reports', () => ({
  reportsApi: {
    getCostTrend: vi.fn(),
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

vi.mock('recharts', () => {
  const passthrough = ({ children }: any) => React.createElement('div', null, children)
  return {
    ResponsiveContainer: passthrough,
    LineChart: passthrough,
    Line: () => null,
    BarChart: passthrough,
    Bar: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
  }
})

describe('normalizeSlideCostTrendRows', () => {
  it('兼容月度汇总型趋势数据并补齐图表字段', () => {
    const result = normalizeSlideCostTrendRows([
      {
        month: '2026-06',
        totalCost: 300,
        materialCost: 210,
        activityCost: 90,
        sampleCount: 5,
      },
    ])

    expect(result).toEqual([
      {
        month: '2026-06',
        bomId: 'all',
        bomName: '全部BOM/项目',
        projectType: 'all',
        costPerSlide: 60,
        materialCost: 210,
        activityCost: 90,
        feeAmount: 0,
        marginRate: 0,
      },
    ])
  })

  it('优先使用明细行已有的BOM名称和利润率', () => {
    const result = normalizeSlideCostTrendRows([
      {
        month: '2026-06',
        bomId: 'bom-1',
        bomName: 'HE标准BOM',
        projectType: 'he',
        costPerSlide: 12.5,
        materialCost: 20,
        activityCost: 5,
        feeAmount: 100,
        marginRate: 0.25,
      },
    ])

    expect(result[0]).toMatchObject({
      bomId: 'bom-1',
      bomName: 'HE标准BOM',
      projectType: 'he',
      costPerSlide: 12.5,
      marginRate: 0.25,
    })
  })
})

describe('CostTrend', () => {
  beforeEach(() => {
    vi.mocked(abcApi.getSlideCostTrend).mockReset()
    vi.mocked(abcApi.exportData).mockReset()
    vi.mocked(reportsApi.getCostTrend).mockReset()
    vi.mocked(downloadTextFile).mockReset()
  })

  it('exports monthly trend data with project type labels instead of generic raw details', async () => {
    vi.mocked(abcApi.getSlideCostTrend).mockResolvedValue({
      trend: [
        {
          month: '2026-06',
          bomId: 'bom-he',
          bomName: 'HE标准BOM',
          projectType: 'he',
          costPerSlide: 12.5,
          materialCost: 20,
          activityCost: 5,
          feeAmount: 100,
          marginRate: 0.25,
        },
      ],
    } as any)
    vi.mocked(abcApi.exportData).mockResolvedValue({
      filename: 'abc-cost-export.csv',
      content: 'project_type\nhe',
      mimeType: 'text/csv;charset=utf-8',
    } as any)

    render(React.createElement(CostTrend))

    await waitFor(() => expect(abcApi.getSlideCostTrend).toHaveBeenCalledWith({ months: 12 }))

    fireEvent.click(screen.getByTestId('export-btn'))

    await waitFor(() => expect(downloadTextFile).toHaveBeenCalled())
    expect(abcApi.exportData).not.toHaveBeenCalled()
    const [, content, mimeType] = vi.mocked(downloadTextFile).mock.calls[0]
    expect(mimeType).toBe('text/csv;charset=utf-8')
    expect(content).toContain('HE标准BOM')
    expect(content).toContain('HE染色')
    expect(content).toContain('2026-06')
    expect(content).not.toContain('project_type\nhe')
  })

  it('loads quarterly trend from the ABC trusted snapshot endpoint', async () => {
    vi.mocked(abcApi.getSlideCostTrend)
      .mockResolvedValueOnce({ trend: [] } as any)
      .mockResolvedValueOnce({
        trend: [
          { period: '2026-Q2', cost: 300, recordCount: 2, sampleCount: 5, isComplete: true },
        ],
      } as any)

    render(React.createElement(CostTrend))

    await waitFor(() => expect(abcApi.getSlideCostTrend).toHaveBeenCalledWith({ months: 12 }))

    fireEvent.click(screen.getByRole('button', { name: '季度' }))

    await waitFor(() => expect(abcApi.getSlideCostTrend).toHaveBeenLastCalledWith({
      dimension: 'quarterly',
      months: 12,
    }))
    expect(reportsApi.getCostTrend).not.toHaveBeenCalled()
    expect(await screen.findByText('2026-Q2')).toBeInTheDocument()
  })

  it('reloads quarterly trend when the selected range changes', async () => {
    vi.mocked(abcApi.getSlideCostTrend)
      .mockResolvedValueOnce({ trend: [] } as any)
      .mockResolvedValueOnce({
        trend: [{ period: '2026-Q2', cost: 300, recordCount: 2, sampleCount: 5, isComplete: true }],
      } as any)
      .mockResolvedValueOnce({
        trend: [{ period: '2026-Q1', cost: 180, recordCount: 1, sampleCount: 2, isComplete: true }],
      } as any)

    render(React.createElement(CostTrend))

    await waitFor(() => expect(abcApi.getSlideCostTrend).toHaveBeenCalledWith({ months: 12 }))
    fireEvent.click(screen.getByRole('button', { name: '季度' }))
    await waitFor(() => expect(abcApi.getSlideCostTrend).toHaveBeenLastCalledWith({
      dimension: 'quarterly',
      months: 12,
    }))

    fireEvent.change(screen.getByDisplayValue('近 12 个月'), { target: { value: '6' } })

    await waitFor(() => expect(abcApi.getSlideCostTrend).toHaveBeenLastCalledWith({
      dimension: 'quarterly',
      months: 6,
    }))
    expect(await screen.findByText('2026-Q1')).toBeInTheDocument()
  })

  it('shows month insight quality for draft or exception cost trend periods', async () => {
    vi.mocked(abcApi.getSlideCostTrend).mockResolvedValue({
      trend: [
        {
          month: '2026-06',
          bomId: 'bom-he',
          bomName: 'HE标准BOM',
          projectType: 'he',
          totalCost: 300,
          materialCost: 210,
          activityCost: 90,
          sampleCount: 5,
        },
      ],
      insightQuality: {
        '2026-06': {
          yearMonth: '2026-06',
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
      },
    } as any)

    render(React.createElement(CostTrend))

    expect(await screen.findByText('趋势口径待确认')).toBeInTheDocument()
    expect(screen.getAllByText(/2026-06/).length).toBeGreaterThan(0)
    expect(screen.getByText(/成本期间未关账/)).toBeInTheDocument()
    expect(screen.getByText(/开放成本异常/)).toBeInTheDocument()
    expect(screen.getAllByText(/未补算/).length).toBeGreaterThan(0)
  })
})
