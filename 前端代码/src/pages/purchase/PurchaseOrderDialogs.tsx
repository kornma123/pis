import { X } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Material, Supplier } from '@/types'
import { formatCurrency } from '@/lib/utils'
import type { NormalizedPurchaseOrder } from './purchaseOrderModel'

export const purchaseStatusConfig: Record<string, { label: string; bg: string; text: string }> = {
  pending: { label: '待收货', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  partial: { label: '部分收货', bg: 'bg-blue-50', text: 'text-blue-600' },
  completed: { label: '已完成', bg: 'bg-green-50', text: 'text-green-600' },
  cancelled: { label: '已取消', bg: 'bg-red-50', text: 'text-red-600' },
}

export const unknownPurchaseStatusConfig = { label: '未知状态', bg: 'bg-gray-100', text: 'text-gray-600' }

export function displayPurchaseQuantity(value: number | null, unit: string | null) {
  return value === null ? '—' : `${value} ${unit ?? ''}`.trim()
}

export function displayPurchaseCurrency(value: number | null) {
  return value === null ? '—' : formatCurrency(value)
}

export type PurchaseOrderForm = {
  materialId: string
  supplierId: string
  orderedQty: number
  unitPrice: number
  unit: string
  expectedDate: string
  remark: string
}

type CreateDialogProps = {
  open: boolean
  form: PurchaseOrderForm
  materials: Material[]
  suppliers: Supplier[]
  referencesLoading: boolean
  referencesError: string | null
  onChange: (form: PurchaseOrderForm) => void
  onClose: () => void
  onRetryReferences: () => void
  onCreate: () => void
}

export function PurchaseOrderCreateDialog({
  open,
  form,
  materials,
  suppliers,
  referencesLoading,
  referencesError,
  onChange,
  onClose,
  onRetryReferences,
  onCreate,
}: CreateDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg mx-4" role="dialog" aria-modal="true" aria-labelledby="purchase-create-title">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 id="purchase-create-title" className="text-lg font-semibold text-gray-900">新建采购订单</h3>
          <button type="button" aria-label="关闭新建采购订单" onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {referencesError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
              <p>基础资料加载失败：{referencesError}</p>
              <button type="button" onClick={onRetryReferences} className="mt-2 h-10 rounded-md border border-red-200 bg-white px-3 font-medium hover:bg-red-100">
                重新加载基础资料
              </button>
            </div>
          ) : referencesLoading ? (
            <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800" role="status">正在加载物料和供应商…</p>
          ) : null}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">物料 <span className="text-red-500">*</span></label>
            <select autoFocus value={form.materialId} onChange={event => onChange({ ...form, materialId: event.target.value })} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">请选择</option>
              {materials.map(material => <option key={material.id} value={material.id}>{material.name} ({material.code})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">供应商</label>
              <select value={form.supplierId} onChange={event => onChange({ ...form, supplierId: event.target.value })} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">请选择</option>
                {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">采购数量 <span className="text-red-500">*</span></label>
              <input type="number" min={1} value={form.orderedQty} onChange={event => onChange({ ...form, orderedQty: Number(event.target.value) })} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">单价</label>
              <input type="number" min={0} step={0.01} value={form.unitPrice} onChange={event => onChange({ ...form, unitPrice: Number(event.target.value) })} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">单位</label>
              <input type="text" value={form.unit} onChange={event => onChange({ ...form, unit: event.target.value })} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">预计到货日期</label>
            <input type="date" value={form.expectedDate} onChange={event => onChange({ ...form, expectedDate: event.target.value })} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
            <textarea value={form.remark} onChange={event => onChange({ ...form, remark: event.target.value })} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button type="button" onClick={onClose} className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">取消</button>
          <button type="button" onClick={onCreate} disabled={referencesLoading || Boolean(referencesError)} className="h-10 px-4 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors disabled:cursor-not-allowed disabled:bg-gray-300">确认创建</button>
        </div>
      </div>
    </div>
  )
}

type DetailDialogProps = {
  order: NormalizedPurchaseOrder | null
  supplierName: string
  inboundContextUrl: string | null
  inboundUnavailableReason: string | null
  onClose: () => void
}

export function PurchaseOrderDetailDialog({ order, supplierName, inboundContextUrl, inboundUnavailableReason, onClose }: DetailDialogProps) {
  if (!order) return null
  const config = purchaseStatusConfig[order.status] ?? unknownPurchaseStatusConfig

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg mx-4" role="dialog" aria-modal="true" aria-labelledby="purchase-detail-title">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 id="purchase-detail-title" className="text-lg font-semibold text-gray-900">采购订单详情</h3>
          <button type="button" aria-label="关闭采购订单详情" onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex justify-between gap-4"><span className="text-sm text-gray-500">订单号</span><span className="font-mono text-sm font-medium">{order.orderNo ?? '—'}</span></div>
          <div className="flex justify-between gap-4"><span className="text-sm text-gray-500">物料</span><span className="text-sm font-medium">{order.materialName ?? order.materialId ?? '—'}</span></div>
          <div className="flex justify-between gap-4"><span className="text-sm text-gray-500">供应商</span><span className="text-sm font-medium">{supplierName}</span></div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">采购数量</div><div className="text-lg font-semibold">{displayPurchaseQuantity(order.orderedQty, order.unit)}</div></div>
            <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">已收货</div><div className="text-lg font-semibold">{displayPurchaseQuantity(order.receivedQty, order.unit)}</div></div>
            <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">剩余待收</div><div className="text-lg font-semibold">{displayPurchaseQuantity(order.remainingQty, order.unit)}</div></div>
            <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">总金额</div><div className="text-lg font-semibold">{displayPurchaseCurrency(order.totalAmount)}</div></div>
          </div>
          <div className="flex justify-between gap-4"><span className="text-sm text-gray-500">单价</span><span className="text-sm">{displayPurchaseCurrency(order.unitPrice)}</span></div>
          {order.expectedDate ? <div className="flex justify-between gap-4"><span className="text-sm text-gray-500">预计到货</span><span className="text-sm">{order.expectedDate}</span></div> : null}
          <div className="flex justify-between gap-4"><span className="text-sm text-gray-500">状态</span><span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>{config.label}{purchaseStatusConfig[order.status] ? '' : `：${order.status}`}</span></div>
          {inboundUnavailableReason ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>{inboundUnavailableReason}</p>
              {inboundContextUrl ? <Link to={inboundContextUrl} className="mt-2 inline-flex h-10 items-center rounded-md border border-amber-300 bg-white px-3 font-medium text-amber-900 hover:bg-amber-100">查看入库限制</Link> : null}
            </div>
          ) : null}
          {order.remark ? <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500 mb-1">备注</div><div className="text-sm">{order.remark}</div></div> : null}
          <div className="text-xs text-gray-400">创建时间: {order.createdAt ?? '未知'}</div>
        </div>
        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-200">
          <button type="button" onClick={onClose} className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">关闭</button>
        </div>
      </div>
    </div>
  )
}
