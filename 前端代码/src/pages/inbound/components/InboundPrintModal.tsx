import { Printer } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import type { InboundRecord } from '@/types'
import { formatDateTime, formatCurrency } from '@/lib/utils'

interface InboundPrintModalProps {
  open: boolean
  data: InboundRecord[]
  selectedRecord: InboundRecord | null
  onClose: () => void
}

function getRecordStatus(row: InboundRecord) {
  return row.status
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    cancelled: '已取消',
  }
  return map[status] || status
}

export default function InboundPrintModal({ open, data, selectedRecord, onClose }: InboundPrintModalProps) {
  if (!open) return null

  return (
    <Modal onClose={onClose} title="打印预览" size="lg">
      <div className="border border-gray-200 rounded-lg p-6 bg-white">
        <div className="text-center mb-6">
          <div className="text-xl font-bold text-gray-900">入库记录报表</div>
          <div className="flex justify-center gap-6 mt-2 text-xs text-gray-500">
            <div>生成时间: {formatDateTime(new Date())}</div>
            <div>操作人: {selectedRecord ? selectedRecord.operator : (JSON.parse(localStorage.getItem('user') || '{}')?.name || 'system')}</div>
          </div>
        </div>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50">
              <th className="border border-gray-200 px-2 py-2 text-left">入库单号</th>
              <th className="border border-gray-200 px-2 py-2 text-left">耗材名称</th>
              <th className="border border-gray-200 px-2 py-2 text-left">批号</th>
              <th className="border border-gray-200 px-2 py-2 text-left">数量</th>
              <th className="border border-gray-200 px-2 py-2 text-left">单价</th>
              <th className="border border-gray-200 px-2 py-2 text-left">金额</th>
              <th className="border border-gray-200 px-2 py-2 text-left">供应商</th>
              <th className="border border-gray-200 px-2 py-2 text-left">入库时间</th>
              <th className="border border-gray-200 px-2 py-2 text-left">状态</th>
            </tr>
          </thead>
          <tbody>
            {(selectedRecord ? [selectedRecord] : data).map(row => (
              <tr key={row.id}>
                <td className="border border-gray-200 px-2 py-2 font-mono">{row.inboundNo}</td>
                <td className="border border-gray-200 px-2 py-2">{row.materialName}</td>
                <td className="border border-gray-200 px-2 py-2 font-mono">{row.batchNo || '-'}</td>
                <td className="border border-gray-200 px-2 py-2">{row.quantity}</td>
                <td className="border border-gray-200 px-2 py-2">{formatCurrency(row.price)}</td>
                <td className="border border-gray-200 px-2 py-2">{formatCurrency(row.amount ?? row.price * row.quantity)}</td>
                <td className="border border-gray-200 px-2 py-2">{row.supplierName || '-'}</td>
                <td className="border border-gray-200 px-2 py-2">{formatDateTime(row.createdAt)}</td>
                <td className="border border-gray-200 px-2 py-2">{getStatusLabel(getRecordStatus(row))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-center mt-4 text-xs text-gray-400">
          <div>本报表由 COREONE 系统自动生成</div>
          <div>第 1 页 / 共 1 页</div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => { window.print(); onClose() }}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors"
        >
          <Printer className="w-3.5 h-3.5" /> 打印
        </button>
      </div>
    </Modal>
  )
}
