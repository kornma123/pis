import { Fragment } from 'react'
import { Search, ArrowUpDown, ArrowUp, ArrowDown, X, Trash2, Upload, ChevronRight, AlertCircle, RefreshCw } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { StockLevelIndicator } from './StockLevelIndicator'
import { ExpiryTag } from './ExpiryTag'
import type { InventoryItem } from '@/types'

interface InventoryRow extends InventoryItem {
  batch?: string
  expiry?: string
}

type SortField = 'quantity' | 'expiry' | null
type SortDirection = 'asc' | 'desc'
type QuickFilterType = 'all' | 'low-stock' | 'expiring-soon' | 'expiring-month' | 'expired' | 'out-of-stock'

interface Props {
  data: InventoryRow[]
  loading: boolean
  error: string | null
  total: number
  page: number
  pageSize: number
  keyword: string
  category: string
  location: string
  quickFilter: QuickFilterType
  sortField: SortField
  sortDirection: SortDirection
  selectedIds: Set<string>
  expandedGroups: Set<string>
  stats: {
    total: number
    normal: number
    low: number
    warning: number
    expired: number
    outOfStock: number
  }
  quickFilterCounts: Record<QuickFilterType, number>
  onKeywordChange: (v: string) => void
  onCategoryChange: (v: string) => void
  onLocationChange: (v: string) => void
  onQuickFilter: (f: QuickFilterType) => void
  onSort: (field: SortField) => void
  onSearch: () => void
  onReset: () => void
  onToggleSelectAll: () => void
  onToggleSelectOne: (id: string) => void
  onClearSelection: () => void
  onToggleGroup: (name: string) => void
  onDetail: (item: InventoryRow) => void
  onOutbound: (item: InventoryRow) => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onBatchOutbound: () => void
  onBatchScrap: () => void
  onRetry: () => void
}

function getStatusInfo(item: InventoryRow) {
  const today = new Date()
  const expiry = item.expiry && item.expiry !== '-' ? new Date(item.expiry) : null
  const daysLeft = expiry ? Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : 999

  if (item.stock === 0) {
    return { label: '已缺货', badgeClass: 'bg-red-50 text-red-600' }
  }
  if (expiry && daysLeft < 0) {
    return { label: '已过期', badgeClass: 'bg-red-50 text-red-600' }
  }
  if (item.stock <= item.minStock) {
    return { label: '库存不足', badgeClass: 'bg-orange-50 text-orange-600' }
  }
  if (expiry && daysLeft <= 30) {
    return { label: '即将过期', badgeClass: 'bg-yellow-50 text-yellow-700' }
  }
  return { label: '正常', badgeClass: 'bg-green-50 text-green-600' }
}

export function InventoryTable({
  data,
  loading,
  error,
  total,
  page,
  pageSize,
  keyword,
  category,
  location,
  quickFilter,
  sortField,
  sortDirection,
  selectedIds,
  expandedGroups,
  stats,
  quickFilterCounts,
  onKeywordChange,
  onCategoryChange,
  onLocationChange,
  onQuickFilter,
  onSort,
  onSearch,
  onReset,
  onToggleSelectAll,
  onToggleSelectOne,
  onClearSelection,
  onToggleGroup,
  onDetail,
  onOutbound,
  onPageChange,
  onPageSizeChange,
  onBatchOutbound,
  onBatchScrap,
  onRetry,
}: Props) {
  const sortedData = [...data]
  if (sortField) {
    sortedData.sort((a, b) => {
      let aVal: any, bVal: any
      if (sortField === 'quantity') {
        aVal = a.stock || 0
        bVal = b.stock || 0
      } else if (sortField === 'expiry') {
        aVal = a.expiry || '9999-12-31'
        bVal = b.expiry || '9999-12-31'
      }
      if (sortDirection === 'asc') {
        return aVal > bVal ? 1 : -1
      }
      return aVal < bVal ? 1 : -1
    })
  }

  const groupedData: Record<string, InventoryRow[]> = {}
  sortedData.forEach(item => {
    if (!groupedData[item.name]) groupedData[item.name] = []
    groupedData[item.name].push(item)
  })

  return (
    <>
      {/* 统计卡片 */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { key: 'all', label: '总库存数量', value: stats.total, color: 'border-l-4 border-l-[#3b82f6]' },
          { key: 'normal', label: '正常', value: stats.normal, color: 'border-l-4 border-l-green-500' },
          { key: 'low-stock', label: '库存不足', value: stats.low, color: 'border-l-4 border-l-orange-500' },
          { key: 'warning', label: '即将过期', value: stats.warning, color: 'border-l-4 border-l-yellow-500' },
          { key: 'expired', label: '已过期', value: stats.expired, color: 'border-l-4 border-l-red-500' },
        ].map(stat => (
          <button
            key={stat.key}
            onClick={() => onQuickFilter(stat.key as QuickFilterType)}
            className={`bg-white rounded-lg shadow-sm p-5 text-left transition-all duration-150 ease hover:shadow-md ${stat.color}`}
          >
            <div className="text-[28px] font-semibold text-gray-900">{stat.value}</div>
            <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
          </button>
        ))}
      </div>

      {/* 快速筛选 */}
      <div className="flex items-center gap-2 flex-wrap">
        {[
          { key: 'all', label: '全部', count: quickFilterCounts.all },
          { key: 'low-stock', label: '库存不足', count: quickFilterCounts['low-stock'] },
          { key: 'expiring-soon', label: '本周过期', count: quickFilterCounts['expiring-soon'] },
          { key: 'expiring-month', label: '本月过期', count: quickFilterCounts['expiring-month'] },
          { key: 'expired', label: '已过期', count: quickFilterCounts.expired },
          { key: 'out-of-stock', label: '缺货', count: quickFilterCounts['out-of-stock'] },
        ].map(filter => (
          <button
            key={filter.key}
            onClick={() => onQuickFilter(filter.key as QuickFilterType)}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-150 ease ${
              quickFilter === filter.key
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {filter.label}
            <span className={`${quickFilter === filter.key ? 'bg-white/20' : 'bg-gray-100'} px-1.5 py-0.5 rounded text-[11px]`}>
              {filter.count}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {/* 卡片头部 - 筛选栏 */}
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between gap-4 flex-wrap">
          <span className="text-base font-semibold text-gray-900">库存明细</span>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索耗材名称/批号/供应商..."
                value={keyword}
                onChange={e => onKeywordChange(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && onSearch()}
                className="w-[260px] pl-10 pr-4 h-10 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
              />
            </div>
            <select
              value={category}
              onChange={e => onCategoryChange(e.target.value)}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease bg-white"
            >
              <option>全部分类</option>
              <option>试剂</option>
              <option>耗材</option>
              <option>设备</option>
            </select>
            <select
              value={location}
              onChange={e => onLocationChange(e.target.value)}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease bg-white"
            >
              <option>全部库位</option>
              <option>A区-试剂冷藏</option>
              <option>B区-常温耗材</option>
              <option>C区-设备配件</option>
            </select>
            <button
              onClick={onSearch}
              className="h-10 px-4 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-all duration-150 ease font-medium"
            >
              查询
            </button>
            <button
              onClick={onReset}
              className="h-10 px-4 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-all duration-150 ease font-medium"
            >
              重置
            </button>
          </div>
        </div>

        {error && sortedData.length > 0 && (
          <div role="alert" className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-3 text-amber-900">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">当前显示的是上次成功加载的数据</div>
              <div className="text-xs text-amber-700">库存数据刷新失败，请重试以获取最新数据。</div>
            </div>
            <button
              type="button"
              onClick={onRetry}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重新加载
            </button>
          </div>
        )}

        {/* 批量操作栏 */}
        {selectedIds.size > 0 && (
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
            <span className="text-sm text-gray-700">
              已选择 <strong className="text-blue-500">{selectedIds.size}</strong> 项
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onBatchOutbound}
                disabled={Boolean(error)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 rounded-md transition-all duration-150 ease"
              >
                <Upload className="w-3.5 h-3.5" />
                批量出库
              </button>
              <button
                onClick={onBatchScrap}
                disabled={Boolean(error)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 rounded-md transition-all duration-150 ease"
              >
                <Trash2 className="w-3.5 h-3.5" />
                批量报废
              </button>
              <button
                onClick={onClearSelection}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white hover:shadow-sm rounded-md transition-all duration-150 ease"
              >
                <X className="w-3.5 h-3.5" />
                取消选择
              </button>
            </div>
          </div>
        )}

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === sortedData.length && sortedData.length > 0}
                    onChange={onToggleSelectAll}
                    disabled={Boolean(error)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">耗材名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">批号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">库位</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  <button onClick={() => onSort('quantity')} className="inline-flex items-center gap-1 hover:text-gray-700 transition-colors">
                    库存数量
                    {sortField === 'quantity' ? (
                      sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                    ) : (
                      <ArrowUpDown className="w-3 h-3 opacity-50" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  <button onClick={() => onSort('expiry')} className="inline-flex items-center gap-1 hover:text-gray-700 transition-colors">
                    有效期
                    {sortField === 'expiry' ? (
                      sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                    ) : (
                      <ArrowUpDown className="w-3 h-3 opacity-50" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">状态</th>
                <th className="w-[140px] px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#3b82f6] rounded-full animate-spin" />
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : error && sortedData.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div role="alert" className="flex flex-col items-center justify-center py-16">
                      <AlertCircle className="mb-4 h-16 w-16 text-red-300" strokeWidth={1.5} />
                      <div className="mb-1 text-base font-medium text-gray-900">库存数据没能加载</div>
                      <div className="mb-4 text-sm text-gray-500">请检查网络连接后重试。</div>
                      <button
                        type="button"
                        onClick={onRetry}
                        className="inline-flex items-center gap-2 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
                      >
                        <RefreshCw className="h-4 w-4" />
                        重试
                      </button>
                    </div>
                  </td>
                </tr>
              ) : sortedData.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="flex flex-col items-center justify-center py-16">
                      <svg className="w-16 h-16 text-gray-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                      </svg>
                      <div className="text-base font-medium text-gray-900 mb-1">暂无库存数据</div>
                      <div className="text-sm text-gray-500 mb-4">当前筛选条件下没有找到库存记录，请尝试调整筛选条件或添加入库记录</div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => { window.location.href = '/inbound' }}
                          className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease"
                        >
                          添加入库
                        </button>
                        <button
                          onClick={onReset}
                          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
                        >
                          清除筛选
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                Object.entries(groupedData).map(([groupName, batches]) => {
                  const isExpanded = expandedGroups.has(groupName)
                  const first = batches[0]
                  const totalStock = batches.reduce((sum, b) => sum + (b.stock || 0), 0)
                  const minStock = first?.minStock || 0
                  return (
                    <Fragment key={groupName}>
                      <tr
                        className="hover:bg-gray-50 transition-colors duration-150 cursor-pointer bg-gray-50/50"
                        onClick={() => onToggleGroup(groupName)}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                            onChange={(e) => e.stopPropagation()}
                            disabled={Boolean(error)}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                              <ChevronRight className="w-3 h-3" strokeWidth={3} />
                            </span>
                            <div>
                              <div className="font-semibold text-gray-900">{first?.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{first?.spec || ''}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                            {batches.length} 批次
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-sm">{first?.locationName || first?.locationId || '-'}</td>
                        <td className="px-4 py-3">
                          <span className="font-semibold text-gray-900">{totalStock}</span>
                          <span className="text-xs text-green-500 ml-1">{totalStock >= minStock ? '充足' : '不足'}</span>
                        </td>
                        <td className="px-4 py-3"></td>
                        <td className="px-4 py-3"></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <button onClick={(e) => { e.stopPropagation(); onDetail(first!) }} className="text-sm text-gray-600 hover:text-gray-900 transition-colors">详情</button>
                            <button disabled={Boolean(error)} onClick={(e) => { e.stopPropagation(); onOutbound(first!) }} className="text-sm text-blue-500 hover:text-blue-600 disabled:cursor-not-allowed disabled:text-gray-300 transition-colors">出库</button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && batches.map(row => {
                        const statusInfo = getStatusInfo(row)
                        const isSelected = selectedIds.has(row.id)
                        return (
                          <tr
                            key={row.id}
                            className="hover:bg-gray-50 transition-colors duration-150"
                          >
                            <td className="px-4 py-3 pl-8">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => onToggleSelectOne(row.id)}
                                disabled={Boolean(error)}
                                className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                              />
                            </td>
                            <td className="px-4 py-3 pl-12">
                              <span className="text-gray-400 text-xs mr-1">└</span>
                              <span className="font-medium text-gray-900">{row.name}</span>
                            </td>
                            <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.batch || '-'}</td>
                            <td className="px-4 py-3 text-gray-600 text-sm">{row.locationName || row.locationId || '-'}</td>
                            <td className="px-4 py-3">
                              <span className="font-medium text-gray-900">{row.stock}</span>
                              <StockLevelIndicator stock={row.stock} minStock={row.minStock} />
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-gray-600">{row.expiry || '-'}</span>
                              <ExpiryTag expiry={row.expiry} />
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusInfo.badgeClass}`}>
                                {statusInfo.label}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <button onClick={() => onDetail(row)} className="text-sm text-gray-600 hover:text-gray-900 transition-colors">详情</button>
                                <button disabled={Boolean(error)} onClick={() => onOutbound(row)} className="text-sm text-blue-500 hover:text-blue-600 disabled:cursor-not-allowed disabled:text-gray-300 transition-colors">出库</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="px-5 py-4 border-t border-gray-200 flex items-center justify-between">
          <span className="text-sm text-gray-500">共 {total} 条记录</span>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChangePage={onPageChange}
            onChangePageSize={onPageSizeChange}
          />
        </div>
      </div>
    </>
  )
}
