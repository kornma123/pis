import { Modal } from '@/components/ui/Modal'
import type { User } from '@/types'

interface Props {
  open: boolean
  user: User | null
  canWrite: boolean
  onClose: () => void
  onEdit: (user: User) => void
}

export function UserDetailModal({ open, user, canWrite, onClose, onEdit }: Props) {
  if (!open || !user) return null

  const userWithRoles = user as User & { roles?: string[]; primaryRole?: string }
  const roles = Array.isArray(userWithRoles.roles) && userWithRoles.roles.length > 0
    ? userWithRoles.roles
    : [user.role]

  return (
    <Modal title="用户详情" onClose={onClose} size="lg">
        <div>
          <div className="flex items-center gap-4 mb-6">
            <div aria-hidden="true" className="w-[60px] h-[60px] bg-blue-50 rounded-full flex items-center justify-center text-blue-600 font-semibold text-xl">
              {user.realName ? user.realName.charAt(0) : '?'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-lg font-semibold text-gray-900 truncate">{user.realName}</div>
              <div className="text-[13px] text-gray-500">用户名：{user.username}</div>
            </div>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${user.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-600'}`}>
              {user.status === 'active' ? '正常' : '禁用'}
            </span>
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <Info label="已分配角色" value={roles.join('、')} />
            <Info label="主角色" value={userWithRoles.primaryRole || user.role} />
            <Info label="部门" value={user.department || '未填写'} />
            <Info label="联系电话" value={user.phone || '未填写'} />
            <Info label="电子邮箱" value={user.email || '未填写'} />
            <Info label="创建时间" value={user.createdAt ? new Date(user.createdAt).toLocaleString('zh-CN') : '接口未提供'} />
            <Info label="最近登录" value="接口未提供" />
          </dl>

          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <h4 className="text-sm font-semibold text-amber-900">用户能力</h4>
            <p className="mt-1 text-sm text-amber-800">
              当前用户列表接口未返回用户能力信息；页面不推断数据范围或权限项。实际访问以该账户登录后返回的 capabilities 为准。
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">关闭</button>
          {canWrite && (
            <button onClick={() => { onClose(); onEdit(user) }} className="h-10 px-4 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 shadow-sm transition-all">编辑</button>
          )}
        </div>
    </Modal>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500 mb-1">{label}</dt>
      <dd className="text-[15px] font-semibold text-gray-900 break-words">{value}</dd>
    </div>
  )
}
