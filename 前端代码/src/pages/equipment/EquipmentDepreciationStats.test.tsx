import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { equipmentApi } from '@/api/master'
import EquipmentDepreciationStats from './EquipmentDepreciationStats'

vi.mock('@/api/master', () => ({
  equipmentApi: {
    getDepreciationStats: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('recharts', () => {
  const Wrapper = ({ children }: { children?: any }) => <div>{children}</div>
  return {
    ResponsiveContainer: Wrapper,
    BarChart: Wrapper,
    Bar: Wrapper,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
    Cell: () => null,
  }
})

describe('EquipmentDepreciationStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(equipmentApi.getDepreciationStats).mockResolvedValue({
      summary: {
        totalEquipment: 2,
        totalPurchasePrice: 100000,
        totalAnnualDepreciation: 12000,
        totalMonthlyDepreciation: 1000,
      },
      stats: [
        {
          typeId: 'type-1',
          typeCode: 'EQ-TYPE',
          typeName: '染色设备',
          equipmentCount: 2,
          totalPurchasePrice: 100000,
          totalAnnualDepreciation: 12000,
          totalMonthlyDepreciation: 1000,
        },
        {
          typeId: 'unclassified',
          typeCode: 'UNCLASSIFIED',
          typeName: '未分类',
          equipmentCount: 1,
          totalPurchasePrice: 50000,
          totalAnnualDepreciation: 9000,
          totalMonthlyDepreciation: 750,
        },
      ],
    } as any)
  })

  it('renders depreciation stats using backend field names including unclassified equipment', async () => {
    render(<EquipmentDepreciationStats />)

    expect(await screen.findByText('染色设备')).toBeInTheDocument()
    expect(screen.getByText('未分类')).toBeInTheDocument()
    expect(screen.getAllByText('¥100,000.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥12,000.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥1,000.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥9,000.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥750.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('年折旧额').length).toBeGreaterThan(0)
    expect(screen.getAllByText('月折旧额').length).toBeGreaterThan(0)
  })
})
