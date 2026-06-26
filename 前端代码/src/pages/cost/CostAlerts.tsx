import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, EyeOff, FileSearch, RefreshCw, RotateCcw, Search, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { Modal } from '@/components/ui/Modal'
import { Pagination } from '@/components/ui/Pagination'

interface CostException {
  id: string
  exceptionNo: string
  exceptionType: string
  sourceModule?: string
  sourceId?: string
  outboundId?: string
  outboundNo?: string
  projectId?: string
  projectName?: string
  bomId?: string
  bomName?: string
  yearMonth?: string
  severity: 'info' | 'warning' | 'error'
  status: 'open' | 'resolved' | 'ignored'
  message: string
  details?: any
  retryCount?: number
  resolvedBy?: string
  resolvedAt?: string
  createdAt: string
}

interface CostExceptionSummary {
  total: number
  status: Record<'open' | 'resolved' | 'ignored', number>
  severity: Record<'error' | 'warning' | 'info', number>
}

const SEVERITY_LABELS: Record<string, { label: string; className: string }> = {
  error: { label: '错误', className: 'bg-red-100 text-red-700' },
  warning: { label: '警告', className: 'bg-amber-100 text-amber-700' },
  info: { label: '提示', className: 'bg-blue-100 text-blue-700' },
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  open: { label: '待处理', className: 'bg-amber-50 text-amber-700' },
  resolved: { label: '已解决', className: 'bg-emerald-50 text-emerald-700' },
  ignored: { label: '已忽略', className: 'bg-gray-100 text-gray-600' },
}

const TYPE_LABELS: Record<string, string> = {
  bom_material_skipped: 'BOM耗材跳过',
  abc_calculation_failed: 'ABC核算失败',
  calculation_failed: '成本计算失败',
  cost_recalculation_failed: '重算失败',
  missing_fee_mapping: '缺少收费映射',
  missing_driver_rate: '缺少动因费率',
  missing_bom: '缺少BOM',
  missing_project: '缺少项目',
  reconciliation_variance: '对账差异',
  manual_review: '人工复核',
}

const listPayload = <T,>(data: any): T[] => data?.list || data?.items || data || []

export function normalizeExceptionSummary(summary?: Partial<CostExceptionSummary> | null): CostExceptionSummary {
  return {
    total: Number(summary?.total) || 0,
    status: {
      open: Number(summary?.status?.open) || 0,
      resolved: Number(summary?.status?.resolved) || 0,
      ignored: Number(summary?.status?.ignored) || 0,
    },
    severity: {
      error: Number(summary?.severity?.error) || 0,
      warning: Number(summary?.severity?.warning) || 0,
      info: Number(summary?.severity?.info) || 0,
    },
  }
}

export function buildInitialCostAlertFilters(searchParams: URLSearchParams, defaultMonth: string) {
  const outboundId = searchParams.get('outboundId') || ''
  const keyword = searchParams.get('keyword') || ''
  const projectId = searchParams.get('projectId') || ''
  const exceptionType = searchParams.get('exceptionType') || ''
  const startDate = searchParams.get('startDate') || ''
  const endDate = searchParams.get('endDate') || ''
  const explicitYearMonth = searchParams.get('yearMonth')
  const includeUnassigned = searchParams.get('includeUnassigned') === '1' || searchParams.get('includeUnassigned') === 'true'
  const hasDeepLinkScope = Boolean(outboundId || keyword || projectId || exceptionType)
  return {
    status: searchParams.get('status') || 'open',
    severity: searchParams.get('severity') || '',
    yearMonth: explicitYearMonth ?? (hasDeepLinkScope ? '' : defaultMonth),
    keyword,
    outboundId,
    projectId,
    exceptionType,
    startDate,
    endDate,
    includeUnassigned,
  }
}

export function getRetryToastMessage(result: any) {
  const status = result?.exception?.status
  if (status === 'open') {
    return { type: 'warning' as const, message: '重试已完成，异常仍待处理' }
  }
  if (status === 'resolved') {
    return { type: 'success' as const, message: '重试已完成，异常已解决' }
  }
  return { type: 'success' as const, message: '重试已完成' }
}

export function getExceptionTypeLabel(type: string) {
  return TYPE_LABELS[type] || type
}

export function getExceptionActionGuidance(type: string) {
  const guidance: Record<string, string> = {
    missing_fee_mapping: '下一步：补齐BOM收费映射后重试，确认收费、利润和审计记录能重新接住。',
    missing_driver_rate: '下一步：补齐作业动因费率后重试，确认作业成本、项目成本和审计记录能重新接住。',
    missing_bom: '下一步：先到检测服务绑定BOM，再回到对账或异常中心重试成本计算。',
    bom_material_skipped: '下一步：检查BOM物料、库存批次和单位口径，修正后重试成本计算。',
    missing_project: '下一步：补齐出库记录的检测项目归属，再重试项目成本归集。',
    reconciliation_variance: '下一步：回到消耗对账核对LIS病例、BOM理论消耗和出库批次，修正后重新审计差异。',
    abc_calculation_failed: '下一步：检查出库、BOM、动因费率和期间状态；修正源数据后重试ABC核算。',
    calculation_failed: '下一步：检查出库、BOM、动因费率和期间状态；修正源数据后重试成本计算。',
    cost_recalculation_failed: '下一步：检查出库、BOM、动因费率和期间状态；修正源数据后重试成本重算。',
    manual_review: '下一步：查看来源单据和审计记录，填写复核结论后解决或忽略异常。',
  }
  return guidance[type] || '下一步：查看来源单据和审计记录，修正源数据后重试；无法确认时填写复核说明再处理。'
}

export default function CostAlerts() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [initialFilters] = useState(() =>
    buildInitialCostAlertFilters(searchParams, new Date().toISOString().slice(0, 7))
  )
  const [exceptions, setExceptions] = useState<CostException[]>([])
  const [summary, setSummary] = useState<CostExceptionSummary>(() => normalizeExceptionSummary())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [filters, setFilters] = useState(initialFilters)
  const [actionModal, setActionModal] = useState<{
    type: 'resolve' | 'ignore'
    exception: CostException
  } | null>(null)
  const [remark, setRemark] = useState('')

  useEffect(() => {
    loadExceptions()
  }, [filters.status, filters.severity, filters.yearMonth, filters.outboundId, filters.includeUnassigned, filters.projectId, filters.exceptionType, page, pageSize])

  const loadExceptions = async (nextPage = page, nextPageSize = pageSize) => {
    try {
      setLoading(true)
      const data = await abcApi.getExceptions({
        page: nextPage,
        pageSize: nextPageSize,
        status: filters.status || undefined,
        severity: filters.severity || undefined,
        yearMonth: filters.yearMonth || undefined,
        includeUnassigned: filters.includeUnassigned ? '1' : undefined,
        keyword: filters.keyword || undefined,
        outboundId: filters.outboundId || undefined,
        projectId: filters.projectId || undefined,
        exceptionType: filters.exceptionType || undefined,
      })
      const nextList = listPayload<CostException>(data)
      setExceptions(nextList)
      setSummary(normalizeExceptionSummary(data?.summary))
      setTotal(Number(data?.pagination?.total ?? data?.total ?? nextList.length) || 0)
    } catch {
      setExceptions([])
      setSummary(normalizeExceptionSummary())
      setTotal(0)
      toast.error('加载成本异常失败')
    } finally {
      setLoading(false)
    }
  }

  const stats = useMemo(() => ({
    total: summary.total,
    open: summary.status.open,
    error: summary.severity.error,
    warning: summary.severity.warning,
  }), [summary])

  const openAction = (type: 'resolve' | 'ignore', exception: CostException) => {
    setRemark('')
    setActionModal({ type, exception })
  }

  const actionValidationMessage = actionModal
    ? actionModal.type === 'resolve'
      ? remark.trim()
        ? ''
        : '请填写处理说明，系统才能留下异常处理、成本重算和审计依据。'
      : remark.trim()
        ? ''
        : '请填写忽略原因，系统才能留下异常忽略、成本复核和审计依据。'
    : ''
  const canSubmitAction = !actionValidationMessage && !actionLoading

  const submitAction = async () => {
    if (!actionModal) return
    if (actionValidationMessage) {
      toast.error(actionValidationMessage)
      return
    }
    try {
      setActionLoading(true)
      if (actionModal.type === 'resolve') {
        await abcApi.resolveException(actionModal.exception.id, { remark: remark.trim() })
        toast.success('异常已解决')
      } else {
        await abcApi.ignoreException(actionModal.exception.id, { reason: remark.trim() })
        toast.success('异常已忽略')
      }
      setActionModal(null)
      await loadExceptions()
    } catch {
      // 统一错误提示已在请求拦截器处理
    } finally {
      setActionLoading(false)
    }
  }

  const retryException = async (exception: CostException) => {
    try {
      setActionLoading(true)
      const result = await abcApi.retryException(exception.id)
      const toastMessage = getRetryToastMessage(result)
      if (toastMessage.type === 'warning') {
        toast.warning(toastMessage.message)
      } else {
        toast.success(toastMessage.message)
      }
      await loadExceptions()
    } catch {
      // 统一错误提示已在请求拦截器处理
    } finally {
      setActionLoading(false)
    }
  }

  const updateFilter = (key: keyof typeof filters, value: string) => {
    setPage(1)
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  const searchExceptions = () => {
    setPage(1)
    void loadExceptions(1)
  }

  const changePageSize = (nextPageSize: number) => {
    setPageSize(nextPageSize)
    setPage(1)
  }

  const openSourceReconciliation = (projectId: string) => {
    const params = new URLSearchParams({ projectId })
    if (filters.startDate && filters.endDate) {
      params.set('startDate', filters.startDate)
      params.set('endDate', filters.endDate)
    }
    navigate(`/reconciliation?${params.toString()}`)
  }

  const openFeeMappingSource = (exception: CostException) => {
    const params = new URLSearchParams()
    const keyword = String(exception.bomId || exception.bomName || '').trim()
    if (keyword) params.set('keyword', keyword)
    params.set('status', 'missing')
    navigate(`/abc/fee-mappings?${params.toString()}`)
  }

  const openProjectBomSource = (projectId: string) => {
    const params = new URLSearchParams({
      keyword: projectId,
      bom: 'unconfigured',
      action: 'edit',
      projectId,
      tab: 'bom',
    })
    navigate(`/projects?${params.toString()}`)
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">成本异常中心</h1>
          <p className="text-sm text-gray-500 mt-1">ABC 核算异常台账</p>
        </div>
        <button
          type="button"
          onClick={() => loadExceptions()}
          disabled={loading}
          className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <AlertTriangle className="h-4 w-4 text-blue-500" />
            匹配异常
          </div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{stats.total}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            待处理
          </div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{stats.open}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            错误
          </div>
          <div className="text-2xl font-bold text-red-600 mt-1">{stats.error}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            警告
          </div>
          <div className="text-2xl font-bold text-amber-600 mt-1">{stats.warning}</div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div className="relative md:col-span-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4" />
            <input
              type="text"
              placeholder="异常编号、出库单、项目"
              value={filters.keyword}
              onChange={(e) => updateFilter('keyword', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') searchExceptions() }}
              className="w-full h-10 pl-10 pr-4 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>
          <input
            type="month"
            value={filters.yearMonth}
            onChange={(e) => updateFilter('yearMonth', e.target.value)}
            className="h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
          <select
            value={filters.status}
            onChange={(e) => updateFilter('status', e.target.value)}
            className="h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            <option value="">全部状态</option>
            <option value="open">待处理</option>
            <option value="resolved">已解决</option>
            <option value="ignored">已忽略</option>
          </select>
          <select
            value={filters.severity}
            onChange={(e) => updateFilter('severity', e.target.value)}
            className="h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            <option value="">全部级别</option>
            <option value="error">错误</option>
            <option value="warning">警告</option>
            <option value="info">提示</option>
          </select>
        </div>
        <div className="mt-3 flex items-center justify-end">
          {(filters.projectId || filters.exceptionType) && (
            <div className="mr-auto flex flex-wrap items-center gap-2 text-xs text-gray-600">
              {filters.projectId && (
                <span className="rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-blue-700">
                  项目筛选：{filters.projectId}
                </span>
              )}
              {filters.exceptionType && (
                <span className="rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 text-amber-700">
                  异常类型：{getExceptionTypeLabel(filters.exceptionType)}
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={searchExceptions}
            disabled={loading}
            className="h-9 px-4 text-sm text-white bg-[#3b82f6] rounded-md hover:bg-blue-600 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            <Search className="h-4 w-4" />
            查询
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">异常编号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">来源</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">内容</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">级别</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">重试</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-[260px]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">加载中...</td>
                </tr>
              ) : exceptions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">暂无成本异常</td>
                </tr>
              ) : (
                exceptions.map(item => {
                  const severity = SEVERITY_LABELS[item.severity] || SEVERITY_LABELS.info
                  const status = STATUS_LABELS[item.status] || STATUS_LABELS.open
                  return (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-gray-700">{item.exceptionNo}</td>
                      <td className="px-4 py-3 text-gray-700">{getExceptionTypeLabel(item.exceptionType)}</td>
                      <td className="px-4 py-3 text-gray-600">
                        <div>{item.outboundNo || item.sourceModule || '-'}</div>
                        <div className="text-xs text-gray-400">{item.projectName || item.bomName || item.yearMonth || '-'}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 max-w-md">
                        <div className="line-clamp-2">{item.message}</div>
                        <div className="mt-1 text-xs leading-5 text-gray-500">{getExceptionActionGuidance(item.exceptionType)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs ${severity.className}`}>{severity.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs ${status.className}`}>{status.label}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{item.retryCount || 0}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openAction('resolve', item)}
                            disabled={item.status !== 'open' || actionLoading}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 rounded transition-colors inline-flex items-center gap-1"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            解决
                          </button>
                          <button
                            type="button"
                            onClick={() => openAction('ignore', item)}
                            disabled={item.status !== 'open' || actionLoading}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-40 rounded transition-colors inline-flex items-center gap-1"
                          >
                            <EyeOff className="h-3.5 w-3.5" />
                            忽略
                          </button>
                          <button
                            type="button"
                            onClick={() => retryException(item)}
                            disabled={item.status !== 'open' || !item.outboundId || actionLoading}
                            title={!item.outboundId ? '该异常没有关联出库记录，不能自动重试' : undefined}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-40 rounded transition-colors inline-flex items-center gap-1"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            重试
                          </button>
                          {item.exceptionType === 'reconciliation_variance' && item.projectId && (
                            <button
                              type="button"
                              onClick={() => openSourceReconciliation(item.projectId as string)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-amber-700 hover:bg-amber-50 rounded transition-colors inline-flex items-center gap-1"
                            >
                              <FileSearch className="h-3.5 w-3.5" />
                              回到消耗对账
                            </button>
                          )}
                          {item.exceptionType === 'missing_fee_mapping' && (item.bomId || item.bomName) && (
                            <button
                              type="button"
                              onClick={() => openFeeMappingSource(item)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-purple-700 hover:bg-purple-50 rounded transition-colors inline-flex items-center gap-1"
                            >
                              <Settings2 className="h-3.5 w-3.5" />
                              配置收费映射
                            </button>
                          )}
                          {item.exceptionType === 'missing_bom' && item.projectId && (
                            <button
                              type="button"
                              onClick={() => openProjectBomSource(item.projectId as string)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-indigo-700 hover:bg-indigo-50 rounded transition-colors inline-flex items-center gap-1"
                            >
                              <Settings2 className="h-3.5 w-3.5" />
                              配置项目BOM
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {total > 0 && (
          <div className="border-t border-gray-100 px-4 py-3">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onChangePage={setPage}
              onChangePageSize={changePageSize}
            />
          </div>
        )}
      </div>

      {actionModal && (
        <Modal
          title={actionModal.type === 'resolve' ? '解决成本异常' : '忽略成本异常'}
          onClose={() => setActionModal(null)}
          size="sm"
        >
          <div className="space-y-4">
            <div>
              <div className="text-xs text-gray-500 mb-1">{actionModal.exception.exceptionNo}</div>
              <div className="text-sm text-gray-900">{actionModal.exception.message}</div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {actionModal.type === 'resolve' ? '处理说明' : '忽略原因'}
                <span className="text-red-500"> *</span>
              </label>
              <textarea
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3">
              <div className="text-sm font-semibold text-emerald-900">异常处理确认</div>
              <div className="mt-1 text-xs text-emerald-700">
                确认后将接住：异常台账、成本重算、成本看板、复核记录、审计记录
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-emerald-700">
                <div>异常编号 {actionModal.exception.exceptionNo}</div>
                <div>处理动作 {actionModal.type === 'resolve' ? '解决异常' : '忽略异常'}</div>
                <div>处理依据 {remark.trim() || '待填写'}</div>
              </div>
            </div>
            {actionValidationMessage ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                {actionValidationMessage}
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
            <button
              type="button"
              onClick={() => setActionModal(null)}
              className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submitAction}
              disabled={!canSubmitAction}
              className="h-10 px-4 text-sm text-white bg-[#3b82f6] rounded-md hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            >
              确认
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
