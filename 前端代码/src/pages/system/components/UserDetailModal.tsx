import { X } from 'lucide-react'
import type { User } from '@/types'

interface Props {
  open: boolean
  user: User | null
  onClose: () => void
  onEdit: (user: User) => void
}

export function UserDetailModal({ open, user, onClose, onEdit }: Props) {
  if (!open || !user) return null

  const getAvatarChar = (name: string) => name ? name.charAt(0) : '?'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">用户详情</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-[60px] h-[60px] bg-blue-50 rounded-full flex items-center justify-center text-blue-500 font-semibold text-xl">
              {getAvatarChar(user.realName)}
            </div>
            <div className="flex-1">
              <div className="text-lg font-semibold text-gray-900">{user.realName}</div>
              <div className="text-[13px] text-gray-500">用户名: {user.username}</div>
            </div>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${user.status === 'active' ? 'bg-green-50 text-green-500' : 'bg-gray-100 text-gray-500'}`}>
              {user.status === 'active' ? '正常' : '禁用'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-5">
            <Info label="角色" value={user.role} />
            <Info label="部门" value={user.department || '-'} />
            <Info label="联系电话" value={user.phone || '-'} />
            <Info label="电子邮箱" value={user.email || '-'} />
            <Info label="创建时间" value={user.createdAt ? new Date(user.createdAt).toLocaleString() : '-'} />
            <Info label="最后登录" value="-" />
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-900">权限列表</h4>
              <span className="text-xs text-gray-500">数据范围: 本部门数据</span>
            </div>
            {user.permissions && user.permissions.length > 0 ? (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <span className="text-sm font-medium text-gray-900">系统权限</span>
                  <span className="text-xs text-gray-500">{user.permissions.length} 项权限</span>
                </div>
                <div className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {user.permissions.map(p => (
                      <span key={p} className="text-xs px-2.5 py-1 rounded-full bg-green-50 text-green-500 font-medium">已授权: {p}</span>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500 py-4">暂无权限信息</div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">关闭</button>
          <button onClick={() => { onClose(); onEdit(user); }} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 shadow-sm transition-all">编辑</button>
        </div>
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-[15px] font-semibold text-gray-900">{value}</div>
    </div>
  )
}
