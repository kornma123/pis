/**
 * 止损执法点（LEG-2）· 拆分口径未认账水印 · 前端回归门禁。
 *
 * 守：① 未认账(ratified=false) → 水印横幅 + 表头徽标显示（与数字同视线）；
 *     ② **fail-closed**：响应缺 caliberRatification（旧缓存/字段丢失）→ 仍显水印；
 *     ③ 仅当后端明确 ratified=true 才免水印（认账后自动摘牌，无需改前端）。
 * 一旦有人把水印摘成"缺省不显示"或"字段缺失即隐藏"，本测试翻红（有牙）。
 */
import { render, screen } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { partnerPnlApi } from '@/api/partner-pnl'
import type { PartnerPnl, CaliberRatification } from '@/types/partner-pnl'
import HospitalPnLDashboard from './HospitalPnLDashboard'

vi.mock('@/api/partner-pnl', () => ({
  partnerPnlApi: { overview: vi.fn(), cases: vi.fn(), trend: vi.fn(), backfill: vi.fn() },
}))
vi.mock('recharts', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    LineChart: pass, Line: () => <div />, XAxis: () => <div />, YAxis: () => <div />,
    CartesianGrid: () => <div />, Tooltip: () => <div />, ResponsiveContainer: pass,
  }
})

function mkPartner(id: string, gm: number): PartnerPnl {
  return {
    partnerId: id, partnerName: id, caseCount: 10,
    netRevenueTotal: 1000, labRevenueTotal: 2000, diagnosisRevenueTotal: 0, costTotal: 500,
    grossMargin: gm, marginRate: 0.3, avgLabRevenuePerCase: 200, avgCostPerCase: 50, avgMarginPerCase: 150,
    qualityCounts: { ok: 10, partial_quantities: 0, no_quantities: 0 },
    sourceCounts: { statement: 10, estimated: 0, corrected: 0 },
    costMatched: true, costMonthAxis: 'all', benchmarkCorrected: false,
    ngsRevenue: 0, ngsCost: 0, ngsMargin: 0, ngsOrderCount: 0, totalMargin: gm,
  }
}
const ROWS = [mkPartner('和睦家', 90000)]
const UNRATIFIED: CaliberRatification = {
  ratified: false, state: 'UNRATIFIED', sourceTag: 'derived',
  basisVersion: '2026-07-06.a', label: '口径未经业务认账',
  note: '拆分口径由政策分摊常量 SPLIT_DIAG_FEE(=105) …', ratifiedAt: null,
}

function mockOverview(caliberRatification?: CaliberRatification) {
  vi.mocked(partnerPnlApi.overview).mockResolvedValue({ list: ROWS, total: ROWS.length, caliberRatification } as any)
  vi.mocked(partnerPnlApi.cases).mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 50 } as any)
  vi.mocked(partnerPnlApi.trend).mockResolvedValue([] as any)
}
const renderPage = () => render(<MemoryRouter><HospitalPnLDashboard /></MemoryRouter>)

describe('拆分口径未认账水印（前端 fail-closed 执法）', () => {
  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify({
      role: 'finance', roles: ['finance'], capabilities: { cost_analysis: 'R' }, canSeeCost: true,
    }))
  })

  it('未认账 → 水印横幅 + 表头徽标显示，点名口径版本', async () => {
    mockOverview(UNRATIFIED)
    renderPage()
    await screen.findByText('院级盈亏 · 按毛利从高到低')
    expect(screen.getByTestId('split-caliber-watermark')).toBeInTheDocument()
    expect(screen.getByText(/口径未经业务认账/)).toBeInTheDocument()
    expect(screen.getByText(/不得作为对外披露、结算或谈判的单独依据/)).toBeInTheDocument()
    expect(screen.getByText(/可能显著高估约 2 倍/)).toBeInTheDocument()
    expect(screen.getByText(/口径版本 2026-07-06\.a/)).toBeInTheDocument()
    expect(screen.getByText('口径未认账')).toBeInTheDocument() // 表头徽标（与表内数字同视线）
  })

  it('fail-closed：响应缺 caliberRatification 字段 → 仍显水印', async () => {
    mockOverview(undefined)
    renderPage()
    await screen.findByText('院级盈亏 · 按毛利从高到低')
    expect(screen.getByTestId('split-caliber-watermark')).toBeInTheDocument()
  })

  it('仅当后端明确 ratified=true 才免水印（认账后自动摘牌）', async () => {
    mockOverview({ ...UNRATIFIED, ratified: true, state: 'RATIFIED', label: '口径已认账' })
    renderPage()
    await screen.findByText('院级盈亏 · 按毛利从高到低')
    expect(screen.queryByTestId('split-caliber-watermark')).not.toBeInTheDocument()
    expect(screen.queryByText('口径未认账')).not.toBeInTheDocument()
  })
})
