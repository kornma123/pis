import { X, CheckCircle, ArrowLeft, ArrowRight, FileText, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { BOM } from '@/types'
import type { FormData } from '../hooks/useProjectsPage'

interface Props {
  open: boolean
  form: FormData
  createStep: number
  bomOption: 'select' | 'create' | 'skip'
  selectedBomId: string
  boms: BOM[]
  selectedBom: BOM | undefined
  isSubmitting: boolean
  onClose: () => void
  onChange: (form: FormData) => void
  onSetCreateStep: (s: number) => void
  onSetBomOption: (o: 'select' | 'create' | 'skip') => void
  onSetSelectedBomId: (id: string) => void
  onSubmit: () => void
}

export function ProjectCreateModal({
  open, form, createStep, bomOption, selectedBomId, boms, selectedBom, isSubmitting,
  onClose, onChange, onSetCreateStep, onSetBomOption, onSetSelectedBomId, onSubmit,
}: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">新建检测服务</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
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
                  }`}>
                    {s < createStep ? <CheckCircle className="w-3 h-3" /> : s}
                  </span>
                  {s === 1 ? '基本信息' : s === 2 ? 'BOM配置' : '完成'}
                </div>
                {i < 2 && (
                  <div className={`w-8 h-0.5 ${s < createStep ? 'bg-blue-500' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="p-6 overflow-y-auto">
          {createStep === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    服务类型 <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={form.type}
                    onChange={e => onChange({ ...form, type: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                  >
                    <option value="he">病理技术-HE制片</option>
                    <option value="ihc">病理技术-免疫组化</option>
                    <option value="ss">病理技术-特殊染色</option>
                    <option value="mp">分子诊断</option>
                    <option value="cyto">病理诊断-细胞学检测</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    服务编号 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.code}
                    onChange={e => onChange({ ...form, code: e.target.value })}
                    placeholder="请输入服务编号"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
                    placeholder="请输入服务名称"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">检测周期</label>
                  <input
                    value={form.cycle}
                    onChange={e => onChange({ ...form, cycle: e.target.value })}
                    placeholder="如：1-2个工作日"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">负责人</label>
                  <input
                    value={form.manager}
                    onChange={e => onChange({ ...form, manager: e.target.value })}
                    placeholder="请输入负责人"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                  <select
                    value={form.status}
                    onChange={e => onChange({ ...form, status: e.target.value as 'active' | 'inactive' })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                  >
                    <option value="active">已启用</option>
                    <option value="inactive">已停用</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">服务描述</label>
                <textarea
                  value={form.description}
                  onChange={e => onChange({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder="请输入服务描述"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          )}
          {createStep === 2 && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">BOM清单配置</label>
                <p className="text-xs text-gray-500 mb-3">
                  配置该检测服务所需的物料清单，可选择已有BOM或新建BOM
                </p>
              </div>
              <div className="flex gap-6 mb-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="bom-option" checked={bomOption === 'select'} onChange={() => onSetBomOption('select')} className="text-blue-600" />选择已有BOM
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="bom-option" checked={bomOption === 'create'} onChange={() => onSetBomOption('create')} className="text-blue-600" />新建BOM
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="bom-option" checked={bomOption === 'skip'} onChange={() => onSetBomOption('skip')} className="text-blue-600" />稍后配置
                </label>
              </div>
              {bomOption === 'select' && (
                <div className="space-y-3">
                  <select
                    value={selectedBomId}
                    onChange={e => onSetSelectedBomId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="">请选择BOM清单</option>
                    {boms.map(b => (
                      <option key={b.id} value={b.id}>{b.code} - {b.name} ({b.version})</option>
                    ))}
                  </select>
                  {selectedBom && (
                    <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">BOM预览</span>
                      </div>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {selectedBom.materials?.slice(0, 5).map(m => (
                          <span key={m.id} className="px-2 py-1 bg-white border border-gray-200 rounded text-xs text-gray-600">
                            {m.name}
                          </span>
                        ))}
                        {(selectedBom.materials?.length || 0) > 5 && (
                          <span className="text-xs text-gray-400">+{selectedBom.materials!.length - 5}项</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-gray-500 border-t border-gray-200 pt-3">
                        <span>共 {selectedBom.materialCount} 项物料</span>
                        <span>可支撑样本数: <span className="text-green-600 font-medium">{selectedBom.supportableSamples || '-'}</span></span>
                        <span>单样本成本: <span className="text-blue-600 font-medium">¥{selectedBom.unitCost?.toFixed(2) || '-'}</span></span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {bomOption === 'create' && (
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                  <FileText className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm text-gray-500 mb-4">创建完成后，在编辑页面配置BOM清单</p>
                  <button className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">
                    前往BOM管理
                  </button>
                </div>
              )}
              {bomOption === 'skip' && (
                <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
                  <p className="text-sm text-amber-700">未配置BOM的检测服务将无法计算成本和自动扣减库存，请尽快完成配置</p>
                </div>
              )}
            </div>
          )}
          {createStep === 3 && (
            <div className="text-center py-10">
              <CheckCircle className="w-14 h-14 mx-auto mb-4 text-green-500" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">创建成功！</h3>
              <p className="text-gray-500 mb-6">检测服务已创建完成</p>
              <div className="flex items-center justify-center gap-3">
                <button onClick={onClose} className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">
                  返回列表
                </button>
                <button className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600">
                  查看详情
                </button>
              </div>
            </div>
          )}
        </div>
        {createStep < 3 && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">
              取消
            </button>
            {createStep > 1 && (
              <button onClick={() => onSetCreateStep(createStep - 1)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 flex items-center gap-1">
                <ArrowLeft className="w-4 h-4" />上一步
              </button>
            )}
            <button
              onClick={() => {
                if (createStep === 1) {
                  if (!form.type || !form.code.trim() || !form.name.trim()) {
                    toast.error('请填写必填字段')
                    return
                  }
                  onSetCreateStep(2)
                } else if (createStep === 2) {
                  onSubmit()
                  onSetCreateStep(3)
                }
              }}
              disabled={isSubmitting}
              className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : createStep === 2 ? (
                '创建'
              ) : (
                <>下一步<ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
