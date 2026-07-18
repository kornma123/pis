import { Modal } from '@/components/ui/Modal'
import type { AlertItem } from '../hooks/useAlertsPage'

interface Props {
  open: boolean
  alert: AlertItem | null
  onClose: () => void
  onHandle: () => void
  formatDate: (dateStr: string) => string
}

export function AlertDetailModal({ open, alert, onClose, onHandle, formatDate }: Props) {
  if (!open || !alert) return null

  return (
    <Modal title={`预警详情 - ${alert.id}`} onClose={onClose} size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">物料名称</div>
              <div className="text-sm font-medium text-gray-900">{alert.materialName || '未提供'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">批次号</div>
              <div className="text-sm font-medium text-gray-900">{alert.batchNo || '未提供'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">当前库存</div>
              <div className="text-sm font-medium text-gray-900">{alert.currentStock ?? '未提供'}</div>
            </div>
            <div className="bg-red-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">预警阈值</div>
              <div className="text-sm font-bold text-red-600">{alert.threshold ?? '未提供'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">来源规则</div>
              <div className="text-sm font-medium text-gray-700">{alert.ruleId || '未提供'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">预警时间</div>
              <div className="text-sm font-medium text-gray-900">{formatDate(alert.createdAt)}</div>
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm font-medium text-gray-700 mb-2">触发条件</div>
            <div className="text-sm text-gray-600">
              {alert.triggerCondition || alert.message || '未提供'}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors">
            关闭
          </button>
          {alert.status === 'pending' && (
            <button onClick={onHandle} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm">
              处理预警
            </button>
          )}
        </div>
    </Modal>
  )
}
