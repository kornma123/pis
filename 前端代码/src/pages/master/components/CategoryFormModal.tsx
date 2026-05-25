import { X } from 'lucide-react'
import type { Category } from '@/types'
import type { FormData } from '../hooks/useCategoriesPage'

interface Props {
  open: boolean
  editingId: string | null
  form: FormData
  flatList: Category[]
  onClose: () => void
  onChange: (form: FormData) => void
  onSubmit: () => void
}

export function CategoryFormModal({ open, editingId, form, flatList, onClose, onChange, onSubmit }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">{editingId ? '编辑分类' : '新建分类'}</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              分类名称 <span className="text-red-500">*</span>
            </label>
            <input
              value={form.name}
              onChange={e => onChange({ ...form, name: e.target.value })}
              placeholder="请输入分类名称"
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              分类编码 <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
            </label>
            <input
              value={form.code}
              disabled
              readOnly
              placeholder="保存后自动生成"
              className="w-full h-10 px-3 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-500 cursor-not-allowed outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">上级分类</label>
            <select
              value={form.parentId || ''}
              onChange={e => onChange({ ...form, parentId: e.target.value || null })}
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 bg-white cursor-pointer"
            >
              <option value="">无（作为一级分类）</option>
              {flatList.filter(c => c.id !== editingId).map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">排序</label>
            <input
              type="number"
              value={form.sortOrder}
              onChange={e => onChange({ ...form, sortOrder: Number(e.target.value) })}
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">状态</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="radio"
                  name="status"
                  checked={form.status === 'active'}
                  onChange={() => onChange({ ...form, status: 'active' })}
                  className="w-4 h-4 text-blue-500"
                />
                启用
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="radio"
                  name="status"
                  checked={form.status === 'inactive'}
                  onChange={() => onChange({ ...form, status: 'inactive' })}
                  className="w-4 h-4 text-blue-500"
                />
                停用
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">备注</label>
            <textarea
              value={form.remark}
              onChange={e => onChange({ ...form, remark: e.target.value })}
              rows={2}
              placeholder="请输入备注信息"
              className="w-full h-10 px-3 py-2 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">取消</button>
          <button onClick={onSubmit} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors">保存</button>
        </div>
      </div>
    </div>
  )
}
