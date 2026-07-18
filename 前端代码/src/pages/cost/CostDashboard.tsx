import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Database,
  Play,
  RefreshCw,
  Lock,
  Clock,
  FilePlus,
  Check,
  X,
} from 'lucide-react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { toast } from 'sonner'
import { Link, useSearchParams } from 'react-router-dom'
import { abcApi } from '@/api/abc'
import { getUserRole } from '@/lib/permissions'
import { downloadTextFile, formatCurrency } from '@/lib/utils'
import { ProfitBadge } from '@/components/ui/ProfitBadge'

interface DashboardSummary {
  totalCost: number
  totalFee: number
  totalProfit: number
  profitRate: number
  caseCount: number
  sampleCount: number
  outboundCount?: number
  abcSnapshotCount?: number
  openExceptionCount?: number
  pendingCostCount?: number
  materialCost: number
  activityCost: number
  adjustmentAmount?: number
  pendingAdjustmentCount?: number
  adjustedTotalCost?: number
  adjustedTotalProfit?: number
  adjustedProfitRate?: number
  costChange: number
  feeChange: number
  profitChange: number
}

interface ProjectProfit {
  projectId: string
  projectName: string
  projectType: string
  caseCount: number
  sampleCount: number
  totalCost: number
  feeAmount: number
  profit: number
  profitRate: number
}

interface CostByActivity {
  activityCenterId: string
  activityCenterName: string
  activityCenterCode: string
  cost: number
  ratio: number
}

interface CostException {
  id: string
  exceptionNo: string
  exceptionType: string
  severity: 'info' | 'warning' | 'error'
  status: 'open' | 'resolved' | 'ignored'
  outboundId?: string
  outboundNo?: string
  projectName: string
  message: string
  createdAt: string
}

interface CostPeriod {
  id: string
  yearMonth: string
  status: 'open' | 'collecting' | 'calculated' | 'closed'
  closedAt?: string
}

interface CostRun {
  id: string
  yearMonth: string
  runType: string
  status: 'running' | 'success' | 'completed' | 'failed'
  summary?: {
    total?: number
    success?: number
    processed?: number
    succeeded?: number
    failed?: number
    sourceTotals?: {
      materialCost?: number
      outboundCount?: number
    }
    failures?: Array<{
      outboundId?: string
      outboundNo?: string
      message?: string
    }>
  }
  startedAt: string
  finishedAt?: string
}

interface CostAdjustment {
  id: string
  adjustmentNo: string
  yearMonth: string
  adjustmentType: string
  amount: number
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  submittedBy?: string
  submittedAt?: string
  reviewedBy?: string
  reviewedAt?: string
  reviewRemark?: string
}

interface ClosingReadinessIssue {
  code: string
  source: string
  severity: 'blocker' | 'warning' | 'info'
  title: string
  message: string
  count?: number
}

interface ClosingReadinessAction {
  action: string
  label: string
  href: string
  source: string
}

interface ClosingReadiness {
  yearMonth: string
  status: 'ready' | 'blocked' | 'warning'
  summary: {
    blockerCount: number
    warningCount: number
    infoCount: number
  }
  blockers: ClosingReadinessIssue[]
  warnings: ClosingReadinessIssue[]
  nextActions: ClosingReadinessAction[]
  sources: Record<string, unknown>
}

const PIE_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ef4444', '#06b6d4', '#f97316', '#14b8a6',
]

const PROJECT_TYPE_LABELS: Record<string, string> = {
  ihc: '免疫组化',
  he: 'HE染色',
  ss: '特殊染色',
  mp: '分子病理',
  cyto: '细胞病理',
}

const PERIOD_STATUS: Record<string, { label: string; className: string }> = {
  open: { label: '已开启', className: 'bg-blue-50 text-blue-700' },
  collecting: { label: '归集中', className: 'bg-amber-50 text-amber-700' },
  calculated: { label: '已核算', className: 'bg-emerald-50 text-emerald-700' },
  closed: { label: '已关账', className: 'bg-gray-100 text-gray-600' },
}

const RUN_STATUS: Record<string, { label: string; className: string }> = {
  running: { label: '运行中', className: 'bg-blue-50 text-blue-700' },
  success: { label: '成功', className: 'bg-emerald-50 text-emerald-700' },
  completed: { label: '成功', className: 'bg-emerald-50 text-emerald-700' },
  failed: { label: '失败', className: 'bg-red-50 text-red-700' },
}

const ADJUSTMENT_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: '待审核', className: 'bg-amber-50 text-amber-700' },
  approved: { label: '已通过', className: 'bg-emerald-50 text-emerald-700' },
  rejected: { label: '已驳回', className: 'bg-red-50 text-red-700' },
}

const CLOSING_READINESS_STATUS: Record<ClosingReadiness['status'], { label: string; className: string; panelClassName: string }> = {
  ready: {
    label: '可关账',
    className: 'bg-emerald-50 text-emerald-700',
    panelClassName: 'border-emerald-200 bg-emerald-50',
  },
  blocked: {
    label: '阻断',
    className: 'bg-red-50 text-red-700',
    panelClassName: 'border-red-200 bg-red-50',
  },
  warning: {
    label: '警告',
    className: 'bg-amber-50 text-amber-700',
    panelClassName: 'border-amber-200 bg-amber-50',
  },
}

const listPayload = <T,>(data: any): T[] => data?.list || data?.items || data || []

const mergeReviewedAdjustment = (items: CostAdjustment[], updated: CostAdjustment) =>
  items.map(item => item.id === updated.id ? { ...item, ...updated } : item)

const mergeCreatedAdjustment = (items: CostAdjustment[], created: CostAdjustment) => [
  created,
  ...items.filter(item => item.id !== created.id),
]

export const applyCreatedAdjustmentToSummary = (
  current: DashboardSummary | null,
  created: CostAdjustment,
) => {
  if (!current || created.status !== 'pending') return current
  return {
    ...current,
    pendingAdjustmentCount: (current.pendingAdjustmentCount ?? 0) + 1,
  }
}

export const applyReviewedAdjustmentToSummary = (
  current: DashboardSummary | null,
  previous: CostAdjustment | undefined,
  updated: CostAdjustment,
) => {
  if (!current || !previous || previous.status !== 'pending') return current
  const pendingAdjustmentCount = Math.max(0, (current.pendingAdjustmentCount ?? 0) - 1)
  if (updated.status !== 'approved') {
    return { ...current, pendingAdjustmentCount }
  }
  const adjustmentAmount = (current.adjustmentAmount ?? 0) + updated.amount
  const adjustedTotalCost = current.adjustedTotalCost === undefined ? undefined : current.adjustedTotalCost + updated.amount
  const adjustedTotalProfit = current.adjustedTotalProfit === undefined ? undefined : current.adjustedTotalProfit - updated.amount
  const adjustedProfitRate = adjustedTotalProfit !== undefined && current.totalFee > 0 ? adjustedTotalProfit / current.totalFee : current.adjustedProfitRate

  return {
    ...current,
    adjustmentAmount,
    pendingAdjustmentCount,
    adjustedTotalCost,
    adjustedTotalProfit,
    adjustedProfitRate,
  }
}

export function getDashboardOpenExceptionCount(summaryCount: number | undefined, visibleAlertsCount: number) {
  return Number.isFinite(summaryCount) ? Number(summaryCount) : visibleAlertsCount
}

export function buildCostAlertsOverviewLink(month: string) {
  const params = new URLSearchParams({
    yearMonth: month,
    status: 'open',
    includeUnassigned: '1',
  })
  return `/abc/alerts?${params.toString()}`
}

export function buildCostRunExceptionLink(runId: string, month: string) {
  const params = new URLSearchParams({
    keyword: runId,
    yearMonth: month,
    status: 'open',
    includeUnassigned: '1',
  })
  return `/abc/alerts?${params.toString()}`
}

export function getClosePeriodBlockReason(
  periodStatus: CostPeriod['status'] | undefined,
  openExceptionCount: number,
  pendingCostCount: number,
) {
  if (!periodStatus) return '请先开启成本期间'
  if (periodStatus === 'closed') return '成本期间已关账'
  if (periodStatus !== 'calculated') return '请先执行重算并完成核算'
  if (openExceptionCount > 0) return `仍有 ${openExceptionCount} 条开放成本异常`
  if (pendingCostCount > 0) return `仍有 ${pendingCostCount} 单未补算或成本异常`
  return ''
}

export function getCostRunProcessedCount(summary?: CostRun['summary']) {
  return summary?.total ?? summary?.processed ?? null
}

export function getCostRunSucceededCount(summary?: CostRun['summary']) {
  return summary?.success ?? summary?.succeeded ?? null
}

function formatKnownCount(value: number | null | undefined, unit: string) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} ${unit}` : '不可用'
}

function formatKnownNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '不可用'
}

function formatKnownCurrency(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? formatCurrency(value) : '不可用'
}

function getFirstCostRunFailure(summary?: CostRun['summary']) {
  return summary?.failures?.find(item => item?.outboundNo || item?.message)
}

export function buildInitialCostDashboardFilters(searchParams: URLSearchParams, defaultMonth: string) {
  return {
    month: searchParams.get('month') || searchParams.get('yearMonth') || defaultMonth,
    keyword: searchParams.get('keyword') || '',
  }
}

export default function CostDashboard() {
  const [searchParams] = useSearchParams()
  const [initialFilters] = useState(() =>
    buildInitialCostDashboardFilters(searchParams, new Date().toISOString().slice(0, 7))
  )
  const [month, setMonth] = useState(initialFilters.month)
  const [dashboardKeyword, setDashboardKeyword] = useState(initialFilters.keyword)
  const [role] = useState(() => getUserRole())
  const [loading, setLoading] = useState(true)
  const [summaryFailed, setSummaryFailed] = useState(false)
  const [workbenchFailed, setWorkbenchFailed] = useState(false)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [profitByProject, setProfitByProject] = useState<ProjectProfit[]>([])
  const [costByActivity, setCostByActivity] = useState<CostByActivity[]>([])
  const [alerts, setAlerts] = useState<CostException[]>([])
  const [currentPeriod, setCurrentPeriod] = useState<CostPeriod | null>(null)
  const [costRuns, setCostRuns] = useState<CostRun[]>([])
  const [adjustments, setAdjustments] = useState<CostAdjustment[]>([])
  const [closingReadiness, setClosingReadiness] = useState<ClosingReadiness | null>(null)
  const [closingReadinessFailed, setClosingReadinessFailed] = useState(false)
  const [workbenchLoading, setWorkbenchLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [adjustmentModalOpen, setAdjustmentModalOpen] = useState(false)
  const [adjustmentAmount, setAdjustmentAmount] = useState('')
  const [adjustmentReason, setAdjustmentReason] = useState('')
  const [adjustmentSubmitting, setAdjustmentSubmitting] = useState(false)
  const requestGenerationRef = useRef(0)

  const loadDashboard = useCallback(async (preserveOptimisticState = false) => {
    const requestGeneration = ++requestGenerationRef.current
    setLoading(true)
    setSummaryFailed(false)
    setWorkbenchFailed(false)
    setClosingReadinessFailed(false)
    if (!preserveOptimisticState) {
      setSummary(null)
      setProfitByProject([])
      setCostByActivity([])
      setAlerts([])
      setCurrentPeriod(null)
      setCostRuns([])
      setAdjustments([])
      setClosingReadiness(null)
    }

    const dashboardRequest = abcApi.getDashboard(month)
    const periodRequest = abcApi.getPeriods({ yearMonth: month, pageSize: 1 })
    const costRunsRequest = abcApi.getCostRuns({
      yearMonth: month,
      pageSize: dashboardKeyword ? 20 : 5,
      keyword: dashboardKeyword || undefined,
    })
    const adjustmentsRequest = abcApi.getAdjustments({
      yearMonth: month,
      pageSize: dashboardKeyword ? 20 : 5,
      keyword: dashboardKeyword || undefined,
    })
    const closingReadinessRequest = abcApi.getClosingReadiness(month)

    const [dashboardResult, periodResult, costRunsResult, adjustmentsResult, readinessResult] =
      await Promise.allSettled([
        dashboardRequest,
        periodRequest,
        costRunsRequest,
        adjustmentsRequest,
        closingReadinessRequest,
      ])

    if (requestGeneration !== requestGenerationRef.current) return

    if (dashboardResult.status === 'fulfilled') {
      const data = dashboardResult.value
      setSummary(data.summary)
      setProfitByProject(data.profitByProject || [])
      setCostByActivity(data.costByActivity || [])
      setAlerts(data.alerts || [])
    } else {
      setSummaryFailed(true)
      toast.error('成本汇总数据加载失败')
      if (preserveOptimisticState) {
        setLoading(false)
        return
      }
    }

    const hasWorkbenchFailure =
      periodResult.status === 'rejected' ||
      costRunsResult.status === 'rejected' ||
      adjustmentsResult.status === 'rejected'
    setWorkbenchFailed(hasWorkbenchFailure)
    setCurrentPeriod(periodResult.status === 'fulfilled' ? listPayload<CostPeriod>(periodResult.value)[0] || null : null)
    setCostRuns(costRunsResult.status === 'fulfilled' ? listPayload<CostRun>(costRunsResult.value) : [])
    setAdjustments(adjustmentsResult.status === 'fulfilled' ? listPayload<CostAdjustment>(adjustmentsResult.value) : [])
    setClosingReadiness(readinessResult.status === 'fulfilled' ? readinessResult.value : null)
    setClosingReadinessFailed(readinessResult.status === 'rejected')
    setLoading(false)
  }, [dashboardKeyword, month])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const pieData = useMemo(() =>
    costByActivity.map(a => ({
      name: a.activityCenterName,
      value: a.cost,
    })),
    [costByActivity]
  )

  const getChangeIcon = (change: number) => {
    if (change > 0) return <TrendingUp className="h-3 w-3 text-green-500" />
    if (change < 0) return <TrendingDown className="h-3 w-3 text-red-500" />
    return <Minus className="h-3 w-3 text-gray-400" />
  }

  const getChangeText = (change: number) => {
    if (change === 0) return '持平'
    const sign = change > 0 ? '+' : ''
    return `${sign}${(change * 100).toFixed(1)}%`
  }

  const ensureCurrentPeriod = async () => {
    if (currentPeriod) return currentPeriod
    const created = await abcApi.createPeriod({ yearMonth: month })
    setCurrentPeriod(created)
    return created as CostPeriod
  }

  const runWorkbenchAction = async (action: 'start' | 'collect' | 'recalculate' | 'close') => {
    try {
      setWorkbenchLoading(true)
      const period = await ensureCurrentPeriod()
      if (action === 'start') {
        await abcApi.startPeriodCollection(period.id)
        toast.success('已开始成本归集')
      }
      if (action === 'collect') {
        await abcApi.autoCollectCostPools(month)
        toast.success('成本池已自动归集')
      }
      if (action === 'recalculate') {
        await abcApi.recalculateCostPools(month)
        toast.success('重算任务已完成')
      }
      if (action === 'close') {
        await abcApi.closePeriod(period.id)
        toast.success('成本期间已关账')
      }
      await loadDashboard(true)
    } catch {
      // 统一错误提示已在请求拦截器处理
    } finally {
      setWorkbenchLoading(false)
    }
  }

  const handleExport = async () => {
    try {
      setExporting(true)
      const data = await abcApi.exportData({ month })
      downloadTextFile(data.filename || `abc-cost-export-${month}.csv`, data.content || '', data.mimeType)
      toast.success('导出完成')
    } catch {
      // 统一错误提示已在请求拦截器处理
    } finally {
      setExporting(false)
    }
  }

  const handleCreateAdjustment = async () => {
    const amount = Number(adjustmentAmount)
    if (!Number.isFinite(amount) || amount === 0) {
      toast.error('请填写非 0 调整金额，系统才能重算调整后成本和利润。')
      return
    }
    if (!adjustmentReason.trim()) {
      toast.error('请填写调整原因，系统才能解释关账后调整并形成审核记录。')
      return
    }
    try {
      setAdjustmentSubmitting(true)
      const createdAdjustment = await abcApi.createAdjustment({
        yearMonth: month,
        adjustmentType: 'closed_period_adjustment',
        amount,
        reason: adjustmentReason.trim(),
      })
      toast.success('调整单已创建，待审核')
      setAdjustments(prev => mergeCreatedAdjustment(prev, createdAdjustment))
      setSummary(prev => applyCreatedAdjustmentToSummary(prev, createdAdjustment))
      setAdjustmentModalOpen(false)
      setAdjustmentAmount('')
      setAdjustmentReason('')
      await loadDashboard(true)
    } catch {
      // 统一错误提示已在请求拦截器处理
    } finally {
      setAdjustmentSubmitting(false)
    }
  }

  const handleReviewAdjustment = async (id: string, action: 'approve' | 'reject') => {
    try {
      setWorkbenchLoading(true)
      let reviewedAdjustment: CostAdjustment
      if (action === 'approve') {
        reviewedAdjustment = await abcApi.approveAdjustment(id, { remark: '成本看板审核' })
        toast.success('调整单已通过')
      } else {
        reviewedAdjustment = await abcApi.rejectAdjustment(id, { remark: '成本看板驳回' })
        toast.success('调整单已驳回')
      }
      const previousAdjustment = adjustments.find(item => item.id === reviewedAdjustment.id)
      setAdjustments(prev => mergeReviewedAdjustment(prev, reviewedAdjustment))
      setSummary(prev => applyReviewedAdjustmentToSummary(prev, previousAdjustment, reviewedAdjustment))
      await loadDashboard(true)
    } catch {
      // 统一错误提示已在请求拦截器处理
    } finally {
      setWorkbenchLoading(false)
    }
  }

  const periodStatus = currentPeriod ? PERIOD_STATUS[currentPeriod.status] || PERIOD_STATUS.open : null
  const canManageCostPeriod = role === 'admin' || role === 'finance'
  const openAlertCount = summary
    ? getDashboardOpenExceptionCount(summary.openExceptionCount, alerts.length)
    : null
  const closeBlockReason = summary && openAlertCount !== null && typeof summary.pendingCostCount === 'number'
    ? getClosePeriodBlockReason(currentPeriod?.status, openAlertCount, summary.pendingCostCount)
    : '成本汇总或未补算口径不可用，暂不能判断是否可关账'
  const adjustmentAmountValue = Number(adjustmentAmount)
  const adjustmentValidationMessage = adjustmentModalOpen
    ? !Number.isFinite(adjustmentAmountValue) || adjustmentAmountValue === 0
      ? '请填写非 0 调整金额，系统才能重算调整后成本和利润。'
      : !adjustmentReason.trim()
        ? '请填写调整原因，系统才能解释关账后调整并形成审核记录。'
        : ''
    : ''
  const canSubmitAdjustment = !adjustmentValidationMessage && !adjustmentSubmitting
  const closingReadinessMeta = closingReadiness
    ? CLOSING_READINESS_STATUS[closingReadiness.status]
    : null
  const visibleClosingReadinessIssues = [
    ...(closingReadiness?.blockers || []),
    ...(closingReadiness?.warnings || []),
  ].slice(0, 5)
  const visibleClosingReadinessActions = (closingReadiness?.nextActions || []).slice(0, 4)

  return (
    <div className="p-6 space-y-6" aria-busy={loading}>
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">成本看板</h1>
          <p className="text-sm text-gray-500 mt-1">ABC 作业成本法总览</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="month"
            aria-label="成本月份"
            value={month}
            onChange={e => {
              setMonth(e.target.value)
              setDashboardKeyword('')
            }}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            <Download className="h-4 w-4" /> 导出报表
          </button>
        </div>
      </div>

      {loading && !summary && (
        <section role="status" aria-label="正在加载成本工作流" className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          正在加载当前筛选条件的成本汇总、期间、任务、调整单与结账健康状态…
        </section>
      )}

      {summaryFailed && !summary && (
        <section
          aria-label="成本汇总数据不可用"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <h2 className="font-semibold">成本汇总数据不可用</h2>
          <p className="mt-1 leading-6">本次请求失败；页面没有把失败响应解释成 0，核算工作台会继续展示独立请求的真实结果。</p>
          <button
            type="button"
            onClick={() => void loadDashboard()}
            className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 font-medium text-amber-800 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          >
            <RefreshCw className="h-4 w-4" /> 重试成本汇总
          </button>
        </section>
      )}

      {summaryFailed && summary && (
        <section aria-label="成本汇总刷新失败" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          成本汇总刷新失败；当前保留的是本筛选条件下最近一次成功结果，请重试后再作判断。
        </section>
      )}

      {workbenchFailed && (
        <section aria-label="核算工作台数据不完整" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          核算期间、任务或调整单中至少一层加载失败；失败层保持不可用，不据此执行关账。
        </section>
      )}

      {/* 核算工作台 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 2xl:grid-cols-7 gap-3">
            <div className="min-h-[72px] rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Clock className="h-3.5 w-3.5" />
                成本期间
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="whitespace-nowrap text-sm font-semibold text-gray-900">{month}</span>
                {periodStatus ? (
                  <span className={`whitespace-nowrap px-2 py-0.5 rounded-full text-xs ${periodStatus.className}`}>
                    {periodStatus.label}
                  </span>
                ) : (
                  <span className="whitespace-nowrap px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">未开启</span>
                )}
              </div>
            </div>
            <div className="min-h-[72px] rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="text-xs text-gray-500">出库数</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">
                {formatKnownCount(summary?.outboundCount, '单')}
              </div>
            </div>
            <div className="min-h-[72px] rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="text-xs text-gray-500">成本快照</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">
                {formatKnownCount(summary?.abcSnapshotCount, '条')}
              </div>
            </div>
            <div className="min-h-[72px] rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                开放异常
              </div>
              <div className="mt-1 text-sm font-semibold text-gray-900">
                {summary ? formatKnownCount(summary.openExceptionCount ?? alerts.length, '条') : '不可用'}
              </div>
            </div>
            <div className="min-h-[72px] rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <RefreshCw className="h-3.5 w-3.5 text-blue-500" />
                未补算
              </div>
              <div className="mt-1 text-sm font-semibold text-gray-900">
                {formatKnownCount(summary?.pendingCostCount, '单')}
              </div>
            </div>
            <div className="min-h-[72px] rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="text-xs text-gray-500">调整额 / 待审</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">
                {summary
                  ? `${formatKnownCurrency(summary.adjustmentAmount)} / ${formatKnownNumber(summary.pendingAdjustmentCount)}`
                  : '不可用'}
              </div>
            </div>
            <div className="min-h-[72px] rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="text-xs text-gray-500">调整后利润</div>
              <div className="mt-1 text-sm font-semibold text-gray-900">
                {formatKnownCurrency(summary?.adjustedTotalProfit ?? summary?.totalProfit)}
              </div>
            </div>
          </div>

          {canManageCostPeriod && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdjustmentModalOpen(true)}
                disabled={workbenchLoading || workbenchFailed || currentPeriod?.status !== 'closed'}
                className="h-9 px-3 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <FilePlus className="h-4 w-4" />
                调整单
              </button>
              <button
                type="button"
                onClick={() => runWorkbenchAction('start')}
                disabled={workbenchLoading || workbenchFailed || currentPeriod?.status === 'closed'}
                className="h-9 px-3 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <Play className="h-4 w-4" />
                开始归集
              </button>
              <button
                type="button"
                onClick={() => runWorkbenchAction('collect')}
                disabled={workbenchLoading || workbenchFailed || currentPeriod?.status === 'closed'}
                className="h-9 px-3 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <Database className="h-4 w-4" />
                自动归集
              </button>
              <button
                type="button"
                onClick={() => runWorkbenchAction('recalculate')}
                disabled={workbenchLoading || workbenchFailed || currentPeriod?.status === 'closed'}
                className="h-9 px-3 text-sm bg-[#3b82f6] text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${workbenchLoading ? 'animate-spin' : ''}`} />
                执行重算
              </button>
              <button
                type="button"
                onClick={() => runWorkbenchAction('close')}
                disabled={workbenchLoading || workbenchFailed || Boolean(closeBlockReason)}
                title={closeBlockReason || undefined}
                className="h-9 px-3 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <Lock className="h-4 w-4" />
                关账
              </button>
            </div>
          )}
          {canManageCostPeriod && closeBlockReason && currentPeriod?.status !== 'closed' && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {closeBlockReason}
            </div>
          )}
        </div>

        {costRuns.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="py-2 text-left font-medium">任务</th>
                  <th className="py-2 text-left font-medium">状态</th>
                  <th className="py-2 text-left font-medium">出库单</th>
                  <th className="py-2 text-left font-medium">成功</th>
                  <th className="py-2 text-left font-medium">失败</th>
                  <th className="py-2 text-left font-medium">完成时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {costRuns.map(run => {
                  const runStatus = RUN_STATUS[run.status] || RUN_STATUS.running
                  const firstFailure = getFirstCostRunFailure(run.summary)
                  return (
                    <tr key={run.id}>
                      <td className="py-2 text-gray-900">
                        <div>{run.runType === 'recalculate' ? '重算' : run.runType}</div>
                        <div className="mt-0.5 font-mono text-xs text-gray-400">{run.id}</div>
                      </td>
                      <td className="py-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs ${runStatus.className}`}>
                          {runStatus.label}
                        </span>
                      </td>
                      <td className="py-2 text-gray-600">{getCostRunProcessedCount(run.summary) ?? '—'}</td>
                      <td className="py-2 text-emerald-600">{getCostRunSucceededCount(run.summary) ?? '—'}</td>
                      <td className="py-2 text-red-600">
                        <div>{run.summary?.failed ?? '—'}</div>
                        {firstFailure && (
                          <div className="mt-1 max-w-[320px] space-y-1 text-xs leading-5 text-red-700">
                            <div>
                              失败出库 {firstFailure.outboundNo || '未关联单号'}：
                              {firstFailure.message || '请查看成本异常详情'}
                            </div>
                            <div className="text-gray-500">修正源数据后重新执行重算</div>
                            <Link
                              to={buildCostRunExceptionLink(run.id, run.yearMonth)}
                              className="inline-flex text-blue-600 hover:text-blue-700"
                            >
                              查看失败异常
                            </Link>
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-gray-500">{run.finishedAt || run.startedAt || '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {adjustments.length > 0 && (
          <div className="mt-4 overflow-x-auto border-t border-gray-100 pt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="py-2 text-left font-medium">调整单</th>
                  <th className="py-2 text-left font-medium">金额</th>
                  <th className="py-2 text-left font-medium">状态</th>
                  <th className="py-2 text-left font-medium">原因</th>
                  <th className="py-2 text-left font-medium">提交人</th>
                  <th className="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {adjustments.map(item => {
                  const status = ADJUSTMENT_STATUS[item.status] || ADJUSTMENT_STATUS.pending
                  return (
                    <tr key={item.id}>
                      <td className="py-2 text-gray-900">{item.adjustmentNo}</td>
                      <td className={`py-2 font-medium ${item.amount >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {formatCurrency(item.amount)}
                      </td>
                      <td className="py-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs ${status.className}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="py-2 text-gray-600">{item.reason}</td>
                      <td className="py-2 text-gray-500">{item.submittedBy || '-'}</td>
                      <td className="py-2 text-right">
                        {item.status === 'pending' ? (
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleReviewAdjustment(item.id, 'approve')}
                              disabled={workbenchLoading}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                            >
                              <Check className="h-3.5 w-3.5" />
                              通过
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReviewAdjustment(item.id, 'reject')}
                              disabled={workbenchLoading}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                            >
                              <X className="h-3.5 w-3.5" />
                              驳回
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">{item.reviewedBy || '-'}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 结账健康检查 */}
      <div className={`rounded-lg border p-4 ${closingReadinessMeta?.panelClassName || 'border-gray-200 bg-white'}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">结账健康检查</h3>
              {closingReadinessFailed ? (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">暂不可用</span>
              ) : closingReadinessMeta ? (
                <span className={`rounded-full px-2 py-0.5 text-xs ${closingReadinessMeta.className}`}>
                  {closingReadinessMeta.label}
                </span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">检查中</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-600">
              <span>期间 {month}</span>
              <span className="inline-flex items-center gap-1">
                <span>阻断</span>
                <span>{closingReadiness?.summary.blockerCount ?? 0} 项</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span>警告</span>
                <span>{closingReadiness?.summary.warningCount ?? 0} 项</span>
              </span>
            </div>
          </div>
          {visibleClosingReadinessActions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {visibleClosingReadinessActions.map(action => (
                <Link
                  key={`${action.action}-${action.href}`}
                  to={action.href}
                  className="inline-flex h-8 items-center rounded-md border border-gray-300 bg-white px-3 text-xs text-gray-700 hover:bg-gray-50"
                >
                  {action.label}
                </Link>
              ))}
            </div>
          )}
        </div>
        {closingReadinessFailed ? (
          <div className="mt-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600">
            结账健康检查暂时不可用，请稍后刷新。
          </div>
        ) : visibleClosingReadinessIssues.length > 0 ? (
          <div className="mt-3 divide-y divide-gray-200 overflow-hidden rounded-md border border-gray-200 bg-white">
            {visibleClosingReadinessIssues.map(issue => (
              <div key={`${issue.source}-${issue.code}`} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">{issue.title}</div>
                  <div className="text-xs text-gray-600">{issue.message}</div>
                </div>
                <span className={`w-fit rounded-full px-2 py-0.5 text-xs ${
                  issue.severity === 'blocker' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                }`}>
                  {issue.count ?? 1}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-md border border-emerald-100 bg-white px-3 py-2 text-sm text-emerald-700">
            当前期间没有发现结账阻断项。
          </div>
        )}
      </div>

      {summary && (
      <>
      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总成本</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatKnownCurrency(summary.totalCost)}</div>
          <div className="flex items-center gap-1 mt-1">
            {typeof summary.costChange === 'number' && Number.isFinite(summary.costChange) ? (
              <>{getChangeIcon(summary.costChange)}<span className="text-xs text-gray-400">环比 {getChangeText(summary.costChange)}</span></>
            ) : <span className="text-xs text-gray-400">环比不可用</span>}
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总收入</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatKnownCurrency(summary.totalFee)}</div>
          <div className="flex items-center gap-1 mt-1">
            {typeof summary.feeChange === 'number' && Number.isFinite(summary.feeChange) ? (
              <>{getChangeIcon(summary.feeChange)}<span className="text-xs text-gray-400">环比 {getChangeText(summary.feeChange)}</span></>
            ) : <span className="text-xs text-gray-400">环比不可用</span>}
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总利润</div>
          <div className={`text-2xl font-bold mt-1 ${typeof summary.totalProfit === 'number' ? (summary.totalProfit >= 0 ? 'text-green-600' : 'text-red-600') : 'text-gray-500'}`}>
            {formatKnownCurrency(summary.totalProfit)}
          </div>
          <div className="flex items-center gap-1 mt-1">
            {typeof summary.profitChange === 'number' && Number.isFinite(summary.profitChange) ? (
              <>{getChangeIcon(summary.profitChange)}<span className="text-xs text-gray-400">环比 {getChangeText(summary.profitChange)}</span></>
            ) : <span className="text-xs text-gray-400">环比不可用</span>}
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">平均利润率</div>
          <div className="mt-1">
            {typeof summary.profitRate === 'number' && Number.isFinite(summary.profitRate)
              ? <ProfitBadge rate={summary.profitRate} showPercent />
              : <span className="text-sm font-semibold text-gray-500">不可用</span>}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            {typeof summary.caseCount === 'number' && Number.isFinite(summary.caseCount)
              ? `${summary.caseCount} 例`
              : '病例数不可用'}
            {' / '}
            {typeof summary.sampleCount === 'number' && Number.isFinite(summary.sampleCount)
              ? `${summary.sampleCount} 片`
              : '样本数不可用'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 项目盈利性排名 */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">项目盈利性排名</h3>
          </div>
          <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
            {profitByProject.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-400 text-sm">暂无数据</div>
            ) : (
              profitByProject.map((item, index) => (
                <div key={item.projectId} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                      index < 3 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{item.projectName}</div>
                      <div className="text-xs text-gray-400">
                        {PROJECT_TYPE_LABELS[item.projectType] || item.projectType}
                      </div>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`text-sm font-medium ${item.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(item.profit)}
                    </div>
                    <ProfitBadge rate={item.profitRate} />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 成本结构饼图 */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">成本结构</h3>
          </div>
          <div className="p-4">
            {pieData.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">暂无数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {pieData.map((_, index) => (
                      <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb' }}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    formatter={(value) => <span className="text-xs text-gray-600">{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* 异常提醒 */}
      {openAlertCount > 0 && (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-gray-900">异常提醒</h3>
            <span className="px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded-full">{openAlertCount}</span>
            {alerts.length > 0 && openAlertCount > alerts.length && (
              <span className="text-xs text-gray-400">显示最近 {alerts.length} 条</span>
            )}
            <Link
              to={buildCostAlertsOverviewLink(month)}
              className="ml-auto text-xs text-blue-600 hover:text-blue-700"
            >
              查看全部
            </Link>
          </div>
          {alerts.length > 0 ? (
            <div className="divide-y divide-gray-100">
              {alerts.map(alert => (
              <div key={alert.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                  alert.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {alert.exceptionType}
                </span>
                <span className="text-sm text-gray-600 flex-1">{alert.message}</span>
                <Link
                  to={alert.outboundId
                    ? `/abc/alerts?outboundId=${encodeURIComponent(alert.outboundId)}`
                    : `/abc/alerts?keyword=${encodeURIComponent(alert.exceptionNo)}`}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  处理
                </Link>
              </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-sm text-gray-500">
              当前存在开放异常，请进入异常中心查看。
            </div>
          )}
        </div>
      )}
      </>
      )}

      {adjustmentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3 className="text-base font-semibold text-gray-900">创建关账后调整单</h3>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
                调整期间：<span className="font-medium text-gray-900">{month}</span>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">调整金额</label>
                <input
                  type="number"
                  value={adjustmentAmount}
                  onChange={event => setAdjustmentAmount(event.target.value)}
                  className="h-10 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10"
                  placeholder="正数增加成本，负数冲减成本"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">调整原因</label>
                <textarea
                  value={adjustmentReason}
                  onChange={event => setAdjustmentReason(event.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10"
                  placeholder="例如：关账后发现设备折旧分摊差异，经财务复核调整"
                />
              </div>
              <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3">
                <div className="text-sm font-semibold text-emerald-900">调整单结果确认</div>
                <div className="mt-1 text-xs text-emerald-700">
                  确认后将接住：关账后调整、调整额、调整后利润、成本看板、审核记录、审计记录
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-emerald-700">
                  <div>调整期间 {month}</div>
                  <div>
                    调整金额 {Number.isFinite(adjustmentAmountValue) && adjustmentAmountValue !== 0
                      ? formatCurrency(adjustmentAmountValue)
                      : '待填写'}
                  </div>
                  <div>调整原因 {adjustmentReason.trim() || '待填写'}</div>
                </div>
              </div>
              {adjustmentValidationMessage ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {adjustmentValidationMessage}
                </div>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-4">
              <button
                type="button"
                onClick={() => setAdjustmentModalOpen(false)}
                className="h-9 rounded-md border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCreateAdjustment}
                disabled={!canSubmitAdjustment}
                className="h-9 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {adjustmentSubmitting ? '提交中...' : '提交调整单'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
