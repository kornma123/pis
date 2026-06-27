import { X } from 'lucide-react'
import type { User } from '@/types'
import type { FormData } from '../hooks/useUsersPage'
import { frontendSoDConflicts } from '../hooks/useUsersPage'

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'admin', label: '系统管理员' },
  { value: 'lab_director', label: '实验室主任' },
  { value: 'warehouse_manager', label: '仓库管理员' },
  { value: 'technician', label: '技术员' },
  { value: 'pathologist', label: '病理医师' },
  { value: 'procurement', label: '采购员' },
  { value: 'finance', label: '财务' },
]
const roleLabel = (v: string) => ROLE_OPTIONS.find(r => r.value === v)?.label || v

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: FormData
  onClose: () => void
  onChange: (form: FormData) => void
  onSubmit: () => void
  onResetPassword: () => void
}

export function UserFormModal({ open, type, form, onClose, onChange, onSubmit, onResetPassword }: Props) {
  if (!open) return null

  const sodConflicts = frontendSoDConflicts(form.roles)
  const toggleRole = (value: string) => {
    const next = form.roles.includes(value) ? form.roles.filter(r => r !== value) : [...form.roles, value]
    const primary = next.includes(form.primaryRole) ? form.primaryRole : (next[0] || '')
    onChange({ ...form, roles: next, primaryRole: primary })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">{type === 'create' ? '新建用户' : '编辑用户'}</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="flex gap-5 mb-5">
            <div className="flex-1">
              <label className="block text-[13px] font-medium text-gray-700 mb-1.5">用户名 {type === 'create' && <span className="text-red-500">*</span>}</label>
              <input
                value={form.username}
                onChange={e => onChange({ ...form, username: e.target.value })}
                readOnly={type === 'edit'}
                className={`w-full h-10 px-3 text-sm text-gray-900 border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 ${type === 'edit' ? 'bg-gray-50 text-gray-400' : 'bg-white'}`}
              />
            </div>
            <div className="flex-1">
              <label className="block text-[13px] font-medium text-gray-700 mb-1.5">姓名 <span className="text-red-500">*</span></label>
              <input
                value={form.realName}
                onChange={e => onChange({ ...form, realName: e.target.value })}
                className="w-full h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
          </div>
          <div className="mb-5">
            <label className="block text-[13px] font-medium text-gray-700 mb-1.5">角色（可多选，鉴权按能力并集）<span className="text-red-500">*</span></label>
            <div className="flex flex-wrap gap-2">
              {ROLE_OPTIONS.map(r => {
                const checked = form.roles.includes(r.value)
                return (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => toggleRole(r.value)}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-all ${
                      checked ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {r.label}
                  </button>
                )
              })}
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
            <select
              value={form.department}
              onChange={e => onChange({ ...form, department: e.target.value })}
              className="w-full h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
            >
              <option value="">请选择部门</option>
              <option value="病理科">病理科</option>
              <option value="检验科">检验科</option>
              <option value="信息科">信息科</option>
              <option value="财务科">财务科</option>
              <option value="设备科">设备科</option>
            </select>
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
          {type === 'create' && (
            <div>
              <label className="block text-[13px] font-medium text-gray-700 mb-1.5">初始密码 <span className="text-red-500">*</span></label>
              <div className="flex gap-2">
                <input value="Abc@123456" readOnly className="flex-1 h-10 px-3 text-sm text-gray-900 bg-gray-50 border border-gray-300 rounded-md outline-none" />
                <button className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">随机生成</button>
              </div>
              <div className="text-xs text-gray-500 mt-1">初始密码将在用户首次登录时要求修改</div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">取消</button>
          {type === 'edit' && (
            <button onClick={onResetPassword} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">重置密码</button>
          )}
          <button onClick={onSubmit} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 shadow-sm transition-all">
            {type === 'create' ? '创建用户' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
