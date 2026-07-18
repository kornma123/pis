import { X } from 'lucide-react'
import type { LogExportForm } from '../hooks/useLogsPage'

interface Props {
  open: boolean
  form: LogExportForm
  exporting: boolean
  error: string | null
  onChange: (form: LogExportForm) => void
  onExport: () => Promise<void>
  onClose: () => void
}

export function LogExportModal({ open, form, exporting, error, onChange, onExport, onClose }: Props) {
  if (!open) return null

  const update = <K extends keyof LogExportForm>(key: K, value: LogExportForm[K]) => {
    onChange({ ...form, [key]: value })
  }
  const noSelectedFields = !form.includeBasic && !form.includeDetail && !form.includeIP

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={event => { if (event.target === event.currentTarget && !exporting) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">导出日志</h3>
            <p className="mt-1 text-sm text-gray-500">沿用当前页面已加载的操作类型、模块、用户和日期筛选</p>
          </div>
          <button
            type="button"
            aria-label="关闭导出窗口"
            disabled={exporting}
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          <fieldset disabled={exporting}>
            <legend className="mb-2 text-sm font-medium text-gray-700">文件格式</legend>
            <div className="flex gap-5 text-sm text-gray-700">
              <label className="flex items-center gap-2">
                <input type="radio" name="log-export-format" checked={form.format === 'xlsx'} onChange={() => update('format', 'xlsx')} />
                Excel (.xlsx)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="log-export-format" checked={form.format === 'csv'} onChange={() => update('format', 'csv')} />
                CSV (.csv)
              </label>
            </div>
          </fieldset>

          <fieldset disabled={exporting}>
            <legend className="mb-2 text-sm font-medium text-gray-700">导出字段</legend>
            <div className="grid grid-cols-2 gap-3 text-sm text-gray-700">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.includeBasic} onChange={event => update('includeBasic', event.target.checked)} />
                基本信息
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.includeDetail} onChange={event => update('includeDetail', event.target.checked)} />
                操作详情
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.includeIP} onChange={event => update('includeIP', event.target.checked)} />
                IP 与设备
              </label>
              <label className="flex items-center gap-2 text-gray-400">
                <input aria-label="请求响应原文（当前不提供）" type="checkbox" checked={false} disabled />
                请求响应原文（不提供）
              </label>
            </div>
            <p className="mt-2 text-xs leading-5 text-gray-500">为避免导出敏感请求或响应内容，文件只包含服务端返回的安全日志证据。</p>
          </fieldset>

          {noSelectedFields && <p role="alert" className="text-sm text-amber-700">请至少选择一组可导出字段。</p>}
          {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            type="button"
            disabled={exporting}
            onClick={onClose}
            className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={exporting || noSelectedFields}
            onClick={() => void onExport()}
            className="h-10 px-4 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {exporting ? '导出中…' : '导出'}
          </button>
        </div>
      </div>
    </div>
  )
}
