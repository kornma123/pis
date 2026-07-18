import { Modal } from '@/components/ui/Modal'
import type { Role } from '@/types'
import { PERMISSION_MODULES, normalizeRolePerms } from '../hooks/useRolesPage'

interface Props {
  open: boolean
  role: Role | null
  onClose: () => void
}

export function RoleDetailModal({ open, role, onClose }: Props) {
  if (!open || !role) return null

  const permissions = Object.entries(normalizeRolePerms(role.permissions)).map(([moduleKey, level]) => ({
    key: moduleKey,
    label: moduleKey === '*'
      ? '全部模块'
      : PERMISSION_MODULES.find(module => module.key === moduleKey)?.label || moduleKey,
    level,
  }))

  return (
    <Modal title="角色详情" onClose={onClose} size="lg">
        <div>
          <div className="mb-5">
            <div className="flex flex-wrap items-center gap-3">
              <h4 className="text-lg font-semibold text-gray-900">{role.name}</h4>
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${role.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                {role.status === 'active' ? '启用' : '停用'}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-gray-500 break-all">{role.code}</p>
            <p className="mt-3 text-sm text-gray-600">{role.description || '未填写说明'}</p>
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-6">
            <Info label="关联用户数量" value="接口未提供" />
            <Info label="数据范围" value="接口未提供" />
            <Info label="创建时间" value={role.createdAt ? new Date(role.createdAt).toLocaleDateString('zh-CN') : '接口未提供'} />
          </dl>

          <section className="mb-6" aria-labelledby="role-permissions-title">
            <h4 id="role-permissions-title" className="text-sm font-semibold text-gray-900 mb-3">后端返回的模块权限</h4>
            {permissions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {permissions.map(permission => (
                  <span key={permission.key} className="text-xs px-2.5 py-1 rounded-full bg-green-50 text-green-700 font-medium">
                    {permission.label} · {permission.level}
                  </span>
                ))}
              </div>
            ) : <p className="text-sm text-gray-500">未配置模块权限</p>}
          </section>

          <section aria-labelledby="role-users-title">
            <h4 id="role-users-title" className="text-sm font-semibold text-gray-900 mb-3">关联用户</h4>
            <div className="border border-amber-200 bg-amber-50 rounded-lg px-4 py-3 text-sm text-amber-800">接口未提供</div>
          </section>
        </div>
        <div className="flex items-center justify-end mt-6 pt-4 border-t border-gray-200">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">关闭</button>
        </div>
    </Modal>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-gray-500 mb-1">{label}</dt><dd className="text-base font-semibold text-gray-900">{value}</dd></div>
}
