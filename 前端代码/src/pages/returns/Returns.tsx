import { returnApi } from '@/api/inventory'
import { formatDate } from '@/lib/utils'
import LaneCPage from '../_laneC/LaneCPage'
import type { LaneCConfig } from '../_laneC/types'

const REASONS = [
  { value: 'excess', label: '领用剩余退回' },
  { value: 'wrong_item', label: '发错物料' },
  { value: 'near_expiry', label: '近效期退回' },
  { value: 'other', label: '其他原因' },
]
// 展示映射含旧口径值（旧库里 quality_issue/expired 走过退库 → 仍能正确显示）
const REASON_MAP: Record<string, string> = {
  ...Object.fromEntries(REASONS.map(r => [r.value, r.label])),
  quality_issue: '质量问题', expired: '过期/近效期',
}
const reasonLabel = (v?: string) => (v ? REASON_MAP[v] || v : '—')

const config: LaneCConfig = {
  module: 'returns',
  noun: '退库',
  title: '退库管理',
  subtitle: '物料退回仓库，增加库存',
  createLabel: '退库登记',
  createTone: 'blue',
  effect: { text: '库存 +数量', tone: 'up' },
  note: '退库＝把领出去没用完、发错或近效期的物料退回仓库，库存增加。撤销一条退库会对称扣回。物料确实不能用（过期、破损、质量问题）请走"报废"。与"供应商退货"是两回事（那条走供应商对账）。',
  filterKind: 'reason',
  reasons: REASONS,
  reasonLabel,
  createMode: 'reason',
  needsLocations: false,
  columns: [
    { key: 'returnNo', label: '退库单号', render: (r) => <span className="font-mono text-gray-600">{r.returnNo}</span> },
    { key: 'materialName', label: '物料', render: (r) => <span className="font-medium text-gray-900">{r.materialName || r.materialId}</span> },
    { key: 'quantity', label: '数量', align: 'right', sortable: 'quantity', render: (r) => <span className="tabular-nums">{r.quantity} {r.unit || ''}</span> },
    { key: 'reason', label: '退库原因', render: (r) => <span className="px-2 py-0.5 rounded-full text-xs bg-orange-50 text-orange-700">{reasonLabel(r.reason)}</span> },
    { key: 'operator', label: '操作人', render: (r) => <span className="text-gray-600">{r.operator}</span> },
    { key: 'createdAt', label: '时间', sortable: 'createdAt', render: (r) => <span className="text-gray-500 tabular-nums">{formatDate(r.createdAt)}</span> },
    { key: 'remark', label: '备注', render: (r) => <span className="text-gray-500">{r.remark || '—'}</span> },
  ],
  detailFields: (r) => [
    { label: '退库单号', value: r.returnNo },
    { label: '物料', value: r.materialName || r.materialId },
    { label: '数量', value: `${r.quantity} ${r.unit || ''}` },
    { label: '退库原因', value: reasonLabel(r.reason) },
    { label: '操作人', value: r.operator },
    { label: '时间', value: formatDate(r.createdAt) },
    { label: '备注', value: r.remark || '—' },
  ],
  exportSheet: '退库记录',
  exportFileName: '退库记录',
  exportRow: (r) => ({
    退库单号: r.returnNo, 物料: r.materialName || r.materialId, 数量: r.quantity, 单位: r.unit || '',
    退库原因: reasonLabel(r.reason), 操作人: r.operator, 时间: formatDate(r.createdAt), 备注: r.remark || '',
  }),
  api: {
    getList: (params) => returnApi.getList(params),
    getStats: () => returnApi.getStats(),
    create: (form) => returnApi.create({ materialId: form.materialId, quantity: form.quantity, reason: form.reason, remark: form.remark || undefined }),
    remove: (id) => returnApi.delete(id),
  },
  validateCreate: (form) => {
    if (!form.materialId) return '请选择物料'
    if (!form.quantity || form.quantity <= 0) return '请填写正确的退库数量'
    if (!form.reason) return '请选择退库原因'
    return null
  },
}

export default function Returns() {
  return <LaneCPage config={config} />
}
