import { useState, useEffect, useMemo } from 'react'
import request from '@/api/request'
import type { OperationLog } from '@/types'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

export interface LogFormData {
  startDate: string
  endDate: string
  format: 'xlsx' | 'csv'
  includeBasic: boolean
  includeDetail: boolean
  includeIP: boolean
  includeDiff: boolean
}

export const LOG_TYPES = [
  { value: 'login', label: '登录', className: 'bg-blue-50 text-blue-500' },
  { value: 'logout', label: '登出', className: 'bg-gray-100 text-gray-500' },
  { value: 'create', label: '新增', className: 'bg-green-50 text-green-500' },
  { value: 'update', label: '修改', className: 'bg-yellow-50 text-yellow-600' },
  { value: 'delete', label: '删除', className: 'bg-red-50 text-red-500' },
  { value: 'export', label: '导出', className: 'bg-blue-50 text-blue-500' },
  { value: 'import', label: '导入', className: 'bg-orange-50 text-orange-500' },
]

export const MODULES = [
  { value: '', label: '全部模块' },
  { value: 'inventory', label: '库存管理' },
  { value: 'inbound', label: '入库管理' },
  { value: 'outbound', label: '出库管理' },
  { value: 'user', label: '用户管理' },
  { value: 'system', label: '系统设置' },
]

export const USERS = [
  { value: '', label: '全部用户' },
  { value: 'admin', label: 'admin' },
  { value: 'zhangsan', label: 'zhangsan' },
  { value: 'lisi', label: 'lisi' },
]

export function useLogsPage() {
  const { get, getNumber, setMultiple } = useUrlParams()

  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [moduleFilter, setModuleFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

  const {
    data, loading, page, pageSize, total,
    setPage, setPageSize,
  } = usePagination<OperationLog>({
    fetchFn: async ({ page, pageSize }) => {
      const params: any = { page, pageSize }
      if (keyword) params.keyword = keyword
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
    deps: [keyword, typeFilter, moduleFilter, userFilter, startDate, endDate],
  })

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
      type: typeFilter || null,
      module: moduleFilter || null,
      user: userFilter || null,
      startDate: startDate || null,
      endDate: endDate || null,
    })
  }, [page, pageSize, keyword, typeFilter, moduleFilter, userFilter, startDate, endDate, setMultiple])

  const [detailLog, setDetailLog] = useState<OperationLog | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [showExport, setShowExport] = useState(false)

  const [exportForm, setExportForm] = useState<LogFormData>({
    startDate: '', endDate: '', format: 'xlsx',
    includeBasic: true, includeDetail: true, includeIP: false, includeDiff: false,
  })

  const stats = useMemo(() => {
    const todayOps = data.length
    const loginCount = data.filter(d => d.operation.toLowerCase().includes('login')).length
    const dataChanges = data.filter(d =>
      d.operation.toLowerCase().includes('create') ||
      d.operation.toLowerCase().includes('update') ||
      d.operation.toLowerCase().includes('delete')
    ).length
    const activeUsers = new Set(data.map(d => d.username)).size
    return { todayOps, loginCount, dataChanges, activeUsers }
  }, [data])

  const handleSearch = () => { setPage(1) }
  const handleReset = () => {
    setKeyword(''); setTypeFilter(''); setModuleFilter(''); setUserFilter('');
    setStartDate(''); setEndDate(''); setPage(1)
  }

  const openDetail = (row: OperationLog) => {
    setDetailLog(row)
    setShowDetail(true)
  }

  const getLogType = (op: string) => {
    const lower = op.toLowerCase()
    if (lower.includes('login')) return LOG_TYPES[0]
    if (lower.includes('logout')) return LOG_TYPES[1]
    if (lower.includes('create') || lower.includes('add')) return LOG_TYPES[2]
    if (lower.includes('update') || lower.includes('edit')) return LOG_TYPES[3]
    if (lower.includes('delete') || lower.includes('remove')) return LOG_TYPES[4]
    if (lower.includes('export')) return LOG_TYPES[5]
    if (lower.includes('import')) return LOG_TYPES[6]
    return LOG_TYPES[0]
  }

  const getAvatarChar = (name: string) => name ? name.charAt(0) : '?'
  const getModuleLabel = (moduleVal: string) => MODULES.find(m => m.value === moduleVal)?.label || moduleVal || '系统'

  const handleExport = async () => {
    try {
      const params = { startDate: exportForm.startDate, endDate: exportForm.endDate, format: exportForm.format }
      const res: any = await request.get('/logs/export', { params, responseType: 'blob' })
      const blob = new Blob([res])
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `操作日志_${exportForm.startDate}_${exportForm.endDate}.${exportForm.format}`
      a.click()
      window.URL.revokeObjectURL(url)
      toast.success('导出成功')
      setShowExport(false)
    } catch (e) { toast.error('导出失败') }
  }

  return {
    data, loading, page, pageSize, total, setPage, setPageSize,
    keyword, setKeyword, typeFilter, setTypeFilter,
    moduleFilter, setModuleFilter, userFilter, setUserFilter,
    startDate, setStartDate, endDate, setEndDate,
    detailLog, setDetailLog,
    showDetail, setShowDetail,
    showExport, setShowExport,
    exportForm, setExportForm,
    stats,
    handleSearch, handleReset,
    openDetail,
    getLogType, getAvatarChar, getModuleLabel,
    handleExport,
  }
}
