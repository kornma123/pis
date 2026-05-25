import { useState, useEffect, useMemo } from 'react'
import { Download, X, Search } from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import request from '@/api/request'
import type { OperationLog } from '@/types'
import { toast } from 'sonner'

interface LogFormData {
  startDate: string
  endDate: string
  format: 'xlsx' | 'csv'
  includeBasic: boolean
  includeDetail: boolean
  includeIP: boolean
  includeDiff: boolean
}

const LOG_TYPES = [
  { value: 'login', label: '登录', className: 'bg-[#eff6ff] text-[#3b82f6]' },
  { value: 'logout', label: '登出', className: 'bg-[#f3f4f6] text-gray-500' },
  { value: 'create', label: '新增', className: 'bg-[#f0fdf4] text-[#22c55e]' },
  { value: 'update', label: '修改', className: 'bg-[#fefce8] text-[#ca8a04]' },
  { value: 'delete', label: '删除', className: 'bg-[#fef2f2] text-[#dc2626]' },
  { value: 'export', label: '导出', className: 'bg-[#eff6ff] text-[#3b82f6]' },
  { value: 'import', label: '导入', className: 'bg-[#fff7ed] text-[#ea580c]' },
]

const MODULES = [
  { value: '', label: '全部模块' },
  { value: 'inventory', label: '库存管理' },
  { value: 'inbound', label: '入库管理' },
  { value: 'outbound', label: '出库管理' },
  { value: 'user', label: '用户管理' },
  { value: 'system', label: '系统设置' },
]

const USERS = [
  { value: '', label: '全部用户' },
  { value: 'admin', label: 'admin' },
  { value: 'zhangsan', label: 'zhangsan' },
  { value: 'lisi', label: 'lisi' },
]

export default function Logs() {
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
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
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
    startDate: '',
    endDate: '',
    format: 'xlsx',
    includeBasic: true,
    includeDetail: true,
    includeIP: false,
    includeDiff: false,
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
    setKeyword('')
    setTypeFilter('')
    setModuleFilter('')
    setUserFilter('')
    setStartDate('')
    setEndDate('')
    setPage(1)
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
      const params = {
        startDate: exportForm.startDate,
        endDate: exportForm.endDate,
        format: exportForm.format,
      }
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
    } catch (e) {
      toast.error('导出失败')
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">操作日志</h1>
          <p className="text-sm text-gray-500 mt-1">查看系统操作记录，追踪用户行为</p>
        </div>
        <button onClick={() => setShowExport(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium shadow-sm transition-all">
          <Download className="w-4 h-4" /> 导出日志
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200 transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">{stats.todayOps}</div>
          <div className="text-[13px] text-gray-500 mt-1">今日操作</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200 transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#3b82f6] leading-tight tracking-tight">{stats.loginCount}</div>
          <div className="text-[13px] text-gray-500 mt-1">登录次数</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200 transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#ca8a04] leading-tight tracking-tight">{stats.dataChanges}</div>
          <div className="text-[13px] text-gray-500 mt-1">数据变更</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200 transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#22c55e] leading-tight tracking-tight">{stats.activeUsers}</div>
          <div className="text-[13px] text-gray-500 mt-1">活跃用户</div>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between flex-wrap gap-3">
          <span className="text-base font-semibold text-gray-900">操作记录</span>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
            >
              <option value="">全部操作类型</option>
              {LOG_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <select
              value={moduleFilter}
              onChange={e => setModuleFilter(e.target.value)}
              className="h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
            >
              {MODULES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <select
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              className="h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
            >
              {USERS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="h-10 px-3 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
            <span className="text-gray-500">至</span>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="h-10 px-3 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
            <button onClick={handleSearch} className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">查询</button>
            <button onClick={handleReset} className="h-10 px-4 text-sm font-medium text-gray-700 bg-transparent hover:bg-gray-100 rounded-md transition-all">重置</button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['操作时间', '操作用户', '操作类型', '操作模块', '操作内容', 'IP地址', '操作'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e5e7eb]">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[#9ca3af]">加载中...</td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[#9ca3af]">暂无日志数据</td></tr>
              ) : data.map(row => {
                const logType = getLogType(row.operation)
                return (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3.5 font-mono text-[13px] text-gray-700">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-[#eff6ff] rounded-full flex items-center justify-center text-[#3b82f6] text-xs font-medium">
                          {getAvatarChar(row.username)}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-gray-900">{row.username}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${logType.className}`}>
                        {logType.label}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="text-xs px-2.5 py-1 rounded-full bg-[#f3f4f6] text-gray-700 font-medium">{getModuleLabel(row.requestData?.module as string || '')}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="text-sm text-gray-900">{row.description}</div>
                      {row.requestData && (
                        <div className="text-xs text-gray-500 mt-0.5">{JSON.stringify(row.requestData).slice(0, 60)}...</div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-[13px] text-gray-500">{row.ip}</td>
                    <td className="px-4 py-3.5">
                      <button onClick={() => openDetail(row)} className="h-8 px-3 text-[13px] text-gray-700 hover:bg-gray-100 rounded-md transition-colors">详情</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200 bg-gray-50">
          <span className="text-sm text-gray-500">共 {total} 条记录</span>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChangePage={setPage}
            onChangePageSize={setPageSize}
          />
        </div>
      </div>

      {/* Detail Modal */}
      {showDetail && detailLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.6)]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">操作详情</h3>
              <button onClick={() => setShowDetail(false)} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="grid grid-cols-2 gap-5 mb-6">
                <div>
                  <div className="text-xs text-gray-500 mb-1">操作时间</div>
                  <div className="text-[15px] font-semibold text-gray-900 font-mono">{new Date(detailLog.createdAt).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">操作类型</div>
                  <div className="text-[15px] font-semibold text-gray-900">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getLogType(detailLog.operation).className}`}>
                      {getLogType(detailLog.operation).label}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">操作用户</div>
                  <div className="text-[15px] font-semibold text-gray-900">{detailLog.username}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">操作模块</div>
                  <div className="text-[15px] font-semibold text-gray-900">{getModuleLabel(detailLog.requestData?.module as string || '')}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">IP地址</div>
                  <div className="text-[15px] font-semibold text-gray-900 font-mono">{detailLog.ip}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">浏览器</div>
                  <div className="text-[15px] font-semibold text-gray-900">{detailLog.userAgent || '-'}</div>
                </div>
              </div>

              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">操作内容</h4>
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-sm text-gray-900 mb-1">{detailLog.description}</div>
                  {detailLog.requestData && (
                    <div className="text-[13px] text-gray-500">{JSON.stringify(detailLog.requestData)}</div>
                  )}
                </div>
              </div>

              {detailLog.requestData && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 mb-3">变更详情</h4>
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-4 py-2 text-xs text-gray-500 border-b border-gray-200">请求数据</div>
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-[#e5e7eb]">
                        {Object.entries(detailLog.requestData).map(([key, value]) => (
                          <tr key={key}>
                            <td className="px-4 py-2.5 w-[140px] bg-gray-50 font-medium text-gray-700">{key}</td>
                            <td className="px-4 py-2.5 text-gray-900">{String(value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button onClick={() => setShowDetail(false)} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {showExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.6)]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">导出日志</h3>
              <button onClick={() => setShowExport(false)} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="mb-5">
                <label className="block text-[13px] font-medium text-gray-700 mb-1.5">导出时间范围</label>
                <div className="flex items-center gap-3">
                  <input
                    type="date"
                    value={exportForm.startDate}
                    onChange={e => setExportForm({ ...exportForm, startDate: e.target.value })}
                    className="flex-1 h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
                  />
                  <span className="text-gray-500">至</span>
                  <input
                    type="date"
                    value={exportForm.endDate}
                    onChange={e => setExportForm({ ...exportForm, endDate: e.target.value })}
                    className="flex-1 h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
                  />
                </div>
              </div>

              <div className="mb-5">
                <label className="block text-[13px] font-medium text-gray-700 mb-2">导出格式</label>
                <div className="flex gap-3">
                  <label
                    onClick={() => setExportForm({ ...exportForm, format: 'xlsx' })}
                    className={`flex-1 flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all ${exportForm.format === 'xlsx' ? 'border-[#3b82f6] bg-[#eff6ff]' : 'border-gray-200'}`}
                  >
                    <input type="radio" checked={exportForm.format === 'xlsx'} readOnly className="text-[#3b82f6]" />
                    <span className="text-sm text-gray-900">Excel (.xlsx)</span>
                  </label>
                  <label
                    onClick={() => setExportForm({ ...exportForm, format: 'csv' })}
                    className={`flex-1 flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all ${exportForm.format === 'csv' ? 'border-[#3b82f6] bg-[#eff6ff]' : 'border-gray-200'}`}
                  >
                    <input type="radio" checked={exportForm.format === 'csv'} readOnly className="text-[#3b82f6]" />
                    <span className="text-sm text-gray-900">CSV (.csv)</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-2">导出内容</label>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                    <input type="checkbox" checked={exportForm.includeBasic} onChange={e => setExportForm({ ...exportForm, includeBasic: e.target.checked })} className="rounded border-gray-300 text-[#3b82f6] focus:ring-blue-500 w-4 h-4" />
                    基本信息（时间、用户、类型、模块）
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                    <input type="checkbox" checked={exportForm.includeDetail} onChange={e => setExportForm({ ...exportForm, includeDetail: e.target.checked })} className="rounded border-gray-300 text-[#3b82f6] focus:ring-blue-500 w-4 h-4" />
                    操作详情
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                    <input type="checkbox" checked={exportForm.includeIP} onChange={e => setExportForm({ ...exportForm, includeIP: e.target.checked })} className="rounded border-gray-300 text-[#3b82f6] focus:ring-blue-500 w-4 h-4" />
                    IP地址和设备信息
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                    <input type="checkbox" checked={exportForm.includeDiff} onChange={e => setExportForm({ ...exportForm, includeDiff: e.target.checked })} className="rounded border-gray-300 text-[#3b82f6] focus:ring-blue-500 w-4 h-4" />
                    变更前后数据对比
                  </label>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button onClick={() => setShowExport(false)} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">取消</button>
              <button onClick={handleExport} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 shadow-sm transition-all">导出</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
