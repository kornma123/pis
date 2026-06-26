import { describe, expect, it } from 'vitest'
import {
  applyCreatedAdjustmentToSummary,
  applyReviewedAdjustmentToSummary,
  buildDashboardComparisonParams,
  buildCostAlertsOverviewLink,
  buildCostRunExceptionLink,
  getClosePeriodBlockReason,
  getComparisonDirectionMeta,
  getCostRunProcessedCount,
  getCostRunSucceededCount,
  getDashboardOpenExceptionCount,
} from './CostDashboard'

describe('getComparisonDirectionMeta', () => {
  it('成本上升时使用红色上升状态', () => {
    expect(getComparisonDirectionMeta('up')).toEqual({
      cardClassName: 'bg-red-50',
      labelClassName: 'text-red-600',
      valueClassName: 'text-red-600',
      icon: 'up',
    })
  })

  it('成本持平时使用中性状态', () => {
    expect(getComparisonDirectionMeta('flat')).toEqual({
      cardClassName: 'bg-gray-50',
      labelClassName: 'text-gray-600',
      valueClassName: 'text-gray-700',
      icon: 'flat',
    })
  })
})

describe('getDashboardOpenExceptionCount', () => {
  it('优先使用看板全量开放异常数，避免最近 10 条低估', () => {
    expect(getDashboardOpenExceptionCount(37, 10)).toBe(37)
  })

  it('后端未返回统计时回退到可见异常条数', () => {
    expect(getDashboardOpenExceptionCount(undefined, 6)).toBe(6)
  })
})

describe('buildCostAlertsOverviewLink', () => {
  it('看板查看全部异常时包含本月和无月份异常', () => {
    expect(buildCostAlertsOverviewLink('2026-04')).toBe('/abc/alerts?yearMonth=2026-04&status=open&includeUnassigned=1')
  })
})

describe('buildCostRunExceptionLink', () => {
  it('按重算任务和月份过滤成本异常', () => {
    expect(buildCostRunExceptionLink('run-1', '2026-04')).toBe('/abc/alerts?keyword=run-1&yearMonth=2026-04&status=open&includeUnassigned=1')
  })
})

describe('buildDashboardComparisonParams', () => {
  it('成本看板月度环比使用 ABC 快照口径', () => {
    expect(buildDashboardComparisonParams('2026-04')).toEqual({ month: '2026-04', source: 'abc' })
  })
})

describe('getClosePeriodBlockReason', () => {
  it('没有成本期间时提示先开启期间', () => {
    expect(getClosePeriodBlockReason(undefined, 0, 0)).toBe('请先开启成本期间')
  })

  it('存在开放异常时阻止关账', () => {
    expect(getClosePeriodBlockReason('calculated', 2, 0)).toBe('仍有 2 条开放成本异常')
  })

  it('存在未补算或成本异常出库时阻止关账', () => {
    expect(getClosePeriodBlockReason('calculated', 0, 3)).toBe('仍有 3 单未补算或成本异常')
  })

  it('期间尚未核算完成时阻止关账', () => {
    expect(getClosePeriodBlockReason('collecting', 0, 0)).toBe('请先执行重算并完成核算')
    expect(getClosePeriodBlockReason('open', 0, 0)).toBe('请先执行重算并完成核算')
  })

  it('期间已核算且没有阻断项时允许关账', () => {
    expect(getClosePeriodBlockReason('calculated', 0, 0)).toBe('')
  })
})

describe('cost run summary normalization', () => {
  it('兼容后端当前 processed/succeeded 字段', () => {
    expect(getCostRunProcessedCount({ processed: 3, succeeded: 2, failed: 1 })).toBe(3)
    expect(getCostRunSucceededCount({ processed: 3, succeeded: 2, failed: 1 })).toBe(2)
  })

  it('兼容旧 total/success 字段', () => {
    expect(getCostRunProcessedCount({ total: 4, success: 4, failed: 0 })).toBe(4)
    expect(getCostRunSucceededCount({ total: 4, success: 4, failed: 0 })).toBe(4)
  })
})

describe('applyReviewedAdjustmentToSummary', () => {
  const summary = {
    totalCost: 100,
    totalFee: 200,
    totalProfit: 100,
    profitRate: 0.5,
    caseCount: 1,
    sampleCount: 1,
    materialCost: 60,
    activityCost: 40,
    adjustmentAmount: 10,
    pendingAdjustmentCount: 2,
    adjustedTotalCost: 110,
    adjustedTotalProfit: 90,
    adjustedProfitRate: 0.45,
    costChange: 0,
    feeChange: 0,
    profitChange: 0,
  }

  it('新建待审调整单后只增加待审核数，不计入调整金额', () => {
    expect(applyCreatedAdjustmentToSummary(
      summary,
      { id: 'adj-created', adjustmentNo: 'ADJ-CREATED', yearMonth: '2026-06', adjustmentType: 'manual', amount: 20, reason: '补差', status: 'pending' },
    )).toMatchObject({
      adjustmentAmount: 10,
      pendingAdjustmentCount: 3,
      adjustedTotalCost: 110,
      adjustedTotalProfit: 90,
    })
  })

  it('调整单通过后减少待审核数并计入调整金额', () => {
    expect(applyReviewedAdjustmentToSummary(
      summary,
      { id: 'adj-1', adjustmentNo: 'ADJ-1', yearMonth: '2026-06', adjustmentType: 'manual', amount: 20, reason: '补差', status: 'pending' },
      { id: 'adj-1', adjustmentNo: 'ADJ-1', yearMonth: '2026-06', adjustmentType: 'manual', amount: 20, reason: '补差', status: 'approved' },
    )).toMatchObject({
      adjustmentAmount: 30,
      pendingAdjustmentCount: 1,
      adjustedTotalCost: 130,
      adjustedTotalProfit: 70,
      adjustedProfitRate: 0.35,
    })
  })

  it('调整单驳回后只减少待审核数，不计入调整金额', () => {
    expect(applyReviewedAdjustmentToSummary(
      summary,
      { id: 'adj-2', adjustmentNo: 'ADJ-2', yearMonth: '2026-06', adjustmentType: 'manual', amount: 20, reason: '补差', status: 'pending' },
      { id: 'adj-2', adjustmentNo: 'ADJ-2', yearMonth: '2026-06', adjustmentType: 'manual', amount: 20, reason: '补差', status: 'rejected' },
    )).toMatchObject({
      adjustmentAmount: 10,
      pendingAdjustmentCount: 1,
      adjustedTotalCost: 110,
      adjustedTotalProfit: 90,
    })
  })
})
