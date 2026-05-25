import { X, AlertTriangle } from 'lucide-react'
import type { AlertItem } from '../hooks/useAlertsPage'
import { ALERT_TYPE_MAP } from '../hooks/useAlertsPage'

interface Props {
  open: boolean
  alert: AlertItem | null
  form: { opinion: string; result: string }
  onClose: () => void
  onChange: (form: { opinion: string; result: string }) => void
  onConfirm: () => void
}

export function AlertHandleModal({ open, alert, form, onClose, onChange, onConfirm }: Props) {
  if (!open || !alert) return null

  const typeInfo = ALERT_TYPE_MAP[alert.type] || { label: alert.type, bg: 'bg-gray-50', text: 'text-gray-600' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">处理预警</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6">
          <div className="bg-red-50 border border-red-100 rounded-lg p-4 mb-5">
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle className="w-6 h-6 text-red-600" />
              <span className="font-semibold text-red-600">{typeInfo.label}预警</span>
            </div>
            <div className="text-sm text-gray-600 space-y-2">
              <div><strong>物料：</strong>{alert.materialName || '-'}</div>
              <div><strong>当前库存：</strong>{alert.currentStock ?? '-'}</div>
              <div><strong>预警阈值：</strong>{alert.threshold ?? '-'}</div>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                处理意见 <span className="text-red-500">*</span>
              </label>
              <textarea
                value={form.opinion}
                onChange={(e) => onChange({ ...form, opinion: e.target.value })}
                placeholder="请输入处理意见..."
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">处理结果</label>
              <div className="flex flex-wrap gap-3">
                {[
                  { key: 'purchased', label: '已采购补货' },
                  { key: 'adjusted', label: '调整阈值' },
                  { key: 'ignored', label: '忽略预警' },
                ].map((opt) => (
                  <label key={opt.key} className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="result"
                      value={opt.key}
                      checked={form.result === opt.key}
                      onChange={(e) => onChange({ ...form, result: e.target.value })}
                      className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors">
            取消
          </button>
          <button onClick={onConfirm} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm">
            确认处理
          </button>
        </div>
      </div>
    </div>
  )
}
