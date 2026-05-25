import { X, CheckCircle, ArrowLeft, ArrowRight, Loader2, BarChart3 } from 'lucide-react'
import { toast } from 'sonner'
import type { Material } from '@/types'
import type { FormData } from '../hooks/useStocktakingPage'

interface Props {
  open: boolean
  form: FormData
  createStep: number
  materials: Material[]
  isSubmitting: boolean
  onClose: () => void
  onChange: (form: FormData) => void
  onSetCreateStep: (s: number) => void
}

export function StocktakingCreateModal({
  open, form, createStep, materials, isSubmitting,
  onClose, onChange, onSetCreateStep,
}: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">新建盘点</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-500" /></button>
        </div>
        {/* Step indicator */}
        <div className="px-6 py-4 border-b border-gray-200 shrink-0">
          <div className="flex items-center justify-center gap-2">
            {[1, 2, 3].map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
                  s === createStep ? 'bg-blue-500 text-white' : s < createStep ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'
                }`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                    s === createStep ? 'bg-white text-blue-600' : s < createStep ? 'bg-blue-500 text-white' : 'bg-gray-300 text-white'
                  }`}>{s < createStep ? <CheckCircle className="w-3 h-3" /> : s}</span>
                  {s === 1 ? '基本信息' : s === 2 ? '确认清单' : '创建完成'}
                </div>
                {i < 2 && <div className={`w-8 h-0.5 ${s < createStep ? 'bg-blue-500' : 'bg-gray-200'}`} />}
              </div>
            ))}
          </div>
        </div>
        <div className="p-6 overflow-y-auto">
          {createStep === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">盘点名称 <span className="text-red-500">*</span></label>
                  <input value={form.name} onChange={e => onChange({ ...form, name: e.target.value })} placeholder="请输入盘点名称" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">盘点方式 <span className="text-red-500">*</span></label>
                  <select value={form.type} onChange={e => onChange({ ...form, type: e.target.value as 'full' | 'sample' })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 bg-white">
                    <option value="">请选择盘点方式</option>
                    <option value="full">全盘</option>
                    <option value="sample">抽盘</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">盘点范围 <span className="text-red-500">*</span></label>
                  <select value={form.scope} onChange={e => onChange({ ...form, scope: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 bg-white">
                    <option value="">请选择盘点范围</option>
                    <option value="all">全部物料</option>
                    <option value="category">指定分类</option>
                    <option value="location">指定库位</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">负责人 <span className="text-red-500">*</span></label>
                  <input value={form.manager} onChange={e => onChange({ ...form, manager: e.target.value })} placeholder="请输入负责人" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                <textarea value={form.remark} onChange={e => onChange({ ...form, remark: e.target.value })} rows={3} placeholder="请输入备注" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
              </div>
            </div>
          )}
          {createStep === 2 && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 flex items-start gap-3">
                <BarChart3 className="w-5 h-5 text-blue-500 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-blue-900">盘点范围预览</div>
                  <div className="text-xs text-blue-700 mt-0.5">全部物料，共 {materials.length} 种</div>
                </div>
              </div>
              <div className="overflow-x-auto max-h-80 border border-gray-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-10"><input type="checkbox" checked className="rounded border-gray-300 text-blue-600" /></th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料编码</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">分类</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">账面数量</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库位</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {materials.slice(0, 8).map(m => (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2"><input type="checkbox" checked className="rounded border-gray-300 text-blue-600" /></td>
                        <td className="px-3 py-2 font-mono text-gray-600 text-xs">{m.code}</td>
                        <td className="px-3 py-2">{m.name}</td>
                        <td className="px-3 py-2 text-gray-500">{m.categoryPath || '-'}</td>
                        <td className="px-3 py-2">{m.stock}</td>
                        <td className="px-3 py-2 text-gray-500">{m.locationName || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-2">
                <span className="text-sm text-gray-500">已选择 <strong>{materials.length}</strong> 种物料</span>
                <div className="flex gap-2">
                  <button className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">全选</button>
                  <button className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">取消全选</button>
                </div>
              </div>
            </div>
          )}
          {createStep === 3 && (
            <div className="text-center py-10">
              <CheckCircle className="w-14 h-14 mx-auto mb-4 text-green-500" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">盘点任务创建成功</h3>
              <div className="bg-gray-50 rounded-lg p-4 text-left space-y-2 max-w-sm mx-auto mb-6">
                <div className="flex justify-between text-sm"><span className="text-gray-500">盘点名称</span><span>{form.name || '-'}</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">盘点范围</span><span>全部物料</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">物料数量</span><span>{materials.length} 种</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">负责人</span><span>{form.manager || '-'}</span></div>
              </div>
              <div className="flex items-center justify-center gap-3">
                <button onClick={onClose} className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600">开始盘点</button>
                <button onClick={onClose} className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">返回列表</button>
              </div>
            </div>
          )}
        </div>
        {createStep < 3 && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">取消</button>
            {createStep > 1 && <button onClick={() => onSetCreateStep(createStep - 1)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 flex items-center gap-1"><ArrowLeft className="w-4 h-4" />上一步</button>}
            <button onClick={() => {
              if (createStep === 1) {
                if (!form.name.trim() || !form.type || !form.scope || !form.manager.trim()) { toast.error('请填写必填字段'); return }
                onSetCreateStep(2)
              } else if (createStep === 2) {
                onSetCreateStep(3)
              }
            }} disabled={isSubmitting} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : createStep === 2 ? '创建盘点' : <>下一步<ArrowRight className="w-4 h-4" /></>}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
