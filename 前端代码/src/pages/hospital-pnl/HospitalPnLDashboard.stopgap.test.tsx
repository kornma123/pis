/**
 * P-2 旧盈利看板止血 · 回归门禁（八层门禁 · DEC 决策安全层 · DEC-1 复核意见①）
 *
 * 把 P0「净贡献者不得被自动点名」的封存断言，第一次绑到线上真实的旧看板页上：
 *   ① 默认排序不得再是「最差在顶 / 按毛利升序」——默认顺序第一行必须是贡献毛利最大者，绝不是最小者；
 *   ② 页面不得渲染任何「亏损账户点名 / 家数计数」字段。
 * 这条测试现在就该常绿；一旦有人把默认排序改回升序、或把负毛利客户重新点名，它立即翻红（有牙）。
 */
import { render, screen } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { partnerPnlApi } from '@/api/partner-pnl'
import type { PartnerPnl } from '@/types/partner-pnl'
import HospitalPnLDashboard, { sortPartnersForDisplay } from './HospitalPnLDashboard'

vi.mock('@/api/partner-pnl', () => ({
  partnerPnlApi: {
    overview: vi.fn(),
    cases: vi.fn(),
    trend: vi.fn(),
    backfill: vi.fn(),
  },
}))

// 趋势图用 recharts；jsdom 无尺寸 → 直通桩，避免 ResponsiveContainer 噪声。
vi.mock('recharts', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    LineChart: pass, Line: () => <div />, XAxis: () => <div />, YAxis: () => <div />,
    CartesianGrid: () => <div />, Tooltip: () => <div />, ResponsiveContainer: pass,
  }
})

// 造一批「最赚钱的大客户 + 一家亏损小客户」——正是旧页会把大客户排到「最差」位置的场景。
function mkPartner(over: Partial<PartnerPnl> & { partnerId: string; grossMargin: number }): PartnerPnl {
  return {
    partnerName: over.partnerId,
    caseCount: 10,
    netRevenueTotal: 0, labRevenueTotal: 0, diagnosisRevenueTotal: 0, costTotal: 0,
    marginRate: 0, avgLabRevenuePerCase: 0, avgCostPerCase: 0, avgMarginPerCase: 0,
    qualityCounts: { ok: 10, partial_quantities: 0, no_quantities: 0 },
    sourceCounts: { statement: 10, estimated: 0, corrected: 0 },
    costMatched: true, costMonthAxis: 'all', benchmarkCorrected: false,
    ngsRevenue: 0, ngsCost: 0, ngsMargin: 0, ngsOrderCount: 0, totalMargin: over.grossMargin,
    ...over,
  }
}

const PILLAR = mkPartner({ partnerId: '和睦家', grossMargin: 90000, labRevenueTotal: 200000, marginRate: 0.45 })
const MID = mkPartner({ partnerId: '东安县医院', grossMargin: 12000, labRevenueTotal: 40000, marginRate: 0.30 })
const LOSS = mkPartner({ partnerId: '小诊所', grossMargin: -3000, labRevenueTotal: 5000, marginRate: -0.6 })
const ALL = [LOSS, PILLAR, MID]
const minGrossMarginId = ALL.slice().sort((a, b) => a.grossMargin - b.grossMargin)[0].partnerId // '小诊所'

describe('sortPartnersForDisplay（P-2 默认排序 · 纯函数）', () => {
  it('按院级毛利降序——顶梁柱在顶，最差绝不置顶', () => {
    const out = sortPartnersForDisplay(ALL)
    expect(out.map((p) => p.partnerId)).toEqual(['和睦家', '东安县医院', '小诊所'])
    // 承重断言：第一行不得是毛利最小者（= 旧的「最差在顶 / 按毛利升序」行为）
    expect(out[0].partnerId).not.toBe(minGrossMarginId)
    expect(out[0].grossMargin).toBe(Math.max(...ALL.map((p) => p.grossMargin)))
  })

  it('不就地改动入参、空数组安全', () => {
    const input = [PILLAR, LOSS]
    const out = sortPartnersForDisplay(input)
    expect(input).toEqual([PILLAR, LOSS]) // 未就地改动原数组
    expect(out).not.toBe(input)
    expect(sortPartnersForDisplay([])).toEqual([])
  })
})

describe('HospitalPnLDashboard 默认呈现（P-2 止血 · 渲染）', () => {
  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify({
      role: 'finance', roles: ['finance'], capabilities: { cost_analysis: 'R' }, canSeeCost: true,
    }))
    vi.mocked(partnerPnlApi.overview).mockResolvedValue({ list: ALL, total: ALL.length })
    vi.mocked(partnerPnlApi.cases).mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 50 })
    vi.mocked(partnerPnlApi.trend).mockResolvedValue([])
  })

  const renderPage = () => render(<MemoryRouter><HospitalPnLDashboard /></MemoryRouter>)

  it('默认顺序顶梁柱在顶（不是最差在顶），且顶部有迁移横幅', async () => {
    renderPage()
    // 等表格标题出现 = 数据已加载渲染
    await screen.findByText('院级盈亏 · 按毛利从高到低')
    const dataRows = screen.getAllByRole('button').filter((el) => el.tagName === 'TR')
    expect(dataRows.length).toBe(3)
    // 第一行必须是顶梁柱、绝不是亏损小客户
    expect(dataRows[0]).toHaveTextContent('和睦家')
    expect(dataRows[0]).not.toHaveTextContent('小诊所')
    // 迁移横幅在位（说人话，不评判客户优劣）
    expect(screen.getByText(/不代表对某家医院客户好坏的评判/)).toBeInTheDocument()
  })

  it('不渲染任何「亏损账户点名 / 家数计数」字段', async () => {
    renderPage()
    await screen.findByText('院级盈亏 · 按毛利从高到低')
    // 旧的点名/计数文案必须全部消失
    expect(screen.queryByText(/家负毛利/)).not.toBeInTheDocument()
    expect(screen.queryByText(/负毛利\s*\d+\s*家/)).not.toBeInTheDocument()
    expect(screen.queryByText('院级盈亏 · 负毛利置顶')).not.toBeInTheDocument()
  })

  it('账户级毛利呈现为中性色——不用红/绿把账户框成「好/坏」（含负毛利行）', async () => {
    renderPage()
    await screen.findByText('院级盈亏 · 按毛利从高到低')
    const dataRows = screen.getAllByRole('button').filter((el) => el.tagName === 'TR')
    expect(dataRows.length).toBe(3)
    for (const row of dataRows) {
      // 行背景不得用红把账户框成「差」（含负毛利的小诊所行）
      expect(row.className).not.toMatch(/bg-rose|bg-red/)
      const tds = row.querySelectorAll('td')
      const marginCell = tds[5] as HTMLElement // 毛利列
      const rateCell = tds[6] as HTMLElement // 毛利率列
      // 仅约束毛利/毛利率两列——趋势多线图的红绿线条 + 完整度徽标(第8列 emerald「全部已对账」)是正交语义，不在此列
      for (const cell of [marginCell, rateCell]) {
        expect(cell.className).not.toMatch(/rose|emerald|text-red|text-green/)
      }
    }
  })
})
