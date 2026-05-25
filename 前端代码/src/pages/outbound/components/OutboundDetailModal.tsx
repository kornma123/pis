import { X } from 'lucide-react'
import type { OutboundRecord, OutboundItem } from '@/types'
import { formatDate, formatCurrency } from '@/lib/utils'

interface OutboundDetailModalProps {
  open: boolean
  record: OutboundRecord | null
  onClose: () => void
  onPrint: (record: OutboundRecord) => void
}

const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
  completed: { label: '已完成', bg: 'bg-green-50', text: 'text-green-600' },
  pending: { label: '待出库', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  cancelled: { label: '已取消', bg: 'bg-red-50', text: 'text-red-600' },
}

export default function OutboundDetailModal({ open, record, onClose, onPrint }: OutboundDetailModalProps) {
  if (!open || !record) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">出库详情</h3>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors duration-150"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="text-xl font-semibold text-gray-900">{record.outboundNo}</div>
            <span
              className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${
                statusConfig[record.status]?.bg
              } ${statusConfig[record.status]?.text}`}
            >
              {statusConfig[record.status]?.label}
            </span>
          </div>
          <div className="text-sm text-gray-500">出库时间: {formatDate(record.createdAt)}</div>

          <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 rounded-md">
            <div>
              <div className="text-xs text-gray-500 mb-1">关联项目</div>
              <div className="text-sm font-medium text-gray-900">{record.projectName || '-'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">领用人</div>
              <div className="text-sm font-medium text-gray-900">{record.operator}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">操作人</div>
              <div className="text-sm font-medium text-gray-900">{record.operator}</div>
            </div>
          </div>

          <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">批号</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">出库数量</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">单位</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">单价</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">金额</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {record.items?.map((item: OutboundItem, i: number) => (
                <tr key={i}>
                  <td className="px-4 py-2 font-medium text-gray-900">{item.materialName || '-'}</td>
                  <td className="px-4 py-2 font-mono text-gray-500">{item.batchNo || '-'}</td>
                  <td className="px-4 py-2">{item.quantity}</td>
                  <td className="px-4 py-2 text-gray-500">{item.unit}</td>
                  <td className="px-4 py-2">{formatCurrency(item.unitCost)}</td>
                  <td className="px-4 py-2 font-medium">{formatCurrency(item.totalCost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-semibold">
                <td colSpan={5} className="px-4 py-2 text-right text-gray-700">合计:</td>
                <td className="px-4 py-2 text-gray-900">{formatCurrency(record.totalCost)}</td>
              </tr>
            </tfoot>
          </table>

          {record.remark && (
            <div className="p-3 bg-gray-50 rounded-md">
              <div className="text-xs text-gray-500 mb-1">备注</div>
              <div className="text-sm text-gray-700">{record.remark}</div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
          >
            关闭
          </button>
          <button
            onClick={() => onPrint(record)}
            className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
          >
            打印
          </button>
        </div>
      </div>
    </div>
  )
}
