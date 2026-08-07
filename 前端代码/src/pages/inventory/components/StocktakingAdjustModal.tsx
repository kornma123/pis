import { Loader2 } from 'lucide-react'
import { formatQuantity, type StocktakingDetail } from '../hooks/useStocktakingPage'
import { StocktakingDialog } from './StocktakingDialog'

interface Props {
  open: boolean
  row: StocktakingDetail | null
  loading: boolean
  reason: string
  submitting: boolean
  onChangeReason: (value: string) => void
  onSubmit: () => void
  onClose: () => void
  returnFocus?: HTMLElement | null
}

export function StocktakingAdjustModal(props: Props) {
  if (!props.open) return null
  const row = props.row
  const current = row?.currentStock ?? row?.systemStock ?? 0
  const target = row?.actualStock ?? 0
  const difference = target - current
  const unit = row?.unit ?? ''
  const delta = `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${formatQuantity(Math.abs(difference))} ${unit}`

  return (
    <StocktakingDialog
      title="确认库存调整"
      onClose={props.onClose}
      returnFocus={props.returnFocus}
      footer={(
        <>
          <button type="button" onClick={props.onClose} className="h-10 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">取消</button>
          <button type="button" onClick={props.onSubmit} disabled={!row || props.loading || props.submitting || !props.reason} className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50">
            {props.submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{props.submitting ? '调整中…' : '确认调整'}
          </button>
        </>
      )}
    >
      {props.loading || !row ? <div className="flex justify-center py-12 text-gray-500"><Loader2 className="h-5 w-5 animate-spin" /></div> : (
        <div className="space-y-5">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            确认后，当前库存将从 {formatQuantity(current)} {unit}调整为 {formatQuantity(target)} {unit}。此次只修改库存数量，不会新增入库记录，也不会改变累计入库数量。
          </div>
          <div>
            <label htmlFor="adjust-reason" className="mb-1 block text-sm font-medium text-gray-700">差异原因 *</label>
            <select id="adjust-reason" data-autofocus value={props.reason} onChange={event => props.onChangeReason(event.target.value)} className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10">
              <option value="pending">待核实</option>
              <option value="missed">此前漏记出库或入库</option>
              <option value="physical">实物摆放或标识问题</option>
              <option value="other">其他</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">原因还不确定时，可以先选“待核实”。提交后只能补充说明，不能改写这次调整。</p>
          </div>
          <dl className="divide-y divide-gray-100 rounded-lg border border-gray-200 px-4">
            <div className="flex justify-between py-3 text-sm"><dt className="text-gray-500">当前库存</dt><dd className="font-medium tabular-nums">{formatQuantity(current)} {unit}</dd></div>
            <div className="flex justify-between py-3 text-sm"><dt className="text-gray-500">调整后库存</dt><dd className="font-medium tabular-nums">{formatQuantity(target)} {unit}</dd></div>
            <div className="flex justify-between py-3 text-sm"><dt className="text-gray-500">调整数量</dt><dd className={`font-semibold tabular-nums ${difference < 0 ? 'text-rose-700' : 'text-blue-700'}`}>{delta}</dd></div>
          </dl>
        </div>
      )}
    </StocktakingDialog>
  )
}
