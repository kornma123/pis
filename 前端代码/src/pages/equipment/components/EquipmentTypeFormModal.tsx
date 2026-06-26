import React from 'react'
import { X } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import type { EquipmentTypeForm } from '../hooks/useEquipmentTypePage'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: EquipmentTypeForm
  submitting?: boolean
  onClose: () => void
  onChange: (form: EquipmentTypeForm) => void
  onSubmit: () => void
}

function formatCurrency(value: number) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export default function EquipmentTypeFormModal({
  open,
  type,
  form,
  submitting = false,
  onClose,
  onChange,
  onSubmit,
}: Props) {
  if (!open) return null

  const updateNumber = (key: keyof EquipmentTypeForm, value: string) => {
    onChange({ ...form, [key]: Number(value) || 0 })
  }
  const depreciableAmount = Math.max(0, Number(form.defaultPurchasePrice || 0) - Number(form.defaultValue || 0))
  const annualDepreciation = form.defaultDepreciableLifeYears > 0
    ? depreciableAmount / form.defaultDepreciableLifeYears
    : 0
  const monthlyDepreciation = annualDepreciation / 12
  const unitDepreciation = form.defaultDepreciationMethod === 'units_of_production' && form.defaultTotalCapacity > 0
    ? depreciableAmount / form.defaultTotalCapacity
    : 0
  const capacityUnit = form.defaultCapacityUnit || '单位'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="equipment-type-form-title"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 id="equipment-type-form-title" className="text-lg font-semibold text-gray-900">
            {type === 'create' ? '新增设备类型' : '编辑设备类型'}
          </h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors" aria-label="关闭弹窗">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">类型编码 *</label>
              <input
                value={form.code}
                onChange={(e) => {
                  if (type === 'create') onChange({ ...form, code: e.target.value })
                }}
                readOnly={type === 'edit'}
                className={`w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 ${
                  type === 'edit' ? 'bg-gray-50 text-gray-400' : ''
                }`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">类型名称 *</label>
              <input
                value={form.name}
                onChange={(e) => onChange({ ...form, name: e.target.value })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
              <SearchableSelect
                value={form.status}
                onChange={(value) => onChange({ ...form, status: value as 'active' | 'inactive' })}
                options={[
                  { value: 'active', label: '启用' },
                  { value: 'inactive', label: '禁用' },
                ]}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
            <textarea
              value={form.description}
              onChange={(e) => onChange({ ...form, description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">默认采购价</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.defaultPurchasePrice}
                onChange={(e) => updateNumber('defaultPurchasePrice', e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">残值</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.defaultValue}
                onChange={(e) => updateNumber('defaultValue', e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">折旧年限</label>
              <input
                type="number"
                min="1"
                value={form.defaultDepreciableLifeYears}
                onChange={(e) => updateNumber('defaultDepreciableLifeYears', e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">折旧方法</label>
              <SearchableSelect
                value={form.defaultDepreciationMethod}
                onChange={(value) => onChange({ ...form, defaultDepreciationMethod: value })}
                options={[
                  { value: 'straight_line', label: '直线法' },
                  { value: 'units_of_production', label: '工作量法' },
                ]}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">默认总产能</label>
              <input
                type="number"
                min="0"
                value={form.defaultTotalCapacity}
                onChange={(e) => updateNumber('defaultTotalCapacity', e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">产能单位</label>
              <SearchableSelect
                value={form.defaultCapacityUnit}
                onChange={(value) => onChange({ ...form, defaultCapacityUnit: value })}
                options={[
                  { value: 'minutes', label: '分钟' },
                  { value: 'slides', label: '切片' },
                  { value: 'tests', label: '测试' },
                  { value: 'hours', label: '小时' },
                ]}
              />
            </div>
          </div>

          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">设备类型默认折旧确认</h4>
                <p className="mt-1 text-xs text-gray-600">
                  后续新建设备可沿用：默认采购价、残值、折旧年限、折旧方法、BOM 成本口径
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-medium text-blue-700 border border-blue-100">
                {form.defaultDepreciationMethod === 'straight_line' ? '直线法' : '工作量法'}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-md bg-white border border-blue-100 p-3">
                <div className="text-xs text-gray-500">默认可折旧金额</div>
                <div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(depreciableAmount)}</div>
              </div>
              {form.defaultDepreciationMethod === 'straight_line' ? (
                <>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">默认年折旧额</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(annualDepreciation)}</div>
                  </div>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">默认月折旧额</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(monthlyDepreciation)}</div>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">默认总产能</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">
                      {Number(form.defaultTotalCapacity || 0).toLocaleString('zh-CN')} {capacityUnit}
                    </div>
                  </div>
                  <div className="rounded-md bg-white border border-blue-100 p-3">
                    <div className="text-xs text-gray-500">默认单位折旧</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">
                      {formatCurrency(unitDepreciation)}/{capacityUnit}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onSubmit}
            disabled={submitting}
            className="h-10 px-4 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
