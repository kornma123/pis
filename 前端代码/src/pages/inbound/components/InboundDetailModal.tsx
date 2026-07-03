import { Modal } from '@/components/ui/Modal'
import type { InboundRecord, Material } from '@/types'
import { formatDateTime, formatCurrency, cn } from '@/lib/utils'

interface InboundDetailModalProps {
  open: boolean
  record: InboundRecord | null
  materials: Material[]
  onClose: () => void
  onPrint: () => void
}

function getRecordStatus(row: InboundRecord) {
  return row.status
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    cancelled: '已取消',
  }
  return map[status] || status
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-50 text-green-700 border-green-200'
    case 'cancelled':
      return 'bg-gray-100 text-gray-600 border-gray-200'
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function getTypeLabel(type: string): string {
  const map: Record<string, string> = {
    direct: '直接入库',
    purchase: '采购入库',
    return: '退库入库',
    transfer: '库位调拨',
    surplus: '盘盈入库',
    other: '其他入库',
  }
  return map[type] || type
}

function getSourceBadgeColor(type: string): string {
  switch (type) {
    case 'purchase':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'return':
      return 'bg-cyan-50 text-cyan-700 border-cyan-200'
    case 'direct':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'transfer':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'surplus':
      return 'bg-slate-50 text-slate-700 border-slate-200'
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200'
  }
}

export default function InboundDetailModal({ open, record, materials, onClose, onPrint }: InboundDetailModalProps) {
  if (!open || !record) return null

  return (
    <Modal onClose={onClose} title="入库详情" size="lg">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="text-lg font-semibold text-gray-900">{record.inboundNo}</div>
          <span className={cn('inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border', getStatusColor(getRecordStatus(record)))}>
            {getStatusLabel(getRecordStatus(record))}
          </span>
        </div>
        <div className="text-sm text-gray-500 mb-5">入库时间: {formatDateTime(record.createdAt)}</div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">物料名称</div>
            <div className="text-sm font-medium text-gray-900">{record.materialName}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">物料编码</div>
            <div className="text-sm font-mono text-gray-900">{record.materialId}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">批次号</div>
            <div className="text-sm font-mono text-gray-900">{record.batchNo || '-'}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">入库来源</div>
            <div className="text-sm">
              <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs border', getSourceBadgeColor(record.type))}>
                {getTypeLabel(record.type)}
              </span>
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">入库数量</div>
            <div className="text-sm font-medium text-gray-900">{record.quantity} {record.unit || materials.find(m => m.id === record.materialId)?.unit || ''}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">入库单价</div>
            <div className="text-sm font-medium text-gray-900">{formatCurrency(record.price)}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">入库金额</div>
            <div className="text-sm font-medium text-gray-900">{formatCurrency(record.amount || record.price * record.quantity)}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">供应商</div>
            <div className="text-sm text-gray-900">{record.supplierName || '-'}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">生产日期</div>
            <div className="text-sm text-gray-900">{record.productionDate || '-'}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">有效期至</div>
            <div className="text-sm text-gray-900">{record.expiryDate || '-'}</div>
          </div>
        </div>

        {record.remark && (
          <div className="mt-4 bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">备注</div>
            <div className="text-sm text-gray-900">{record.remark}</div>
          </div>
        )}

        <div className="mt-4 bg-gray-50 rounded-lg p-3">
          <div className="flex justify-between text-xs">
            <div><span className="text-gray-500">操作人:</span> <span className="ml-1 text-gray-900">{record.operator}</span></div>
            <div><span className="text-gray-500">入库时间:</span> <span className="ml-1 text-gray-900">{formatDateTime(record.createdAt)}</span></div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        >
          关闭
        </button>
        <button
          onClick={onPrint}
          className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        >
          打印入库单
        </button>
      </div>
    </Modal>
  )
}
