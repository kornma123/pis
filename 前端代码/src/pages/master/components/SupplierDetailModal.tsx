import { X } from 'lucide-react'
import type { Supplier } from '@/types'

interface Props {
  open: boolean
  row: Supplier | null
  getAvatarColor: (name: string) => { bg: string; text: string }
  onClose: () => void
  onEdit: (row: Supplier) => void
}

export function SupplierDetailModal({ open, row, getAvatarColor, onClose, onEdit }: Props) {
  if (!open || !row) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">供应商详情</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="flex items-center gap-4 mb-6">
            <div
              className="w-[60px] h-[60px] rounded-xl flex items-center justify-center font-semibold text-2xl"
              style={{
                backgroundColor: getAvatarColor(row.name).bg,
                color: getAvatarColor(row.name).text,
              }}
            >
              {row.name.charAt(0)}
            </div>
            <div>
              <div className="text-lg font-semibold text-gray-900">{row.name}</div>
              <div className="text-sm text-gray-500">{row.code}</div>
            </div>
            <span className={`ml-auto inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              row.status === 'active'
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-600'
            }`}>
              {row.status === 'active' ? '合作中' : '已终止'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <div className="text-xl font-semibold text-blue-500">
                ¥{(row.totalAmount || 0).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500 mt-1">年度采购额</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <div className="text-xl font-semibold text-gray-900">
                {row.cooperationCount || 0}
              </div>
              <div className="text-xs text-gray-500 mt-1">合作次数</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <div className="text-xl font-semibold text-green-600">
                {'★'.repeat(row.rating || 5)}
              </div>
              <div className="text-xs text-gray-500 mt-1">信用评级</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-y-4 gap-x-6">
            <InfoItem label="联系人" value={row.contact} />
            <InfoItem label="联系电话" value={row.phone} />
            <InfoItem label="电子邮箱" value={row.email} />
            <InfoItem label="公司地址" value={row.address} />
            <InfoItem label="开户银行" value={row.bankName} />
            <InfoItem label="银行账号" value={row.bankAccount} />
            <InfoItem label="纳税人识别号" value={row.taxNo} />
            <InfoItem label="创建时间" value={row.createdAt ? row.createdAt.split('T')[0] : '-'} />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <button
            onClick={onClose}
            className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 transition-colors"
          >
            关闭
          </button>
          <button
            onClick={() => { onClose(); onEdit(row) }}
            className="h-10 px-4 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors"
          >
            编辑
          </button>
        </div>
      </div>
    </div>
  )
}

function InfoItem({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span className="text-sm text-gray-500">{label}：</span>
      <span className="text-sm text-gray-900 ml-2">{value || '-'}</span>
    </div>
  )
}
