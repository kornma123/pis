import type { InboundRecord } from '@/types'
import { formatDateTime, formatCurrency, cn } from '@/lib/utils'
import { Download, Printer } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'

function getTypeLabel(type: string): string {
  const map: Record<string, string> = {
    direct: '直接入库',
    purchase: '采购入库',
    return: '退库入库',
    transfer: '库位调拨',
    surplus: '盘盈入库',
    other: '其他入库',
  }
  return map[type] || type
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    cancelled: '已取消',
  }
  return map[status] || status
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-50 text-green-700 border-green-200'
    case 'cancelled':
      return 'bg-gray-100 text-gray-600 border-gray-200'
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function getSourceBadgeColor(type: string): string {
  switch (type) {
    case 'purchase':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'return':
      return 'bg-cyan-50 text-cyan-700 border-cyan-200'
    case 'direct':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'transfer':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'surplus':
      return 'bg-slate-50 text-slate-700 border-slate-200'
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200'
  }
}

function getRecordStatus(row: InboundRecord) {
  return row.status
}

interface InboundTableProps {
  data: InboundRecord[]
  loading: boolean
  error: string | null
  onRetry: () => void
  canWrite: boolean
  selectedIds: Set<string>
  onToggleSelectAll: () => void
  onToggleSelectOne: (id: string) => void
  isAllSelected: boolean
  isIndeterminate: boolean
  onClearSelection: () => void
  onDetail: (record: InboundRecord) => void
  onEdit: (record: InboundRecord) => void
  onDelete: (record: InboundRecord) => void
  onRestore: (record: InboundRecord) => void
  onPrint: (record: InboundRecord) => void
  onBatchExport: () => void
  onBatchPrint: () => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

export default function InboundTable({
  data,
  loading,
  error,
  onRetry,
  canWrite,
  selectedIds,
  onToggleSelectAll,
  onToggleSelectOne,
  isAllSelected,
  isIndeterminate,
  onClearSelection,
  onDetail,
  onEdit,
  onDelete,
  onRestore,
  onPrint,
  onBatchExport,
  onBatchPrint,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: InboundTableProps) {
  return (
    <>
      {/* 批量操作栏 */}
      {selectedIds.size > 0 && (
        <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
          <span className="text-sm text-blue-700">
            已选择 <strong>{selectedIds.size}</strong> 项
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onBatchExport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-white rounded-md border border-transparent hover:border-gray-200 transition-all"
            >
              <Download className="w-3.5 h-3.5" /> 导出
            </button>
            <button
              onClick={onBatchPrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-white rounded-md border border-transparent hover:border-gray-200 transition-all"
            >
              <Printer className="w-3.5 h-3.5" /> 打印
            </button>
            <button
              onClick={onClearSelection}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
            >
              取消选择
            </button>
          </div>
        </div>
      )}

      {/* 表格 */}
      <div className="max-w-full overflow-x-auto" aria-busy={loading}>
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 w-10 text-center">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  ref={el => { if (el) el.indeterminate = isIndeterminate }}
                  onChange={onToggleSelectAll}
                  aria-label="选择当前页全部入库记录"
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">入库单号</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">耗材名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">批号</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">入库来源</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">数量</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">金额</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">入库时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-40">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={11} className="px-4 py-12 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    加载中...
                  </div>
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center">
                  <div role="alert" className="mx-auto max-w-lg rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
                    <p className="font-medium">入库记录未能加载</p>
                    <p className="mt-1 text-sm">{error}</p>
                    <button type="button" onClick={onRetry} className="mt-3 min-h-10 rounded-md border border-red-300 bg-white px-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-red-500">重试</button>
                  </div>
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-12 text-center text-gray-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              data.map(row => {
                const status = getRecordStatus(row)
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      'hover:bg-gray-50 transition-colors',
                      selectedIds.has(row.id) && 'bg-blue-50'
                    )}
                  >
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={() => onToggleSelectOne(row.id)}
                        aria-label={`选择入库记录 ${row.inboundNo}`}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.inboundNo}</td>
                    <td className="px-4 py-3">
                      <strong className="text-gray-900 font-medium">{row.materialName}</strong>
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-500 text-xs">{row.batchNo || '-'}</td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs border', getSourceBadgeColor(row.type))}>
                        {getTypeLabel(row.type)}
                      </span>
                      {row.purchaseOrderNo && <div className="mt-1 text-xs text-gray-500">采购单 {row.purchaseOrderNo}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {row.quantity} {row.unit}
                    </td>
                    <td className="px-4 py-3 text-gray-700 font-medium">
                      {formatCurrency(row.amount ?? row.price * row.quantity)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{row.supplierName || '-'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{formatDateTime(row.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border', getStatusColor(status))}>
                        {getStatusLabel(status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onDetail(row)}
                          className="min-h-9 px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          详情
                        </button>
                        {canWrite && !row.purchaseOrderId && (
                          <button
                            onClick={() => onEdit(row)}
                            className="min-h-9 px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            编辑
                          </button>
                        )}
                        {canWrite && (
                          <button
                            onClick={() => onDelete(row)}
                            className="min-h-9 px-2 py-1 text-xs text-red-600 hover:text-red-900 hover:bg-red-50 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
                          >
                            删除
                          </button>
                        )}
                        {canWrite && status === 'cancelled' && (
                          <button onClick={() => onRestore(row)} className="min-h-9 px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500">恢复</button>
                        )}
                        {status !== 'cancelled' && (
                          <button onClick={() => onPrint(row)} className="min-h-9 px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500">打印</button>
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

      {/* 分页 */}
      {!error && <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />}
    </>
  )
}
