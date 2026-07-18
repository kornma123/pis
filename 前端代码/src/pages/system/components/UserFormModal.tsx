import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import type { FormData, RoleItem } from '../hooks/useUsersPage'
import { frontendSoDConflicts, generateStrongInitialPassword } from '../hooks/useUsersPage'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: FormData
  roles?: RoleItem[]
  error?: string
  onClose: () => void
  onChange: (form: FormData) => void
  onSubmit: () => void
}

export function UserFormModal({ open, type, form, roles = [], error = '', onClose, onChange, onSubmit }: Props) {
  const [showPassword, setShowPassword] = useState(false)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const errorSummaryRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && error) errorSummaryRef.current?.focus()
    else if (open) firstInputRef.current?.focus()
    else setShowPassword(false)
  }, [open, type, error])

  useEffect(() => {
    if (!showPassword) return undefined
    const timer = window.setTimeout(() => setShowPassword(false), 10_000)
    return () => window.clearTimeout(timer)
  }, [showPassword])

  if (!open) return null

  const roleLabel = (value: string) => roles.find(role => role.code === value)?.name || value
  const sodConflicts = frontendSoDConflicts(form.roles)
  const toggleRole = (value: string) => {
    const next = form.roles.includes(value) ? form.roles.filter(r => r !== value) : [...form.roles, value]
    const primary = next.includes(form.primaryRole) ? form.primaryRole : (next[0] || '')
    onChange({ ...form, roles: next, primaryRole: primary })
  }

  return (
    <Modal title={type === 'create' ? '新建用户' : '编辑用户'} onClose={onClose} size="lg">
        <div>
          {error && <div ref={errorSummaryRef} role="alert" tabIndex={-1} className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 outline-none focus:ring-2 focus:ring-red-500/30">{error}</div>}
          <div className="flex gap-5 mb-5">
            <div className="flex-1">
              <label htmlFor="user-username" className="block text-[13px] font-medium text-gray-700 mb-1.5">用户名 {type === 'create' && <span className="text-red-500">*</span>}</label>
              <input
                ref={firstInputRef}
                id="user-username"
                value={form.username}
                onChange={e => onChange({ ...form, username: e.target.value })}
                readOnly={type === 'edit'}
                className={`w-full h-10 px-3 text-sm text-gray-900 border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 ${type === 'edit' ? 'bg-gray-50 text-gray-400' : 'bg-white'}`}
              />
            </div>
            <div className="flex-1">
              <label htmlFor="user-real-name" className="block text-[13px] font-medium text-gray-700 mb-1.5">姓名 <span className="text-red-500">*</span></label>
              <input
                id="user-real-name"
                value={form.realName}
                onChange={e => onChange({ ...form, realName: e.target.value })}
                className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
          </div>
          <div className="mb-5">
            <label className="block text-[13px] font-medium text-gray-700 mb-1.5">角色（可多选，鉴权按能力并集）<span className="text-red-500">*</span></label>
            <div className="flex flex-wrap gap-2">
              {roles.map(role => {
                const checked = form.roles.includes(role.code)
                return (
                  <button
                    key={role.id}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggleRole(role.code)}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-all ${
                      checked ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {role.name}
                  </button>
                )
              })}
              {roles.length === 0 && <span role="status" className="text-sm text-amber-700">角色列表未加载，暂不能提交用户。</span>}
            </div>
            {form.roles.length > 1 && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <span className="text-gray-600">主角色（身份展示）</span>
                <select
                  value={form.primaryRole}
                  onChange={e => onChange({ ...form, primaryRole: e.target.value })}
                  className="h-9 px-2 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none focus:border-blue-500"
                >
                  {form.roles.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
              </div>
            )}
            {sodConflicts.length > 0 && (
              <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                ⚠ 职责分离(SoD)提醒：{sodConflicts.map(c => c.split('+').map(roleLabel).join(' + ')).join('；')}。可保存，但建议复核或走豁免审批。
              </div>
            )}
          </div>
          <div className="mb-5">
            <label className="block text-[13px] font-medium text-gray-700 mb-1.5">部门</label>
            <input
              value={form.department}
              onChange={e => onChange({ ...form, department: e.target.value })}
              placeholder="按实际组织名称填写"
              className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <div className="flex gap-5 mb-5">
            <div className="flex-1">
              <label className="block text-[13px] font-medium text-gray-700 mb-1.5">联系电话</label>
              <input
                value={form.phone}
                onChange={e => onChange({ ...form, phone: e.target.value })}
                className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[13px] font-medium text-gray-700 mb-1.5">电子邮箱</label>
              <input
                value={form.email}
                onChange={e => onChange({ ...form, email: e.target.value })}
                className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
          </div>
          {type === 'edit' && (
            <div className="mb-5">
              <label className="block text-[13px] font-medium text-gray-700 mb-1.5">状态</label>
              <select
                value={form.status}
                onChange={e => onChange({ ...form, status: e.target.value as 'active' | 'inactive' })}
                className="w-full h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
              >
                <option value="active">正常</option>
                <option value="inactive">禁用</option>
              </select>
            </div>
          )}
          {(type === 'create' || type === 'edit') && (
            <div>
              <label className="block text-[13px] font-medium text-gray-700 mb-1.5">
                {type === 'create' ? '初始密码' : '新密码'} {type === 'create' && <span className="text-red-500">*</span>}
              </label>
              <div className="flex gap-2">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => onChange({ ...form, password: e.target.value })}
                  placeholder={type === 'edit' ? '留空则不修改' : undefined}
                  autoComplete="new-password"
                  className="flex-1 h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
                />
                <button
                  type="button"
                  aria-label={showPassword ? '隐藏密码' : '显示密码 10 秒'}
                  onClick={() => setShowPassword(value => !value)}
                  className="h-10 w-10 inline-flex items-center justify-center text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => onChange({ ...form, password: generateStrongInitialPassword() })}
                  className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all"
                >随机生成</button>
              </div>
              <div className="text-xs text-gray-500 mt-1">至少 12 个字符且不超过 72 字节；禁止常见、重复或连续弱口令</div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">取消</button>
          <button onClick={onSubmit} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 shadow-sm transition-all">
            {type === 'create' ? '创建用户' : '保存'}
          </button>
        </div>
    </Modal>
  )
}
