import { X, AlertTriangle } from 'lucide-react'
import type { Category } from '@/types'

interface Props {
  open: boolean
  target: Category | null
  onClose: () => void
  onConfirm: () => void
}

export function CategoryDeleteModal({ open, target, onClose, onConfirm }: Props) {
  if (!open || !target) return null

  const hasChildren = target.children && target.children.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6">
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-amber-800 mb-1">删除确认</div>
              <p className="text-amber-700">确定要删除分类 &quot;{target.name}&quot; 吗？</p>
              {hasChildren ? (
                <p className="text-amber-700 mt-1.5 text-xs">该分类下有 {target.children!.length} 个子分类，请先删除子分类。</p>
              ) : target.count ? (
                <p className="text-amber-700 mt-1.5 text-xs">该分类下有关联物料，删除后物料将变为未分类状态。</p>
              ) : (
                <p className="text-amber-700 mt-1.5 text-xs">此操作不可恢复。</p>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">取消</button>
          <button
            onClick={onConfirm}
            disabled={hasChildren}
            className="h-10 px-4 text-sm font-medium text-white bg-red-500 rounded-md hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  )
}
