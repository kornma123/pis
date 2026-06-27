import { X, Shield } from 'lucide-react'
import type { Role } from '@/types'
import { PERMISSION_MODULES } from '../hooks/useRolesPage'

interface Props {
  open: boolean
  role: Role | null
  onClose: () => void
}

function getRoleBadge(role: Role) {
  if (role.code === 'admin') {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-500 font-medium">系统角色</span>
  }
  return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">自定义</span>
}

function getPermissionChips(role: Role) {
  if (role.code === 'admin') return [<span key="all" className="text-xs px-2.5 py-1 rounded-full bg-green-50 text-green-500 font-medium">全部权限</span>]
  const perms = Array.isArray(role.permissions) ? role.permissions : Object.keys(role.permissions ?? {})
  const chips: string[] = []
  const uniqueModules = new Set<string>()
  perms.forEach(p => {
    const mod = p.split(':')[0]
    if (mod) uniqueModules.add(mod)
  })
  uniqueModules.forEach(mod => {
    const found = PERMISSION_MODULES.find(m => m.key === mod)
    if (found) chips.push(found.label)
  })
  return chips.slice(0, 4).map((c, i) => (
    <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-medium">{c}</span>
  ))
}

function getDataScopeLabel(role: Role) {
  if (role.code === 'admin') return '全部数据'
  return '本部门数据'
}

export function RoleDetailModal({ open, role, onClose }: Props) {
  if (!open || !role) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">角色详情</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-gray-900">{role.name}</span>
              {getRoleBadge(role)}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-5 mb-6">
            <div>
              <div className="text-xs text-gray-500 mb-1">用户数量</div>
              <div className="text-base font-semibold text-gray-900">{(role as any).userCount || 0} 人</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">数据权限</div>
              <div className="text-base font-semibold text-gray-900">{getDataScopeLabel(role)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">创建时间</div>
              <div className="text-base font-semibold text-gray-900">{role.createdAt ? new Date(role.createdAt).toLocaleDateString() : '-'}</div>
            </div>
          </div>

          <div className="mb-6">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">权限配置</h4>
            {role.code === 'admin' ? (
              <div className="bg-green-50 text-green-500 px-4 py-3 rounded-lg text-sm flex items-center gap-2">
                <Shield className="w-4 h-4" />
                拥有系统全部权限
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {getPermissionChips(role)}
              </div>
            )}
          </div>

          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3">关联用户</h4>
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
              <div className="px-4 py-3 text-sm text-gray-500">暂无关联用户数据</div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">关闭</button>
        </div>
      </div>
    </div>
  )
}
