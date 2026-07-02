import { useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Modal } from '@/components/ui/Modal'
import type { InboundRecord, Material, Supplier, Location } from '@/types'

export interface FormData {
  type: 'purchase' | 'direct' | 'return' | 'transfer'
  fromLocationId: string
  fromLocationName: string
  materialId: string
  batchNo: string
  quantity: number
  price: number
  supplierId: string
  locationId: string
  productionDate: string
  expiryDate: string
  remark: string
  purchaseOrderId: string
}

interface InboundFormModalProps {
  open: boolean
  modalType: 'create' | 'edit'
  form: FormData
  setForm: Dispatch<SetStateAction<FormData>>
  materials: Material[]
  locations: Location[]
  suppliers: Supplier[]
  purchaseOrders: any[]
  selectedOrderId: string
  setSelectedOrderId: (id: string) => void
  selectedRecord: InboundRecord | null
  submitting: boolean
  onClose: () => void
  onSubmit: () => void
}

function getLocationTypeLabel(type?: string): string {
  const map: Record<string, string> = {
    shelf: '货架',
    fridge: '冰箱',
    cabinet: '柜',
    counter: '操作台',
    other: '其他',
  }
  return map[type || ''] || type || '其他'
}

function getLocationDisplay(loc: Location): string {
  const parts: string[] = [loc.name]
  if (loc.zone) parts.push(`库区${loc.zone}`)
  if (loc.shelf) parts.push(`货架${loc.shelf}`)
  if (loc.position) parts.push(`库位${loc.position}`)
  return parts.join('-')
}

export default function InboundFormModal({
  open,
  modalType,
  form,
  setForm,
  materials,
  locations,
  suppliers,
  purchaseOrders,
  selectedOrderId,
  setSelectedOrderId,
  submitting,
  onClose,
  onSubmit,
}: InboundFormModalProps) {
  if (!open) return null

  const selectedOrder = useMemo(() =>
    purchaseOrders.find(o => o.id === selectedOrderId),
    [purchaseOrders, selectedOrderId]
  )

  return (
    <Modal onClose={onClose} title={modalType === 'create' ? '新增入库' : '编辑入库'} size="xl">
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              入库来源 <span className="text-red-500">*</span>
            </label>
            <select
              value={form.type}
              onChange={e => setForm({ ...form, type: e.target.value as any })}
              className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">请选择来源</option>
              <option value="purchase">采购入库</option>
              <option value="return">退库入库</option>
              <option value="direct">直接入库</option>
              <option value="transfer">调拨入库</option>
            </select>
          </div>
          {form.type === 'purchase' && purchaseOrders.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                采购订单 <span className="text-gray-400 text-xs font-normal">(可选，选择后自动填充)</span>
              </label>
              <select
                value={selectedOrderId}
                onChange={e => {
                  const orderId = e.target.value
                  setSelectedOrderId(orderId)
                  if (orderId) {
                    const order = purchaseOrders.find(o => o.id === orderId)
                    if (order) {
                      setForm(prev => ({
                        ...prev,
                        purchaseOrderId: orderId,
                        supplierId: order.supplier_id || '',
                        materialId: order.material_id || prev.materialId,
                        price: order.unit_price || prev.price,
                        quantity: order.remainingQty || prev.quantity,
                      }))
                    }
                  } else {
                    setForm(prev => ({ ...prev, purchaseOrderId: '' }))
                  }
                }}
                className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">不关联采购订单</option>
                {purchaseOrders.map(o => (
                  <option key={o.id} value={o.id}>{o.order_no} · {o.material_name || o.material_id} · 待入:{o.remainingQty}{o.unit}</option>
                ))}
              </select>
            </div>
          )}
          {form.type === 'transfer' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                来源库位 <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  list="source-location-list"
                  value={form.fromLocationName || locations.find(l => l.id === form.fromLocationId)?.name || ''}
                  onChange={e => {
                    const val = e.target.value
                    const matched = locations.find(l => l.name === val)
                    setForm({ ...form, fromLocationId: matched ? matched.id : '', fromLocationName: matched ? '' : val })
                  }}
                  placeholder="请选择或输入来源库位"
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
                />
                <datalist id="source-location-list">
                  {locations.map(l => (
                    <option key={l.id} value={l.name}>{getLocationDisplay(l)} · {getLocationTypeLabel(l.type)}</option>
                  ))}
                </datalist>
                <select
                  value={form.fromLocationId}
                  onChange={e => {
                    const id = e.target.value
                    const loc = locations.find(l => l.id === id)
                    setForm({ ...form, fromLocationId: id, fromLocationName: loc ? loc.name : '' })
                  }}
                  className="absolute right-0 top-0 h-10 w-8 border-l border-gray-300 bg-transparent text-transparent cursor-pointer focus:outline-none"
                  title="选择来源库位"
                >
                  <option value=""></option>
                  {locations.map(l => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            耗材名称 <span className="text-red-500">*</span>
          </label>
          <select
            value={form.materialId}
            onChange={e => setForm({ ...form, materialId: e.target.value })}
            className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">请选择耗材</option>
            {materials.map(m => (
              <option key={m.id} value={m.id}>{m.name} ({m.code}) {m.spec ? `· 规格:${m.spec}` : ''} {m.unit ? `· 单位:${m.unit}` : ''}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">批号</label>
            <input
              value={form.batchNo}
              onChange={e => setForm({ ...form, batchNo: e.target.value })}
              className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="请输入批号"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              数量 <span className="text-red-500">*</span>
              {form.materialId && materials.find(m => m.id === form.materialId)?.unit && (
                <span className="text-xs text-gray-400 ml-2">
                  ({materials.find(m => m.id === form.materialId)?.unit})
                </span>
              )}
              {selectedOrderId && selectedOrder && selectedOrder.remainingQty > 0 && (
                <span className="text-xs text-amber-600 ml-2">
                  待入库: {selectedOrder.remainingQty}
                </span>
              )}
            </label>
            <input
              type="number"
              step="0.01"
              min={0.01}
              max={selectedOrderId && selectedOrder ? selectedOrder.remainingQty : undefined}
              value={form.quantity}
              onChange={e => setForm({ ...form, quantity: Number(e.target.value) })}
              className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">规格单价 (¥) <span className="text-gray-400 text-xs font-normal">按包装规格计价</span></label>
            <input
              type="number"
              step="0.01"
              value={form.price}
              onChange={e => setForm({ ...form, price: Number(e.target.value) })}
              className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {form.type === 'transfer' ? '目标库位' : '库位'} <span className="text-red-500">*</span>
            </label>
            <select
              value={form.locationId}
              onChange={e => setForm({ ...form, locationId: e.target.value })}
              className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">{form.type === 'transfer' ? '请选择目标库位' : '请选择库位'}</option>
              {locations.map(l => (
                <option key={l.id} value={l.id}>{getLocationDisplay(l)} · {getLocationTypeLabel(l.type)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">生产日期</label>
            <input
              type="date"
              value={form.productionDate}
              onChange={e => setForm({ ...form, productionDate: e.target.value })}
              className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">有效期至</label>
            <input
              type="date"
              value={form.expiryDate}
              onChange={e => setForm({ ...form, expiryDate: e.target.value })}
              className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">供应商</label>
          <select
            value={form.supplierId}
            onChange={e => setForm({ ...form, supplierId: e.target.value })}
            className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">请选择供应商</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">备注</label>
          <textarea
            value={form.remark}
            onChange={e => setForm({ ...form, remark: e.target.value })}
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="请输入备注信息（可选）"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        >
          取消
        </button>
        <button
          onClick={onSubmit}
          disabled={submitting}
          className="px-4 py-2 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? '提交中...' : '确认入库'}
        </button>
      </div>
    </Modal>
  )
}
