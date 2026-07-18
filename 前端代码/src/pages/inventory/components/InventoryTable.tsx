import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import type { InventoryItem } from '@/types'
import { ExpiryTag } from './ExpiryTag'
import { StockLevelIndicator } from './StockLevelIndicator'

interface InventoryRow extends InventoryItem {
  batch?: string
  expiry?: string
}

type SortField = 'quantity' | 'expiry' | null
type SortDirection = 'asc' | 'desc'
type QuickFilterType = 'all' | 'low-stock' | 'expiring-soon' | 'expiring-month' | 'expired' | 'out-of-stock'
type Count = number | null

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
  stats: { total: Count; normal: Count; low: Count; warning: Count; expired: Count; outOfStock: Count }
  quickFilterCounts: Record<QuickFilterType, Count>
  statsError?: string | null
  canOutbound?: boolean
  canScrap?: boolean
  onKeywordChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onLocationChange: (value: string) => void
  onQuickFilter: (filter: QuickFilterType) => void
  onSort: (field: SortField) => void
  onSearch: () => void
  onReset: () => void
  onToggleSelectAll: () => void
  onToggleSelectOne: (id: string) => void
  onClearSelection: () => void
  onToggleGroup: (name: string) => void
  onDetail: (item: InventoryRow) => void
  onOutbound: (item: InventoryRow) => void
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  onBatchOutbound: () => void
  onBatchScrap: () => void
  onRetry: () => void
  onRetryStats?: () => void
}

const STATUS_COPY: Record<string, { label: string; className: string }> = {
  normal: { label: '正常', className: 'bg-green-50 text-green-700' },
  'low-stock': { label: '库存不足', className: 'bg-orange-50 text-orange-700' },
  warning: { label: '30 天内到期', className: 'bg-amber-50 text-amber-700' },
  expired: { label: '已过期', className: 'bg-red-50 text-red-700' },
  'out-of-stock': { label: '无正库存', className: 'bg-gray-100 text-gray-700' },
}

function displayCount(value: Count) {
  return value === null ? '—' : value.toLocaleString('zh-CN')
}

function displayLocation(item: InventoryRow) {
  const hasId = typeof item.locationId === 'string' && item.locationId.trim() !== ''
  const hasName = typeof item.locationName === 'string'
    && item.locationName.trim() !== ''
    && item.locationName !== '-'
  if (!hasId) return { text: '未登记库位', className: 'text-amber-700' }
  if (!hasName) return { text: '库位引用失效', className: 'text-red-700' }
  return { text: `${item.locationName}（未按批次验证）`, className: 'text-gray-700' }
}

function sortRows(data: InventoryRow[], field: SortField, direction: SortDirection) {
  if (!field) return data
  return [...data].sort((left, right) => {
    const leftValue = field === 'quantity' ? left.stock : left.expiry && left.expiry !== '-' ? left.expiry : '9999-12-31'
    const rightValue = field === 'quantity' ? right.stock : right.expiry && right.expiry !== '-' ? right.expiry : '9999-12-31'
    const result = leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1
    return direction === 'asc' ? result : -result
  })
}

export function InventoryTable({
  data,
  loading,
  error,
  total,
  page,
  pageSize,
  keyword,
  quickFilter,
  sortField,
  sortDirection,
  selectedIds,
  stats,
  quickFilterCounts,
  statsError = null,
  canOutbound = true,
  canScrap = true,
  onKeywordChange,
  onQuickFilter,
  onSort,
  onSearch,
  onReset,
  onToggleSelectAll,
  onToggleSelectOne,
  onClearSelection,
  onDetail,
  onOutbound,
  onPageChange,
  onPageSizeChange,
  onBatchOutbound,
  onBatchScrap,
  onRetry,
  onRetryStats,
}: Props) {
  const rows = sortRows(data, sortField, sortDirection)
  const hasFilters = Boolean(keyword.trim()) || quickFilter !== 'all'
  const summary = [
    { label: '正库存物料条目', value: stats.total, border: 'border-l-blue-500' },
    { label: '正常', value: stats.normal, border: 'border-l-green-500' },
    { label: '库存不足', value: stats.low, border: 'border-l-orange-500' },
    { label: '30 天内到期', value: stats.warning, border: 'border-l-amber-500' },
    { label: '已过期', value: stats.expired, border: 'border-l-red-500' },
  ]
  const filters: Array<{ key: QuickFilterType; label: string }> = [
    { key: 'all', label: '全部正库存' },
    { key: 'low-stock', label: '库存不足' },
    { key: 'expiring-month', label: '30 天内到期' },
    { key: 'expired', label: '已过期' },
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        每行是物料级正库存缓存，不是逐批持仓。批次/效期只显示当前 FEFO 起始候选；登记库位未按批次验证。
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {summary.map(item => (
          <div key={item.label} className={`rounded-lg border border-gray-200 border-l-4 ${item.border} bg-white p-4 shadow-sm`}>
            <div className="text-2xl font-semibold tabular-nums text-gray-900">{displayCount(item.value)}</div>
            <div className="mt-1 text-sm text-gray-500">{item.label}</div>
          </div>
        ))}
      </div>

      {statsError && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>统计数据未能刷新，破折号表示未知，不代表 0。</span>
          {onRetryStats && (
            <button type="button" onClick={onRetryStats} className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100">
              重试统计
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2" aria-label="库存状态筛选">
        {filters.map(filter => (
          <button
            key={filter.key}
            type="button"
            aria-pressed={quickFilter === filter.key}
            onClick={() => onQuickFilter(filter.key)}
            className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors ${
              quickFilter === filter.key
                ? 'border-blue-500 bg-blue-500 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {filter.label}
            <span aria-label={`${filter.label}数量`} className="tabular-nums opacity-80">
              {displayCount(quickFilterCounts[filter.key])}
            </span>
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm" aria-labelledby="inventory-table-title">
        <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="inventory-table-title" className="font-semibold text-gray-900">库存浏览</h2>
            <p className="mt-0.5 text-xs text-gray-500">搜索支持物料名称与编码；排序只影响当前页。</p>
          </div>
          <form
            className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row"
            onSubmit={event => { event.preventDefault(); onSearch() }}
          >
            <label className="relative block sm:w-72">
              <span className="sr-only">搜索物料名称或编码</span>
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={keyword}
                onChange={event => onKeywordChange(event.target.value)}
                placeholder="搜索物料名称或编码"
                className="h-10 w-full rounded-md border border-gray-300 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10"
              />
            </label>
            <button type="submit" className="h-10 rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600">查询</button>
            <button type="button" onClick={onReset} className="h-10 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">重置</button>
          </form>
        </div>

        {error && rows.length > 0 && (
          <div role="alert" className="flex flex-col gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 sm:flex-row sm:items-center">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">当前显示的是上次成功加载的数据</div>
              <div className="text-xs text-amber-700">刷新失败后数据已标记为陈旧，恢复新鲜状态前禁止库存写操作。</div>
            </div>
            <button
              type="button"
              onClick={onRetry}
              disabled={loading}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 text-sm font-medium hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              重新加载
            </button>
          </div>
        )}

        {selectedIds.size > 0 && (
          <div className="flex flex-col gap-3 border-b border-blue-100 bg-blue-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-blue-800">已选择 <strong>{selectedIds.size}</strong> 项当前页物料</span>
            <div className="flex flex-wrap gap-2">
              {canOutbound && (
                <button type="button" onClick={onBatchOutbound} disabled={Boolean(error)} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50">
                  <Upload className="h-4 w-4" />批量加入出库单
                </button>
              )}
              {canScrap && (
                <button type="button" onClick={onBatchScrap} disabled={Boolean(error)} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50">
                  <Trash2 className="h-4 w-4" />批量报废
                </button>
              )}
              <button type="button" onClick={onClearSelection} className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-gray-700 hover:bg-white">
                <X className="h-4 w-4" />取消选择
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-[980px] w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="w-12 px-4 py-3">
                  <label className="sr-only" htmlFor="inventory-select-page">选择当前页全部物料</label>
                  <input id="inventory-select-page" type="checkbox" checked={rows.length > 0 && selectedIds.size === rows.length} onChange={onToggleSelectAll} disabled={Boolean(error)} className="h-4 w-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500" />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">物料</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">FEFO 起始批次</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">登记库位（未按批次验证）</th>
                <th aria-sort={sortField === 'quantity' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4 py-3 text-right text-xs font-medium text-gray-600">
                  <button type="button" onClick={() => onSort('quantity')} className="inline-flex items-center gap-1 hover:text-gray-900">正库存缓存{sortField === 'quantity' ? sortDirection === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3" />}</button>
                </th>
                <th aria-sort={sortField === 'expiry' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4 py-3 text-left text-xs font-medium text-gray-600">
                  <button type="button" onClick={() => onSort('expiry')} className="inline-flex items-center gap-1 hover:text-gray-900">候选批次效期{sortField === 'expiry' ? sortDirection === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3" />}</button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">状态</th>
                <th className="w-36 px-4 py-3 text-left text-xs font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && rows.length === 0 ? (
                Array.from({ length: 4 }, (_, index) => (
                  <tr key={index} aria-label="正在加载库存" className="animate-pulse">
                    <td colSpan={8} className="px-4 py-3"><div className="h-8 rounded bg-gray-100" /></td>
                  </tr>
                ))
              ) : error && rows.length === 0 ? (
                <tr><td colSpan={8}><div role="alert" className="flex flex-col items-center py-14 text-center"><AlertCircle className="mb-3 h-12 w-12 text-red-300" /><div className="font-medium text-gray-900">库存数据没能加载</div><div className="mt-1 text-sm text-gray-500">没有把请求失败当成空库存，请重试。</div><button type="button" onClick={onRetry} className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-4 text-sm font-medium text-white hover:bg-blue-600"><RefreshCw className="h-4 w-4" />重试</button></div></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8}><div className="flex flex-col items-center py-14 text-center"><div className="font-medium text-gray-900">暂无库存数据</div><div className="mt-1 max-w-lg text-sm text-gray-500">{hasFilters ? '当前筛选没有匹配的正库存物料，请调整筛选条件。' : '库存接口成功返回 0 个正库存物料条目；这不等于已核实所有批次库存都为 0。'}</div>{hasFilters && <button type="button" onClick={onReset} className="mt-4 h-10 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">清除筛选</button>}</div></td></tr>
              ) : rows.map(row => {
                const locationEvidence = displayLocation(row)
                const status = STATUS_COPY[row.status] ?? STATUS_COPY.normal
                return (
                  <tr key={row.id} className={`[content-visibility:auto] [contain-intrinsic-size:0_58px] hover:bg-gray-50 ${selectedIds.has(row.id) ? 'bg-blue-50' : ''}`}>
                    <td className="px-4 py-3"><label className="sr-only" htmlFor={`inventory-select-${row.id}`}>选择 {row.name}</label><input id={`inventory-select-${row.id}`} type="checkbox" checked={selectedIds.has(row.id)} onChange={() => onToggleSelectOne(row.id)} disabled={Boolean(error)} className="h-4 w-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500" /></td>
                    <td className="px-4 py-3"><div className="font-medium text-gray-900">{row.name}</div><div className="mt-0.5 text-xs text-gray-500">{row.code} · {row.spec || '规格未提供'}</div></td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{row.batch && row.batch !== '-' ? row.batch : '未取得可用批次证据'}</td>
                    <td className={`px-4 py-3 text-sm ${locationEvidence.className}`}>{locationEvidence.text}</td>
                    <td className="px-4 py-3 text-right"><span className="font-medium tabular-nums text-gray-900">{row.stock} {row.unit}</span><StockLevelIndicator stock={row.stock} minStock={row.minStock} /></td>
                    <td className="px-4 py-3"><span className="text-gray-700">{row.expiry && row.expiry !== '-' ? row.expiry : '未取得效期证据'}</span><ExpiryTag expiry={row.expiry} /></td>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${status.className}`}>{status.label}</span></td>
                    <td className="px-4 py-3"><div className="flex items-center gap-2"><button type="button" onClick={() => onDetail(row)} className="text-sm text-gray-700 hover:text-gray-900">详情</button>{canOutbound && <button type="button" disabled={Boolean(error)} onClick={() => onOutbound(row)} className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-gray-300">出库</button>}</div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-gray-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-gray-500">接口共返回 {total.toLocaleString('zh-CN')} 个正库存物料条目</span>
          <Pagination page={page} pageSize={pageSize} total={total} onChangePage={onPageChange} onChangePageSize={onPageSizeChange} />
        </div>
      </section>
    </div>
  )
}
