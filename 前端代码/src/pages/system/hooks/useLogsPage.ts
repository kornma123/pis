import { useState, useEffect, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { toast } from 'sonner'
import request from '@/api/request'
import type { OperationLog } from '@/types'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

export type LogActionType = 'login' | 'logout' | 'create' | 'update' | 'delete' | 'export' | 'import' | 'denied' | 'unknown'

export interface LogRecord extends OperationLog {
  actionType?: LogActionType
  module?: string
  outcome?: string | null
}

export interface LogExportForm {
  format: 'xlsx' | 'csv'
  includeBasic: boolean
  includeDetail: boolean
  includeIP: boolean
  includeDiff: boolean
}

type LogsExportResponse = {
  rows: LogRecord[]
  total: number
  maxRows: number
}

const DEFAULT_EXPORT_FORM: LogExportForm = {
  format: 'xlsx',
  includeBasic: true,
  includeDetail: true,
  includeIP: false,
  includeDiff: false,
}

function getExportErrorMessage(error: unknown) {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown
      response?: { data?: { error?: { message?: unknown } } }
    }
    const responseMessage = candidate.response?.data?.error?.message
    if (typeof responseMessage === 'string' && responseMessage.trim()) return responseMessage
    if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message
  }
  return '导出失败，请稍后重试'
}

function safeSpreadsheetText(value: string | null | undefined) {
  const text = value || ''
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text
}

export const LOG_TYPES = [
  { value: 'login', label: '登录', className: 'bg-blue-50 text-blue-500' },
  { value: 'logout', label: '登出', className: 'bg-gray-100 text-gray-500' },
  { value: 'create', label: '新增', className: 'bg-green-50 text-green-500' },
  { value: 'update', label: '修改', className: 'bg-yellow-50 text-yellow-600' },
  { value: 'delete', label: '删除', className: 'bg-red-50 text-red-500' },
  { value: 'export', label: '导出', className: 'bg-blue-50 text-blue-500' },
  { value: 'import', label: '导入', className: 'bg-orange-50 text-orange-500' },
  { value: 'denied', label: '已拒绝', className: 'bg-red-50 text-red-700' },
  { value: 'unknown', label: '未识别', className: 'bg-gray-100 text-gray-700' },
] satisfies { value: LogActionType; label: string; className: string }[]

export const MODULES = [
  { value: '', label: '全部模块' },
  { value: 'inventory', label: '库存管理' },
  { value: 'inbound', label: '入库管理' },
  { value: 'outbound', label: '出库管理' },
  { value: 'users', label: '用户管理' },
  { value: 'system', label: '系统设置' },
]

export function resolveLogType(op: string, actionType?: LogActionType) {
  const serverType = actionType && LOG_TYPES.find(type => type.value === actionType)
  if (serverType) return serverType

  const normalized = op.trim().toLowerCase()
  let inferred: LogActionType = 'unknown'
  if (/^(denied|denied_agg|security_alert)(\s|$)/.test(normalized)) inferred = 'denied'
  else if (/^login(\s|$)/.test(normalized)) inferred = 'login'
  else if (/^logout(\s|$)/.test(normalized)) inferred = 'logout'
  else if (/^(post|create|add)(\s|$)/.test(normalized) || /新增|创建/.test(normalized)) inferred = 'create'
  else if (/^(put|patch|update|edit)(\s|$)/.test(normalized) || /修改|更新/.test(normalized)) inferred = 'update'
  else if (/^(delete|remove)(\s|$)/.test(normalized) || /删除/.test(normalized)) inferred = 'delete'
  else if (/^export(\s|$)/.test(normalized) || /导出/.test(normalized)) inferred = 'export'
  else if (/^import(\s|$)/.test(normalized) || /导入/.test(normalized)) inferred = 'import'

  return LOG_TYPES.find(type => type.value === inferred)!
}

export function useLogsPage() {
  const { getNumber, setMultiple } = useUrlParams()

  const [typeFilter, setTypeFilterState] = useState('')
  const [moduleFilter, setModuleFilterState] = useState('')
  const [userFilter, setUserFilterState] = useState('')
  const [startDate, setStartDateState] = useState('')
  const [endDate, setEndDateState] = useState('')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

  const {
    data, loading, error, page, pageSize, total,
    setPage, setPageSize, refresh,
  } = usePagination<LogRecord>({
    fetchFn: async ({ page, pageSize }) => {
      const params: any = { page, pageSize }
      if (typeFilter) params.type = typeFilter
      if (moduleFilter) params.module = moduleFilter
      if (userFilter) params.username = userFilter
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate
      const res: any = await request.get('/logs', { params })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [typeFilter, moduleFilter, userFilter, startDate, endDate],
  })

  const setTypeFilter = (value: string) => { setTypeFilterState(value); setPage(1) }
  const setModuleFilter = (value: string) => { setModuleFilterState(value); setPage(1) }
  const setUserFilter = (value: string) => { setUserFilterState(value); setPage(1) }
  const setStartDate = (value: string) => { setStartDateState(value); setPage(1) }
  const setEndDate = (value: string) => { setEndDateState(value); setPage(1) }

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      type: typeFilter || null,
      module: moduleFilter || null,
      user: userFilter || null,
      startDate: startDate || null,
      endDate: endDate || null,
    })
  }, [page, pageSize, typeFilter, moduleFilter, userFilter, startDate, endDate, setMultiple])

  const [detailLog, setDetailLog] = useState<LogRecord | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [exportForm, setExportForm] = useState<LogExportForm>(DEFAULT_EXPORT_FORM)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    if (showExport) setExportError(null)
  }, [showExport])

  const stats = useMemo(() => {
    const pageOps = data.length
    const types = data.map(row => resolveLogType(row.operation, row.actionType).value)
    const loginCount = types.filter(type => type === 'login').length
    const dataChanges = types.filter(type => type === 'create' || type === 'update' || type === 'delete').length
    const activeUsers = new Set(data.map(row => row.username).filter(Boolean)).size
    return { pageOps, loginCount, dataChanges, activeUsers }
  }, [data])

  const handleSearch = () => { setPage(1) }
  const handleReset = () => {
    setTypeFilterState(''); setModuleFilterState(''); setUserFilterState('');
    setStartDateState(''); setEndDateState(''); setPage(1)
  }

  const openDetail = (row: LogRecord) => {
    setDetailLog(row)
    setShowDetail(true)
  }

  const getAvatarChar = (name: string) => name ? name.charAt(0) : '?'
  const getModuleLabel = (moduleVal: string) => {
    if (!moduleVal) return '未识别'
    return MODULES.find(m => m.value === moduleVal)?.label || moduleVal
  }

  const handleExport = async () => {
    if (exporting) return

    setExportError(null)
    const exportStartDate = startDate
    const exportEndDate = endDate
    if (exportStartDate && exportEndDate && exportStartDate > exportEndDate) {
      const message = '开始日期不能晚于结束日期'
      setExportError(message)
      toast.error(message)
      return
    }
    if (!exportForm.includeBasic && !exportForm.includeDetail && !exportForm.includeIP) {
      const message = '请至少选择一组可导出字段'
      setExportError(message)
      toast.error(message)
      return
    }

    setExporting(true)
    try {
      const params: Record<string, string> = {}
      if (typeFilter) params.type = typeFilter
      if (moduleFilter) params.module = moduleFilter
      if (userFilter) params.username = userFilter
      if (exportStartDate) params.startDate = exportStartDate
      if (exportEndDate) params.endDate = exportEndDate

      const response = await request.get<LogsExportResponse>('/logs/export', { params })
      if (!response || !Array.isArray(response.rows)) throw new Error('服务端返回了无效的导出结果')
      if (response.rows.length === 0) {
        const message = '当前筛选条件没有可导出的日志'
        setExportError(message)
        toast.warning(message)
        return
      }

      const exportRows = response.rows.map((log) => {
        const row: Record<string, string> = {}
        if (exportForm.includeBasic) {
          row['操作时间'] = safeSpreadsheetText(log.createdAt)
          row['操作用户'] = safeSpreadsheetText(log.username)
          row['操作类型'] = safeSpreadsheetText(resolveLogType(log.operation, log.actionType).label)
          row['操作模块'] = safeSpreadsheetText(getModuleLabel(log.module || ''))
        }
        if (exportForm.includeDetail) {
          row['操作内容'] = safeSpreadsheetText(log.description)
          row['原始动作'] = safeSpreadsheetText(log.operation)
          row['执行结果'] = safeSpreadsheetText(log.outcome || (log.actionType === 'denied' ? 'denied' : '未记录'))
        }
        if (exportForm.includeIP) {
          row['IP地址'] = safeSpreadsheetText(log.ip)
          row['设备信息'] = safeSpreadsheetText(log.userAgent)
        }
        return row
      })

      const worksheet = XLSX.utils.json_to_sheet(exportRows)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, '操作日志')
      const today = new Date().toISOString().slice(0, 10)
      const rangeLabel = `${exportStartDate || '全部'}_${exportEndDate || today}`
      XLSX.writeFile(workbook, `操作日志_${rangeLabel}.${exportForm.format}`, {
        bookType: exportForm.format,
        compression: true,
      })
      toast.success(`已导出 ${response.rows.length} 条日志`)
      setShowExport(false)
    } catch (error) {
      const message = getExportErrorMessage(error)
      setExportError(message)
      toast.error(message)
    } finally {
      setExporting(false)
    }
  }

  return {
    data, loading, error, page, pageSize, total, setPage, setPageSize, refresh,
    typeFilter, setTypeFilter,
    moduleFilter, setModuleFilter, userFilter, setUserFilter,
    startDate, setStartDate, endDate, setEndDate,
    detailLog, setDetailLog,
    showDetail, setShowDetail,
    showExport, setShowExport,
    exportForm, setExportForm, exporting, exportError, handleExport,
    stats,
    handleSearch, handleReset,
    openDetail,
    getLogType: resolveLogType, getAvatarChar, getModuleLabel,
  }
}
