import { Shield } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import type { Role } from '@/types'

interface Props {
  open: boolean
  role: Role | null
  onClose: () => void
  onConfirm: () => void
}

export function RoleDeleteModal({ open, role, onClose, onConfirm }: Props) {
  if (!open || !role) return null

  return (
    <Modal title="确认删除角色" description="此操作不可撤销，请核对后继续。" onClose={onClose} size="md">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-50 flex items-center justify-center">
            <Shield className="w-6 h-6 text-red-500" />
          </div>
          <h4 className="text-base font-semibold text-gray-900 mb-2">确定要删除该角色吗？</h4>
          <p className="text-sm text-gray-600 mb-4">角色记录将被永久删除。后端未返回关联用户，请先确认该角色已无人使用；若服务端拒绝，页面会保留当前数据。</p>
          <div className="bg-gray-50 rounded-lg p-3 text-left">
            <div className="text-xs text-gray-500 mb-1">待删除角色</div>
            <div className="font-semibold text-gray-900">{role.name}</div>
            <div className="text-xs text-amber-700 mt-2">关联用户数量：接口未提供</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">取消</button>
          <button onClick={onConfirm} className="h-10 px-4 text-sm font-medium text-white bg-red-500 rounded-md hover:bg-red-600 shadow-sm transition-all">确认删除</button>
        </div>
    </Modal>
  )
}
