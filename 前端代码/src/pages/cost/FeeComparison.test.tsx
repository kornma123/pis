import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import { downloadTextFile } from '@/lib/utils'
import FeeComparison from './FeeComparison'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getFeeComparison: vi.fn(),
    exportData: vi.fn(),
  },
}))

vi.mock('@/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  downloadTextFile: vi.fn(),
  formatCurrency: (num: number | undefined) => {
    if (num === undefined || num === null) return '-'
    return '¥' + num.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  },
  formatDate: (value: string) => value,
}))

const feeRecord = (overrides: Partial<any> = {}) => ({
  outboundId: 'out-he-1',
  outboundNo: 'OUT-HE-001',
  date: '2026-06-18',
  projectName: 'HE检测',
  projectType: 'he',
  sampleCount: 2,
  materialCost: 40,
  activityCost: 20,
  totalCost: 60,
  feeAmount: 120,
  profit: 60,
  profitRate: 0.5,
  feeStandardName: 'HE收费标准',
  feeCategory: 'HE',
  ...overrides,
})

const feeResponse = (list = [feeRecord()], total = list.length) => ({
  list,
  summary: {
    totalOutbounds: total,
    totalCost: list.reduce((sum, item) => sum + item.totalCost, 0),
    totalFee: list.reduce((sum, item) => sum + item.feeAmount, 0),
    totalProfit: list.reduce((sum, item) => sum + item.profit, 0),
    lossCount: list.filter(item => item.profit < 0).length,
    noMappingCount: list.filter(item => !item.feeStandardName).length,
  },
  pagination: { page: 1, pageSize: 20, total },
})

describe('FeeComparison', () => {
  beforeEach(() => {
    vi.mocked(abcApi.getFeeComparison).mockReset()
    vi.mocked(abcApi.exportData).mockReset()
    vi.mocked(downloadTextFile).mockReset()
  })

  it('displays project type labels in the table instead of internal enum values', async () => {
    vi.mocked(abcApi.getFeeComparison).mockResolvedValue(feeResponse() as any)

    render(<FeeComparison />)

    await waitFor(() => expect(screen.getByText('OUT-HE-001')).toBeInTheDocument())

    const row = screen.getByText('OUT-HE-001').closest('tr')
    expect(row).not.toBeNull()
    expect(within(row!).getByText('HE染色')).toBeInTheDocument()
    expect(within(row!).queryByText('he')).not.toBeInTheDocument()
  })

  it('exports all filtered fee comparison rows with display labels', async () => {
    const firstPage = feeResponse([feeRecord()], 2)
    const exportRows = [
      feeRecord(),
      feeRecord({
        outboundId: 'out-he-2',
        outboundNo: 'OUT-HE-002',
        projectName: 'HE亏损检测',
        profit: -10,
        profitRate: -0.1,
        feeStandardName: null,
      }),
    ]
    vi.mocked(abcApi.getFeeComparison)
      .mockResolvedValueOnce(firstPage as any)
      .mockResolvedValue(feeResponse(exportRows, 2) as any)
    vi.mocked(abcApi.exportData).mockResolvedValue({
      filename: 'abc-cost-export.csv',
      content: 'project_type\nhe',
      mimeType: 'text/csv;charset=utf-8',
    } as any)

    render(<FeeComparison />)

    await waitFor(() => expect(screen.getByText('OUT-HE-001')).toBeInTheDocument())

    const [profitSelect, mappingSelect] = screen.getAllByDisplayValue('全部')
    fireEvent.change(profitSelect, { target: { value: 'loss' } })
    fireEvent.change(mappingSelect, { target: { value: 'unmapped' } })

    await waitFor(() => expect(abcApi.getFeeComparison).toHaveBeenLastCalledWith(expect.objectContaining({
      profitFilter: 'loss',
      mappingFilter: 'unmapped',
    })))

    fireEvent.click(screen.getByRole('button', { name: /导出/ }))

    await waitFor(() => expect(downloadTextFile).toHaveBeenCalled())
    expect(abcApi.exportData).not.toHaveBeenCalled()
    expect(abcApi.getFeeComparison).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      pageSize: 20,
      profitFilter: 'loss',
      mappingFilter: 'unmapped',
    }))
    const [, content, mimeType] = vi.mocked(downloadTextFile).mock.calls[0]
    expect(mimeType).toBe('text/csv;charset=utf-8')
    expect(content).toContain('HE染色')
    expect(content).toContain('OUT-HE-002')
    expect(content).toContain('未映射')
    expect(content).not.toContain('project_type\nhe')
  })
})
