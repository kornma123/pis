import { X } from 'lucide-react'
import type { OutboundRecord } from '@/types'

interface OutboundDeleteModalProps {
  open: boolean
  record: OutboundRecord | null
  onDelete: () => void
  onClose: () => void
}

export default function OutboundDeleteModal({ open, record, onDelete, onClose }: OutboundDeleteModalProps) {
  if (!open || !record) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors duration-150"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600">
            确定要删除出库单 <strong>{record.outboundNo}</strong> 吗？
          </p>
          <p className="text-sm text-gray-500">删除后将恢复库存并清除出库记录。此操作不可撤销。</p>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
          >
            取消
          </button>
          <button
            onClick={onDelete}
            className="px-4 py-2 text-sm text-white bg-red-500 rounded-md hover:bg-red-600 transition-colors duration-150"
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  )
}
