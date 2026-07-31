/**
 * LOC-015 前端真实消费者：后端真实响应形状 -> 解析 -> 页面 consumer。
 *
 * 本文件使用与后端集成测试（server/tests/hospital-cm-evidence-unavailable.test.ts）
 * 断言一致的真实 wire 形状（GET /hospital-pnl、/health 的 DTO 由同一实现产出）：
 *   - evidence.status='unavailable' 的行/健康卡必须显示「数据不可用」；
 *   - 不得显示 0 或成功金额（cm=null 渲染成不可用而非 ¥0）；
 *   - 合法显式 0（cm=0 + evidence ok）仍保真显示 ¥0；
 *   - 刷新/缓存旧成功值：同组件先渲染成功值再换 unavailable 载荷，不得残留 ¥280；
 *   - 导出旁路：CSV 对不可用行输出「数据不可用」，不输出成功金额。
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ComparisonTable from './ComparisonTable'
import PortfolioHero from './PortfolioHero'
import { exportComparisonCsv } from './exportComparison'
import type { ComparisonRow, PortfolioHealth } from '@/types/hospital-cm'

const UNAVAILABLE_ISSUES = [
  { caseNo: 'EV-C-003', field: 'ihc_count', reason: 'malformed' as const },
]

const unavailableRow: ComparisonRow = {
  partnerId: 'EV-TEXT',
  partnerName: '证据损坏院',
  cm: null,
  cmRate: null,
  fixedCoverageShare: null,
  trend: null,
  measurable: false,
  evidence: { status: 'unavailable', issues: UNAVAILABLE_ISSUES },
  detail: null,
  trendPoints: [{
    serviceMonth: '2099-01',
    hospitalCm: null,
    labRevenueInRate: null,
    cmRate: null,
    revenueCaseCount: null,
    caliber: '仅染色',
    evidence: { status: 'unavailable', issues: UNAVAILABLE_ISSUES },
  }],
}

const cleanRow: ComparisonRow = {
  partnerId: 'EV-CLEAN',
  partnerName: '干净医院',
  cm: 280,
  cmRate: 0.8235,
  fixedCoverageShare: 1,
  trend: null,
  measurable: true,
  evidence: { status: 'ok' },
  detail: {
    partnerId: 'EV-CLEAN', partnerName: '干净医院', hospitalCm: 280, labRevenueInRate: 300, cmRate: 0.8235,
    revenueCaseCount: 1, diagnosisCaseCount: 0, nonIhcCaseCount: 0, crossMonthReuseCaseCount: 0,
    bucketA: 15, bucketB: 5,
    quality: { coverage: 1, missingPriceRate: 0, starRatio: 0.25, lineCoverage: 1, needsTissueScopeRate: 0, stainPlaceholderShare: 0, needsData: false },
    caliber: '仅染色', state: '可判定', confidence: 'high', businessLineDefined: false,
  },
  trendPoints: [{
    serviceMonth: '2099-01', hospitalCm: 280, labRevenueInRate: 300, cmRate: 0.8235, revenueCaseCount: 1, caliber: '仅染色', evidence: { status: 'ok' },
  }],
}

const zeroRow: ComparisonRow = {
  partnerId: 'EV-ZERO',
  partnerName: '合法零医院',
  cm: 0,
  cmRate: 0,
  fixedCoverageShare: 0,
  trend: null,
  measurable: true,
  evidence: { status: 'ok' },
  detail: {
    partnerId: 'EV-ZERO', partnerName: '合法零医院', hospitalCm: 0, labRevenueInRate: 0, cmRate: 0,
    revenueCaseCount: 1, diagnosisCaseCount: 0, nonIhcCaseCount: 0, crossMonthReuseCaseCount: 0,
    bucketA: 0, bucketB: 0,
    quality: { coverage: 1, missingPriceRate: 0, starRatio: 0, lineCoverage: 1, needsTissueScopeRate: 0, stainPlaceholderShare: 0, needsData: false },
    caliber: '仅染色', state: '可判定', confidence: 'high', businessLineDefined: false,
  },
  trendPoints: [],
}

const unavailableHealth: PortfolioHealth = {
  totalCm: null,
  fixedPool: 1000,
  coverageMultiple: null,
  coverageMultipleTrendOnly: true,
  capacityUtilization: null,
  measurableAccountCount: null,
  unmeasuredRevenueShare: null,
  reopenAutomationQuestion: false,
  revivalCap: null,
  revivalUnmeasuredShareLine: null,
  shadowMode: true,
  gatesVerified: false,
  disclaimer: '影子模式',
  serviceMonth: '2099-01',
  fixedPoolProvided: true,
  evidence: { status: 'unavailable', issues: UNAVAILABLE_ISSUES, affectedPartners: ['EV-TEXT'] },
}

describe('LOC-015 ComparisonTable consumer', () => {
  it('unavailable 行显示「数据不可用」，不显示 0/成功金额；合法 0 行保真 ¥0；干净行照常数字', () => {
    render(<ComparisonTable rows={[cleanRow, zeroRow, unavailableRow]} periodRange="2099-01" />)
    const table = screen.getByTestId('comparison-table')
    const rows = within(table).getAllByRole('row').filter((r) => r.querySelector('td'))

    const bad = rows.find((r) => r.textContent?.includes('证据损坏院'))!
    expect(bad).toBeTruthy()
    expect(within(bad).getByTestId('evidence-unavailable-badge')).toHaveTextContent('数据不可用')
    expect(bad.textContent).not.toContain('¥280')
    expect(bad.textContent).not.toContain('¥0')
    expect(bad.textContent).not.toContain('¥200')

    const good = rows.find((r) => r.textContent?.includes('干净医院'))!
    expect(good).toHaveTextContent('¥280')

    const zero = rows.find((r) => r.textContent?.includes('合法零医院'))!
    expect(zero).toHaveTextContent('¥0')
    expect(zero).not.toHaveTextContent('数据不可用')
  })

  it('刷新/缓存旧成功值：载荷从成功切到 unavailable 后不得残留旧金额', () => {
    const { rerender } = render(<ComparisonTable rows={[cleanRow]} periodRange="2099-01" />)
    expect(screen.getByText('¥280')).toBeTruthy()

    rerender(<ComparisonTable rows={[unavailableRow]} periodRange="2099-01" />)
    expect(screen.queryByText('¥280')).toBeNull()
    expect(screen.getAllByTestId('evidence-unavailable-badge').length).toBeGreaterThan(0)
    expect(screen.getAllByText('数据不可用').length).toBeGreaterThan(0)
  })
})

describe('LOC-015 PortfolioHero consumer', () => {
  it('健康卡证据不可用 -> 显示「数据不可用」，不显示 ¥/0.00× 成功值', () => {
    render(<PortfolioHero health={unavailableHealth} />)
    const hero = screen.getByTestId('portfolio-hero')
    expect(within(hero).getByTestId('health-evidence-unavailable')).toHaveTextContent('数据不可用')
    expect(hero.textContent).not.toContain('¥')
    expect(hero.textContent).not.toContain('0.00×')
    expect(hero.textContent).not.toContain('280')
  })
})

describe('LOC-015 导出旁路', () => {
  it('CSV 对 unavailable 行输出「数据不可用」，不输出其成功金额/伪 0', () => {
    const csv = exportComparisonCsv([cleanRow, zeroRow, unavailableRow], null, {
      periodRange: '2099-01',
      exportedAt: '2026-07-31T00:00:00Z',
      download: false,
    })
    const lines = csv.split('\n')
    const badLine = lines.find((l) => l.includes('证据损坏院'))!
    expect(badLine).toContain('数据不可用')
    expect(badLine).not.toContain('280')
    expect(badLine).not.toContain(',0,')
    const goodLine = lines.find((l) => l.includes('干净医院'))!
    expect(goodLine).toContain('280')
    const zeroLine = lines.find((l) => l.includes('合法零医院'))!
    expect(zeroLine).toContain(',0,')
  })
})
