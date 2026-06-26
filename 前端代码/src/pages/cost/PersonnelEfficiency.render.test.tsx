import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportsApi } from '@/api/reports'
import { downloadTextFile } from '@/lib/utils'
import PersonnelEfficiency from './PersonnelEfficiency'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

vi.mock('@/api/reports', () => ({
  reportsApi: {
    getPersonnelEfficiency: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
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
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    LineChart: passthrough,
    Line: () => <div />,
    BarChart: passthrough,
    Bar: () => <div />,
    XAxis: () => <div />,
    YAxis: () => <div />,
    CartesianGrid: () => <div />,
    Tooltip: () => <div />,
    Legend: () => <div />,
    ResponsiveContainer: passthrough,
  }
})

describe('PersonnelEfficiency', () => {
  beforeEach(() => {
    vi.mocked(reportsApi.getPersonnelEfficiency).mockReset()
    vi.mocked(downloadTextFile).mockReset()
  })

  it('uses backend summary instead of recalculating report totals from ranking rows', async () => {
    vi.mocked(reportsApi.getPersonnelEfficiency).mockResolvedValue({
      summary: {
        personCount: 3,
        totalOutput: 20,
        totalLaborCost: 999,
        totalStandardHours: 12.5,
        avgEfficiency: 1.23,
        costPerOutput: 49.95,
      },
      ranking: [
        {
          id: 'tech-a',
          name: '技术员A',
          role: 'technician',
          efficiency: 0.5,
          totalCost: 100,
          outputCount: 5,
          standardHours: 1,
          outputPerHour: 5,
          costPerOutput: 20,
        },
      ],
      trend: [],
    } as any)

    render(<PersonnelEfficiency />)

    await waitFor(() => expect(reportsApi.getPersonnelEfficiency).toHaveBeenCalledWith({
      timeRange: '6m',
      role: 'all',
    }))

    expect(screen.getByText('人员数量').parentElement).toHaveTextContent('3')
    expect(screen.getByText('平均效率').parentElement).toHaveTextContent('1.23')
    expect(screen.getByText('总人工成本').parentElement).toHaveTextContent('¥999.00')
    expect(screen.getByText('总人工成本').parentElement).not.toHaveTextContent('¥100.00')
    expect(screen.getByText('单位产出成本').parentElement).toHaveTextContent('¥49.95')
  })

  it('keeps the latest filter result when an older request resolves later', async () => {
    const initialRequest = deferred<any>()
    const latestRequest = deferred<any>()
    vi.mocked(reportsApi.getPersonnelEfficiency)
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(latestRequest.promise)

    render(<PersonnelEfficiency />)

    await waitFor(() => expect(reportsApi.getPersonnelEfficiency).toHaveBeenCalledWith({
      timeRange: '6m',
      role: 'all',
    }))

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '3m' } })

    await waitFor(() => expect(reportsApi.getPersonnelEfficiency).toHaveBeenLastCalledWith({
      timeRange: '3m',
      role: 'all',
    }))

    await act(async () => {
      latestRequest.resolve({
        summary: {
          personCount: 2,
          totalOutput: 12,
          totalLaborCost: 240,
          totalStandardHours: 4,
          avgEfficiency: 1.1,
          costPerOutput: 20,
        },
        ranking: [],
        trend: [],
      })
      await latestRequest.promise
    })

    expect(screen.getByText('人员数量').parentElement).toHaveTextContent('2')
    expect(screen.getByText('总人工成本').parentElement).toHaveTextContent('¥240.00')

    await act(async () => {
      initialRequest.resolve({
        summary: {
          personCount: 9,
          totalOutput: 90,
          totalLaborCost: 900,
          totalStandardHours: 30,
          avgEfficiency: 0.9,
          costPerOutput: 10,
        },
        ranking: [],
        trend: [],
      })
      await initialRequest.promise
    })

    expect(screen.getByText('人员数量').parentElement).toHaveTextContent('2')
    expect(screen.getByText('总人工成本').parentElement).toHaveTextContent('¥240.00')
  })

  it('exports role labels with the same display vocabulary as the ranking table', async () => {
    vi.mocked(reportsApi.getPersonnelEfficiency).mockResolvedValue({
      summary: {
        personCount: 1,
        totalOutput: 5,
        totalLaborCost: 125,
        totalStandardHours: 1.25,
        avgEfficiency: 1.29,
        costPerOutput: 25,
      },
      ranking: [
        {
          id: 'tech-a',
          name: '技术员A',
          role: 'technician',
          efficiency: 1.29,
          totalCost: 125,
          outputCount: 5,
          standardHours: 1.25,
          outputPerHour: 4,
          costPerOutput: 25,
        },
      ],
      trend: [],
    } as any)

    render(<PersonnelEfficiency />)

    await waitFor(() => expect(screen.getByText('技术人员')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /导出/ }))

    expect(downloadTextFile).toHaveBeenCalledTimes(1)
    const [, content, mimeType] = vi.mocked(downloadTextFile).mock.calls[0]
    expect(mimeType).toBe('text/csv;charset=utf-8')
    expect(content).toContain('"技术员A","技术人员","1.29"')
    expect(content).not.toContain('technician')
  })
})
