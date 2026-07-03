import { useRef, useEffect } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown, Download, Undo2, Inbox, CloudOff, RotateCcw } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { cn } from '@/lib/utils'
import type { LaneCConfig, LaneCRecord, SortField, SortOrder, Material } from '../types'

interface Props {
  config: LaneCConfig
  data: LaneCRecord[]
  loading: boolean
  error: string | null
  materials: Material[]
  canWrite: boolean
  isFilterActive: boolean
  selectedIds: Set<string>
  isAllSelected: boolean
  isIndeterminate: boolean
  onToggleSelectAll: () => void
  onToggleSelectOne: (id: string) => void
  sortField: SortField | ''
  sortOrder: SortOrder
  onSort: (field: SortField) => void
  onDetail: (row: LaneCRecord) => void
  onDelete: (row: LaneCRecord) => void
  onBatchExport: () => void
  onBatchDelete: () => void
  onRetry: () => void
  onResetFilters: () => void
  page: number
  pageSize: number
  total: number
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
}

export default function LaneCTable(p: Props) {
  const allRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = p.isIndeterminate }, [p.isIndeterminate])

  const colCount = p.config.columns.length + 2
  const th = 'px-4 py-3 text-xs font-medium text-gray-500 tracking-wider'

  const sortIcon = (field: SortField) => {
    if (p.sortField !== field) return <ArrowUpDown className="w-3.5 h-3.5 text-gray-300" />
    return p.sortOrder === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-blue-600" />
      : <ArrowDown className="w-3.5 h-3.5 text-blue-600" />
  }

  const stateRow = (content: React.ReactNode) => (
    <tr><td colSpan={colCount} className="px-4 py-14 text-center">{content}</td></tr>
  )

  return (
    <div>
      {p.selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-5 py-3 bg-blue-50 border-b border-blue-100 text-sm text-blue-700">
          <span>已选择 <strong className="tabular-nums">{p.selectedIds.size}</strong> 项</span>
          <button onClick={p.onBatchExport} className="h-8 px-3 inline-flex items-center gap-1.5 bg-white border border-gray-300 rounded-md text-xs text-gray-700 hover:bg-gray-50">
            <Download className="w-3.5 h-3.5" /> 批量导出
          </button>
          {p.canWrite && (
            <button onClick={p.onBatchDelete} className="h-8 px-3 inline-flex items-center gap-1.5 bg-white border border-red-200 rounded-md text-xs text-red-600 hover:bg-red-50">
              <Undo2 className="w-3.5 h-3.5" /> 批量撤销
            </button>
          )}
          <span className="ml-auto text-xs text-gray-500">批量撤销逐条执行，完成后汇总成功 / 失败数</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="w-10 pl-4 pr-0 py-3">
                <input ref={allRef} type="checkbox" checked={p.isAllSelected} onChange={p.onToggleSelectAll} aria-label="全选" className="cursor-pointer" />
              </th>
              {p.config.columns.map(col => (
                <th key={col.key} className={cn(th, col.align === 'right' ? 'text-right' : 'text-left')}>
                  {col.sortable ? (
                    <button onClick={() => p.onSort(col.sortable!)} className={cn('inline-flex items-center gap-1 hover:text-gray-700', col.align === 'right' && 'flex-row-reverse')}>
                      {col.label}{sortIcon(col.sortable)}
                    </button>
                  ) : col.label}
                </th>
              ))}
              <th className={cn(th, 'text-left')}>操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {p.loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: colCount }).map((__, j) => (
                    <td key={j} className="px-4 py-3.5"><div className="h-3 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : p.error ? (
              stateRow(
                <div className="flex flex-col items-center gap-2">
                  <CloudOff className="w-7 h-7 text-red-300" />
                  <div className="text-sm text-gray-600">数据没能加载</div>
                  <button onClick={p.onRetry} className="mt-1 h-8 px-3 inline-flex items-center gap-1.5 bg-white border border-gray-300 rounded-md text-xs text-gray-700 hover:bg-gray-50">
                    <RotateCcw className="w-3.5 h-3.5" /> 点击重试
                  </button>
                </div>
              )
            ) : p.data.length === 0 ? (
              p.isFilterActive ? stateRow(
                <div className="flex flex-col items-center gap-2">
                  <Inbox className="w-7 h-7 text-gray-300" />
                  <div className="text-sm text-gray-600">没有符合条件的记录</div>
                  <button onClick={p.onResetFilters} className="mt-1 h-8 px-3 bg-white border border-gray-300 rounded-md text-xs text-gray-700 hover:bg-gray-50">
                    清除筛选
                  </button>
                </div>
              ) : stateRow(
                <div className="flex flex-col items-center gap-2">
                  <Inbox className="w-7 h-7 text-gray-300" />
                  <div className="text-sm text-gray-600">本月还没有{p.config.noun}记录</div>
                  <div className="text-xs text-gray-400">点右上角“{p.config.createLabel}”登记第一条</div>
                </div>
              )
            ) : (
              p.data.map(row => {
                const checked = p.selectedIds.has(row.id)
                return (
                  <tr
                    key={row.id}
                    onClick={() => p.onDetail(row)}
                    className={cn('cursor-pointer transition-colors', checked ? 'bg-blue-50/60' : 'hover:bg-gray-50')}
                  >
                    <td className="w-10 pl-4 pr-0 py-3" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={checked} onChange={() => p.onToggleSelectOne(row.id)} aria-label={`选择 ${row.id}`} className="cursor-pointer" />
                    </td>
                    {p.config.columns.map(col => (
                      <td key={col.key} className={cn('px-4 py-3', col.align === 'right' ? 'text-right' : 'text-left')}>
                        {col.render(row, { materials: p.materials })}
                      </td>
                    ))}
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      {p.canWrite ? (
                        <button onClick={() => p.onDelete(row)} title="撤销" className="text-gray-400 hover:text-red-600 transition-colors">
                          <Undo2 className="w-4 h-4" />
                        </button>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
        <span className="text-sm text-gray-500 tabular-nums">共 {p.total} 条记录</span>
        <Pagination page={p.page} pageSize={p.pageSize} total={p.total} onChangePage={p.onPageChange} onChangePageSize={p.onPageSizeChange} />
      </div>
    </div>
  )
}
