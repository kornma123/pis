import React from 'react'
import { X } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import type { EquipmentForm } from '../hooks/useEquipmentPage'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: EquipmentForm
  typeOptions?: Array<{ value: string; label: string }>
  onClose: () => void
  onChange: (form: EquipmentForm) => void
  onSubmit: () => void
}

function formatCurrency(value: number) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function EquipmentFormModal({ open, type, form, typeOptions = [], onClose, onChange, onSubmit }: Props) {
  if (!open) return null

  const depreciableAmount = Math.max(0, Number(form.purchasePrice || 0) - Number(form.residualValue || 0))
  const annualDepreciation = form.depreciableLifeYears > 0
    ? depreciableAmount / form.depreciableLifeYears
    : 0
  const monthlyDepreciation = annualDepreciation / 12
  const unitDepreciation = form.depreciationMethod === 'units_of_production' && form.totalCapacity > 0
    ? depreciableAmount / form.totalCapacity
    : 0
  const capacityUnit = form.capacityUnit.trim() || '单位'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">
            {type === 'create' ? '新增设备' : '编辑设备'}
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
                设备编号 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.code}
                onChange={(e) => {
                  if (type === 'create') onChange({ ...form, code: e.target.value })
                }}
                placeholder="请输入设备编号"
                readOnly={type === 'edit'}
                className={`w-full h-10 px-3 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors ${
                  type === 'edit' ? 'bg-gray-50 text-gray-400' : 'text-gray-700'
                }`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                设备名称 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) => onChange({ ...form, name: e.target.value })}
                placeholder="请输入设备名称"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">设备类型</label>
              <SearchableSelect
                value={form.typeId}
                onChange={(val) => onChange({ ...form, typeId: val })}
                options={[{ value: '', label: '未分类' }, ...typeOptions]}
                placeholder="选择设备类型"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">型号</label>
              <input
                value={form.model}
                onChange={(e) => onChange({ ...form, model: e.target.value })}
                placeholder="请输入型号"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">制造商</label>
              <input
                value={form.manufacturer}
                onChange={(e) => onChange({ ...form, manufacturer: e.target.value })}
                placeholder="请输入制造商"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">购置价格</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.purchasePrice}
                onChange={(e) => onChange({ ...form, purchasePrice: Number(e.target.value) })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">购置日期</label>
              <input
                type="date"
                value={form.purchaseDate}
                onChange={(e) => onChange({ ...form, purchaseDate: e.target.value })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">折旧年限（年）</label>
              <input
                type="number"
                min={1}
                value={form.depreciableLifeYears}
                onChange={(e) => onChange({ ...form, depreciableLifeYears: Number(e.target.value) })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">残值</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.residualValue}
                onChange={(e) => onChange({ ...form, residualValue: Number(e.target.value) })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">折旧方式</label>
              <SearchableSelect
                value={form.depreciationMethod}
                onChange={(val) => onChange({ ...form, depreciationMethod: val as 'straight_line' | 'units_of_production' })}
                options={[
                  { value: 'straight_line', label: '直线法' },
                  { value: 'units_of_production', label: '工作量法' },
                ]}
                placeholder="请选择"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">状态</label>
              <SearchableSelect
                value={form.status}
                onChange={(val) => onChange({ ...form, status: val as 'active' | 'inactive' | 'scrapped' })}
                options={[
                  { value: 'active', label: '已启用' },
                  { value: 'inactive', label: '已停用' },
                  { value: 'scrapped', label: '已报废' },
                ]}
                placeholder="请选择"
              />
            </div>
          </div>
          {form.depreciationMethod === 'units_of_production' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">总工作量</label>
                <input
                  type="number"
                  min={1}
                  value={form.totalCapacity}
                  onChange={(e) => onChange({ ...form, totalCapacity: Number(e.target.value) })}
                  placeholder="总工作量（小时/张数）"
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">工作量单位</label>
                <input
                  value={form.capacityUnit}
                  onChange={(e) => onChange({ ...form, capacityUnit: e.target.value })}
                  placeholder="如：小时、张数、批次"
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                />
              </div>
            </div>
          )}
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">设备折旧结果确认</h4>
                <p className="mt-1 text-xs text-gray-600">
                  确认后将接住：设备档案、折旧统计、月度成本、BOM 成本、审计记录
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-medium text-blue-700 border border-blue-100">
                {form.depreciationMethod === 'straight_line' ? '直线法' : '工作量法'}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-md bg-white border border-blue-100 p-3">
                <div className="text-xs text-gray-500">可折旧金额</div>
                <div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(depreciableAmount)}</div>
              </div>
              {form.depreciationMethod === 'straight_line' ? (
                <>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">年折旧额</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(annualDepreciation)}</div>
                  </div>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">月折旧额</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(monthlyDepreciation)}</div>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">总工作量</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">
                      {Number(form.totalCapacity || 0).toLocaleString('zh-CN')} {capacityUnit}
                    </div>
                  </div>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">单位折旧</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">
                      {formatCurrency(unitDepreciation)}/{capacityUnit}
                    </div>
                  </div>
                </>
              )}
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
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm"
          >
            {type === 'create' ? '创建设备' : '保存修改'}
          </button>
        </div>
      </div>
    </div>
  )
}
