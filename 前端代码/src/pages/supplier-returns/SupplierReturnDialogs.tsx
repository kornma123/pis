import type { Dispatch, SetStateAction } from 'react'
import { AlertCircle, Loader2, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { formatDate } from '@/lib/utils'
import type { InboundRecord, Material, PurchaseOrder, Supplier, SupplierReturnRecord } from '@/types'
import {
  REASONS,
  STATUS,
  reasonLabel,
  refundLabel,
  transitionsFor,
  type SupplierReturnFormState,
  type Transition,
} from './supplierReturnModel'

const inputClass = 'a11y-focus-ring h-10 w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-700 disabled:bg-gray-100 disabled:text-gray-500'
const secondaryButton = 'a11y-focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50'
const primaryButton = 'a11y-focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50'

export function SupplierReturnCreateDialog({
  form,
  setForm,
  materials,
  suppliers,
  purchaseOrders,
  inboundRecords,
  refsError,
  validationError,
  onClose,
  onConfirm,
}: {
  form: SupplierReturnFormState
  setForm: Dispatch<SetStateAction<SupplierReturnFormState>>
  materials: Material[]
  suppliers: Supplier[]
  purchaseOrders: PurchaseOrder[]
  inboundRecords: InboundRecord[]
  refsError: string
  validationError: string
  onClose: () => void
  onConfirm: () => void
}) {
  const material = materials.find((item) => item.id === form.materialId)
  const visibleOrders = purchaseOrders.filter((order) => (
    (!form.supplierId || order.supplierId === form.supplierId)
    && (!form.materialId || order.materialId === form.materialId)
  ))
  const visibleInbound = inboundRecords.filter((record) => !form.materialId || record.materialId === form.materialId)

  return (
    <Modal
      title="新建供应商退货"
      description="创建成功会立即扣减库存；后端会再次核对物料、数量、来源成本和批次。"
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-4">
        {refsError && (
          <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            引用数据未加载：{refsError}。不能把未知物料或供应商当作空选项提交。
          </div>
        )}
        {validationError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{validationError}</div>}

        <label className="block text-sm font-medium text-gray-700">
          物料 <span aria-hidden="true" className="text-red-500">*</span>
          <select
            className={`${inputClass} mt-1.5`}
            value={form.materialId}
            disabled={Boolean(refsError)}
            onChange={(event) => {
              const materialId = event.target.value
              setForm((current) => {
                const inbound = inboundRecords.find((record) => record.id === current.inboundRecordId)
                const order = purchaseOrders.find((item) => item.id === current.purchaseOrderId)
                return {
                  ...current,
                  materialId,
                  inboundRecordId: inbound && inbound.materialId !== materialId ? '' : current.inboundRecordId,
                  purchaseOrderId: order && order.materialId !== materialId ? '' : current.purchaseOrderId,
                }
              })
            }}
          >
            <option value="">请选择物料</option>
            {materials.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.code}）· 可见库存 {item.stock} {item.unit}</option>)}
          </select>
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-gray-700">
            退货数量 <span aria-hidden="true" className="text-red-500">*</span>
            <input
              className={`${inputClass} mt-1.5`}
              type="number"
              min="0.000001"
              max={material?.stock || undefined}
              value={form.quantity}
              onChange={(event) => setForm((current) => ({ ...current, quantity: Number(event.target.value) }))}
            />
            {material && <span className="mt-1 block text-xs font-normal text-gray-500">当前可见库存：{material.stock} {material.unit}；提交时以后端锁内库存为准。</span>}
          </label>
          <label className="block text-sm font-medium text-gray-700">
            供应商
            <select
              className={`${inputClass} mt-1.5`}
              value={form.supplierId}
              disabled={Boolean(refsError)}
              onChange={(event) => {
                const supplierId = event.target.value
                setForm((current) => {
                  const order = purchaseOrders.find((item) => item.id === current.purchaseOrderId)
                  return { ...current, supplierId, purchaseOrderId: order && order.supplierId !== supplierId ? '' : current.purchaseOrderId }
                })
              }}
            >
              <option value="">未关联</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-gray-700">
            关联采购订单
            <select
              className={`${inputClass} mt-1.5`}
              value={form.purchaseOrderId}
              disabled={Boolean(refsError)}
              onChange={(event) => {
                const purchaseOrderId = event.target.value
                const order = purchaseOrders.find((item) => item.id === purchaseOrderId)
                setForm((current) => ({
                  ...current,
                  purchaseOrderId,
                  materialId: order?.materialId || current.materialId,
                  supplierId: order?.supplierId || current.supplierId,
                  inboundRecordId: order && inboundRecords.find((record) => record.id === current.inboundRecordId)?.materialId !== order.materialId ? '' : current.inboundRecordId,
                }))
              }}
            >
              <option value="">未关联</option>
              {visibleOrders.map((order) => <option key={order.id} value={order.id}>{order.orderNo} · {order.materialName}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-700">
            关联入库记录
            <select
              className={`${inputClass} mt-1.5`}
              value={form.inboundRecordId}
              disabled={Boolean(refsError)}
              onChange={(event) => {
                const inboundRecordId = event.target.value
                const inbound = inboundRecords.find((record) => record.id === inboundRecordId)
                setForm((current) => ({
                  ...current,
                  inboundRecordId,
                  materialId: inbound?.materialId || current.materialId,
                  supplierId: inbound?.supplierId || current.supplierId,
                  purchaseOrderId: inbound && purchaseOrders.find((order) => order.id === current.purchaseOrderId)?.materialId !== inbound.materialId ? '' : current.purchaseOrderId,
                }))
              }}
            >
              <option value="">未关联（后端按库存规则选批次）</option>
              {visibleInbound.map((record) => <option key={record.id} value={record.id}>{record.inboundNo} · {record.materialName} × {record.quantity} {record.unit}</option>)}
            </select>
          </label>
        </div>

        <label className="block text-sm font-medium text-gray-700">
          退货原因 <span aria-hidden="true" className="text-red-500">*</span>
          <select className={`${inputClass} mt-1.5`} value={form.reason} onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}>
            <option value="">请选择</option>
            {REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
          </select>
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-gray-700">
            拟登记退款额
            <input className={`${inputClass} mt-1.5`} type="number" min="0" step="0.01" value={form.refundAmount} onChange={(event) => setForm((current) => ({ ...current, refundAmount: event.target.value }))} placeholder="未登记" />
            <span className="mt-1 block text-xs font-normal text-gray-500">这是预期/登记金额，不代表已收款、已过账或已冲销。</span>
          </label>
          <label className="block text-sm font-medium text-gray-700">
            物流单号
            <input className={`${inputClass} mt-1.5`} value={form.trackingNo} onChange={(event) => setForm((current) => ({ ...current, trackingNo: event.target.value }))} placeholder="可选" />
          </label>
        </div>

        <label className="block text-sm font-medium text-gray-700">
          备注
          <textarea className="a11y-focus-ring mt-1.5 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" rows={3} value={form.remark} onChange={(event) => setForm((current) => ({ ...current, remark: event.target.value }))} placeholder="可选；不要填写患者身份或诊断信息" />
        </label>

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4">
          <button type="button" className={secondaryButton} onClick={onClose}>取消</button>
          <button type="button" className={primaryButton} onClick={onConfirm} disabled={Boolean(refsError)}>检查并确认</button>
        </div>
      </div>
    </Modal>
  )
}

export function SupplierReturnDetailDialog({
  record,
  loading,
  error,
  canWrite,
  mutationUnknown,
  onClose,
  onRetry,
  onTransition,
  onDelete,
}: {
  record: SupplierReturnRecord | null
  loading: boolean
  error: string
  canWrite: boolean
  mutationUnknown: string
  onClose: () => void
  onRetry: () => void
  onTransition: (transition: Transition) => void
  onDelete: () => void
}) {
  return (
    <Modal title="供应商退货详情" description="显示当前可验证状态；系统没有伪造的流转时间线。" onClose={onClose} size="lg">
      {loading ? (
        <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />加载最新详情…</div>
      ) : error ? (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertCircle aria-hidden="true" className="mb-2 h-5 w-5" />
          <div className="font-medium">详情未加载</div><div className="mt-1 text-xs">{error}。不能依据列表快照执行写操作。</div>
          <button type="button" className={`${secondaryButton} mt-3`} onClick={onRetry}>重新核对详情</button>
        </div>
      ) : !record ? (
        <div className="py-10 text-center text-sm text-gray-500">记录不存在或已变化。</div>
      ) : (
        <div className="space-y-4">
          {mutationUnknown && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {mutationUnknown} 写操作已锁定；请重新核对详情后再决定下一步。
              <button type="button" className="ml-2 underline" onClick={onRetry}>立即核对</button>
            </div>
          )}
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <DetailField label="退货单号" value={record.returnNo} mono />
            <DetailField label="物料" value={record.materialName || '未提供'} />
            <DetailField label="数量" value={String(record.quantity)} />
            <DetailField label="供应商" value={record.supplierName || '未关联'} />
            <DetailField label="采购订单" value={record.purchaseOrderNo || '未关联'} />
            <DetailField label="入库记录" value={record.inboundNo || '未关联'} />
            <DetailField label="退货原因" value={reasonLabel(record.reason)} />
            <DetailField label="拟登记退款额" value={refundLabel(record.refundAmount)} />
            <DetailField label="物流单号" value={record.trackingNo || '未提供'} />
            <DetailField label="操作人" value={record.operator || '未提供'} />
            <DetailField label="创建时间" value={formatDate(record.createdAt)} />
            <DetailField label="最后更新时间" value={formatDate(record.updatedAt)} />
          </dl>
          {record.remark && <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-700"><div className="mb-1 text-xs text-gray-500">备注</div><div className="break-words">{record.remark}</div></div>}

          <div className="border-t border-gray-200 pt-4">
            <div className="text-xs text-gray-500">当前记录状态</div>
            <StatusBadge status={record.status} />
            {record.status === 'refunded' && <p className="mt-2 text-xs text-gray-600">此状态不构成付款到账、应付过账或冲销凭证；财务台账能力尚未接通。</p>}
          </div>

          {canWrite && !mutationUnknown && transitionsFor(record.status).length > 0 && (
            <div className="border-t border-gray-200 pt-4">
              <div className="mb-2 text-sm font-medium text-gray-700">允许的下一步</div>
              <div className="flex flex-wrap gap-2">
                {transitionsFor(record.status).map((transition) => (
                  <button key={transition.next} type="button" className={transition.danger ? `${secondaryButton} text-red-700` : primaryButton} onClick={() => onTransition(transition)}>{transition.actionLabel}</button>
                ))}
                {record.status === 'pending' && <button type="button" className={`${secondaryButton} text-red-700`} onClick={onDelete}><Trash2 aria-hidden="true" className="h-4 w-4" />删除待发货记录</button>}
              </div>
            </div>
          )}
          {!canWrite && <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-500">只读：当前 capability 不允许创建、流转或删除。</div>}
        </div>
      )}
    </Modal>
  )
}

export function MutationConfirmDialog({
  title,
  description,
  confirmLabel,
  danger,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal title={title} description={description} onClose={() => { if (!busy) onClose() }} size="sm">
      {error && <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={secondaryButton} disabled={busy} onClick={onClose}>返回</button>
        <button type="button" className={danger ? 'a11y-focus-ring inline-flex min-h-10 items-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50' : primaryButton} disabled={busy} onClick={onConfirm}>
          {busy ? <><Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />提交中…</> : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function StatusBadge({ status }: { status: SupplierReturnRecord['status'] }) {
  const info = STATUS[status]
  const Icon = info.icon
  return <span className={`mt-1 inline-flex max-w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium ${info.tone}`}><Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{info.label}</span>
}

function DetailField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-gray-500">{label}</dt><dd className={`mt-0.5 break-words text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</dd></div>
}
