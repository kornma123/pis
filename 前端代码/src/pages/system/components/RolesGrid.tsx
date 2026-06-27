import { Users, Database } from 'lucide-react'
import type { Role } from '@/types'
import { PERMISSION_MODULES } from '../hooks/useRolesPage'

interface Props {
  data: Role[]
  loading: boolean
  onDetail: (row: Role) => void
  onEdit: (row: Role) => void
  onDelete: (row: Role) => void
  getDataScopeLabel: (role: Role) => string
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

export function RolesGrid({ data, loading, onDetail, onEdit, onDelete, getDataScopeLabel }: Props) {
  if (loading) {
    return <div className="text-center py-12 text-gray-400">加载中...</div>
  }
  if (data.length === 0) {
    return <div className="text-center py-12 text-gray-400">暂无数据</div>
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
      {data.map(row => (
        <div key={row.id} className="bg-white border border-gray-200 rounded-lg p-5 transition-all hover:shadow-md hover:border-gray-300 shadow-sm">
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-base font-semibold text-gray-900">{row.name}</span>
              {getRoleBadge(row)}
            </div>
            <div className="text-sm text-gray-500">{row.description || '-'}</div>
          </div>
          <div className="flex items-center gap-4 mb-3">
            <div className="flex items-center gap-1.5 text-sm text-gray-500">
              <Users className="w-3.5 h-3.5" />
              {(row as any).userCount || 0} 人
            </div>
            <div className="flex items-center gap-1.5 text-sm text-gray-500">
              <Database className="w-3.5 h-3.5" />
              {getDataScopeLabel(row)}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-4 min-h-[28px]">
            {getPermissionChips(row)}
          </div>
          <div className="flex items-center gap-2 pt-3 border-t border-gray-200">
            <button onClick={() => onDetail(row)} className="h-8 px-3 text-xs text-gray-700 hover:bg-gray-100 rounded-md transition-colors">查看详情</button>
            {row.code !== 'admin' && (
              <>
                <button onClick={() => onEdit(row)} className="h-8 px-3 text-xs text-gray-700 hover:bg-gray-100 rounded-md transition-colors">编辑</button>
                <button onClick={() => onDelete(row)} className="h-8 px-3 text-xs text-red-500 hover:bg-red-50 rounded-md transition-colors">删除</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
