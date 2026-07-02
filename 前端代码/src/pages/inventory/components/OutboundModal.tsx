import { X, Trash2, Plus } from 'lucide-react'
import type { Project } from '@/types'

interface OutboundMaterial {
  rowId: number
  materialId: string
  name: string
  spec: string
  batch?: string
  stock: number
  quantity: number
  unit: string
  project: string
  user: string
  usage: 'self' | 'external'
  receiver: string
}

interface Props {
  open: boolean
  materials: OutboundMaterial[]
  remark: string
  projectList: Project[]
  userList: { id: string; real_name: string }[]
  onClose: () => void
  onAddMaterial: () => void
  onRemoveItem: (rowId: number) => void
  onUpdateQuantity: (rowId: number, value: string) => void
  onUpdateProject: (rowId: number, value: string) => void
  onUpdateUser: (rowId: number, value: string) => void
  onUpdateUsage: (rowId: number, value: 'self' | 'external') => void
  onUpdateReceiver: (rowId: number, value: string) => void
  onChangeRemark: (v: string) => void
  onConfirm: () => void
}

export function OutboundModal({
  open,
  materials,
  remark,
  projectList,
  userList,
  onClose,
  onAddMaterial,
  onRemoveItem,
  onUpdateQuantity,
  onUpdateProject,
  onUpdateUser,
  onUpdateUsage,
  onUpdateReceiver,
  onChangeRemark,
  onConfirm,
}: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/[0.6]">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-lg w-full max-w-[1100px] max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 tracking-normal">出库登记</h3>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-all duration-150 ease"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="mb-5">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-base font-semibold text-gray-900">出库明细</h4>
              <button
                onClick={onAddMaterial}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <Plus className="w-3.5 h-3.5" />
                添加物料
              </button>
            </div>

            {materials.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <svg className="w-12 h-12 mx-auto mb-3 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                </svg>
                <div className="text-sm">请选择物料或点击"添加物料"按钮</div>
              </div>
            ) : (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-[13px] border-collapse">
                  <thead>
                    <tr>
                      <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">物料名称</th>
                      <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">关联项目</th>
                      <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">批次号</th>
                      <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">库存</th>
                      <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200 w-[90px]">出库数量</th>
                      <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200 w-[120px]">领用人</th>
                      <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200 w-[50px]">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f3f4f6]">
                    {materials.map(m => (
                      <tr key={m.rowId} className="hover:bg-gray-50 transition-colors duration-150 ease">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{m.name}</div>
                          <div className="text-xs text-gray-500">{m.spec}</div>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={m.project}
                            onChange={e => onUpdateProject(m.rowId, e.target.value)}
                            className="h-8 px-3 border border-gray-300 rounded-md text-xs bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                          >
                            <option value="">公共成本</option>
                            {projectList.map(p => (
                              <option key={p.id} value={p.name}>{p.name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{m.batch || '-'}</td>
                        <td className="px-4 py-3 text-gray-900">{m.stock}</td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={m.quantity}
                            min={1}
                            max={m.stock}
                            onChange={e => onUpdateQuantity(m.rowId, e.target.value)}
                            className="w-[70px] h-8 px-3 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={m.user}
                            onChange={e => onUpdateUser(m.rowId, e.target.value)}
                            className="h-8 px-3 border border-gray-300 rounded-md text-xs bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                          >
                            <option value="">选择领用人</option>
                            {userList.map(u => (
                              <option key={u.id} value={u.real_name}>{u.real_name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={m.usage}
                            onChange={e => onUpdateUsage(m.rowId, e.target.value as 'self' | 'external')}
                            className="h-8 px-3 border border-gray-300 rounded-md text-xs bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                          >
                            <option value="self">自用</option>
                            <option value="external">外给</option>
                          </select>
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="text"
                            value={m.receiver}
                            onChange={e => onUpdateReceiver(m.rowId, e.target.value)}
                            placeholder={m.usage === 'external' ? '接收方名称' : '-'}
                            disabled={m.usage === 'self'}
                            className="w-[120px] h-8 px-3 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100 disabled:text-gray-400 transition-all duration-150 ease"
                          />
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => onRemoveItem(m.rowId)}
                            className="text-red-500 hover:text-red-600 transition-colors duration-150 ease"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="mt-5">
            <label className="block text-[13px] font-medium text-gray-700 mb-1.5">备注</label>
            <textarea
              value={remark}
              onChange={e => onChangeRemark(e.target.value)}
              rows={2}
              placeholder="请输入出库备注信息（可选）"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease resize-none"
            />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease shadow-sm focus:outline-none focus:ring-2 focus:ring-gray-400/30"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={materials.length === 0}
            className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            确认出库
          </button>
        </div>
      </div>
    </div>
  )
}
