import { X, Loader2 } from 'lucide-react'
import type { Project, BOM } from '@/types'
import type { FormData } from '../hooks/useProjectsPage'

interface Props {
  open: boolean
  editingRow: Project | null
  form: FormData
  editTab: 'basic' | 'bom'
  boms: BOM[]
  isSubmitting: boolean
  onClose: () => void
  onChange: (form: FormData) => void
  onSetEditTab: (tab: 'basic' | 'bom') => void
  onSubmit: () => void
  onOpenDelete: (row: Project) => void
}

export function ProjectEditModal({
  open, editingRow, form, editTab, boms, isSubmitting,
  onClose, onChange, onSetEditTab, onSubmit, onOpenDelete,
}: Props) {
  if (!open || !editingRow) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">编辑检测服务</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="px-6 pt-4 border-b border-gray-200 shrink-0">
          <div className="flex gap-1">
            <button
              onClick={() => onSetEditTab('basic')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                editTab === 'basic' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              基本信息
            </button>
            <button
              onClick={() => onSetEditTab('bom')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                editTab === 'bom' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              BOM配置
            </button>
          </div>
        </div>
        <div className="p-6 overflow-y-auto">
          {editTab === 'basic' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">服务类型</label>
                  <select
                    value={form.type}
                    onChange={e => onChange({ ...form, type: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="he">病理技术-HE制片</option>
                    <option value="ihc">病理技术-免疫组化</option>
                    <option value="ss">病理技术-特殊染色</option>
                    <option value="mp">分子诊断</option>
                    <option value="cyto">病理诊断-细胞学检测</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">服务编号</label>
                  <input
                    value={form.code}
                    readOnly
                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    服务名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.name}
                    onChange={e => onChange({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">检测周期</label>
                  <input
                    value={form.cycle}
                    onChange={e => onChange({ ...form, cycle: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">负责人</label>
                  <input
                    value={form.manager}
                    onChange={e => onChange({ ...form, manager: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                  <div className="flex gap-4 mt-2">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="edit-status"
                        checked={form.status === 'active'}
                        onChange={() => onChange({ ...form, status: 'active' })}
                        className="text-blue-600"
                      />已启用
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="edit-status"
                        checked={form.status === 'inactive'}
                        onChange={() => onChange({ ...form, status: 'inactive' })}
                        className="text-blue-600"
                      />已停用
                    </label>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">服务描述</label>
                <textarea
                  value={form.description}
                  onChange={e => onChange({ ...form, description: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    当前BOM: {editingRow.bomId ? (editingRow.bomName || '已配置') : '未配置'}
                  </span>
                  <button className="text-sm text-blue-600 hover:text-blue-700">
                    前往BOM管理
                  </button>
                </div>
              </div>
              {editingRow.bomId && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-200 rounded-lg">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">序号</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">规格型号</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">用量/样本</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单位</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单价</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库存状态</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {boms.find(b => b.id === editingRow.bomId)?.materials?.map((m, i) => (
                        <tr key={m.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                          <td className="px-3 py-2 font-medium">{m.name}</td>
                          <td className="px-3 py-2 text-gray-500">{m.spec}</td>
                          <td className="px-3 py-2">{m.usagePerSample}</td>
                          <td className="px-3 py-2">{m.unit}</td>
                          <td className="px-3 py-2">¥{m.price}/{m.unit}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              m.stock > 10 ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'
                            }`}>
                              {m.stock > 10 ? '充足' : '偏低'}
                            </span>
                          </td>
                        </tr>
                      )) || (
                        <tr>
                          <td colSpan={7} className="px-3 py-4 text-center text-gray-400 text-sm">
                            暂无物料数据
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="flex gap-3">
                <button className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">
                  更换BOM
                </button>
                <button className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-sm">
                  编辑BOM详情
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 shrink-0">
          <button
            onClick={() => onOpenDelete(editingRow)}
            className="px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-md border border-red-200"
          >
            删除服务
          </button>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">
              取消
            </button>
            <button
              onClick={onSubmit}
              disabled={isSubmitting}
              className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
