import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { OutboundRecord } from '@/types'
import { formatCurrency, formatDate } from '@/lib/utils'

interface Props {
  open: boolean
  record: OutboundRecord | null
  onClose: () => void
  onPrint: (record: OutboundRecord) => void
}

const statusConfig: Record<string, { label: string; className: string }> = {
  completed: { label: '已完成', className: 'bg-green-50 text-green-700' },
  pending: { label: '待出库', className: 'bg-amber-50 text-amber-700' },
  cancelled: { label: '已取消', className: 'bg-red-50 text-red-700' },
}

export default function OutboundDetailModal({ open, record, onClose, onPrint }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (!open) return undefined
    titleRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || !record) return null
  const status = statusConfig[record.status] ?? { label: record.status || '未知', className: 'bg-gray-100 text-gray-700' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby="outbound-detail-title" className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 sm:px-6">
          <h2 id="outbound-detail-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-gray-900 outline-none">出库详情</h2>
          <button type="button" aria-label="关闭出库详情" onClick={onClose} className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </header>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <strong className="text-xl text-gray-900">{record.outboundNo}</strong>
            <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>
            <span className="text-sm text-gray-500">{formatDate(record.createdAt)}</span>
          </div>

          <dl className="grid gap-4 rounded-lg bg-gray-50 p-4 sm:grid-cols-2">
            <div><dt className="text-xs text-gray-500">关联项目</dt><dd className="mt-1 text-sm font-medium text-gray-900">{record.projectName || '公共成本'}</dd></div>
            <div><dt className="text-xs text-gray-500">后端记录操作人</dt><dd className="mt-1 text-sm font-medium text-gray-900">{record.operator || '未提供'}</dd></div>
          </dl>

          <div>
            <h3 className="mb-2 font-semibold text-gray-900">实际 FEFO 批次分配</h3>
            <p className="mb-3 text-sm text-gray-500">以下为出库成功后后端返回的全部物料/批次分配，不以列表首批次替代。</p>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-[720px] w-full text-sm">
                <thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-600">物料</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-600">实际批号</th><th className="px-4 py-3 text-right text-xs font-medium text-gray-600">数量</th><th className="px-4 py-3 text-right text-xs font-medium text-gray-600">单价</th><th className="px-4 py-3 text-right text-xs font-medium text-gray-600">金额</th></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {record.items?.length ? record.items.map((item, index) => (
                    <tr key={item.id || `${item.materialId}-${item.batchId || index}`} className="[content-visibility:auto] [contain-intrinsic-size:0_48px]">
                      <td className="px-4 py-3 font-medium text-gray-900">{item.materialName || item.materialId}</td>
                      <td className="px-4 py-3 font-mono text-gray-600">{item.batchNo || '未提供批号'}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{item.quantity} {item.unit}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{typeof item.unitCost === 'number' ? formatCurrency(item.unitCost) : '—'}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{typeof item.totalCost === 'number' ? formatCurrency(item.totalCost) : '—'}</td>
                    </tr>
                  )) : <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-500">接口没有返回批次分配明细，不能据此推断批次。</td></tr>}
                </tbody>
                <tfoot><tr className="bg-gray-50"><td colSpan={4} className="px-4 py-3 text-right font-medium text-gray-700">合计</td><td className="px-4 py-3 text-right font-semibold text-gray-900">{typeof record.totalCost === 'number' ? formatCurrency(record.totalCost) : '—'}</td></tr></tfoot>
              </table>
            </div>
          </div>

          {record.remark && <div className="rounded-lg bg-gray-50 p-3"><div className="text-xs text-gray-500">备注</div><div className="mt-1 text-sm text-gray-700">{record.remark}</div></div>}
        </div>

        <footer className="flex justify-end gap-3 border-t border-gray-200 px-5 py-4 sm:px-6">
          <button type="button" onClick={onClose} className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">关闭</button>
          <button type="button" onClick={() => onPrint(record)} className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">打印</button>
        </footer>
      </section>
    </div>
  )
}
