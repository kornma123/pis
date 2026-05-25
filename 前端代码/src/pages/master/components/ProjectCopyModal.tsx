import { X } from 'lucide-react'
import type { Project } from '@/types'
import type { FormData } from '../hooks/useProjectsPage'

interface Props {
  open: boolean
  editingRow: Project | null
  form: FormData
  isSubmitting: boolean
  onClose: () => void
  onChange: (form: FormData) => void
  onConfirm: () => void
}

export function ProjectCopyModal({ open, editingRow, form, isSubmitting, onClose, onChange, onConfirm }: Props) {
  if (!open || !editingRow) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">复制检测服务</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-xs text-gray-500 mb-1">原服务</div>
            <div className="font-semibold text-sm">{editingRow.code} {editingRow.name}</div>
            <div className="text-xs text-gray-500 mt-1">
              BOM: {editingRow.bomId ? (editingRow.bomName || '已配置') : '未配置'}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              新服务名称 <span className="text-red-500">*</span>
            </label>
            <input
              value={form.name}
              onChange={e => onChange({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">复制内容</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked readOnly className="text-blue-600" />
                基本信息（类型、周期、负责人）
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked readOnly className="text-blue-600" />
                BOM配置（物料清单关联）
              </label>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={isSubmitting}
            className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50"
          >
            确认复制
          </button>
        </div>
      </div>
    </div>
  )
}
