import { X, AlertTriangle } from 'lucide-react'
import type { Project } from '@/types'

interface Props {
  open: boolean
  editingRow: Project | null
  onClose: () => void
  onConfirm: () => void
}

export function ProjectDeleteModal({ open, editingRow, onClose, onConfirm }: Props) {
  if (!open || !editingRow) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 text-center">
          <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-red-500" />
          <h3 className="text-base font-semibold text-gray-900 mb-2">确定要删除该检测服务吗？</h3>
          <p className="text-sm text-gray-500 mb-4">删除后将无法恢复，关联的BOM配置将解除关联</p>
          <div className="bg-gray-50 rounded-lg p-3 text-left">
            <div className="text-xs text-gray-500">待删除服务</div>
            <div className="font-semibold text-sm">{editingRow.code} {editingRow.name}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">
            取消
          </button>
          <button onClick={onConfirm} className="px-4 py-2 bg-red-500 text-white text-sm rounded-md hover:bg-red-600">
            确认删除
          </button>
        </div>
      </div>
    </div>
  )
}
