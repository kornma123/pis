import React from 'react'
import { X } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import type { CostCenterForm } from '../hooks/useCostCenterPage'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: CostCenterForm
  onClose: () => void
  onChange: (form: CostCenterForm) => void
  onSubmit: () => void
}

const COST_TYPE_OPTIONS = [
  { value: 'rent', label: '房租' },
  { value: 'utilities', label: '水电' },
  { value: 'maintenance', label: '维护' },
  { value: 'admin', label: '管理费' },
  { value: 'it', label: 'IT费用' },
  { value: 'other', label: '其他' },
]

export function CostCenterFormModal({ open, type, form, onClose, onChange, onSubmit }: Props) {
  if (!open) return null
  const costTypeLabel = COST_TYPE_OPTIONS.find(item => item.value === form.costType)?.label || '待选择'
  const statusLabel = form.status === 'active' ? '已启用' : '已停用'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">
            {type === 'create' ? '新增成本中心' : '编辑成本中心'}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                编号 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.code}
                onChange={(e) => onChange({ ...form, code: e.target.value })}
                placeholder="请输入编号"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                名称 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) => onChange({ ...form, name: e.target.value })}
                placeholder="请输入名称"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                费用类型 <span className="text-red-500">*</span>
              </label>
              <SearchableSelect
                value={form.costType}
                onChange={(val) => onChange({ ...form, costType: val })}
                options={COST_TYPE_OPTIONS}
                placeholder="请选择"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                月度金额（元）
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.monthlyAmount}
                onChange={(e) => onChange({ ...form, monthlyAmount: Number(e.target.value) })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                分摊基础
              </label>
              {/* HON-4（P-7 · 分摊口径空转控件摘除）：逐成本中心单选口径（样本数/收入/工时/面积）从不被引擎读取，
                  「选了不听」→ 摘掉交互下拉，改为只读说明，避免用户误以为选了会生效。真实分摊见下方说明。 */}
              <div className="min-h-[40px] px-3 py-2 rounded-md border border-gray-200 bg-gray-50 text-sm text-gray-600 leading-relaxed">
                间接费用目前按<span className="font-medium text-gray-700">每月统一规则</span>分摊（默认按各成本中心的直接成本比例）。
                按成本中心单独选择分摊口径的功能尚未开放。
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                状态
              </label>
              <SearchableSelect
                value={form.status}
                onChange={(val) => onChange({ ...form, status: val as 'active' | 'inactive' })}
                options={[
                  { value: 'active', label: '已启用' },
                  { value: 'inactive', label: '已停用' },
                ]}
                placeholder="请选择"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              描述
            </label>
            <textarea
              value={form.description}
              onChange={(e) => onChange({ ...form, description: e.target.value })}
              rows={2}
              placeholder="请输入描述"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors resize-none"
            />
          </div>
          <div className="rounded-md border border-emerald-100 bg-emerald-50 px-4 py-3">
            <div className="text-sm font-semibold text-emerald-900">成本中心配置确认</div>
            <div className="mt-1 text-xs text-emerald-800">确认后将接住：成本中心、月度分摊、项目成本、成本结账、审计记录</div>
            <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-emerald-900 sm:grid-cols-2">
              <div>成本中心 {form.name || '待填写'}</div>
              <div>费用类型 {costTypeLabel}</div>
              <div>月度金额 ¥{Number(form.monthlyAmount || 0).toFixed(2)}</div>
              <div>分摊 按每月统一规则</div>
              <div>状态 {statusLabel}</div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
          >
            取消
          </button>
          <button
            onClick={onSubmit}
            className="px-4 h-10 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors"
          >
            {type === 'create' ? '创建' : '保存修改'}
          </button>
        </div>
      </div>
    </div>
  )
}
