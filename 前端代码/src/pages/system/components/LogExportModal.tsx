import { X } from 'lucide-react'
import type { LogFormData } from '../hooks/useLogsPage'

interface Props {
  open: boolean
  form: LogFormData
  onClose: () => void
  onChange: (form: LogFormData) => void
  onExport: () => void
}

export function LogExportModal({ open, form, onClose, onChange, onExport }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">导出日志</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="mb-5">
            <label className="block text-[13px] font-medium text-gray-700 mb-1.5">导出时间范围</label>
            <div className="flex items-center gap-3">
              <input
                type="date"
                value={form.startDate}
                onChange={e => onChange({ ...form, startDate: e.target.value })}
                className="flex-1 h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
              <span className="text-gray-500">至</span>
              <input
                type="date"
                value={form.endDate}
                onChange={e => onChange({ ...form, endDate: e.target.value })}
                className="flex-1 h-10 px-3 text-sm text-gray-900 bg-white border border-gray-300 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
              />
            </div>
          </div>

          <div className="mb-5">
            <label className="block text-[13px] font-medium text-gray-700 mb-2">导出格式</label>
            <div className="flex gap-3">
              <label
                onClick={() => onChange({ ...form, format: 'xlsx' })}
                className={`flex-1 flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all ${form.format === 'xlsx' ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}
              >
                <input type="radio" checked={form.format === 'xlsx'} readOnly className="text-blue-500" />
                <span className="text-sm text-gray-900">Excel (.xlsx)</span>
              </label>
              <label
                onClick={() => onChange({ ...form, format: 'csv' })}
                className={`flex-1 flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all ${form.format === 'csv' ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}
              >
                <input type="radio" checked={form.format === 'csv'} readOnly className="text-blue-500" />
                <span className="text-sm text-gray-900">CSV (.csv)</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-gray-700 mb-2">导出内容</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                <input type="checkbox" checked={form.includeBasic} onChange={e => onChange({ ...form, includeBasic: e.target.checked })} className="rounded border-gray-300 text-blue-500 focus:ring-blue-500 w-4 h-4" />
                基本信息（时间、用户、类型、模块）
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                <input type="checkbox" checked={form.includeDetail} onChange={e => onChange({ ...form, includeDetail: e.target.checked })} className="rounded border-gray-300 text-blue-500 focus:ring-blue-500 w-4 h-4" />
                操作详情
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                <input type="checkbox" checked={form.includeIP} onChange={e => onChange({ ...form, includeIP: e.target.checked })} className="rounded border-gray-300 text-blue-500 focus:ring-blue-500 w-4 h-4" />
                IP地址和设备信息
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                <input type="checkbox" checked={form.includeDiff} onChange={e => onChange({ ...form, includeDiff: e.target.checked })} className="rounded border-gray-300 text-blue-500 focus:ring-blue-500 w-4 h-4" />
                变更前后数据对比
              </label>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">取消</button>
          <button onClick={onExport} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 shadow-sm transition-all">导出</button>
        </div>
      </div>
    </div>
  )
}
