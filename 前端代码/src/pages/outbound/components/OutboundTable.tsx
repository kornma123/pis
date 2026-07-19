import { ArrowDown, ArrowUp, ArrowUpDown, Download, Printer, X } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import type { OutboundRecord } from '@/types'
import { formatDate } from '@/lib/utils'

export type OutboundSortField = 'createdAt' | 'totalCost' | 'quantity'
export type OutboundSortOrder = 'asc' | 'desc'

const statusConfig: Record<string, { label: string; className: string }> = {
  completed: { label: '已完成', className: 'bg-green-50 text-green-700' },
  pending: { label: '待出库', className: 'bg-amber-50 text-amber-700' },
  cancelled: { label: '已取消', className: 'bg-red-50 text-red-700' },
}

const typeConfig: Record<string, string> = {
  direct: '常规出库',
  project: '项目出库',
  transfer: '调拨出库',
  scrap: '报废出库',
}

interface SortButtonProps {
  field: OutboundSortField
  label: string
  activeField: OutboundSortField
  order: OutboundSortOrder
  onSort: (field: OutboundSortField) => void
}

function SortButton({ field, label, activeField, order, onSort }: SortButtonProps) {
  return (
    <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 hover:text-gray-900">
      {label}
      {activeField !== field ? <ArrowUpDown className="h-3 w-3 opacity-50" /> : order === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
    </button>
  )
}

interface OutboundTableProps {
  loading: boolean
  stale?: boolean
  canWrite?: boolean
  data: OutboundRecord[]
  selectedIds: Set<string>
  selectAll: boolean
  total: number
  page: number
  pageSize: number
  sortField: OutboundSortField
  sortOrder: OutboundSortOrder
  onSort: (field: OutboundSortField) => void
  onToggleSelectAll: () => void
  onToggleSelectRow: (id: string) => void
  onClearSelection: () => void
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  onOpenDetail: (record: OutboundRecord) => void
  onOpenEdit: (record: OutboundRecord) => void
  onOpenDelete: (record: OutboundRecord) => void
  onPrintRecord: (record: OutboundRecord) => void
  onBatchExport: () => void
  onBatchPrint: () => void
}

export default function OutboundTable({
  loading,
  stale = false,
  canWrite = false,
  data,
  selectedIds,
  selectAll,
  total,
  page,
  pageSize,
  sortField,
  sortOrder,
  onSort,
  onToggleSelectAll,
  onToggleSelectRow,
  onClearSelection,
  onPageChange,
  onPageSizeChange,
  onOpenDetail,
  onOpenEdit,
  onOpenDelete,
  onPrintRecord,
  onBatchExport,
  onBatchPrint,
}: OutboundTableProps) {
  return (
    <>
      {selectedIds.size > 0 && (
        <div className="flex flex-col gap-3 border-b border-blue-100 bg-blue-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-blue-800">已选择 <strong>{selectedIds.size}</strong> 条当前页记录</span>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onBatchExport} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3 text-sm text-gray-700 shadow-sm hover:text-blue-700"><Download className="h-4 w-4" />导出</button>
            <button type="button" onClick={onBatchPrint} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3 text-sm text-gray-700 shadow-sm hover:text-blue-700"><Printer className="h-4 w-4" />打印</button>
            <button type="button" aria-label="清除已选出库记录" onClick={onClearSelection} className="rounded-md p-2 text-gray-500 hover:bg-white"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-[1120px] w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="w-12 px-4 py-3">
                <label htmlFor="outbound-select-page" className="sr-only">选择当前页全部出库记录</label>
                <input id="outbound-select-page" type="checkbox" checked={selectAll} onChange={onToggleSelectAll} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">出库单号</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">物料</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">FEFO 批次分配</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">类型</th>
              <th aria-sort={sortField === 'quantity' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4 py-3 text-left text-xs font-medium text-gray-600"><SortButton field="quantity" label="出库数量" activeField={sortField} order={sortOrder} onSort={onSort} /></th>
              <th aria-sort={sortField === 'totalCost' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4 py-3 text-left text-xs font-medium text-gray-600"><SortButton field="totalCost" label="总金额" activeField={sortField} order={sortOrder} onSort={onSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">关联项目</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">后端记录操作人</th>
              <th aria-sort={sortField === 'createdAt' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4 py-3 text-left text-xs font-medium text-gray-600"><SortButton field="createdAt" label="出库时间" activeField={sortField} order={sortOrder} onSort={onSort} /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">状态</th>
              <th className="w-40 px-4 py-3 text-left text-xs font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && data.length === 0 ? (
              Array.from({ length: 4 }, (_, index) => <tr key={index} aria-label="正在加载出库记录" className="animate-pulse"><td colSpan={12} className="px-4 py-3"><div className="h-8 rounded bg-gray-100" /></td></tr>)
            ) : data.length === 0 ? (
              <tr><td colSpan={12} className="px-4 py-14 text-center"><div className="font-medium text-gray-900">暂无出库记录</div><div className="mt-1 text-sm text-gray-500">当前筛选由接口成功返回 0 条记录。</div></td></tr>
            ) : data.map(record => {
              const firstItem = record.items?.[0]
              const allocations = record.items?.length ?? 0
              const status = statusConfig[record.status] ?? { label: record.status || '未知', className: 'bg-gray-100 text-gray-700' }
              return (
                <tr key={record.id} className={`[content-visibility:auto] [contain-intrinsic-size:0_58px] hover:bg-gray-50 ${selectedIds.has(record.id) ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-3"><label htmlFor={`outbound-select-${record.id}`} className="sr-only">选择出库单 {record.outboundNo}</label><input id={`outbound-select-${record.id}`} type="checkbox" checked={selectedIds.has(record.id)} onChange={() => onToggleSelectRow(record.id)} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" /></td>
                  <td className="px-4 py-3 font-mono text-gray-700">{record.outboundNo}</td>
                  <td className="px-4 py-3"><span className="font-medium text-gray-900">{firstItem?.materialName || '物料名称未提供'}</span>{allocations > 1 && <span className="ml-1 text-xs text-gray-500">共 {allocations} 条物料/批次分配</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{firstItem?.batchNo || '未取得批次证据'}{allocations > 1 && <span className="ml-1 font-sans text-gray-500">（详情见全部）</span>}</td>
                  <td className="px-4 py-3"><span className="rounded bg-purple-50 px-2 py-1 text-xs text-purple-700">{typeConfig[record.type] || record.type}</span></td>
                  <td className="px-4 py-3 tabular-nums">{record.items?.reduce((sum, item) => sum + item.quantity, 0) ?? '—'} {firstItem?.unit || ''}</td>
                  <td className="px-4 py-3 tabular-nums text-gray-700">{typeof record.totalCost === 'number' ? `¥${record.totalCost.toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{record.projectName || '公共成本'}</td>
                  <td className="px-4 py-3 text-gray-700">{record.operator || '未提供'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(record.createdAt)}</td>
                  <td className="px-4 py-3"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${status.className}`}>{status.label}</span></td>
                  <td className="px-4 py-3"><div className="flex items-center gap-1"><button type="button" onClick={() => onOpenDetail(record)} className="rounded px-2 py-1 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700">详情</button><button type="button" onClick={() => onPrintRecord(record)} className="rounded px-2 py-1 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700">打印</button>{canWrite && !stale && record.status === 'completed' && <><button type="button" onClick={() => onOpenEdit(record)} className="rounded px-2 py-1 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700">编辑</button><button type="button" onClick={() => onOpenDelete(record)} className="rounded px-2 py-1 text-xs text-gray-700 hover:bg-red-50 hover:text-red-700">删除</button></>}</div></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 border-t border-gray-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-gray-500">接口共返回 {total.toLocaleString('zh-CN')} 条记录</span>
        <Pagination page={page} pageSize={pageSize} total={total} onChangePage={onPageChange} onChangePageSize={onPageSizeChange} />
      </div>
    </>
  )
}
