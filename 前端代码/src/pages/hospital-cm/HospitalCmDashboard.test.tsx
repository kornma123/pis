/**
 * 院级贡献毛利看板（两层框架真前端）· 回归门禁（DEC 决策安全层 + 11 诚实元素 + URL 后门 DOM 红线）。
 *
 * 守（有牙）：
 *   · 缺省排序=绝对贡献降序·顶梁柱在顶（**绝不**最差在顶）；不出裁决词（可留/需谈价/停止候选）；
 *   · 元素④ 未认账水印 fail-closed；⑥「未配置」不渲染 0；⑦ 校准就绪清单渲染（红条）；⑧ UNMEASURED 灰行；
 *     ⑩「观察中」徽标；① 「排序≠评判」常显；⑪ 导出带口径声明；
 *   · 🔒 URL 后门 DOM 红线：ready=false ⇒ 完整体检态组件**不在 DOM**（非隐藏）；ready=true ⇒ 才挂载。
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hospitalCmApi } from '@/api/hospital-cm'
import HospitalCmDashboard from './HospitalCmDashboard'
import type { CaliberRatification, ComparisonRow, PortfolioHealth, Readiness } from '@/types/hospital-cm'

vi.mock('@/api/hospital-cm', () => ({
  hospitalCmApi: { comparison: vi.fn(), health: vi.fn(), readiness: vi.fn(), fullHealth: vi.fn(), trend: vi.fn() },
}))

const UNRATIFIED: CaliberRatification = {
  ratified: false, state: 'UNRATIFIED', sourceTag: 'derived', basisVersion: '2026-07-06.a',
  label: '口径未经业务认账', note: '拆分口径由政策分摊常量派生…', ratifiedAt: null,
}

function mkRow(over: Partial<ComparisonRow> & { partnerId: string; cm: number }): ComparisonRow {
  return {
    partnerName: over.partnerId, cmRate: 0.8, fixedCoverageShare: 0.3, trend: null, measurable: true,
    detail: {
      partnerId: over.partnerId, hospitalCm: over.cm, labRevenueInRate: 1000, cmRate: 0.8, revenueCaseCount: 20,
      diagnosisCaseCount: 0, nonIhcCaseCount: 0, crossMonthReuseCaseCount: 0, bucketA: 100, bucketB: 100,
      quality: { coverage: 0.95, missingPriceRate: 0.02, starRatio: 0.3, lineCoverage: 0.9, needsTissueScopeRate: 0, stainPlaceholderShare: 0, needsData: false },
      caliber: '仅染色', state: '经营线未定·仅供观察', confidence: 'high', businessLineDefined: false,
    },
    trendPoints: [], ...over,
  }
}

const PILLAR = mkRow({ partnerId: '东安县医院', cm: 36994, cmRate: 0.687, fixedCoverageShare: 0.531 })
const MID = mkRow({ partnerId: '和睦家系', cm: 22348, cmRate: 0.86, fixedCoverageShare: 0.321 })
const OBSERVING = mkRow({ partnerId: '新城医院', cm: 4979, cmRate: 0.837, fixedCoverageShare: 0.072 })
OBSERVING.detail!.confidence = 'low'
OBSERVING.detail!.quality.needsData = true
const UNMEASURED = mkRow({ partnerId: '外送会诊院', cm: 0, measurable: false })
const ROWS = [OBSERVING, PILLAR, UNMEASURED, MID] // 故意乱序 + 最差混入，验证前端排序

function mkHealth(over: Partial<PortfolioHealth> = {}): PortfolioHealth {
  return {
    totalCm: 64321, fixedPool: 0, coverageMultiple: 0, coverageMultipleTrendOnly: true, capacityUtilization: null,
    measurableAccountCount: 3, unmeasuredRevenueShare: 0.22, reopenAutomationQuestion: false, revivalCap: 30,
    revivalUnmeasuredShareLine: 0.3, shadowMode: true, gatesVerified: false, disclaimer: '影子模式',
    fixedPoolProvided: false, caliberRatification: UNRATIFIED, ...over,
  }
}

function mkReadiness(over: Partial<Readiness> = {}): Readiness {
  return {
    ready: false,
    checklist: [
      { key: 'foundation', label: '数据地基门全绿', met: false, owner: 'tech', due: '2026-09-30' },
      { key: 'denominator', label: '固定成本池已认账', met: false, owner: 'business', due: '2026-08-31' },
      { key: 'history', label: '历史 ≥ 3 期', met: false, owner: 'pm', due: '2026-10-31' },
      { key: 'first_period', label: '首个真实周期通过校验', met: false, owner: 'tech', due: '2026-10-31' },
    ],
    findings: [], caliberRatification: UNRATIFIED, ...over,
  }
}

function mockAll(opts: { readiness?: Readiness; rows?: ComparisonRow[]; health?: PortfolioHealth; caliber?: CaliberRatification | null } = {}) {
  vi.mocked(hospitalCmApi.readiness).mockResolvedValue(opts.readiness ?? mkReadiness())
  vi.mocked(hospitalCmApi.comparison).mockResolvedValue({
    list: opts.rows ?? ROWS, total: (opts.rows ?? ROWS).length,
    caliberRatification: opts.caliber === undefined ? UNRATIFIED : opts.caliber ?? undefined,
  } as any)
  vi.mocked(hospitalCmApi.health).mockResolvedValue(opts.health ?? mkHealth())
  vi.mocked(hospitalCmApi.fullHealth).mockResolvedValue({
    ...mkHealth({ coverageMultiple: 1.74, fixedPool: 40000, fixedPoolProvided: true }), fullState: true, readiness: mkReadiness({ ready: true }),
  } as any)
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><HospitalCmDashboard /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.setItem('user', JSON.stringify({ role: 'finance', roles: ['finance'], capabilities: { cost_analysis: 'R' }, canSeeCost: true }))
})

describe('缺省排序 + 不点名（DEC-2·不把误伤从算法搬进人脑）', () => {
  it('缺省=绝对贡献降序·顶梁柱(东安)在顶·最差绝不置顶', async () => {
    mockAll()
    renderPage()
    const table = await screen.findByTestId('comparison-table')
    const dataRows = within(table).getAllByRole('row').filter((r) => r.querySelector('td'))
    // 首个可测行 = 贡献最大的东安（¥36,994），不是最小的新城/外送
    expect(dataRows[0]).toHaveTextContent('东安县医院')
    expect(dataRows[0]).not.toHaveTextContent('新城医院')
  })

  it('不出裁决词：页面显式声明「经营线未定·裁决词暂不出」，行内无裁决徽标', async () => {
    mockAll()
    renderPage()
    const table = await screen.findByTestId('comparison-table')
    // 正面断言：系统显式声明裁决词被抑制（而非 blanket 搜索——那会撞上这段解释文案本身）
    expect(within(table).getByText(/经营线未定 · 仅供观察/)).toBeInTheDocument()
    expect(within(table).getByText(/裁决词暂不出/)).toBeInTheDocument()
    // 行内不得出现「顶梁柱/最差/建议砍」这类系统贴给单家医院的评判标签
    const dataRows = within(table).getAllByRole('row').filter((r) => r.querySelector('td'))
    for (const row of dataRows) {
      expect(row.textContent || '').not.toMatch(/顶梁柱|最差|建议砍|停止候选/)
    }
  })

  it('① 「排序≠评判」常显；按率排序切换后仍在且强调', async () => {
    mockAll()
    renderPage()
    await screen.findByTestId('comparison-table')
    expect(screen.getByTestId('sort-not-verdict')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('按率排序'))
    await waitFor(() => expect(screen.getByTestId('sort-not-verdict')).toHaveTextContent(/别据此当「最差」压价/))
  })
})

describe('11 诚实元素（校准态）', () => {
  it('④ 未认账水印显示（fail-closed）；⑥「未配置」不渲染 0；⑦ 校准清单渲染', async () => {
    mockAll()
    renderPage()
    await screen.findByTestId('comparison-table')
    expect(screen.getByTestId('split-caliber-watermark')).toBeInTheDocument()
    expect(screen.getByText(/口径版本 2026-07-06\.a/)).toBeInTheDocument()
    // ⑥ 固定池未配置 → "未配置" 而非 0×
    expect(screen.getByTestId('coverage-not-configured')).toHaveTextContent('未配置')
    expect(screen.queryByText('0.00×')).not.toBeInTheDocument()
    // ⑦ 校准就绪清单四条 + owner 归属
    expect(screen.getByTestId('calibration-view')).toBeInTheDocument()
    for (const k of ['foundation', 'denominator', 'history', 'first_period']) {
      expect(screen.getByTestId(`readiness-condition-${k}`)).toBeInTheDocument()
    }
    expect(screen.getByText(/业务决策方（不可代签）/)).toBeInTheDocument()
  })

  it('⑧ UNMEASURED 账户以灰行+原因出现（缺席=被读成不存在）', async () => {
    mockAll()
    renderPage()
    await screen.findByTestId('comparison-table')
    const gray = screen.getByTestId('unmeasured-row')
    expect(gray).toHaveTextContent('外送会诊院')
    expect(gray).toHaveTextContent(/未测量/)
  })

  it('⑩ 可测但未过数据质量门 → 「观察中」徽标而非自信数字', async () => {
    mockAll()
    renderPage()
    await screen.findByTestId('comparison-table')
    expect(screen.getAllByTestId('observing-badge').length).toBeGreaterThan(0)
  })

  it('④ fail-closed：响应缺 caliberRatification → 仍显水印', async () => {
    mockAll({ caliber: null })
    renderPage()
    await screen.findByTestId('comparison-table')
    expect(screen.getByTestId('split-caliber-watermark')).toBeInTheDocument()
  })

  it('④ 仅后端明确 ratified=true 才免水印', async () => {
    const ratified: CaliberRatification = { ...UNRATIFIED, ratified: true, state: 'RATIFIED', label: '口径已认账' }
    mockAll({ caliber: ratified, readiness: mkReadiness({ caliberRatification: ratified }), health: mkHealth({ caliberRatification: ratified }) })
    renderPage()
    await screen.findByTestId('comparison-table')
    expect(screen.queryByTestId('split-caliber-watermark')).not.toBeInTheDocument()
  })

  it('⑦ 缺死线的未满足条件标红（configError·公理一）', async () => {
    const rd = mkReadiness()
    rd.checklist[0] = { key: 'foundation', label: '数据地基门全绿', met: false, owner: 'tech', due: null, configError: true }
    mockAll({ readiness: rd })
    renderPage()
    await screen.findByTestId('calibration-view')
    expect(screen.getByTestId('readiness-condition-foundation')).toHaveTextContent(/未填死线|违反公理一/)
  })
})

describe('🔒 URL 后门 DOM 红线（谓词假 ⇒ 完整态组件不在 DOM）', () => {
  it('ready=false ⇒ 完整体检态组件不在 DOM（非隐藏）', async () => {
    mockAll() // readiness.ready=false
    renderPage()
    await screen.findByTestId('comparison-table')
    expect(screen.queryByTestId('full-physical-exam')).not.toBeInTheDocument()
    // 校准态内容在场
    expect(screen.getByTestId('portfolio-hero')).toBeInTheDocument()
    expect(screen.getByTestId('calibration-view')).toBeInTheDocument()
  })

  it('ready=true ⇒ 完整体检态组件才挂载（运行时切换态）', async () => {
    mockAll({ readiness: mkReadiness({ ready: true, checklist: mkReadiness().checklist.map((c) => ({ ...c, met: true })) }) })
    renderPage()
    expect(await screen.findByTestId('full-physical-exam')).toBeInTheDocument()
    // 完整态下不再渲染校准 hero（切换态，非并列）
    expect(screen.queryByTestId('portfolio-hero')).not.toBeInTheDocument()
  })
})

describe('导出（⑪·带口径声明列）', () => {
  it('导出按钮在位', async () => {
    mockAll()
    renderPage()
    await screen.findByTestId('comparison-table')
    expect(screen.getByText(/导出（带口径声明）/)).toBeInTheDocument()
  })
})
