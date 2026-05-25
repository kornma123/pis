import { X } from 'lucide-react'
import type { FormData } from '../hooks/useSuppliersPage'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: FormData
  onClose: () => void
  onChange: (form: FormData) => void
  onSubmit: () => void
}

export function SupplierFormModal({ open, type, form, onClose, onChange, onSubmit }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">
            {type === 'create' ? '新增供应商' : '编辑供应商'}
          </h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                供应商名称 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) => onChange({ ...form, name: e.target.value })}
                placeholder="请输入供应商名称"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                供应商编码
                <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
              </label>
              <input
                value={form.code}
                disabled
                readOnly
                placeholder="保存后自动生成"
                className="w-full h-10 px-3 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                联系人 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.contact}
                onChange={(e) => onChange({ ...form, contact: e.target.value })}
                placeholder="请输入联系人姓名"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                联系电话 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.phone}
                onChange={(e) => onChange({ ...form, phone: e.target.value })}
                placeholder="请输入联系电话"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                电子邮箱
              </label>
              <input
                value={form.email}
                onChange={(e) => onChange({ ...form, email: e.target.value })}
                placeholder="请输入电子邮箱"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                合作状态 <span className="text-red-500">*</span>
              </label>
              <select
                value={form.status}
                onChange={(e) => onChange({ ...form, status: e.target.value as 'active' | 'inactive' })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                <option value="active">合作中</option>
                <option value="inactive">已终止</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              公司地址
            </label>
            <input
              value={form.address}
              onChange={(e) => onChange({ ...form, address: e.target.value })}
              placeholder="请输入公司地址"
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                开户银行
              </label>
              <input
                value={form.bankName}
                onChange={(e) => onChange({ ...form, bankName: e.target.value })}
                placeholder="请输入开户银行"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                银行账号
              </label>
              <input
                value={form.bankAccount}
                onChange={(e) => onChange({ ...form, bankAccount: e.target.value })}
                placeholder="请输入银行账号"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              纳税人识别号
            </label>
            <input
              value={form.taxNo}
              onChange={(e) => onChange({ ...form, taxNo: e.target.value })}
              placeholder="请输入纳税人识别号"
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <button
            onClick={onClose}
            className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onSubmit}
            className="h-10 px-4 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
