import type { Role } from '@/types'
import { PERMISSION_MODULES, normalizeRolePerms } from '../hooks/useRolesPage'

interface Props {
  data: Role[]
  loading: boolean
  error?: string | null
  canWrite: boolean
  onRetry?: () => void
  onDetail: (row: Role) => void
  onEdit: (row: Role) => void
  onDelete: (row: Role) => void
}

function permissionLabels(role: Role): string[] {
  const permissions = normalizeRolePerms(role.permissions)
  return Object.entries(permissions).map(([moduleKey, level]) => {
    const label = moduleKey === '*'
      ? '全部模块'
      : PERMISSION_MODULES.find(module => module.key === moduleKey)?.label || moduleKey
    return `${label} · ${level}`
  })
}

export function RolesGrid({ data, loading, error = null, canWrite, onRetry, onDetail, onEdit, onDelete }: Props) {
  if (loading) return <div className="text-center py-12 text-gray-500">正在加载角色...</div>
  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center text-sm text-red-700">
        <span>{error}</span>
        {onRetry && <button onClick={onRetry} className="h-9 px-3 rounded-md border border-red-200 bg-white hover:bg-red-50">重新加载</button>}
      </div>
    )
  }
  if (data.length === 0) return <div className="text-center py-12 text-gray-500">当前没有已记录角色</div>

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {data.map(role => {
        const permissions = permissionLabels(role)
        return (
          <article key={role.id} className="bg-white border border-gray-200 rounded-lg p-5 transition-all hover:shadow-md hover:border-gray-300 shadow-sm" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 220px' }}>
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-gray-900 break-words">{role.name}</h3>
                <p className="mt-1 font-mono text-xs text-gray-500 break-all">{role.code}</p>
              </div>
              <span className={`self-start text-xs px-2.5 py-1 rounded-full font-medium ${role.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                {role.status === 'active' ? '启用' : '停用'}
              </span>
            </div>
            <p className="text-sm text-gray-500 min-h-10">{role.description || '未填写说明'}</p>
            <div className="mt-3 text-xs text-gray-500">关联用户：接口未提供</div>
            <div className="flex flex-wrap gap-1.5 my-4 min-h-[28px]">
              {permissions.length > 0
                ? permissions.slice(0, 5).map(permission => <span key={permission} className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-medium">{permission}</span>)
                : <span className="text-xs text-gray-500">未配置模块权限</span>}
              {permissions.length > 5 && <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700">+{permissions.length - 5}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-200">
              <button onClick={() => onDetail(role)} className="h-8 px-3 text-xs text-gray-700 hover:bg-gray-100 rounded-md transition-colors">查看详情</button>
              {canWrite && (
                <>
                  <button onClick={() => onEdit(role)} className="h-8 px-3 text-xs text-gray-700 hover:bg-gray-100 rounded-md transition-colors">编辑</button>
                  <button onClick={() => onDelete(role)} className="h-8 px-3 text-xs text-red-600 hover:bg-red-50 rounded-md transition-colors">删除</button>
                </>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}
