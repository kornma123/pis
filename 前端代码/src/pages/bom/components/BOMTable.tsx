import { Search, Clock, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Pagination } from '@/components/ui/Pagination'
import type { BOM } from '@/types'
import {
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  QUICK_FILTERS,
  QUICK_FILTER_COLORS,
  getMaterialStatus,
  formatDateTime,
} from '../constants'
import { StatusBadge } from './StatusBadge'

interface Props {
  data: BOM[]
  loading: boolean
  total: number
  page: number
  pageSize: number
  searchInput: string
  filterType: string
  filterStatus: string
  quickFilter: string
  selectedIds: Set<string>
  isAllSelected: boolean
  isIndeterminate: boolean
  onSearchInputChange: (v: string) => void
  onSearch: () => void
  onReset: () => void
  onFilterTypeChange: (v: string) => void
  onFilterStatusChange: (v: string) => void
  onQuickFilterChange: (v: string) => void
  onToggleSelectAll: () => void
  onToggleSelectRow: (id: string) => void
  onClearSelection: () => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onOpenDetail: (row: BOM) => void
  onOpenEdit: (row: BOM) => void
  onOpenCopy: (row: BOM) => void
  onOpenDelete: (row: BOM) => void
  onBatchDelete: () => void
}

export function BOMTable({
  data,
  loading,
  total,
  page,
  pageSize,
  searchInput,
  filterType,
  filterStatus,
  quickFilter,
  selectedIds,
  isAllSelected,
  isIndeterminate,
  onSearchInputChange,
  onSearch,
  onReset,
  onFilterTypeChange,
  onFilterStatusChange,
  onQuickFilterChange,
  onToggleSelectAll,
  onToggleSelectRow,
  onClearSelection,
  onPageChange,
  onPageSizeChange,
  onOpenDetail,
  onOpenEdit,
  onOpenCopy,
  onOpenDelete,
  onBatchDelete,
}: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      {/* 筛选栏 */}
      <div className="px-5 py-4 border-b border-gray-200 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索BOM名称/编号..."
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            className="w-full h-10 pl-10 pr-4 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={filterType}
            onChange={(e) => onFilterTypeChange(e.target.value)}
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => onFilterStatusChange(e.target.value)}
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={onSearch}
            className="h-10 px-4 bg-white text-gray-700 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            查询
          </button>
          <button
            onClick={onReset}
            className="h-10 px-4 text-gray-500 text-sm font-medium hover:text-gray-700 transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* 快速筛选 */}
      <div className="px-5 py-3 border-b border-gray-200 flex items-center gap-2">
        {QUICK_FILTERS.map((f) => {
          const isActive = quickFilter === f.key
          const colors = QUICK_FILTER_COLORS[f.key]
          return (
            <button
              key={f.key}
              onClick={() => onQuickFilterChange(f.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                isActive ? colors.active : colors.inactive
              }`}
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {/* 批量操作栏 */}
      {selectedIds.size > 0 && (
        <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-3 flex-wrap">
          <span className="text-sm text-gray-700">
            已选择{' '}
            <span className="font-semibold text-blue-600">
              {selectedIds.size}
            </span>{' '}
            项
          </span>
          <button
            onClick={() => {
              toast.info('批量启用功能开发中')
              onClearSelection()
            }}
            className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-xs font-medium hover:bg-gray-50 transition-colors"
          >
            批量启用
          </button>
          <button
            onClick={() => {
              toast.info('批量停用功能开发中')
              onClearSelection()
            }}
            className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-xs font-medium hover:bg-gray-50 transition-colors"
          >
            批量停用
          </button>
          <button
            onClick={onBatchDelete}
            className="px-3 py-1.5 bg-red-600 text-white border border-red-600 rounded-md text-xs font-medium hover:bg-red-700 transition-colors"
          >
            批量删除
          </button>
          <button
            onClick={onClearSelection}
            className="px-3 py-1.5 text-gray-500 text-xs font-medium hover:text-gray-700 transition-colors"
          >
            取消选择
          </button>
        </div>
      )}

      {/* 表格 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="w-12 px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = isIndeterminate
                  }}
                  onChange={onToggleSelectAll}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                BOM编号
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                BOM名称
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                关联检测服务
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                版本
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                物料数
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                可支撑样本数
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                物料状态
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                更新时间
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <Clock className="w-5 h-5 animate-spin" />
                    加载中...
                  </div>
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="w-12 h-12 text-gray-300" />
                    <p className="text-sm">暂无BOM数据</p>
                    <p className="text-xs text-gray-400">
                      点击“新建BOM”添加物料清单
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              data.map((row) => {
                const mStatus = getMaterialStatus(row)
                const selected = selectedIds.has(row.id)
                const supportable = row.supportableSamples
                const supportableClass =
                  supportable === undefined || supportable === null
                    ? 'text-gray-400'
                    : supportable === 0
                    ? 'text-red-600 font-medium'
                    : supportable < 30
                    ? 'text-yellow-600 font-medium'
                    : 'text-gray-700'

                return (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => onToggleSelectRow(row.id)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">
                      {row.code}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 text-sm">
                        {row.name}
                      </div>
                      {row.description && (
                        <div className="text-xs text-gray-400 mt-0.5 line-clamp-1">
                          {row.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {row.serviceName || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {row.version || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {row.materialCount ?? 0}
                    </td>
                    <td className={`px-4 py-3 ${supportableClass}`}>
                      {supportable !== undefined && supportable !== null
                        ? supportable
                        : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={mStatus} />
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {formatDateTime(row.updatedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onOpenDetail(row)}
                          className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors"
                        >
                          详情
                        </button>
                        <button
                          onClick={() => onOpenEdit(row)}
                          className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => onOpenCopy(row)}
                          className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors"
                        >
                          复制
                        </button>
                        <button
                          onClick={() => {
                            if (row.status === 'active') {
                              toast.info('停用功能开发中')
                            } else {
                              toast.info('启用功能开发中')
                            }
                          }}
                          className="px-2 py-1 text-gray-500 hover:text-yellow-600 text-xs font-medium transition-colors"
                        >
                          {row.status === 'active' ? '停用' : '启用'}
                        </button>
                        <button
                          onClick={() => onOpenDelete(row)}
                          className="px-2 py-1 text-gray-500 hover:text-red-600 text-xs font-medium transition-colors"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </div>
  )
}
