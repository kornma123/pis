import { useEffect, useRef } from 'react'
import { Modal } from '@/components/ui/Modal'
import type { FormData, PermLevel } from '../hooks/useRolesPage'
import { PERMISSION_MODULES } from '../hooks/useRolesPage'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: FormData
  error?: string
  onClose: () => void
  onChange: (form: FormData) => void
  onSubmit: () => void
  onSetPermLevel: (moduleKey: string, level: PermLevel | null) => void
}

export function RoleFormModal({ open, type, form, error = '', onClose, onChange, onSubmit, onSetPermLevel }: Props) {
  const firstInputRef = useRef<HTMLInputElement>(null)
  const errorSummaryRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && error) errorSummaryRef.current?.focus()
    else if (open) firstInputRef.current?.focus()
  }, [open, type, error])

  if (!open) return null

  const LEVELS: { value: PermLevel | null; label: string }[] = [
    { value: null, label: '无' },
    { value: 'R', label: '只读' },
    { value: 'W', label: '读写' },
  ]

  return (
    <Modal title={type === 'create' ? '新建角色' : '编辑角色'} onClose={onClose} size="lg">
        <div>
          {error && <div ref={errorSummaryRef} role="alert" tabIndex={-1} className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 outline-none focus:ring-2 focus:ring-red-500/30">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">
            <div className="flex-1">
              <label htmlFor="role-name" className="block text-sm font-medium text-gray-700 mb-1.5">角色名称 <span className="text-red-500">*</span></label>
              <input
                ref={firstInputRef}
                id="role-name"
                value={form.name}
                onChange={e => onChange({ ...form, name: e.target.value })}
                placeholder="请输入角色名称"
                className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
            <div className="flex-1">
              <label htmlFor="role-code" className="block text-sm font-medium text-gray-700 mb-1.5">角色标识 <span className="text-red-500">*</span></label>
              <input
                id="role-code"
                value={form.code}
                onChange={e => onChange({ ...form, code: e.target.value })}
                placeholder={type === 'create' ? '请输入唯一角色标识' : ''}
                readOnly={type === 'edit'}
                className={`w-full h-10 px-3 text-sm border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 ${type === 'edit' ? 'bg-gray-50 text-gray-500' : 'bg-white text-gray-900'}`}
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">功能权限矩阵（每模块：无 / 只读 / 读写）</label>
            <div className="border border-gray-200 rounded-lg overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
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
                                aria-pressed={cur === lv.value}
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
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">取消</button>
          <button onClick={onSubmit} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 shadow-sm transition-all">
            {type === 'create' ? '创建角色' : '保存'}
          </button>
        </div>
    </Modal>
  )
}
