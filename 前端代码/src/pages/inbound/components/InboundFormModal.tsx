import { useEffect, useRef } from 'react'
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'
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
  selectedRecord: InboundRecord | null
  submitting: boolean
  onClose: () => void
  onSubmit: () => void
}

const fieldClass = 'w-full min-h-11 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500'

function getLocationDisplay(location: Location) {
  return [location.code, location.name, location.zone, location.shelf, location.position].filter(Boolean).join(' · ')
}

export default function InboundFormModal({
  open,
  modalType,
  form,
  setForm,
  materials,
  locations,
  suppliers,
  selectedRecord,
  submitting,
  onClose,
  onSubmit,
}: InboundFormModalProps) {
  const firstFieldRef = useRef<HTMLSelectElement>(null)
  const contentRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(timer)
      previouslyFocused?.focus()
    }
  }, [open])

  if (!open) return null

  const editing = modalType === 'edit'
  const trapFocus = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(contentRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    ) || [])
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <Modal onClose={onClose} title={editing ? '编辑入库记录' : '新增直接入库'} size="xl">
      <form
        ref={contentRef}
        className="space-y-5"
        onKeyDown={trapFocus}
        onSubmit={(event) => { event.preventDefault(); onSubmit() }}
        aria-busy={submitting}
      >
        {editing && (
          <div role="note" className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            为避免库存金额和数量漂移，编辑仅开放批号、供应商、日期与备注；来源、物料、数量、单价和库位保持原记录。
            {selectedRecord?.purchaseOrderId ? ' 关联采购单的记录不可在此编辑。' : ''}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="inbound-type" className="mb-1.5 block text-sm font-medium text-gray-700">入库来源 <span aria-hidden="true" className="text-red-500">*</span></label>
            <select
              id="inbound-type"
              ref={firstFieldRef}
              value={form.type}
              disabled={editing}
              required
              onChange={(event) => setForm(current => ({
                ...current,
                type: event.target.value as FormData['type'],
                purchaseOrderId: '',
                fromLocationId: event.target.value === 'transfer' ? current.fromLocationId : '',
                fromLocationName: event.target.value === 'transfer' ? current.fromLocationName : '',
              }))}
              className={fieldClass}
            >
              <option value="direct">直接入库</option>
              <option value="return">退库入库</option>
              <option value="transfer">库位调拨</option>
              {form.type === 'purchase' && <option value="purchase" disabled>采购入库（当前不可执行）</option>}
            </select>
          </div>

          {form.type === 'transfer' && (
            <div>
              <label htmlFor="inbound-from-location" className="mb-1.5 block text-sm font-medium text-gray-700">来源库位 <span aria-hidden="true" className="text-red-500">*</span></label>
              <select
                id="inbound-from-location"
                value={form.fromLocationId}
                required
                disabled={editing}
                onChange={(event) => setForm(current => ({ ...current, fromLocationId: event.target.value, fromLocationName: '' }))}
                className={fieldClass}
              >
                <option value="">请选择来源库位</option>
                {locations.map(location => <option key={location.id} value={location.id}>{getLocationDisplay(location)}</option>)}
              </select>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="inbound-material" className="mb-1.5 block text-sm font-medium text-gray-700">耗材 <span aria-hidden="true" className="text-red-500">*</span></label>
          <select
            id="inbound-material"
            value={form.materialId}
            required
            disabled={editing}
            onChange={(event) => setForm(current => ({ ...current, materialId: event.target.value }))}
            className={fieldClass}
          >
            <option value="">请选择耗材</option>
            {materials.map(material => (
              <option key={material.id} value={material.id}>{material.code} · {material.name}{material.spec ? ` · ${material.spec}` : ''}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="inbound-batch" className="mb-1.5 block text-sm font-medium text-gray-700">批号</label>
            <input id="inbound-batch" value={form.batchNo} onChange={(event) => setForm(current => ({ ...current, batchNo: event.target.value }))} className={fieldClass} />
          </div>
          <div>
            <label htmlFor="inbound-quantity" className="mb-1.5 block text-sm font-medium text-gray-700">数量 <span aria-hidden="true" className="text-red-500">*</span></label>
            <input id="inbound-quantity" type="number" min="0.01" step="0.01" required disabled={editing} value={form.quantity} onChange={(event) => setForm(current => ({ ...current, quantity: Number(event.target.value) }))} className={fieldClass} />
          </div>
          <div>
            <label htmlFor="inbound-price" className="mb-1.5 block text-sm font-medium text-gray-700">规格单价（元） <span className="text-xs font-normal text-gray-500">明确填写 0 表示零价</span></label>
            <input id="inbound-price" type="number" min="0" step="0.01" disabled={editing} value={form.price} onChange={(event) => setForm(current => ({ ...current, price: Number(event.target.value) }))} className={fieldClass} />
          </div>
          <div>
            <label htmlFor="inbound-location" className="mb-1.5 block text-sm font-medium text-gray-700">{form.type === 'transfer' ? '目标库位' : '库位'} <span aria-hidden="true" className="text-red-500">*</span></label>
            <select id="inbound-location" value={form.locationId} required disabled={editing} onChange={(event) => setForm(current => ({ ...current, locationId: event.target.value }))} className={fieldClass}>
              <option value="">请选择库位</option>
              {locations.map(location => <option key={location.id} value={location.id}>{getLocationDisplay(location)}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="inbound-production-date" className="mb-1.5 block text-sm font-medium text-gray-700">生产日期</label>
            <input id="inbound-production-date" type="date" value={form.productionDate} onChange={(event) => setForm(current => ({ ...current, productionDate: event.target.value }))} className={fieldClass} />
          </div>
          <div>
            <label htmlFor="inbound-expiry-date" className="mb-1.5 block text-sm font-medium text-gray-700">有效期至</label>
            <input id="inbound-expiry-date" type="date" value={form.expiryDate} onChange={(event) => setForm(current => ({ ...current, expiryDate: event.target.value }))} className={fieldClass} />
          </div>
        </div>

        <div>
          <label htmlFor="inbound-supplier" className="mb-1.5 block text-sm font-medium text-gray-700">供应商</label>
          <select id="inbound-supplier" value={form.supplierId} onChange={(event) => setForm(current => ({ ...current, supplierId: event.target.value }))} className={fieldClass}>
            <option value="">不指定供应商</option>
            {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.code} · {supplier.name}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="inbound-remark" className="mb-1.5 block text-sm font-medium text-gray-700">备注</label>
          <textarea id="inbound-remark" rows={3} value={form.remark} onChange={(event) => setForm(current => ({ ...current, remark: event.target.value }))} className={fieldClass} />
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={submitting} className="min-h-11 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50">取消</button>
          <button type="submit" disabled={submitting} className="min-h-11 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? '提交中…' : editing ? '保存安全字段' : '确认入库'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
