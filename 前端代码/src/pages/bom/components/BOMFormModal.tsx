import { X, FileSpreadsheet } from 'lucide-react'
import { TYPE_OPTIONS } from '../constants'
import type { BOMForm } from '../hooks/useBOMPage'
import type { BOM, BOMMaterial } from '@/types'

interface Props {
  open: boolean
  type: 'create' | 'edit'
  form: BOMForm
  detailBom: BOM | null
  onClose: () => void
  onChange: (form: BOMForm) => void
  onSubmit: () => void
}

export function BOMFormModal({
  open,
  type,
  form,
  detailBom,
  onClose,
  onChange,
  onSubmit,
}: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">
            {type === 'create' ? '新建BOM' : '编辑BOM'}
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
                BOM名称 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) => onChange({ ...form, name: e.target.value })}
                placeholder="请输入BOM名称"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                BOM编号 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.code}
                onChange={(e) => onChange({ ...form, code: e.target.value })}
                placeholder="请输入BOM编号"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                关联检测服务
              </label>
              <input
                value={form.serviceId}
                onChange={(e) => onChange({ ...form, serviceId: e.target.value })}
                placeholder="请选择检测服务"
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                BOM类型
              </label>
              <select
                value={form.type}
                onChange={(e) => onChange({ ...form, type: e.target.value })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              >
                {TYPE_OPTIONS.filter((o) => o.value).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {type === 'create' ? '初始版本' : '当前版本'}
              </label>
              <input
                value={form.version}
                readOnly={type === 'create'}
                onChange={(e) =>
                  type === 'edit' && onChange({ ...form, version: e.target.value })
                }
                className={`w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 transition-colors ${
                  type === 'create' ? 'bg-gray-50 text-gray-400' : ''
                }`}
              />
              {type === 'create' && (
                <p className="text-xs text-gray-400 mt-1">
                  新建BOM默认版本号为 v1.0
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                状态
              </label>
              <select
                value={form.status}
                onChange={(e) =>
                  onChange({
                    ...form,
                    status: e.target.value as 'active' | 'inactive',
                  })
                }
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              >
                <option value="active">已启用</option>
                <option value="inactive">已停用</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              可支撑样本数
            </label>
            <input
              type="number"
              value={form.supportableSamples}
              onChange={(e) =>
                onChange({ ...form, supportableSamples: Number(e.target.value) })
              }
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              BOM描述
            </label>
            <textarea
              value={form.description}
              onChange={(e) => onChange({ ...form, description: e.target.value })}
              rows={2}
              placeholder="请输入BOM描述"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors resize-none"
            />
          </div>
          {/* 物料清单区域（展示性） */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-gray-700">
                物料清单
              </label>
              <span className="text-xs text-gray-400">
                {type === 'edit'
                  ? `${detailBom?.materials?.length || 0} 项物料`
                  : '至少添加1项物料'}
              </span>
            </div>
            <div className="border border-gray-200 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      序号
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      物料名称
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      规格型号
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      用量/样本
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      单位
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {type === 'edit' &&
                  detailBom?.materials &&
                  detailBom.materials.length > 0 ? (
                    detailBom.materials.map((m: BOMMaterial, idx: number) => (
                      <tr key={m.id || idx}>
                        <td className="px-3 py-2 text-gray-500">{idx + 1}</td>
                        <td className="px-3 py-2 font-medium text-gray-900">
                          {m.name}
                        </td>
                        <td className="px-3 py-2 text-gray-500">
                          {m.spec || '-'}
                        </td>
                        <td className="px-3 py-2 text-gray-700">
                          {m.usagePerSample}
                        </td>
                        <td className="px-3 py-2 text-gray-500">{m.unit}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-3 py-8 text-center text-gray-400"
                      >
                        <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                        <p className="text-xs">暂无物料</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
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
            {type === 'create' ? '创建BOM' : '保存修改'}
          </button>
        </div>
      </div>
    </div>
  )
}
