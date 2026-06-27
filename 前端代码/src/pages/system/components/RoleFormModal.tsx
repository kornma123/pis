import { X } from 'lucide-react'
import type { FormData, PermLevel } from '../hooks/useRolesPage'
import { PERMISSION_MODULES, DATA_SCOPE_OPTIONS } from '../hooks/useRolesPage'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: FormData
  onClose: () => void
  onChange: (form: FormData) => void
  onSubmit: () => void
  onSetPermLevel: (moduleKey: string, level: PermLevel | null) => void
}

export function RoleFormModal({ open, type, form, onClose, onChange, onSubmit, onSetPermLevel }: Props) {
  if (!open) return null

  const LEVELS: { value: PermLevel | null; label: string }[] = [
    { value: null, label: '无' },
    { value: 'R', label: '只读' },
    { value: 'W', label: '读写' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">{type === 'create' ? '新建角色' : '编辑角色'}</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="flex gap-5 mb-5">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">角色名称 <span className="text-red-500">*</span></label>
              <input
                value={form.name}
                onChange={e => onChange({ ...form, name: e.target.value })}
                placeholder="请输入角色名称"
                className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">角色标识</label>
              <input
                value={form.code}
                onChange={e => onChange({ ...form, code: e.target.value })}
                placeholder={type === 'create' ? '系统自动生成' : ''}
                disabled={type === 'create'}
                readOnly={type === 'edit'}
                className={`w-full h-10 px-3 text-sm border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 ${type === 'edit' ? 'bg-gray-50 text-gray-400' : 'bg-gray-50 text-gray-400'}`}
              />
            </div>
          </div>
          <div className="mb-5">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">角色描述</label>
            <input
              value={form.description}
              onChange={e => onChange({ ...form, description: e.target.value })}
              placeholder="请输入角色描述"
              className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>

          <div className="mb-5">
            <label className="block text-sm font-medium text-gray-700 mb-2">数据权限范围</label>
            <div className="grid grid-cols-3 gap-3">
              {DATA_SCOPE_OPTIONS.map(opt => (
                <label
                  key={opt.value}
                  onClick={() => onChange({ ...form, dataScope: opt.value })}
                  className={`flex flex-col gap-1 p-4 border rounded-lg cursor-pointer transition-all ${form.dataScope === opt.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}
                >
                  <div className="flex items-center gap-2">
                    <input type="radio" name="dataScope" checked={form.dataScope === opt.value} readOnly className="text-blue-500" />
                    <span className="text-sm font-medium text-gray-900">{opt.label}</span>
                  </div>
                  <span className="text-xs text-gray-500 ml-6">{opt.desc}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">功能权限矩阵（每模块：无 / 只读 / 读写）</label>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-700">模块</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-700 w-[220px]">权限</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {PERMISSION_MODULES.map(mod => {
                    const cur = form.permissions[mod.key] ?? null
                    return (
                      <tr key={mod.key} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-900">{mod.label}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-center gap-1">
                            {LEVELS.map(lv => (
                              <button
                                key={lv.label}
                                type="button"
                                onClick={() => onSetPermLevel(mod.key, lv.value)}
                                className={`px-3 py-1 rounded-md text-xs font-medium border transition-all ${
                                  cur === lv.value
                                    ? 'bg-blue-500 text-white border-blue-500'
                                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                                }`}
                              >
                                {lv.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">取消</button>
          <button onClick={onSubmit} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 shadow-sm transition-all">
            {type === 'create' ? '创建角色' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
