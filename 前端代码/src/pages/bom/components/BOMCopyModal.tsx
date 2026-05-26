import { X } from 'lucide-react'
import type { CopyForm } from '../hooks/useBOMPage'
import type { BOM } from '@/types'

interface Props {
  open: boolean
  editingId: string | null
  copyForm: CopyForm
  data: BOM[]
  onClose: () => void
  onChange: (form: CopyForm) => void
  onConfirm: () => void
}

export function BOMCopyModal({
  open,
  editingId,
  copyForm,
  data,
  onClose,
  onChange,
  onConfirm,
}: Props) {
  if (!open) return null

  const original = data.find((d) => d.id === editingId)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">复制BOM</h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-gray-50 p-4 rounded-lg">
            <div className="text-xs text-gray-500 mb-1">原BOM</div>
            <div className="font-semibold text-gray-900">
              {original?.code} {original?.name}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              新BOM名称 <span className="text-red-500">*</span>
            </label>
            <input
              value={copyForm.name}
              onChange={(e) => onChange({ ...copyForm, name: e.target.value })}
              placeholder="请输入新BOM名称"
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">复制内容</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={copyForm.copyInfo}
                  onChange={(e) => onChange({ ...copyForm, copyInfo: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">基本信息（描述、关联服务）</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={copyForm.copyMaterials}
                  onChange={(e) => onChange({ ...copyForm, copyMaterials: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">物料清单（所有物料及用量）</span>
              </label>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm"
          >
            确认复制
          </button>
        </div>
      </div>
    </div>
  )
}
