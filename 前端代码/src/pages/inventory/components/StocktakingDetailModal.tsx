import { AlertTriangle, Loader2, MessageSquarePlus, RotateCcw } from 'lucide-react'
import {
  formatQuantity,
  getStocktakingStatusDisplay,
  type StocktakingDetail,
} from '../hooks/useStocktakingPage'
import { StocktakingDialog } from './StocktakingDialog'

interface Props {
  open: boolean
  row: StocktakingDetail | null
  loading: boolean
  canAdjust: boolean
  canReverse: boolean
  explanation: string
  explanationSubmitting: boolean
  onExplanationChange: (value: string) => void
  onAppendExplanation: () => void
  onAdjust: (row: StocktakingDetail) => void
  onReverse: (row: StocktakingDetail) => void
  onClose: () => void
  returnFocus?: HTMLElement | null
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replaceAll('/', '-')
}

const reasonLabels: Record<string, string> = {
  pending: '待核实',
  missed: '此前漏记出库或入库',
  physical: '实物摆放或标识问题',
  other: '其他',
}

function eventTitle(event: StocktakingDetail['events'][number]) {
  if (event.eventKind === 'adjustment') return '按盘点结果调整库存'
  return event.chainDepth % 2 === 0 ? '恢复原调整' : '撤销上一次调整'
}

export function StocktakingDetailModal(props: Props) {
  if (!props.open) return null
  const row = props.row
  const status = getStocktakingStatusDisplay(row?.status ?? '')
  const canExplain = Boolean(
    props.canAdjust && row && ['adjusted', 'compensated'].includes(row.status) && row.adjustmentEventId,
  )

  return (
    <StocktakingDialog title={row ? `盘点详情 · ${row.stocktakingNo}` : '盘点详情'} onClose={props.onClose} returnFocus={props.returnFocus} size="lg">
      {props.loading || !row ? (
        <div className="flex justify-center py-16 text-gray-500"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-base font-semibold text-gray-900">{row.materialName}</h3><p className="mt-1 text-sm text-gray-500">{row.materialCode} · {row.batchNo ?? '非批次管理'} · {row.locationName ?? '库位待核实'}</p></div>
            <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${status.cls}`}>{status.label}</span>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-gray-200 p-4"><dt className="text-xs text-gray-500">盘点时系统库存</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{formatQuantity(row.systemStock)} {row.unit}</dd></div>
            <div className="rounded-lg border border-gray-200 p-4"><dt className="text-xs text-gray-500">实盘数量</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{formatQuantity(row.actualStock)} {row.unit}</dd></div>
            <div className="rounded-lg border border-gray-200 p-4"><dt className="text-xs text-gray-500">盘点差异</dt><dd className={`mt-1 text-lg font-semibold tabular-nums ${row.difference < 0 ? 'text-rose-700' : row.difference > 0 ? 'text-blue-700' : 'text-emerald-700'}`}>{row.difference > 0 ? '+' : ''}{formatQuantity(row.difference)} {row.unit}</dd></div>
            <div className="rounded-lg border border-gray-200 p-4"><dt className="text-xs text-gray-500">当前库存</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{row.currentStock === null ? '无法确认' : `${formatQuantity(row.currentStock)} ${row.unit}`}</dd></div>
          </dl>

          {row.status === 'pending' ? (
            <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><p><strong>这条记录还没有修改库存。</strong><br />请先核对批次和库位，再决定是否按实盘数量调整。{props.canAdjust ? '' : '你可以查看和记录盘点，但没有调整库存权限。'}</p></div>
          ) : null}

          {row.remark ? <div><h4 className="text-sm font-semibold text-gray-900">盘点备注</h4><p className="mt-2 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700">{row.remark}</p></div> : null}

          <section>
            <h4 className="text-sm font-semibold text-gray-900">库存调整记录</h4>
            {row.events.length === 0 ? <p className="mt-2 rounded-lg border border-dashed border-gray-300 px-4 py-5 text-sm text-gray-500">还没有调整库存。</p> : (
              <ol className="mt-3 space-y-3">
                {row.events.map(event => <li key={event.id} className="rounded-lg border border-gray-200 p-4"><div className="flex flex-wrap justify-between gap-2"><strong className="text-sm text-gray-900">{eventTitle(event)}</strong><span className="text-xs text-gray-500">{event.operator} · {formatDate(event.createdAt)}</span></div><p className="mt-2 text-sm text-gray-700">{formatQuantity(event.inventoryBefore)} → {formatQuantity(event.inventoryAfter)} {row.unit}；原因：{reasonLabels[event.reason] ?? event.reason}</p></li>)}
              </ol>
            )}
          </section>

          <section>
            <h4 className="text-sm font-semibold text-gray-900">后续说明</h4>
            {row.explanations.length === 0 ? <p className="mt-2 text-sm text-gray-500">还没有补充说明。原操作会永久保留，新说明只会追加在后面。</p> : <ol className="mt-3 space-y-2">{row.explanations.map(item => <li key={item.id} className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700"><p>{item.explanation}</p><p className="mt-1 text-xs text-gray-500">{item.operator} · {formatDate(item.createdAt)}</p></li>)}</ol>}
            {canExplain ? <div className="mt-3 flex gap-2"><input aria-label="补充说明" value={props.explanation} onChange={event => props.onExplanationChange(event.target.value)} placeholder="例如：后续确认为漏记出库" className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10" /><button type="button" onClick={props.onAppendExplanation} disabled={!props.explanation.trim() || props.explanationSubmitting} className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"><MessageSquarePlus className="h-4 w-4" />追加说明</button></div> : null}
          </section>

          <div className="flex flex-wrap justify-end gap-3 border-t border-gray-200 pt-5">
            <button type="button" onClick={props.onClose} className="h-10 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">关闭</button>
            {row.status === 'pending' && props.canAdjust ? <button type="button" onClick={() => props.onAdjust(row)} className="h-10 rounded-md bg-blue-500 px-4 text-sm font-medium text-white hover:bg-blue-600">按盘点结果调整库存</button> : null}
            {row.latestEventId && props.canReverse ? <button type="button" onClick={() => props.onReverse(row)} className="inline-flex h-10 items-center gap-2 rounded-md border border-rose-200 px-4 text-sm font-medium text-rose-700 hover:bg-rose-50"><RotateCcw className="h-4 w-4" />{row.status === 'compensated' ? '恢复原调整' : '撤销本次调整'}</button> : null}
          </div>
        </div>
      )}
    </StocktakingDialog>
  )
}
