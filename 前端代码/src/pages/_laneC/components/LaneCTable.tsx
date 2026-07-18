import { useRef, useEffect, type ReactNode } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown, Download, Undo2, Inbox, CloudOff, RotateCcw } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { cn } from '@/lib/utils'
import type { LaneCConfig, LaneCListPayload, LaneCRecord, SortField, SortOrder, Material } from '../types'
import { requestFailureMessage, type RequestTruth } from '../requestTruth'

interface Props {
  config: LaneCConfig
  state: RequestTruth<LaneCListPayload>
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
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

export default function LaneCTable(p: Props) {
  const allRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = p.isIndeterminate }, [p.isIndeterminate])

  const payload = p.state.status === 'ready' || p.state.status === 'stale' ? p.state.data : undefined
  const data = payload?.list ?? []
  const colCount = p.config.columns.length + 2
  const th = 'px-4 py-3 text-xs font-medium text-gray-500 tracking-wider'

  const sortIcon = (field: SortField) => {
    if (p.sortField !== field) return <ArrowUpDown className="w-3.5 h-3.5 text-gray-300" />
    return p.sortOrder === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-blue-600" />
      : <ArrowDown className="w-3.5 h-3.5 text-blue-600" />
  }

  const stateRow = (content: ReactNode) => (
    <tr><td colSpan={colCount} className="px-4 py-14 text-center">{content}</td></tr>
  )

  return (
    <div>
      {p.state.status === 'stale' && (
        <div role="alert" aria-label={`${p.config.noun}记录状态`} className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-800">
          <span className="flex-1">
            刷新失败，当前显示上次成功结果。{requestFailureMessage(p.state.failure, `${p.config.noun}记录`)}
          </span>
          <button onClick={p.onRetry} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 text-xs hover:bg-amber-100">
            <RotateCcw className="h-3.5 w-3.5" /> 重试
          </button>
        </div>
      )}

      {p.selectedIds.size > 0 && payload && (
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
                <input ref={allRef} type="checkbox" checked={p.isAllSelected} onChange={p.onToggleSelectAll} disabled={!payload} aria-label="全选" className="cursor-pointer disabled:cursor-not-allowed" />
              </th>
              {p.config.columns.map(column => (
                <th key={column.key} className={cn(th, column.align === 'right' ? 'text-right' : 'text-left')}>
                  {column.sortable ? (
                    <button onClick={() => p.onSort(column.sortable!)} className={cn('inline-flex items-center gap-1 hover:text-gray-700', column.align === 'right' && 'flex-row-reverse')}>
                      {column.label}{sortIcon(column.sortable)}
                    </button>
                  ) : column.label}
                </th>
              ))}
              <th className={cn(th, 'text-left')}>操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {p.state.status === 'loading' ? (
              Array.from({ length: 5 }).map((_, rowIndex) => (
                <tr key={rowIndex}>
                  {Array.from({ length: colCount }).map((__, columnIndex) => (
                    <td key={columnIndex} className="px-4 py-3.5"><div className="h-3 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : p.state.status === 'error' ? (
              stateRow(
                <div role="alert" aria-label={`${p.config.noun}记录状态`} className="flex flex-col items-center gap-2">
                  <CloudOff className="w-7 h-7 text-red-300" />
                  <div className="text-sm text-gray-600">{requestFailureMessage(p.state.failure, `${p.config.noun}记录`)}</div>
                  <button onClick={p.onRetry} className="mt-1 h-8 px-3 inline-flex items-center gap-1.5 bg-white border border-gray-300 rounded-md text-xs text-gray-700 hover:bg-gray-50">
                    <RotateCcw className="w-3.5 h-3.5" /> 点击重试
                  </button>
                </div>,
              )
            ) : data.length === 0 ? (
              p.isFilterActive ? stateRow(
                <div className="flex flex-col items-center gap-2">
                  <Inbox className="w-7 h-7 text-gray-300" />
                  <div className="text-sm text-gray-600">没有符合条件的记录</div>
                  <button onClick={p.onResetFilters} className="mt-1 h-8 px-3 bg-white border border-gray-300 rounded-md text-xs text-gray-700 hover:bg-gray-50">
                    清除筛选
                  </button>
                </div>,
              ) : stateRow(
                <div className="flex flex-col items-center gap-2">
                  <Inbox className="w-7 h-7 text-gray-300" />
                  <div className="text-sm text-gray-600">本月还没有{p.config.noun}记录</div>
                  <div className="text-xs text-gray-400">点右上角“{p.config.createLabel}”登记第一条</div>
                </div>,
              )
            ) : (
              data.map(row => {
                const checked = p.selectedIds.has(row.id)
                return (
                  <tr
                    key={row.id}
                    onClick={() => p.onDetail(row)}
                    className={cn('cursor-pointer transition-colors', checked ? 'bg-blue-50/60' : 'hover:bg-gray-50')}
                  >
                    <td className="w-10 pl-4 pr-0 py-3" onClick={event => event.stopPropagation()}>
                      <input type="checkbox" checked={checked} onChange={() => p.onToggleSelectOne(row.id)} aria-label={`选择 ${row.id}`} className="cursor-pointer" />
                    </td>
                    {p.config.columns.map(column => (
                      <td key={column.key} className={cn('px-4 py-3', column.align === 'right' ? 'text-right' : 'text-left')}>
                        {column.render(row, { materials: p.materials })}
                      </td>
                    ))}
                    <td className="px-4 py-3" onClick={event => event.stopPropagation()}>
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
        {payload ? (
          <>
            <span className="text-sm text-gray-500 tabular-nums">共 {payload.pagination.total} 条记录</span>
            <Pagination page={p.page} pageSize={p.pageSize} total={payload.pagination.total} onChangePage={p.onPageChange} onChangePageSize={p.onPageSizeChange} />
          </>
        ) : (
          <span className="text-sm text-gray-400">总数未确认</span>
        )}
      </div>
    </div>
  )
}
