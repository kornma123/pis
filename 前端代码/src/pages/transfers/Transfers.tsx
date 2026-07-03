import { transferApi } from '@/api/inventory'
import { formatDate } from '@/lib/utils'
import LaneCPage from '../_laneC/LaneCPage'
import type { LaneCConfig } from '../_laneC/types'

const config: LaneCConfig = {
  module: 'transfers',
  noun: '调拨',
  title: '调拨管理',
  subtitle: '在库位之间移动物料，总库存不变',
  createLabel: '调拨登记',
  createTone: 'blue',
  effect: { text: '总库存不变', tone: 'neutral' },
  note: '调拨＝把物料从一个库位移到另一个库位，总库存不变。单库位模型下按"整物料换库位"记录（同一物料"5 件里挪 3 件"这类分库位拆分暂不支持），数量仅作调拨记录。撤销调拨会把库位还原到来源。',
  filterKind: 'location',
  createMode: 'transfer',
  needsLocations: true,
  columns: [
    { key: 'inboundNo', label: '调拨单号', render: (r) => <span className="font-mono text-gray-600">{r.inboundNo}</span> },
    { key: 'materialName', label: '物料', render: (r) => <span className="font-medium text-gray-900">{r.materialName || r.materialId}</span> },
    { key: 'quantity', label: '数量', align: 'right', sortable: 'quantity', render: (r) => <span className="tabular-nums">{r.quantity} {r.unit || ''}</span> },
    { key: 'fromLocationName', label: '来源库位', render: (r) => <span className="text-gray-600">{r.fromLocationName || '—'}</span> },
    { key: 'toLocationName', label: '目标库位', render: (r) => <span className="px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700">{r.toLocationName || r.toLocationId || '—'}</span> },
    { key: 'operator', label: '操作人', render: (r) => <span className="text-gray-600">{r.operator}</span> },
    { key: 'createdAt', label: '时间', sortable: 'createdAt', render: (r) => <span className="text-gray-500 tabular-nums">{formatDate(r.createdAt)}</span> },
  ],
  detailFields: (r) => [
    { label: '调拨单号', value: r.inboundNo },
    { label: '物料', value: r.materialName || r.materialId },
    { label: '数量', value: `${r.quantity} ${r.unit || ''}` },
    { label: '批号', value: r.batchNo || '—' },
    { label: '来源库位', value: r.fromLocationName || '—' },
    { label: '目标库位', value: r.toLocationName || r.toLocationId || '—' },
    { label: '操作人', value: r.operator },
    { label: '时间', value: formatDate(r.createdAt) },
    { label: '备注', value: r.remark || '—' },
  ],
  exportSheet: '调拨记录',
  exportFileName: '调拨记录',
  exportRow: (r) => ({
    调拨单号: r.inboundNo, 物料: r.materialName || r.materialId, 数量: r.quantity, 单位: r.unit || '',
    来源库位: r.fromLocationName || '', 目标库位: r.toLocationName || r.toLocationId || '',
    操作人: r.operator, 时间: formatDate(r.createdAt), 备注: r.remark || '',
  }),
  api: {
    getList: (params) => transferApi.getList(params),
    getStats: () => transferApi.getStats(),
    create: (form) => transferApi.createInbound({
      materialId: form.materialId, quantity: form.quantity, batchNo: form.batchNo || undefined,
      fromLocationId: form.fromLocationId, toLocationId: form.toLocationId, remark: form.remark || undefined,
    }),
    remove: (id) => transferApi.delete(id),
  },
  validateCreate: (form) => {
    if (!form.materialId) return '请选择物料'
    if (!form.quantity || form.quantity <= 0) return '请填写正确的调拨数量'
    if (!form.fromLocationId) return '请选择来源库位'
    if (!form.toLocationId) return '请选择目标库位'
    if (form.fromLocationId === form.toLocationId) return '来源库位和目标库位不能相同'
    return null
  },
}

export default function Transfers() {
  return <LaneCPage config={config} />
}
