import { Search, RotateCcw, CheckSquare, Clock, Eye } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import type { AlertItem, AlertTypeFilter, AlertStatusFilter } from '../hooks/useAlertsPage'
import { ALERT_TYPE_MAP, STATUS_MAP } from '../hooks/useAlertsPage'

interface Props {
  data: AlertItem[]
  loading: boolean
  total: number
  page: number
  pageSize: number
  filter: { keyword: string; type: AlertTypeFilter; status: AlertStatusFilter; dateRange: [string, string] }
  quickFilter: AlertStatusFilter
  selectedIds: Set<string>
  onFilterChange: (filter: { keyword: string; type: AlertTypeFilter; status: AlertStatusFilter; dateRange: [string, string] }) => void
  onQuickFilterChange: (v: AlertStatusFilter) => void
  onSelect: (id: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onBatchProcess: () => void
  onOpenModal: (type: 'handle' | 'consumption-handle' | 'consumption-detail' | 'detail', alert: AlertItem) => void
  onIgnore: (id: string) => void
  getAlertTypeInfo: (type: string) => { label: string; bg: string; text: string }
  getStatusInfo: (status: string) => { label: string; bg: string; text: string }
  isConsumption: (type: string) => boolean
  formatDate: (dateStr: string) => string
}

export function AlertTable({
  data,
  loading,
  total,
  page,
  pageSize,
  filter,
  quickFilter,
  selectedIds,
  onFilterChange,
  onQuickFilterChange,
  onSelect,
  onSelectAll,
  onClearSelection,
  onPageChange,
  onPageSizeChange,
  onBatchProcess,
  onOpenModal,
  onIgnore,
  getAlertTypeInfo,
  getStatusInfo,
  isConsumption,
  formatDate,
}: Props) {
  const isAllSelected = data.length > 0 && selectedIds.size === data.length

  return (
    <div className="space-y-4">
      {/* 快速筛选 */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { key: 'all', label: '全部' },
            { key: 'pending', label: '待处理' },
            { key: 'processed', label: '已处理' },
            { key: 'ignored', label: '已忽略' },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            onClick={() => onQuickFilterChange(item.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all duration-150 h-10 ${
              quickFilter === item.key
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 筛选栏 */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex flex-col xl:flex-row gap-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="搜索预警编号/物料..."
              value={filter.keyword}
              onChange={(e) => onFilterChange({ ...filter, keyword: e.target.value })}
              className="w-full h-10 pl-9 pr-4 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
            />
          </div>
          <select
            value={filter.type}
            onChange={(e) => onFilterChange({ ...filter, type: e.target.value as AlertTypeFilter })}
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
          >
            <option value="all">全部类型</option>
            <option value="low-stock">库存不足</option>
            <option value="expiry">即将过期</option>
            <option value="stagnant">消耗异常</option>
          </select>
          <select
            value={filter.status}
            onChange={(e) => onFilterChange({ ...filter, status: e.target.value as AlertStatusFilter })}
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
          >
            <option value="all">全部状态</option>
            <option value="pending">待处理</option>
            <option value="processed">已处理</option>
            <option value="ignored">已忽略</option>
          </select>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={filter.dateRange[0]}
              onChange={(e) => onFilterChange({ ...filter, dateRange: [e.target.value, filter.dateRange[1]] })}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
            />
            <span className="text-gray-400">-</span>
            <input
              type="date"
              value={filter.dateRange[1]}
              onChange={(e) => onFilterChange({ ...filter, dateRange: [filter.dateRange[0], e.target.value] })}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onPageChange(1)}
              className="inline-flex items-center gap-1.5 h-10 px-4 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors duration-150 shadow-sm"
            >
              <Search className="w-4 h-4" />
              查询
            </button>
            <button
              onClick={() => {
                onFilterChange({ keyword: '', type: 'all', status: 'all', dateRange: ['', ''] })
                onQuickFilterChange('all')
                onPageChange(1)
              }}
              className="inline-flex items-center gap-1.5 h-10 px-4 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
            >
              <RotateCcw className="w-4 h-4" />
              重置
            </button>
          </div>
        </div>
      </div>

      {/* 批量操作 */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <span className="text-sm text-blue-800">
            已选择 <strong>{selectedIds.size}</strong> 条预警
          </span>
          <button
            onClick={onBatchProcess}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 transition-colors"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            批量处理
          </button>
          <button
            onClick={onClearSelection}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
          >
            取消选择
          </button>
        </div>
      )}

      {/* 表格卡片 */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">预警列表</h2>
          <span className="text-xs text-gray-400">共 {total} 条记录</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={onSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">预警编号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">预警类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">物料信息</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">触发条件</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">来源规则</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">预警时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <Clock className="w-5 h-5 animate-spin" />
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    暂无预警数据
                  </td>
                </tr>
              ) : (
                data.map((alert) => {
                  const typeInfo = getAlertTypeInfo(alert.type)
                  const statusInfo = getStatusInfo(alert.status)
                  return (
                    <tr key={alert.id} className="hover:bg-gray-50 transition-colors duration-150">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(alert.id)}
                          onChange={() => onSelect(alert.id)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">{alert.id}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${typeInfo.bg} ${typeInfo.text}`}>
                          {typeInfo.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{alert.materialName || '-'}</div>
                        <div className="text-xs text-gray-500">{alert.batchNo || alert.materialId}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs max-w-[200px] truncate">
                        {alert.triggerCondition || alert.message || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-blue-600">{alert.ruleId || 'RULE-001'}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(alert.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${statusInfo.bg} ${statusInfo.text}`}>
                          {statusInfo.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {alert.status === 'pending' ? (
                            <>
                              <button
                                onClick={() => onOpenModal(isConsumption(alert.type) ? 'consumption-handle' : 'handle', alert)}
                                className="inline-flex items-center px-2.5 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 transition-colors duration-150"
                              >
                                处理
                              </button>
                              <button
                                onClick={() => onIgnore(alert.id)}
                                className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
                              >
                                忽略
                              </button>
                              <button
                                onClick={() => onOpenModal(isConsumption(alert.type) ? 'consumption-detail' : 'detail', alert)}
                                className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
                              >
                                详情
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => onOpenModal(isConsumption(alert.type) ? 'consumption-detail' : 'detail', alert)}
                              className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
                            >
                              <Eye className="w-3.5 h-3.5 mr-1" />
                              查看
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
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      </div>
    </div>
  )
}
