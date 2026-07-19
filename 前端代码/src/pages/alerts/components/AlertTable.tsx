import { Search, RotateCcw, Clock, Eye, BellOff, RefreshCw } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import type { AlertItem, AlertTypeFilter, AlertStatusFilter } from '../hooks/useAlertsPage'

interface Props {
  data: AlertItem[]
  loading: boolean
  error?: string | null
  generating?: boolean
  total: number
  page: number
  pageSize: number
  filter: { keyword: string; type: AlertTypeFilter; status: AlertStatusFilter; dateRange: [string, string] }
  quickFilter: AlertStatusFilter
  selectedIds: Set<string>
  onFilterChange: (filter: { keyword: string; type: AlertTypeFilter; status: AlertStatusFilter; dateRange: [string, string] }) => void
  onQuickFilterChange: (value: AlertStatusFilter) => void
  onSelect: (id: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onBatchProcess: () => void
  onOpenModal: (type: 'handle' | 'detail', alert: AlertItem) => void
  onIgnore: (id: string) => void
  onGenerate: () => void
  onRetry?: () => void
  hasActiveFilters: boolean
  getAlertTypeInfo: (type: string) => { label: string; bg: string; text: string }
  getStatusInfo: (status: string) => { label: string; bg: string; text: string }
  formatDate: (date: string) => string
}

const QUICK_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'processed', label: '已处理' },
  { key: 'ignored', label: '已忽略' },
] as const

export function AlertTable({
  data, loading, error = null, generating = false, total, page, pageSize,
  filter, quickFilter, onFilterChange, onQuickFilterChange,
  onPageChange, onPageSizeChange, onOpenModal, onGenerate, onRetry, hasActiveFilters,
  getAlertTypeInfo, getStatusInfo, formatDate,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="快速筛选">
        {QUICK_FILTERS.map(item => (
          <button
            key={item.key}
            aria-pressed={quickFilter === item.key}
            onClick={() => onQuickFilterChange(item.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all h-10 ${quickFilter === item.key ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_auto_auto_auto_auto] gap-3">
          <div className="relative min-w-0">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              aria-label="搜索预警"
              type="search"
              placeholder="搜索预警编号或物料..."
              value={filter.keyword}
              onChange={event => onFilterChange({ ...filter, keyword: event.target.value })}
              onKeyDown={event => { if (event.key === 'Enter') onPageChange(1) }}
              className="w-full h-10 pl-9 pr-4 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <select aria-label="预警类型" value={filter.type} onChange={event => onFilterChange({ ...filter, type: event.target.value as AlertTypeFilter })} className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10">
            <option value="all">全部类型</option>
            <option value="low-stock">库存不足</option>
            <option value="expiry">即将过期</option>
          </select>
          <select aria-label="预警状态" value={filter.status} onChange={event => onFilterChange({ ...filter, status: event.target.value as AlertStatusFilter })} className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10">
            <option value="all">全部状态</option>
            <option value="pending">待处理</option>
            <option value="processed">已处理</option>
            <option value="ignored">已忽略</option>
          </select>
          <div className="flex items-center gap-2">
            <input aria-label="开始日期" type="date" value={filter.dateRange[0]} onChange={event => onFilterChange({ ...filter, dateRange: [event.target.value, filter.dateRange[1]] })} className="min-w-0 h-10 px-2 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500" />
            <span aria-hidden="true" className="text-gray-400">–</span>
            <input aria-label="结束日期" type="date" value={filter.dateRange[1]} onChange={event => onFilterChange({ ...filter, dateRange: [filter.dateRange[0], event.target.value] })} className="min-w-0 h-10 px-2 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => onPageChange(1)} className="inline-flex items-center gap-1.5 h-10 px-4 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 shadow-sm"><Search className="w-4 h-4" />查询</button>
            <button onClick={() => { onFilterChange({ keyword: '', type: 'all', status: 'all', dateRange: ['', ''] }); onQuickFilterChange('all'); onPageChange(1) }} className="inline-flex items-center gap-1.5 h-10 px-4 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50"><RotateCcw className="w-4 h-4" />重置</button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900">预警列表</h2>
          <span className="text-xs text-gray-500">{error ? '记录数未连接' : `共 ${total} 条记录`}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['预警编号', '预警类型', '物料信息', '触发条件', '来源规则', '预警时间', '状态', '操作'].map(heading => <th key={heading} scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">{heading}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-500"><span className="inline-flex items-center gap-2"><Clock className="w-5 h-5 animate-spin" />正在加载预警...</span></td></tr>
              ) : error ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center"><div role="alert" className="inline-flex flex-col items-center gap-3 text-sm text-red-700"><span>{error}</span>{onRetry && <button onClick={onRetry} className="h-9 px-3 rounded-md border border-red-200 bg-white hover:bg-red-50">重新加载</button>}</div></td></tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16">
                    <div className="flex flex-col items-center justify-center gap-3 text-center">
                      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-gray-100"><BellOff className="w-6 h-6 text-gray-400" /></div>
                      {hasActiveFilters ? <><p className="text-sm font-medium text-gray-700">没有符合筛选条件的已记录预警</p><p className="text-xs text-gray-500">调整或重置筛选条件后重试</p></> : <><p className="text-sm font-medium text-gray-700">当前没有已记录的预警</p><p className="text-xs text-gray-500 max-w-sm">这只表示列表为空；自动生成与推送未连接。可明确发起一次手动生成。</p><button disabled={generating} onClick={onGenerate} className="mt-1 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-60 h-10"><RefreshCw className={`w-4 h-4 ${generating ? 'animate-spin' : ''}`} />{generating ? '生成中...' : '手动生成预警'}</button></>}
                    </div>
                  </td>
                </tr>
              ) : data.map(alert => {
                const typeInfo = getAlertTypeInfo(alert.type)
                const statusInfo = getStatusInfo(alert.status)
                return (
                  <tr key={alert.id} className="hover:bg-gray-50 transition-colors" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 56px' }}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{alert.id}</td>
                    <td className="px-4 py-3"><span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${typeInfo.bg} ${typeInfo.text}`}>{typeInfo.label}</span></td>
                    <td className="px-4 py-3"><div className="font-medium text-gray-900">{alert.materialName || '未提供'}</div><div className="text-xs text-gray-500">{alert.batchNo || alert.materialId || '未提供'}</div></td>
                    <td className="px-4 py-3 text-gray-600 text-xs max-w-[220px] truncate">{alert.triggerCondition || alert.message || '未提供'}</td>
                    <td className="px-4 py-3"><span className="font-mono text-xs text-gray-600">{alert.ruleId || '未提供'}</span></td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(alert.createdAt)}</td>
                    <td className="px-4 py-3"><span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${statusInfo.bg} ${statusInfo.text}`}>{statusInfo.label}</span></td>
                    <td className="px-4 py-3"><div className="flex items-center gap-2">{alert.status === 'pending' ? <><button onClick={() => onOpenModal('handle', alert)} className="px-2.5 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700">处理或忽略</button><button onClick={() => onOpenModal('detail', alert)} className="px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50">详情</button></> : <button onClick={() => onOpenModal('detail', alert)} className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50"><Eye className="w-3.5 h-3.5 mr-1" />查看</button>}</div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!error && <Pagination page={page} pageSize={pageSize} total={total} onChange={onPageChange} onPageSizeChange={onPageSizeChange} />}
      </div>
    </div>
  )
}
