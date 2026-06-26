import { X } from 'lucide-react'
import type { FormData } from '../hooks/useMaterialsPage'

interface Props {
  open: boolean
  editingId: string | null
  form: FormData
  specPart: { amount: string; unit: string }
  categories: { id: string; name: string }[]
  suppliers: { id: string; name: string }[]
  onClose: () => void
  onChange: (form: FormData) => void
  onSpecPartChange: (sp: { amount: string; unit: string }) => void
  onCategoryChange: (categoryId: string) => void
  onSubmit: () => void
}

export function MaterialFormModal({
  open, editingId, form, specPart, categories, suppliers,
  onClose, onChange, onSpecPartChange, onCategoryChange, onSubmit
}: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-base font-semibold text-gray-900">{editingId ? '编辑物料' : '新建物料'}</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                物料编码
                <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
              </label>
              <input value={form.code} disabled readOnly placeholder="选择分类后自动生成" className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-500 cursor-not-allowed" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">物料名称 <span className="text-red-500">*</span></label>
              <input value={form.name} onChange={e => onChange({ ...form, name: e.target.value })} placeholder="请输入物料名称" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">规格型号</label>
            <div className="flex items-center gap-2">
              <input
                value={specPart.amount}
                onChange={e => {
                  const next = { ...specPart, amount: e.target.value }
                  onSpecPartChange(next)
                  onChange({ ...form, spec: `${next.amount}/${next.unit}` })
                }}
                placeholder="数量，如 50、100"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
              <span className="text-gray-400 text-sm">/</span>
              <input
                value={specPart.unit}
                onChange={e => {
                  const next = { ...specPart, unit: e.target.value }
                  onSpecPartChange(next)
                  onChange({ ...form, spec: `${next.amount}/${next.unit}` })
                }}
                placeholder="单位，如 ml、盒、瓶"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                计量单位 <span className="text-red-500">*</span>
              </label>
              <input value={form.unit} onChange={e => onChange({ ...form, unit: e.target.value })} placeholder="如：个、盒、瓶" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                参考单价 (¥)
                <span className="text-xs text-gray-400 font-normal ml-1">[预算用]</span>
              </label>
              <input type="number" step="0.01" value={form.price} onChange={e => onChange({ ...form, price: Number(e.target.value) })} placeholder="用于采购预算和成本预估" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">物料分类</label>
              <select value={form.categoryId} onChange={e => {
                const val = e.target.value
                onChange({ ...form, categoryId: val })
                if (!editingId && val) onCategoryChange(val)
              }} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500">
                <option value="">请选择</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">供应商</label>
              <select value={form.supplierId} onChange={e => onChange({ ...form, supplierId: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500">
                <option value="">请选择</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                库存预警阈值 <span className="text-xs text-gray-400 font-normal ml-1">({form.unit || '个'})</span>
              </label>
              <input type="number" value={form.minStock} onChange={e => onChange({ ...form, minStock: Number(e.target.value) })} placeholder={`输入数量，单位：${form.unit || '个'}`} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                最大库存 <span className="text-xs text-gray-400 font-normal ml-1">({form.unit || '个'})</span>
              </label>
              <input type="number" value={form.maxStock} onChange={e => onChange({ ...form, maxStock: Number(e.target.value) })} placeholder={`输入数量，单位：${form.unit || '个'}`} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                保险库存 <span className="text-xs text-gray-400 font-normal ml-1">({form.unit || '个'})</span>
              </label>
              <input type="number" value={form.safetyStock} onChange={e => onChange({ ...form, safetyStock: Number(e.target.value) })} placeholder={`输入数量，单位：${form.unit || '个'}`} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">状态</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="m-status" checked={form.status === 'active'} onChange={() => onChange({ ...form, status: 'active' })} className="w-4 h-4 text-blue-600" />
                启用
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="m-status" checked={form.status === 'inactive'} onChange={() => onChange({ ...form, status: 'inactive' })} className="w-4 h-4 text-blue-600" />
                停用
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">备注</label>
            <textarea value={form.remark} onChange={e => onChange({ ...form, remark: e.target.value })} rows={2} placeholder="请输入备注信息" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 transition-colors">取消</button>
          <button onClick={onSubmit} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors">保存</button>
        </div>
      </div>
    </div>
  )
}
