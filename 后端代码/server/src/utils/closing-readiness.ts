import { buildInventoryConsistencyIssues } from './inventory-consistency.js'

type ClosingReadinessStatus = 'ready' | 'blocked' | 'warning'
type ClosingReadinessIssueSeverity = 'blocker' | 'warning' | 'info'

type ClosingReadinessIssue = {
  code: string
  source: string
  severity: ClosingReadinessIssueSeverity
  title: string
  message: string
  count?: number
  examples?: unknown[]
}

type ClosingReadinessAction = {
  action: string
  label: string
  href: string
  source: string
}

const addUniqueAction = (actions: ClosingReadinessAction[], action: ClosingReadinessAction) => {
  if (!actions.some(item => item.action === action.action && item.href === action.href)) {
    actions.push(action)
  }
}

const costExceptionHref = (yearMonth: string) =>
  `/abc/alerts?yearMonth=${encodeURIComponent(yearMonth)}&status=open&includeUnassigned=1`

const outboundCostHref = (yearMonth: string) =>
  `/abc/alerts?yearMonth=${encodeURIComponent(yearMonth)}&status=open`

export function buildClosingReadiness(db: any, yearMonth: string) {
  const blockers: ClosingReadinessIssue[] = []
  const warnings: ClosingReadinessIssue[] = []
  const info: ClosingReadinessIssue[] = []
  const nextActions: ClosingReadinessAction[] = []

  const period = db.prepare('SELECT * FROM abc_periods WHERE year_month = ?').get(yearMonth) as any
  if (!period || period.status !== 'calculated') {
    blockers.push({
      code: 'PERIOD_NOT_CALCULATED',
      source: 'abc_periods',
      severity: 'blocker',
      title: period ? '成本期间尚未完成核算' : '成本期间不存在',
      message: period
        ? `成本期间状态为 ${period.status}，需先执行重算并完成核算。`
        : '本成本期间不存在，需先开启期间并完成重算/核算。',
      count: 1,
    })
    addUniqueAction(nextActions, {
      action: 'recalculate_costs',
      label: '执行重算',
      href: `/abc/dashboard?month=${encodeURIComponent(yearMonth)}`,
      source: 'abc_periods',
    })
  }

  const openFeeMappingExceptions = db.prepare(`
    SELECT id, exception_no as exceptionNo, exception_type as exceptionType, severity, message
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND exception_type = 'missing_fee_mapping'
    ORDER BY created_at DESC
    LIMIT 5
  `).all(yearMonth) as any[]
  const openFeeMappingCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND exception_type = 'missing_fee_mapping'
  `).get(yearMonth) as any)?.total || 0)
  if (openFeeMappingCount > 0) {
    blockers.push({
      code: 'OPEN_FEE_MAPPING_EXCEPTIONS',
      source: 'cost_exceptions',
      severity: 'blocker',
      title: '收费映射异常未处理',
      message: `存在 ${openFeeMappingCount} 条未处理的收费映射异常，收费与利润不可确认。`,
      count: openFeeMappingCount,
      examples: openFeeMappingExceptions,
    })
    addUniqueAction(nextActions, {
      action: 'configure_fee_mapping',
      label: '检查收费映射',
      href: costExceptionHref(yearMonth),
      source: 'cost_exceptions',
    })
  }

  const openErrorExceptions = db.prepare(`
    SELECT id, exception_no as exceptionNo, exception_type as exceptionType, severity, message
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND severity = 'error'
      AND exception_type <> 'missing_fee_mapping'
    ORDER BY created_at DESC
    LIMIT 5
  `).all(yearMonth) as any[]
  const openErrorCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND severity = 'error'
      AND exception_type <> 'missing_fee_mapping'
  `).get(yearMonth) as any)?.total || 0)
  if (openErrorCount > 0) {
    blockers.push({
      code: 'OPEN_ERROR_COST_EXCEPTIONS',
      source: 'cost_exceptions',
      severity: 'blocker',
      title: '开放错误级成本异常',
      message: `存在 ${openErrorCount} 条未处理的错误级成本异常。`,
      count: openErrorCount,
      examples: openErrorExceptions,
    })
    addUniqueAction(nextActions, {
      action: 'review_cost_exceptions',
      label: '处理成本异常',
      href: costExceptionHref(yearMonth),
      source: 'cost_exceptions',
    })
  }

  const openWarningExceptions = db.prepare(`
    SELECT id, exception_no as exceptionNo, exception_type as exceptionType, severity, message
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND severity <> 'error'
      AND exception_type NOT IN ('missing_fee_mapping', 'absorption_residual')
    ORDER BY created_at DESC
    LIMIT 5
  `).all(yearMonth) as any[]
  const openWarningCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND severity <> 'error'
      AND exception_type NOT IN ('missing_fee_mapping', 'absorption_residual')
  `).get(yearMonth) as any)?.total || 0)
  if (openWarningCount > 0) {
    warnings.push({
      code: 'OPEN_WARNING_COST_EXCEPTIONS',
      source: 'cost_exceptions',
      severity: 'warning',
      title: '开放警告级成本异常',
      message: `存在 ${openWarningCount} 条建议处理的成本异常。`,
      count: openWarningCount,
      examples: openWarningExceptions,
    })
    addUniqueAction(nextActions, {
      action: 'review_cost_warnings',
      label: '查看成本异常',
      href: costExceptionHref(yearMonth),
      source: 'cost_exceptions',
    })
  }

  const pendingCostItems = db.prepare(`
    SELECT id, outbound_no as outboundNo, cost_status as costStatus, created_at as createdAt
    FROM outbound_records
    WHERE is_deleted = 0
      AND status = 'completed'
      AND substr(created_at, 1, 7) = ?
      AND COALESCE(cost_status, 'pending_cost') IN ('pending_cost', 'cost_exception')
    ORDER BY created_at DESC
    LIMIT 5
  `).all(yearMonth) as any[]
  const pendingCostCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM outbound_records
    WHERE is_deleted = 0
      AND status = 'completed'
      AND substr(created_at, 1, 7) = ?
      AND COALESCE(cost_status, 'pending_cost') IN ('pending_cost', 'cost_exception')
  `).get(yearMonth) as any)?.total || 0)
  if (pendingCostCount > 0) {
    blockers.push({
      code: 'PENDING_COST_ITEMS',
      source: 'outbound_records',
      severity: 'blocker',
      title: '未补算或成本异常出库',
      message: `存在 ${pendingCostCount} 单未补算或成本异常的出库记录。`,
      count: pendingCostCount,
      examples: pendingCostItems,
    })
    addUniqueAction(nextActions, {
      action: 'review_outbound_costs',
      label: '查看消耗对账',
      href: outboundCostHref(yearMonth),
      source: 'outbound_records',
    })
  }

  // R4（CHAIN-10）：完全吸收硬门禁——成本池未完全吸收（Σ池≠Σ来源）登记为 blocker，与关账端点 INCOMPLETE_ABSORPTION 一致。
  const absorptionResiduals = db.prepare(`
    SELECT id, exception_no as exceptionNo, exception_type as exceptionType, severity, message
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND exception_type = 'absorption_residual'
    ORDER BY created_at DESC
    LIMIT 5
  `).all(yearMonth) as any[]
  const absorptionResidualCount = Number((db.prepare(`
    SELECT COUNT(*) as total
    FROM cost_exceptions
    WHERE (year_month = ? OR year_month IS NULL)
      AND status = 'open'
      AND exception_type = 'absorption_residual'
  `).get(yearMonth) as any)?.total || 0)
  if (absorptionResidualCount > 0) {
    blockers.push({
      code: 'INCOMPLETE_ABSORPTION',
      source: 'cost_exceptions',
      severity: 'blocker',
      title: '成本池未完全吸收',
      message: `Σ池≠Σ来源，存在 ${absorptionResidualCount} 条未吸收残差（多为来源未映射作业中心），关账前须补齐映射并重新归集。`,
      count: absorptionResidualCount,
      examples: absorptionResiduals,
    })
    addUniqueAction(nextActions, {
      action: 'review_absorption_residual',
      label: '检查未吸收来源',
      href: costExceptionHref(yearMonth),
      source: 'cost_exceptions',
    })
  }

  const inventoryIssues = buildInventoryConsistencyIssues(db)
  const inventoryCriticalIssues = inventoryIssues.filter(issue => issue.severity === 'critical')
  const inventoryWarningIssues = inventoryIssues.filter(issue => issue.severity === 'warning')
  if (inventoryCriticalIssues.length > 0) {
    blockers.push({
      code: 'CRITICAL_INVENTORY_CONSISTENCY',
      source: 'inventory_consistency',
      severity: 'blocker',
      title: '库存一致性存在 critical 风险',
      message: `存在 ${inventoryCriticalIssues.length} 个库存/批次/库位一致性 critical 问题，可能影响成本可信度。`,
      count: inventoryCriticalIssues.length,
      examples: inventoryCriticalIssues.slice(0, 5),
    })
    addUniqueAction(nextActions, {
      action: 'review_inventory_consistency',
      label: '检查库存',
      href: '/inventory?consistency=1',
      source: 'inventory_consistency',
    })
  } else if (inventoryWarningIssues.length > 0) {
    warnings.push({
      code: 'WARNING_INVENTORY_CONSISTENCY',
      source: 'inventory_consistency',
      severity: 'warning',
      title: '库存一致性存在警告',
      message: `存在 ${inventoryWarningIssues.length} 个库存一致性警告，建议关账前复核。`,
      count: inventoryWarningIssues.length,
      examples: inventoryWarningIssues.slice(0, 5),
    })
    addUniqueAction(nextActions, {
      action: 'review_inventory_consistency',
      label: '检查库存',
      href: '/inventory?consistency=1',
      source: 'inventory_consistency',
    })
  }

  const status: ClosingReadinessStatus = blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'ready'

  return {
    yearMonth,
    status,
    summary: {
      blockerCount: blockers.length,
      warningCount: warnings.length,
      infoCount: info.length,
    },
    blockers,
    warnings,
    info,
    nextActions,
    sources: {
      abc_periods: {
        exists: Boolean(period),
        id: period?.id || null,
        status: period?.status || 'missing',
      },
      cost_exceptions: {
        openFeeMappingCount,
        openErrorCount,
        openWarningCount,
      },
      outbound_records: {
        pendingCostCount,
      },
      inventory_consistency: {
        issueCount: inventoryIssues.length,
        criticalCount: inventoryCriticalIssues.length,
        warningCount: inventoryWarningIssues.length,
      },
    },
  }
}
