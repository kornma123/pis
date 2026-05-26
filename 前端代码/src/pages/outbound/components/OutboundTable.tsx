import { X, Download, Printer } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import type { OutboundRecord } from '@/types'
import { formatDate } from '@/lib/utils'

const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
  completed: { label: '已完成', bg: 'bg-green-50', text: 'text-green-600' },
  pending: { label: '待出库', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  cancelled: { label: '已取消', bg: 'bg-red-50', text: 'text-red-600' },
}

const typeConfig: Record<string, string> = {
  project: '项目出库',
  transfer: '调拨出库',
  scrap: '报废出库',
}

interface OutboundTableProps {
  loading: boolean
  data: OutboundRecord[]
  selectedIds: Set<string>
  selectAll: boolean
  total: number
  page: number
  pageSize: number
  onToggleSelectAll: () => void
  onToggleSelectRow: (id: string) => void
  onClearSelection: () => void
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  onOpenDetail: (record: OutboundRecord) => void
  onOpenEdit: (record: OutboundRecord) => void
  onOpenDelete: (record: OutboundRecord) => void
  onOpenCancel: (record: OutboundRecord) => void
  onPrintRecord: (record: OutboundRecord) => void
  onBatchExport: () => void
  onBatchPrint: () => void
}

export default function OutboundTable({
  loading,
  data,
  selectedIds,
  selectAll,
  total,
  page,
  pageSize,
  onToggleSelectAll,
  onToggleSelectRow,
  onClearSelection,
  onPageChange,
  onPageSizeChange,
  onOpenDetail,
  onOpenEdit,
  onOpenDelete,
  onOpenCancel,
  onPrintRecord,
  onBatchExport,
  onBatchPrint,
}: OutboundTableProps) {
  return (
    <>
      {/* Batch Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between px-4 py-3 bg-blue-50 border-b border-blue-100">
          <div className="text-sm text-blue-700">
            已选择 <strong>{selectedIds.size}</strong> 项
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onBatchExport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-white rounded-md transition-colors duration-150"
            >
              <Download className="w-3.5 h-3.5" />
              导出
            </button>
            <button
              onClick={onBatchPrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-white rounded-md transition-colors duration-150"
            >
              <Printer className="w-3.5 h-3.5" />
              打印
            </button>
            <button
              onClick={onClearSelection}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-white rounded-md transition-colors duration-150"
            >
              <X className="w-3.5 h-3.5" />
              取消选择
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={selectAll}
                  onChange={onToggleSelectAll}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">出库单号</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">耗材名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">批号</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">出库类型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">数量</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">领用项目</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">领用人</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">出库时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[140px]">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-gray-400">加载中...</td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-gray-400">暂无数据</td>
              </tr>
            ) : (
              data.map(row => {
                const firstItem = row.items?.[0]
                const cfg = statusConfig[row.status] || statusConfig.completed
                return (
                  <tr
                    key={row.id}
                    className={`hover:bg-gray-50 transition-colors duration-150 ${
                      selectedIds.has(row.id) ? 'bg-blue-50' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={() => onToggleSelectRow(row.id)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600">{row.outboundNo}</td>
                    <td className="px-4 py-3">
                      <strong className="text-gray-900">{firstItem?.materialName || '-'}</strong>
                      {(row.items?.length || 0) > 1 && (
                        <span className="text-xs text-gray-400 ml-1">等{row.items?.length}项</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-500">{firstItem?.batchNo || '-'}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded text-xs bg-purple-50 text-purple-700">
                        {typeConfig[row.type] || row.type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {row.items?.reduce((sum, i) => sum + i.quantity, 0) || 0} {firstItem?.unit || '件'}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{row.projectName || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">{row.operator}</td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(row.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onOpenDetail(row)}
                          className="px-2 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors duration-150"
                        >
                          详情
                        </button>
                        <button
                          onClick={() => onPrintRecord(row)}
                          className="px-2 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors duration-150"
                        >
                          打印
                        </button>
                        {row.status === 'completed' && (
                          <>
                            <button
                              onClick={() => onOpenEdit(row)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors duration-150"
                            >
                              编辑
                            </button>
                            <button
                              onClick={() => onOpenDelete(row)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors duration-150"
                            >
                              删除
                            </button>
                          </>
                        )}
                        {row.status === 'pending' && (
                          <button
                            onClick={() => onOpenCancel(row)}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors duration-150"
                          >
                            取消出库
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

      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
        <span className="text-sm text-gray-500">共 {total} 条记录</span>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChangePage={onPageChange}
          onChangePageSize={onPageSizeChange}
        />
      </div>
    </>
  )
}
