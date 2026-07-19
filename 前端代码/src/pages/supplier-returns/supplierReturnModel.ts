import type { ElementType } from 'react'
import { CheckCircle2, CircleDollarSign, Clock, RotateCcw, Truck } from 'lucide-react'
import type { SupplierReturnRecord } from '@/types'

export type SupplierReturnStatus = SupplierReturnRecord['status']

export const STATUS: Record<SupplierReturnStatus, { label: string; tone: string; icon: ElementType }> = {
  pending: { label: '待发货', tone: 'bg-amber-50 text-amber-700', icon: Clock },
  shipped: { label: '发货状态已登记', tone: 'bg-blue-50 text-blue-700', icon: Truck },
  received: { label: '供应商已收货', tone: 'bg-purple-50 text-purple-700', icon: CheckCircle2 },
  refunded: { label: '退款状态已登记（未过账）', tone: 'bg-green-50 text-green-700', icon: CircleDollarSign },
  cancelled: { label: '已取消（库存已回补）', tone: 'bg-gray-100 text-gray-600', icon: RotateCcw },
}

export const REASONS = [
  { value: 'quality_issue', label: '质量问题' },
  { value: 'wrong_item', label: '发错货' },
  { value: 'quantity_mismatch', label: '数量不符' },
  { value: 'damaged', label: '破损' },
  { value: 'other', label: '其他' },
]

export interface SupplierReturnFormState {
  materialId: string
  quantity: number
  supplierId: string
  purchaseOrderId: string
  inboundRecordId: string
  reason: string
  refundAmount: string
  trackingNo: string
  remark: string
}

export const EMPTY_FORM: SupplierReturnFormState = {
  materialId: '',
  quantity: 1,
  supplierId: '',
  purchaseOrderId: '',
  inboundRecordId: '',
  reason: '',
  refundAmount: '',
  trackingNo: '',
  remark: '',
}

export interface Transition {
  next: SupplierReturnStatus
  actionLabel: string
  title: string
  confirmLabel: string
  description: string
  danger?: boolean
}

export function transitionsFor(status: SupplierReturnStatus): Transition[] {
  const cancel: Transition = {
    next: 'cancelled',
    actionLabel: '取消退货',
    title: '确认取消供应商退货？',
    confirmLabel: '确认取消并恢复库存',
    description: '仅当前状态仍允许取消、且原批次可精确恢复时才会成功；失败或未知不会显示已恢复。',
    danger: true,
  }
  if (status === 'pending') return [{
    next: 'shipped',
    actionLabel: '登记发货',
    title: '确认登记发货？',
    confirmLabel: '确认登记',
    description: '前置条件：当前仍为待发货。这里只记录发货状态，不代表供应商已收货或已退款。',
  }, cancel]
  if (status === 'shipped') return [{
    next: 'received',
    actionLabel: '登记供应商收货',
    title: '确认登记供应商收货？',
    confirmLabel: '确认登记',
    description: '前置条件：当前仍为发货状态已登记。这里只记录供应商收货结果，不代表退款或财务过账。',
  }, cancel]
  if (status === 'received') return [{
    next: 'refunded',
    actionLabel: '登记退款结果',
    title: '确认登记退款结果？',
    confirmLabel: '确认登记',
    description: '前置条件：供应商收货已登记。此操作只写工作流状态；当前系统没有应付贷项/财务台账过账，不能据此视为退款到账或冲销。',
  }, cancel]
  return []
}

export function reasonLabel(value: string) {
  return REASONS.find((reason) => reason.value === value)?.label || value || '未提供'
}

export function refundLabel(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? `¥${value.toFixed(2)}`
    : '未登记退款额'
}

export function validateForm(form: SupplierReturnFormState, availableStock?: number) {
  if (!form.materialId) return '请选择物料'
  if (!Number.isFinite(form.quantity) || form.quantity <= 0) return '退货数量必须大于 0'
  if (typeof availableStock === 'number' && form.quantity > availableStock) return '退货数量超过当前可见库存，请刷新物料后核对'
  if (!form.reason) return '请选择退货原因'
  if (form.refundAmount !== '') {
    const refund = Number(form.refundAmount)
    if (!Number.isFinite(refund) || refund < 0) return '拟登记退款额必须为有限非负数'
  }
  return ''
}
