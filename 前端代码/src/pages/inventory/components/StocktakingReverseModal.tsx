import { Loader2, RotateCcw } from 'lucide-react'
import { formatQuantity, type StocktakingDetail } from '../hooks/useStocktakingPage'
import { StocktakingDialog } from './StocktakingDialog'

interface Props {
  open: boolean
  row: StocktakingDetail | null
  loading: boolean
  reason: string
  submitting: boolean
  onReasonChange: (value: string) => void
  onSubmit: () => void
  onClose: () => void
  returnFocus?: HTMLElement | null
}

export function StocktakingReverseModal(props: Props) {
  if (!props.open) return null
  const restoring = props.row?.status === 'compensated'
  return (
    <StocktakingDialog
      title={restoring ? '恢复原库存调整' : '撤销库存调整'}
      onClose={props.onClose}
      returnFocus={props.returnFocus}
      size="sm"
      footer={<><button type="button" onClick={props.onClose} className="h-10 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">取消</button><button type="button" onClick={props.onSubmit} disabled={!props.row || props.loading || props.submitting || !props.reason.trim()} className="inline-flex h-10 items-center gap-2 rounded-md bg-rose-600 px-4 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50">{props.submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}{restoring ? '确认恢复' : '确认撤销'}</button></>}
    >
      {props.loading || !props.row ? <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div> : <div className="space-y-4"><div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">{restoring ? `系统会新增一条补偿记录，把库存从 ${formatQuantity(props.row.currentStock ?? 0)} ${props.row.unit}恢复到原调整后的数量。` : `系统会新增一条补偿记录，把本次调整撤销。原调整记录不会被删除或改写。`}</div><div><label htmlFor="reverse-reason" className="mb-1 block text-sm font-medium text-gray-700">{restoring ? '恢复原因' : '撤销原因'} *</label><textarea id="reverse-reason" data-autofocus rows={3} value={props.reason} onChange={event => props.onReasonChange(event.target.value)} placeholder={restoring ? '例如：复核后确认原调整正确' : '例如：选错批次，需要重新盘点'} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10" /></div></div>}
    </StocktakingDialog>
  )
}
