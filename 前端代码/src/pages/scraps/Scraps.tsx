import { scrapApi } from '@/api/inventory'
import { formatDate } from '@/lib/utils'
import { toast } from 'sonner'
import LaneCPage from '../_laneC/LaneCPage'
import type { LaneCConfig, LaneCForm } from '../_laneC/types'
import { createRecoverablePost } from '../returns/recoverablePost'

const REASONS = [
  { value: 'expired', label: '过期报废' },
  { value: 'damaged', label: '破损报废' },
  { value: 'quality_issue', label: '质量问题' },
  { value: 'obsolete', label: '淘汰/停用' },
  { value: 'other', label: '其他原因' },
]
const REASON_MAP: Record<string, string> = Object.fromEntries(REASONS.map(r => [r.value, r.label]))
const reasonLabel = (v?: string) => (v ? REASON_MAP[v] || v : '—')

const postScrap = createRecoverablePost<LaneCForm, { materialId: string; quantity: number; reason: string; remark?: string }, { id?: unknown }>(
  '/scraps',
  (form) => ({ materialId: form.materialId, quantity: form.quantity, reason: form.reason, remark: form.remark || undefined }),
  (result) => typeof result?.id === 'string' && result.id.length > 0,
)

async function createScrap(form: LaneCForm) {
  try {
    return await postScrap(form)
  } catch (error) {
    const gotFailureResponse = Boolean((error as { response?: unknown } | null)?.response)
    toast.error(
      gotFailureResponse ? '报损未创建，服务端已拒绝请求' : '报损结果未知，未取得可验证回执',
      { description: gotFailureResponse ? '请按服务端提示修正后重新确认。' : '请先核对报损列表；相同内容可安全重试并复用幂等键。' },
    )
    throw error
  }
}

const config: LaneCConfig = {
  module: 'scraps',
  noun: '报废',
  title: '报废管理',
  subtitle: '登记报废物料，减少库存',
  createLabel: '报废登记',
  createTone: 'red',
  effect: { text: '库存 −数量', tone: 'down' },
  note: '报废＝物料已不可用（过期、破损、质量问题、淘汰停用），从库存移除。报废金额（按单片成本折算）等成本数据接通后再补，本版先看数量。撤销报废会把库存加回。',
  filterKind: 'reason',
  reasons: REASONS,
  reasonLabel,
  createMode: 'reason',
  needsLocations: false,
  columns: [
    { key: 'scrapNo', label: '报废单号', render: (r) => <span className="font-mono text-gray-600">{r.scrapNo}</span> },
    { key: 'materialName', label: '物料', render: (r) => <span className="font-medium text-gray-900">{r.materialName || r.materialId}</span> },
    { key: 'quantity', label: '数量', align: 'right', sortable: 'quantity', render: (r) => <span className="tabular-nums">{r.quantity} {r.unit || ''}</span> },
    { key: 'reason', label: '报废原因', render: (r) => <span className="px-2 py-0.5 rounded-full text-xs bg-red-50 text-red-700">{reasonLabel(r.reason)}</span> },
    { key: 'operator', label: '操作人', render: (r) => <span className="text-gray-600">{r.operator}</span> },
    { key: 'createdAt', label: '时间', sortable: 'createdAt', render: (r) => <span className="text-gray-500 tabular-nums">{formatDate(r.createdAt)}</span> },
    { key: 'remark', label: '备注', render: (r) => <span className="text-gray-500">{r.remark || '—'}</span> },
  ],
  detailFields: (r) => [
    { label: '报废单号', value: r.scrapNo },
    { label: '物料', value: r.materialName || r.materialId },
    { label: '数量', value: `${r.quantity} ${r.unit || ''}` },
    { label: '报废原因', value: reasonLabel(r.reason) },
    { label: '操作人', value: r.operator },
    { label: '时间', value: formatDate(r.createdAt) },
    { label: '备注', value: r.remark || '—' },
  ],
  exportSheet: '报废记录',
  exportFileName: '报废记录',
  exportRow: (r) => ({
    报废单号: r.scrapNo, 物料: r.materialName || r.materialId, 数量: r.quantity, 单位: r.unit || '',
    报废原因: reasonLabel(r.reason), 操作人: r.operator, 时间: formatDate(r.createdAt), 备注: r.remark || '',
  }),
  api: {
    getList: (params) => scrapApi.getList(params),
    getStats: () => scrapApi.getStats(),
    create: createScrap,
    remove: (id) => scrapApi.delete(id),
  },
  validateCreate: (form) => {
    if (!form.materialId) return '请选择物料'
    if (!form.quantity || form.quantity <= 0) return '请填写正确的报废数量'
    if (!form.reason) return '请选择报废原因'
    return null
  },
}

export default function Scraps() {
  return <LaneCPage config={config} />
}
