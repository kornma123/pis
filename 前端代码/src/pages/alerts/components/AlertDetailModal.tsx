import { X } from 'lucide-react'
import type { AlertItem } from '../hooks/useAlertsPage'
import { ALERT_TYPE_MAP } from '../hooks/useAlertsPage'

interface Props {
  open: boolean
  alert: AlertItem | null
  onClose: () => void
  onHandle: () => void
  formatDate: (dateStr: string) => string
}

export function AlertDetailModal({ open, alert, onClose, onHandle, formatDate }: Props) {
  if (!open || !alert) return null

  const typeInfo = ALERT_TYPE_MAP[alert.type] || { label: alert.type, bg: 'bg-gray-50', text: 'text-gray-600' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">预警详情 - {alert.id}</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">物料名称</div>
              <div className="text-sm font-medium text-gray-900">{alert.materialName || '-'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">批次号</div>
              <div className="text-sm font-medium text-gray-900">{alert.batchNo || '-'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">当前库存</div>
              <div className="text-sm font-medium text-gray-900">{alert.currentStock ?? '-'}</div>
            </div>
            <div className="bg-red-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">预警阈值</div>
              <div className="text-sm font-bold text-red-600">{alert.threshold ?? '-'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">来源规则</div>
              <div className="text-sm font-medium text-blue-600">{alert.ruleId || 'RULE-001'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">预警时间</div>
              <div className="text-sm font-medium text-gray-900">{formatDate(alert.createdAt)}</div>
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm font-medium text-gray-700 mb-2">触发条件</div>
            <div className="text-sm text-gray-600">
              {alert.triggerCondition || alert.message || '当前库存低于预警阈值'}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors">
            关闭
          </button>
          {alert.status === 'pending' && (
            <button onClick={onHandle} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm">
              处理预警
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
