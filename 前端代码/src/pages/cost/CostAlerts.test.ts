import { describe, expect, it } from 'vitest'
import { buildInitialCostAlertFilters, getExceptionActionGuidance, getExceptionTypeLabel, getRetryToastMessage, normalizeExceptionSummary } from './CostAlerts'

describe('buildInitialCostAlertFilters', () => {
  it('普通打开异常中心时默认筛当前月份', () => {
    const filters = buildInitialCostAlertFilters(new URLSearchParams(), '2026-06')

    expect(filters).toEqual({
      status: 'open',
      severity: '',
      yearMonth: '2026-06',
      keyword: '',
      outboundId: '',
      projectId: '',
      exceptionType: '',
      startDate: '',
      endDate: '',
      includeUnassigned: false,
    })
  })

  it('从看板深链处理异常时不额外套当前月份过滤', () => {
    const filters = buildInitialCostAlertFilters(new URLSearchParams('outboundId=out-1'), '2026-06')

    expect(filters.yearMonth).toBe('')
    expect(filters.outboundId).toBe('out-1')
  })

  it('显式传入月份时保留月份过滤', () => {
    const filters = buildInitialCostAlertFilters(
      new URLSearchParams('keyword=CE-001&yearMonth=2026-04&status=resolved&severity=error'),
      '2026-06',
    )

    expect(filters).toMatchObject({
      status: 'resolved',
      severity: 'error',
      yearMonth: '2026-04',
      keyword: 'CE-001',
    })
  })

  it('看板打开本月异常总览时保留无月份异常选项', () => {
    const filters = buildInitialCostAlertFilters(
      new URLSearchParams('yearMonth=2026-04&includeUnassigned=1&status=open'),
      '2026-06',
    )

    expect(filters).toMatchObject({
      status: 'open',
      yearMonth: '2026-04',
      includeUnassigned: true,
    })
  })

  it('从项目对账异常深链进入时保留项目和异常类型筛选', () => {
    const filters = buildInitialCostAlertFilters(
      new URLSearchParams('projectId=project-1&exceptionType=reconciliation_variance&status=open'),
      '2026-06',
    )

    expect(filters).toMatchObject({
      status: 'open',
      yearMonth: '',
      projectId: 'project-1',
      exceptionType: 'reconciliation_variance',
    })
  })
})

describe('normalizeExceptionSummary', () => {
  it('补齐异常摘要缺失字段，避免页面统计受当前页影响', () => {
    const summary = normalizeExceptionSummary({
      total: 123,
      status: { open: 101 } as any,
      severity: { error: 3, warning: 7 } as any,
    })

    expect(summary).toEqual({
      total: 123,
      status: {
        open: 101,
        resolved: 0,
        ignored: 0,
      },
      severity: {
        error: 3,
        warning: 7,
        info: 0,
      },
    })
  })
})

describe('getExceptionTypeLabel', () => {
  it('uses business wording for fee mapping exceptions instead of raw enum values', () => {
    expect(getExceptionTypeLabel('missing_fee_mapping')).toBe('缺少收费映射')
    expect(getExceptionTypeLabel('missing_driver_rate')).toBe('缺少动因费率')
  })
})

describe('getExceptionActionGuidance', () => {
  it('returns actionable business next steps by exception type', () => {
    expect(getExceptionActionGuidance('missing_fee_mapping')).toBe('下一步：补齐BOM收费映射后重试，确认收费、利润和审计记录能重新接住。')
    expect(getExceptionActionGuidance('missing_bom')).toBe('下一步：先到检测服务绑定BOM，再回到对账或异常中心重试成本计算。')
    expect(getExceptionActionGuidance('reconciliation_variance')).toBe('下一步：回到消耗对账核对LIS病例、BOM理论消耗和出库批次，修正后重新审计差异。')
    expect(getExceptionActionGuidance('cost_recalculation_failed')).toBe('下一步：检查出库、BOM、动因费率和期间状态；修正源数据后重试成本重算。')
    expect(getExceptionActionGuidance('unknown_type')).toBe('下一步：查看来源单据和审计记录，修正源数据后重试；无法确认时填写复核说明再处理。')
  })
})

describe('getRetryToastMessage', () => {
  it('重试后异常仍开放时提示仍待处理', () => {
    expect(getRetryToastMessage({ exception: { status: 'open' } })).toEqual({
      type: 'warning',
      message: '重试已完成，异常仍待处理',
    })
  })

  it('重试后异常已解决时提示已解决', () => {
    expect(getRetryToastMessage({ exception: { status: 'resolved' } })).toEqual({
      type: 'success',
      message: '重试已完成，异常已解决',
    })
  })
})
