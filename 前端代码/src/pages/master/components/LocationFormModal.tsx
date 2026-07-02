import { X } from 'lucide-react'
import type { Location } from '@/types'
import type { FormData, ModalType } from '../hooks/useLocationsPage'
import { typeOptions, getTypeIcon } from '../hooks/useLocationsPage'

interface Props {
  open: boolean
  type: ModalType
  form: FormData
  editingId: string | null
  data: Location[]
  flatLocations: Map<string, Location>
  levelConfigs: Record<string, string[]>
  onClose: () => void
  onChange: (form: FormData) => void
  onSubmit: () => void
}

export function LocationFormModal({
  open,
  type,
  form,
  data,
  flatLocations,
  levelConfigs,
  onClose,
  onChange,
  onSubmit,
}: Props) {
  if (!open || type === 'levelConfig') return null

  const labels = levelConfigs[form.type] || []
  const cols = labels.length >= 5 ? 3 : labels.length >= 3 ? 2 : 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            {type === 'create' ? '新建库位' : '编辑库位'}
          </h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                库位编码 <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">
                库位名称 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={e => onChange({ ...form, name: e.target.value })}
                placeholder="请输入库位名称"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              库位类型 <span className="text-red-500">*</span>
            </label>
            <select
              value={form.type}
              onChange={e => onChange({ ...form, type: e.target.value as FormData['type'] })}
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 bg-white cursor-pointer"
            >
              {typeOptions.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              上级库位 <span className="text-xs text-gray-400 font-normal ml-1">（留空则为顶级库位）</span>
            </label>
            <select
              value={form.parentId}
              onChange={e => {
                const pid = e.target.value
                const parent = pid ? flatLocations.get(pid) : null
                const ls = levelConfigs[form.type] || []
                const nextLevelData = [...form.levelData]
                if (parent && ls.length > 0) {
                  nextLevelData[0] = parent.zone || nextLevelData[0] || ''
                }
                onChange({ ...form, parentId: pid, levelData: nextLevelData })
              }}
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 bg-white cursor-pointer"
            >
              <option value="">无（作为顶级库位）</option>
              {data.map(loc => (
                <option key={loc.id} value={loc.id}>
                  {getTypeIcon(loc.type)} {loc.name} ({loc.zone})
                </option>
              ))}
            </select>
          </div>
          <div className={`grid grid-cols-${cols} gap-4`}>
            {labels.map((label, i) => (
              <div key={i}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {label} {i === 0 ? <span className="text-red-500">*</span> : ''}
                </label>
                <input
                  value={form.levelData[i] || ''}
                  onChange={e => {
                    const next = [...form.levelData]
                    next[i] = e.target.value
                    onChange({ ...form, levelData: next })
                  }}
                  placeholder={`请输入${label}`}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
                />
              </div>
            ))}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">容量限制</label>
            <input
              type="number"
              value={form.capacity}
              onChange={e => onChange({ ...form, capacity: Number(e.target.value) })}
              placeholder="请输入容量"
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
            <select
              value={form.status}
              onChange={e => onChange({ ...form, status: e.target.value as 'active' | 'inactive' })}
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 cursor-pointer"
            >
              <option value="active">已启用</option>
              <option value="inactive">已停用</option>
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
            取消
          </button>
          <button onClick={onSubmit} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors">
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
