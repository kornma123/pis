import { X, Plus, Trash2 } from 'lucide-react'
import type { Material, Project } from '@/types'

export interface OutboundItemForm {
  materialId: string
  quantity: number
}

export interface FormData {
  type: 'project' | 'transfer' | 'scrap'
  projectId: string
  items: OutboundItemForm[]
  remark: string
}

interface OutboundFormModalProps {
  open: boolean
  editRecordId: string | null
  form: FormData
  materials: Material[]
  projects: Project[]
  onClose: () => void
  onSubmit: () => void
  onFormChange: (form: FormData) => void
}

export default function OutboundFormModal({
  open,
  editRecordId,
  form,
  materials,
  projects,
  onClose,
  onSubmit,
  onFormChange,
}: OutboundFormModalProps) {
  if (!open) return null

  const setFormField = <K extends keyof FormData>(field: K, value: FormData[K]) => {
    onFormChange({ ...form, [field]: value })
  }

  const addItem = () =>
    onFormChange({
      ...form,
      items: [...form.items, { materialId: materials[0]?.id || '', quantity: 1 }],
    })

  const removeItem = (idx: number) =>
    onFormChange({
      ...form,
      items: form.items.filter((_, i) => i !== idx),
    })

  const updateItem = (idx: number, field: keyof OutboundItemForm, value: string | number) => {
    onFormChange({
      ...form,
      items: form.items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">{editRecordId ? '编辑出库' : '出库登记'}</h3>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors duration-150"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">出库类型</label>
              <select
                value={form.type}
                onChange={e => setFormField('type', e.target.value as FormData['type'])}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="project">项目出库</option>
                <option value="transfer">调拨出库</option>
                <option value="scrap">报废出库</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">关联项目</label>
              <select
                value={form.projectId}
                onChange={e => setFormField('projectId', e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">请选择</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">出库明细 *</label>
              <button
                onClick={addItem}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-500 text-white text-xs rounded-md hover:bg-blue-600 transition-colors duration-150"
              >
                <Plus className="w-3.5 h-3.5" />
                添加物料
              </button>
            </div>
            <div className="space-y-2">
              {form.items.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2 p-3 bg-gray-50 rounded-md">
                  <select
                    value={item.materialId}
                    onChange={e => updateItem(idx, 'materialId', e.target.value)}
                    className="flex-1 h-9 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">选择物料</option>
                    {materials.map(m => (
                      <option key={m.id} value={m.id}>{m.name} ({m.code})</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    placeholder="数量"
                    min={1}
                    value={item.quantity || ''}
                    onChange={e => updateItem(idx, 'quantity', Number(e.target.value))}
                    className="w-24 h-9 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {form.items.length > 1 && (
                    <button
                      onClick={() => removeItem(idx)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors duration-150"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
            <textarea
              value={form.remark}
              onChange={e => setFormField('remark', e.target.value)}
              rows={2}
              placeholder="请输入出库备注信息（可选）"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
          >
            取消
          </button>
          <button
            onClick={onSubmit}
            className="px-4 py-2 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors duration-150"
          >
            {editRecordId ? '确认更新' : '确认出库'}
          </button>
        </div>
      </div>
    </div>
  )
}
