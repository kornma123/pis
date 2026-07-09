import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import { downloadTextFile } from '@/lib/utils'
import CostVarianceAnalysis from './CostVarianceAnalysis'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getVarianceAnalysis: vi.fn(),
  },
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    downloadTextFile: vi.fn(),
  }
})

// HON-3（P-7）：标准成本停返后，本页降级为「仅展示实际成本」。以下用例锁定：
//   ① 不再渲染任何假差异率/差异数；② 显示「待校准」降级态；③ 实际成本真实透出、可导出。
const uncalibratedSummary = (totalActual: number) => ({
  totalActual,
  totalStandard: null,
  totalVariance: null,
  varianceRate: null,
  standardCalibrated: false,
})

describe('CostVarianceAnalysis 降级（标准成本停返）', () => {
  beforeEach(() => {
    vi.mocked(abcApi.getVarianceAnalysis).mockReset()
    vi.mocked(downloadTextFile).mockReset()
    vi.mocked(abcApi.getVarianceAnalysis).mockResolvedValue({
      summary: uncalibratedSummary(0),
      list: [],
    })
  })

  it('shows a visible month range validation error before requesting reversed report dates', async () => {
    const { container } = render(<CostVarianceAnalysis />)
    await waitFor(() => expect(abcApi.getVarianceAnalysis).toHaveBeenCalled())

    const [startInput, endInput] = Array.from(container.querySelectorAll('input[type="month"]'))
    fireEvent.change(startInput, { target: { value: '2026-07' } })
    fireEvent.change(endInput, { target: { value: '2026-06' } })

    expect(screen.getByText('开始月份不能晚于结束月份')).toBeInTheDocument()
    await waitFor(() => {
      expect(abcApi.getVarianceAnalysis).not.toHaveBeenCalledWith(expect.objectContaining({
        startDate: '2026-07-01',
        endDate: '2026-06-28',
      }))
    })
  })

  it('renders real actual cost but never fabricates a variance rate, and shows the uncalibrated notice', async () => {
    vi.mocked(abcApi.getVarianceAnalysis).mockResolvedValueOnce({
      summary: uncalibratedSummary(1200),
      list: [
        {
          projectId: 'project-1',
          projectName: '胃癌筛查项目',
          materialActual: 1000,
          activityCost: 200,
          totalActual: 1200,
          sampleCount: 5,
          month: '2026-06',
          standardCalibrated: false,
        },
      ],
    })

    render(<CostVarianceAnalysis />)

    expect(await screen.findByText('胃癌筛查项目')).toBeInTheDocument()
    // 降级提示可见
    expect(screen.getByText('标准成本待校准 · 差异分析暂不可用')).toBeInTheDocument()
    // 标准/差异/差异率显示「待校准」，不再渲染任何假差异率
    expect(screen.getAllByText('待校准').length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText('+20.00%')).not.toBeInTheDocument()
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
    // HON-3：标题下不再以「计划值 vs 核算值」的对比口吻误导用户（该框架正是本次要退休的）
    expect(document.body.textContent).not.toContain('计划值')
    expect(document.body.textContent).toContain('暂不做「标准 vs 实际」差异对比')
  })

  it('uses the supported BOM dimension for actual cost grouping', async () => {
    vi.mocked(abcApi.getVarianceAnalysis)
      .mockResolvedValueOnce({ summary: uncalibratedSummary(0), list: [] })
      .mockResolvedValueOnce({
        summary: uncalibratedSummary(850),
        list: [
          {
            id: 'bom-1',
            bomId: 'bom-1',
            bomName: 'HE染色BOM',
            projectId: 'project-1',
            projectName: '不应作为BOM维度主标签',
            materialActual: 800,
            activityCost: 50,
            totalActual: 850,
            sampleCount: 8,
            month: '2026-06',
            standardCalibrated: false,
          },
        ],
      })

    const { container } = render(<CostVarianceAnalysis />)
    await waitFor(() => expect(abcApi.getVarianceAnalysis).toHaveBeenCalledTimes(1))

    fireEvent.change(container.querySelector('select') as HTMLSelectElement, { target: { value: 'bom' } })

    expect(await screen.findByText('HE染色BOM')).toBeInTheDocument()
    expect(screen.queryByText('不应作为BOM维度主标签')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(abcApi.getVarianceAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({
        compareType: 'bom',
      }))
    })
  })

  it('clears stale rows when a refreshed request fails', async () => {
    vi.mocked(abcApi.getVarianceAnalysis)
      .mockResolvedValueOnce({
        summary: uncalibratedSummary(1200),
        list: [
          {
            projectId: 'project-1',
            projectName: '胃癌筛查项目',
            materialActual: 1000,
            activityCost: 200,
            totalActual: 1200,
            sampleCount: 5,
            month: '2026-06',
            standardCalibrated: false,
          },
        ],
      })
      .mockRejectedValueOnce(new Error('network down'))

    const { container } = render(<CostVarianceAnalysis />)

    expect(await screen.findByText('胃癌筛查项目')).toBeInTheDocument()
    fireEvent.change(container.querySelector('select') as HTMLSelectElement, { target: { value: 'bom' } })

    await waitFor(() => expect(abcApi.getVarianceAnalysis).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(screen.queryByText('胃癌筛查项目')).not.toBeInTheDocument()
      expect(screen.getByText('暂无实际成本数据')).toBeInTheDocument()
    })
  })

  it('exports only real actual-cost columns (no fabricated standard/variance columns)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(abcApi.getVarianceAnalysis).mockResolvedValueOnce({
      summary: uncalibratedSummary(1700),
      list: [
        {
          projectId: 'project-1',
          projectName: '胃癌筛查项目',
          materialActual: 1000,
          activityCost: 200,
          totalActual: 1200,
          sampleCount: 5,
          month: '2026-06',
          standardCalibrated: false,
        },
        {
          projectId: 'project-2',
          projectName: '未筛选项目',
          materialActual: 500,
          activityCost: 0,
          totalActual: 500,
          sampleCount: 2,
          month: '2026-06',
          standardCalibrated: false,
        },
      ],
    })

    try {
      render(<CostVarianceAnalysis />)

      expect(await screen.findByText('胃癌筛查项目')).toBeInTheDocument()
      fireEvent.change(screen.getByPlaceholderText('搜索项目名称...'), { target: { value: '胃癌' } })
      fireEvent.click(screen.getByRole('button', { name: /导出/ }))

      await waitFor(() => expect(downloadTextFile).toHaveBeenCalledTimes(1))
      const [filename, content, mimeType] = vi.mocked(downloadTextFile).mock.calls[0]
      expect(filename).toMatch(/^abc-cost-actual-project-/)
      expect(mimeType).toBe('text/csv;charset=utf-8')
      expect(content).toContain('项目名称,月份,样本数,实际成本,材料实际,作业成本')
      expect(content).toContain('胃癌筛查项目,2026-06,5,1200,1000,200')
      expect(content).not.toContain('未筛选项目')
      // 停返的假列不得出现在导出中
      expect(content).not.toContain('差异率')
      expect(content).not.toContain('标准成本')
      expect(consoleErrorSpy.mock.calls.some(call =>
        call.some(part => String(part).includes('Encountered two children with the same key'))
      )).toBe(false)
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })
})
