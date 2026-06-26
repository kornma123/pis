import React, { useState, useEffect } from 'react'
import { Search, Filter, ChevronLeft, ChevronRight, Eye, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { Modal } from '@/components/ui/Modal'

interface AuditLog {
  id: string
  module?: string
  action: string
  targetType?: string
  targetId?: string
  detail?: string
  oldValue?: string
  newValue?: string
  reason?: string
  operator: string
  createdAt: string
}

const ACTION_LABELS: Record<string, string> = {
  create: '创建',
  update: '更新',
  delete: '删除',
  calculate: '计算',
  export: '导出',
  import: '导入',
  sync: '同步',
  recalculate: '重算',
  auto_collect: '自动归集',
  start_collection: '开始归集',
  close: '关账',
  approve: '审核通过',
  reject: '驳回',
  audit: '审计检查',
}

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-green-100 text-green-700',
  update: 'bg-blue-100 text-blue-700',
  delete: 'bg-red-100 text-red-700',
  calculate: 'bg-purple-100 text-purple-700',
  export: 'bg-cyan-100 text-cyan-700',
  import: 'bg-amber-100 text-amber-700',
  sync: 'bg-indigo-100 text-indigo-700',
  recalculate: 'bg-orange-100 text-orange-700',
  auto_collect: 'bg-indigo-100 text-indigo-700',
  start_collection: 'bg-indigo-100 text-indigo-700',
  close: 'bg-slate-100 text-slate-700',
  approve: 'bg-emerald-100 text-emerald-700',
  reject: 'bg-red-100 text-red-700',
  audit: 'bg-violet-100 text-violet-700',
}

const TARGET_TYPE_LABELS: Record<string, string> = {
  cost_pool: '成本池',
  budget: '预算',
  quality_cost: '质量成本',
  alert_rule: '预警规则',
  fee_standard: '收费标准',
  bom: 'BOM',
  activity_center: '作业中心',
  period: '成本期间',
  cost_adjustment: '关账后调整单',
  exception: '成本异常',
  cost_run: '成本任务',
  export: '导出',
  bom_fee_mapping: 'BOM收费映射',
}

const TARGET_TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'cost_pool', label: '成本池' },
  { value: 'budget', label: '预算' },
  { value: 'quality_cost', label: '质量成本' },
  { value: 'alert_rule', label: '预警规则' },
  { value: 'fee_standard', label: '收费标准' },
  { value: 'bom', label: 'BOM' },
  { value: 'activity_center', label: '作业中心' },
  { value: 'period', label: '成本期间' },
  { value: 'cost_adjustment', label: '关账后调整单' },
  { value: 'exception', label: '成本异常' },
  { value: 'cost_run', label: '成本任务' },
  { value: 'export', label: '导出' },
  { value: 'bom_fee_mapping', label: 'BOM收费映射' },
]

const ACTION_OPTIONS = [
  { value: '', label: '全部操作' },
  { value: 'create', label: '创建' },
  { value: 'update', label: '更新' },
  { value: 'delete', label: '删除' },
  { value: 'calculate', label: '计算' },
  { value: 'export', label: '导出' },
  { value: 'sync', label: '同步' },
  { value: 'recalculate', label: '重算' },
  { value: 'auto_collect', label: '自动归集' },
  { value: 'start_collection', label: '开始归集' },
  { value: 'close', label: '关账' },
  { value: 'approve', label: '审核通过' },
  { value: 'reject', label: '驳回' },
  { value: 'audit', label: '审计检查' },
]

const listPayload = <T,>(data: any): T[] => data?.list || data?.items || data?.data?.list || data?.data?.items || []

export function getAuditTargetType(log: Pick<AuditLog, 'targetType' | 'module'>) {
  return log.targetType || log.module || ''
}

export function getAuditReason(log: Pick<AuditLog, 'reason' | 'detail'>) {
  if (log.reason) return log.reason
  if (!log.detail) return ''
  try {
    const detail = JSON.parse(log.detail)
    return detail.reason || detail.remark || detail.adjustmentNo || detail.exceptionNo || ''
  } catch {
    return ''
  }
}

function parseAuditDetail(detail?: string) {
  if (!detail) return null
  try {
    const parsed = JSON.parse(detail)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

export function getAuditReviewKeyword(log: Pick<AuditLog, 'targetId' | 'detail'>) {
  const detail = parseAuditDetail(log.detail)
  return stringValue(detail?.adjustmentNo)
    || stringValue(detail?.exceptionNo)
    || stringValue(detail?.runNo)
    || stringValue(detail?.runId)
    || stringValue(detail?.costRunId)
    || stringValue(log.targetId)
}

export function buildAuditBusinessReviewLink(log: Pick<AuditLog, 'targetType' | 'module' | 'targetId' | 'detail'>) {
  const targetType = getAuditTargetType(log)
  const detail = parseAuditDetail(log.detail)
  const keyword = getAuditReviewKeyword(log)
  if (!keyword) return ''

  if (targetType === 'exception') {
    const params = new URLSearchParams()
    params.set('keyword', keyword)
    return `/abc/alerts?${params.toString()}`
  }

  if (targetType === 'cost_adjustment' || targetType === 'cost_run' || targetType === 'period') {
    const params = new URLSearchParams()
    const yearMonth = stringValue(detail?.yearMonth)
    if (yearMonth) params.set('month', yearMonth)
    params.set('keyword', keyword)
    return `/abc/dashboard?${params.toString()}`
  }

  if (targetType === 'cost_pool') return `/abc/cost-pools?keyword=${encodeURIComponent(keyword)}`
  if (targetType === 'bom_fee_mapping') return `/abc/fee-mappings?keyword=${encodeURIComponent(keyword)}`
  return ''
}

export default function AuditTrail() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [filterAction, setFilterAction] = useState('')
  const [filterTargetType, setFilterTargetType] = useState('')
  const [filterStartDate, setFilterStartDate] = useState('')
  const [filterEndDate, setFilterEndDate] = useState('')
  const [filterKeyword, setFilterKeyword] = useState(() => new URLSearchParams(window.location.search).get('keyword')?.trim() || '')
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null)

  useEffect(() => {
    loadLogs()
  }, [page, filterAction, filterTargetType, filterStartDate, filterEndDate, filterKeyword])

  const loadLogs = async () => {
    try {
      setLoading(true)
      const params: Record<string, string | number> = { page, pageSize }
      if (filterAction) params.action = filterAction
      if (filterTargetType) params.targetType = filterTargetType
      if (filterStartDate) params.startDate = filterStartDate
      if (filterEndDate) params.endDate = filterEndDate
      if (filterKeyword.trim()) params.keyword = filterKeyword.trim()
      const data = await abcApi.getAuditLogs(params)
      const nextLogs = listPayload<AuditLog>(data)
      setLogs(nextLogs)
      setTotal(Number(data?.pagination?.total ?? data?.total ?? data?.data?.pagination?.total ?? data?.data?.total ?? nextLogs.length) || 0)
    } catch {
      toast.error('加载审计日志失败')
    } finally {
      setLoading(false)
    }
  }

  const handleClearFilters = () => {
    setFilterAction('')
    setFilterTargetType('')
    setFilterStartDate('')
    setFilterEndDate('')
    setFilterKeyword('')
    setPage(1)
  }

  const totalPages = Math.ceil(total / pageSize)

  const formatDateTime = (value: string) => {
    if (!value) return '-'
    const d = new Date(value)
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }

  const tryParseJson = (str?: string) => {
    if (!str) return null
    try {
      return JSON.parse(str)
    } catch {
      return null
    }
  }

  const renderJsonDetail = (label: string, jsonStr?: string) => {
    const parsed = tryParseJson(jsonStr)
    if (!parsed) return null
    return (
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-2">{label}</h4>
        <div className="bg-gray-50 rounded-md p-3 overflow-x-auto">
          <pre className="text-xs text-gray-600 whitespace-pre-wrap">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">审计追踪</h1>
        <p className="text-sm text-gray-500 mt-1">成本相关操作的完整审计日志</p>
      </div>

      {/* 筛选栏 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">筛选条件</span>
          {(filterAction || filterTargetType || filterStartDate || filterEndDate || filterKeyword) && (
            <button
              onClick={handleClearFilters}
              className="ml-auto text-sm text-blue-600 hover:text-blue-800 transition-colors"
            >
              清除筛选
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={filterKeyword}
              onChange={(e) => { setFilterKeyword(e.target.value); setPage(1) }}
              placeholder="调整单号/异常号/任务号"
              className="h-10 w-full rounded-md border border-gray-200 pl-9 pr-3 text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>
          <select
            value={filterAction}
            onChange={(e) => { setFilterAction(e.target.value); setPage(1) }}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {ACTION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            value={filterTargetType}
            onChange={(e) => { setFilterTargetType(e.target.value); setPage(1) }}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {TARGET_TYPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <input
            type="date"
            value={filterStartDate}
            onChange={(e) => { setFilterStartDate(e.target.value); setPage(1) }}
            placeholder="开始日期"
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
          <input
            type="date"
            value={filterEndDate}
            onChange={(e) => { setFilterEndDate(e.target.value); setPage(1) }}
            placeholder="结束日期"
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
        </div>
        {filterKeyword.trim() ? (
          <div className="mt-3 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            当前按关键字检索：{filterKeyword.trim()}
          </div>
        ) : null}
      </div>

      {/* 审计日志表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作类型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">目标类型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作人</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">原因</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">详情</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  {filterKeyword.trim() ? (
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">
                        未找到 {filterKeyword.trim()} 的成本审计证据
                      </div>
                      <div className="mx-auto max-w-xl text-sm text-gray-500">
                        请确认调整单号、异常号或任务号是否正确；也可以返回成本看板或异常中心确认该业务动作是否已经生成审计记录。
                      </div>
                    </div>
                  ) : (
                    <span className="text-gray-400">暂无审计日志</span>
                  )}
                </td>
              </tr>
            ) : (
              logs.map(log => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs ${ACTION_COLORS[log.action] || 'bg-gray-100 text-gray-700'}`}>
                      {ACTION_LABELS[log.action] || log.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {TARGET_TYPE_LABELS[getAuditTargetType(log)] || getAuditTargetType(log) || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{log.operator || '-'}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3 text-gray-400" />
                      {formatDateTime(log.createdAt)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">{getAuditReason(log) || '-'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedLog(log)}
                      className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                      title="查看详情"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">
            共 {total} 条记录，第 {page}/{totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              上一页
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              下一页
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 日志详情弹窗 */}
      {selectedLog && (
        <Modal onClose={() => setSelectedLog(null)} title="审计日志详情">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-gray-500">操作类型</span>
                <div className="mt-1">
                  <span className={`px-2 py-1 rounded-full text-xs ${ACTION_COLORS[selectedLog.action] || 'bg-gray-100 text-gray-700'}`}>
                    {ACTION_LABELS[selectedLog.action] || selectedLog.action}
                  </span>
                </div>
              </div>
              <div>
                <span className="text-xs text-gray-500">目标类型</span>
                <div className="mt-1 text-sm text-gray-900">
                  {TARGET_TYPE_LABELS[getAuditTargetType(selectedLog)] || getAuditTargetType(selectedLog) || '-'}
                </div>
              </div>
              <div>
                <span className="text-xs text-gray-500">操作人</span>
                <div className="mt-1 text-sm text-gray-900">{selectedLog.operator || '-'}</div>
              </div>
              <div>
                <span className="text-xs text-gray-500">时间</span>
                <div className="mt-1 text-sm text-gray-900">{formatDateTime(selectedLog.createdAt)}</div>
              </div>
              <div>
                <span className="text-xs text-gray-500">目标ID</span>
                <div className="mt-1 text-sm text-gray-500 font-mono break-all">{selectedLog.targetId || '-'}</div>
              </div>
              <div>
                <span className="text-xs text-gray-500">原因</span>
                <div className="mt-1 text-sm text-gray-900">{getAuditReason(selectedLog) || '-'}</div>
              </div>
            </div>

            <AuditReviewLinks log={selectedLog} />

            {renderJsonDetail('变更前数据', selectedLog.oldValue)}
            {renderJsonDetail('变更后数据', selectedLog.newValue)}
            {renderJsonDetail('审计详情', selectedLog.detail)}
          </div>
          <div className="flex items-center justify-end mt-6 pt-4 border-t border-gray-200">
            <button
              onClick={() => setSelectedLog(null)}
              className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              关闭
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function AuditReviewLinks({ log }: { log: AuditLog }) {
  const keyword = getAuditReviewKeyword(log)
  if (!keyword) return null

  const businessLink = buildAuditBusinessReviewLink(log)
  const auditLink = `/abc/audit?keyword=${encodeURIComponent(keyword)}`

  return (
    <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-3">
      <div className="text-sm font-semibold text-blue-950">审计证据回看</div>
      <div className="mt-1 text-sm text-blue-800">
        先回成本业务页面核对原始事实，再用同一业务标识继续查看审计日志。
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {businessLink && (
          <a
            href={businessLink}
            className="inline-flex h-8 items-center rounded-md border border-blue-200 bg-white px-3 text-xs font-medium text-blue-700 hover:bg-blue-50"
          >
            回到成本业务页面
          </a>
        )}
        <a
          href={auditLink}
          className="inline-flex h-8 items-center rounded-md border border-blue-200 bg-white px-3 text-xs font-medium text-blue-700 hover:bg-blue-50"
        >
          查看同一标识审计日志
        </a>
      </div>
    </div>
  )
}
