import { AlertCircle, ArrowLeft, ArrowRight, Loader2, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import {
  formatQuantity,
  parseQuantityInput,
  quantityUnits,
  type StocktakingPositionOption,
} from '../hooks/useStocktakingPage'
import { StocktakingDialog } from './StocktakingDialog'

interface Props {
  open: boolean
  step: 1 | 2 | 3
  positions: StocktakingPositionOption[]
  confirmedPosition: StocktakingPositionOption | null
  loading: boolean
  keyword: string
  selectedPositionId: string
  actualStock: string
  remark: string
  submitting: boolean
  onClose: () => void
  returnFocus?: HTMLElement | null
  onKeywordChange: (value: string) => void
  onSelectPosition: (id: string) => void
  onActualStockChange: (value: string) => void
  onRemarkChange: (value: string) => void
  onStepChange: (step: 1 | 2 | 3) => void
  onSubmit: () => void
}

const stepLabels = ['选择库存位置', '填写实盘数量', '确认盘点结果']

function deltaText(systemStock: number, actualStock: number, unit: string) {
  const deltaUnits = quantityUnits(actualStock) - quantityUnits(systemStock)
  const delta = formatQuantity(Math.abs(deltaUnits) / 10000)
  if (deltaUnits > 0) return `+${delta} ${unit}`
  if (deltaUnits < 0) return `−${delta} ${unit}`
  return `0 ${unit}`
}

export function StocktakingCreateModal(props: Props) {
  if (!props.open) return null
  const selected = props.step === 3
    ? props.confirmedPosition
    : props.positions.find(position => position.id === props.selectedPositionId) ?? null
  const actual = parseQuantityInput(props.actualStock)
  const delta = selected && actual !== null ? quantityUnits(actual) - quantityUnits(selected.quantity) : null

  const moveSelection = (currentIndex: number, direction: 1 | -1) => {
    if (props.positions.length === 0) return
    const next = (currentIndex + direction + props.positions.length) % props.positions.length
    props.onSelectPosition(props.positions[next].id)
    document.getElementById(`stock-position-${props.positions[next].id}`)?.focus()
  }

  const goNext = () => {
    if (props.step === 1 && !selected) {
      toast.error('请选择库存位置')
      return
    }
    if (props.step === 2 && actual === null) {
      toast.error('实盘数量不能小于 0，且最多保留 4 位小数')
      return
    }
    props.onStepChange((props.step + 1) as 2 | 3)
  }

  const footer = (
    <>
      <button type="button" onClick={props.onClose} className="h-10 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">取消</button>
      {props.step > 1 ? (
        <button type="button" onClick={() => props.onStepChange((props.step - 1) as 1 | 2)} className="inline-flex h-10 items-center gap-1 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">
          <ArrowLeft className="h-4 w-4" />上一步
        </button>
      ) : null}
      {props.step < 3 ? (
        <button type="button" onClick={goNext} className="inline-flex h-10 items-center gap-1 rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600">
          下一步<ArrowRight className="h-4 w-4" />
        </button>
      ) : (
        <button type="button" onClick={props.onSubmit} disabled={props.submitting} className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50">
          {props.submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {props.submitting ? '保存中…' : '保存盘点结果'}
        </button>
      )}
    </>
  )

  return (
    <StocktakingDialog title="新建盘点" onClose={props.onClose} returnFocus={props.returnFocus} footer={footer} size="lg">
      <ol className="mb-5 grid grid-cols-3 gap-2" aria-label="新建盘点步骤">
        {stepLabels.map((label, index) => {
          const number = index + 1
          return (
            <li key={label} className={`rounded-lg border px-3 py-2 text-xs font-medium ${number === props.step ? 'border-blue-200 bg-blue-50 text-blue-700' : number < props.step ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-gray-200 text-gray-500'}`}>
              {number}. {label}
            </li>
          )
        })}
      </ol>

      {props.step === 1 ? (
        <div className="space-y-4">
          <div>
            <label htmlFor="stock-position-search" className="mb-1 block text-sm font-medium text-gray-700">搜索已有库存位置</label>
            <input id="stock-position-search" data-autofocus value={props.keyword} onChange={event => props.onKeywordChange(event.target.value)} placeholder="搜索物料名称或编码" className="h-10 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10" />
          </div>
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            这里只显示系统中已有的库存位置。如果找不到对应的批次或库位，请取消本次盘点，并联系管理员补充资料。
          </div>
          <div role="radiogroup" aria-label="已有库存位置" className="max-h-[410px] space-y-2 overflow-y-auto pr-1">
            {props.loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500"><Loader2 className="h-5 w-5 animate-spin" />正在加载库存位置…</div>
            ) : props.positions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500">没有找到可盘点的库存位置。</div>
            ) : props.positions.map((position, index) => {
              const selectedRow = position.id === props.selectedPositionId
              const label = `${position.materialName}，${position.batchNo ?? '非批次管理'}，${position.locationName}`
              return (
                <button
                  key={position.id}
                  id={`stock-position-${position.id}`}
                  type="button"
                  role="radio"
                  aria-checked={selectedRow}
                  aria-label={label}
                  onClick={() => props.onSelectPosition(position.id)}
                  onKeyDown={event => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); moveSelection(index, 1) }
                    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(index, -1) }
                  }}
                  className={`grid w-full grid-cols-[auto_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border p-4 text-left transition-colors ${selectedRow ? 'border-blue-500 bg-blue-50/60' : 'border-gray-200 hover:border-blue-200 hover:bg-gray-50'}`}
                >
                  <span aria-hidden="true" className={`h-4 w-4 rounded-full border-[5px] ${selectedRow ? 'border-blue-500' : 'border-gray-300'}`} />
                  <span className="min-w-0"><strong className="block truncate text-sm text-gray-900">{position.materialName}</strong><span className="block truncate font-mono text-xs text-gray-500">{position.materialCode}</span></span>
                  <span><span className="block text-xs text-gray-500">批次</span><span className="block truncate text-sm text-gray-800">{position.batchNo ?? '非批次管理'}</span></span>
                  <span><span className="block text-xs text-gray-500">库位</span><span className="block truncate text-sm text-gray-800">{position.locationName}</span></span>
                  <span className="text-right"><span className="block text-xs text-gray-500">当前库存</span><strong className="tabular-nums text-sm text-gray-900">{formatQuantity(position.quantity)} {position.unit}</strong></span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {props.step === 2 && selected ? (
        <div className="space-y-5">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-start gap-3"><MapPin className="mt-0.5 h-5 w-5 text-blue-500" /><div><strong className="text-sm text-gray-900">{selected.materialName}</strong><p className="mt-1 text-sm text-gray-600">{selected.batchNo ?? '非批次管理'} · {selected.locationName}</p></div></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className="mb-1 block text-sm font-medium text-gray-700">盘点时系统库存</label><div className="flex h-10 items-center rounded-md border border-gray-200 bg-gray-50 px-3 text-sm tabular-nums text-gray-700">{formatQuantity(selected.quantity)} {selected.unit}</div></div>
            <div><label htmlFor="actual-stock" className="mb-1 block text-sm font-medium text-gray-700">实盘数量 *</label><input id="actual-stock" data-autofocus type="number" min="0" step="0.0001" value={props.actualStock} onChange={event => props.onActualStockChange(event.target.value)} className="h-10 w-full rounded-md border border-gray-300 px-3 text-sm tabular-nums focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10" /><p className="mt-1 text-xs text-gray-500">可以填 0，不能小于 0；最多保留 4 位小数。</p></div>
          </div>
          <div><label htmlFor="stocktaking-remark" className="mb-1 block text-sm font-medium text-gray-700">盘点备注</label><textarea id="stocktaking-remark" rows={3} value={props.remark} onChange={event => props.onRemarkChange(event.target.value)} placeholder="例如：同一货架另外发现 2 盒，未贴入库标签（选填）" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10" /></div>
          {actual !== null ? (
            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3"><span className="text-sm text-gray-600">保存后只记录盘点结果，不会修改库存数量。</span><strong className={`tabular-nums ${delta === 0 ? 'text-emerald-700' : delta && delta > 0 ? 'text-blue-700' : 'text-rose-700'}`}>{deltaText(selected.quantity, actual, selected.unit)}</strong></div>
          ) : null}
        </div>
      ) : null}

      {props.step === 3 && selected && actual !== null ? (
        <div className="space-y-5">
          <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0" /><p><strong>请再次核对批次和库位。</strong><br />保存后只记录盘点结果，当前库存仍不会改变；如果有差异，需要另行确认库存调整。</p></div>
          <dl className="divide-y divide-gray-100 rounded-lg border border-gray-200 px-4">
            <div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-gray-500">物料</dt><dd className="font-medium text-gray-900">{selected.materialName}</dd></div>
            <div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-gray-500">批次、库位</dt><dd className="text-right font-medium text-gray-900">{selected.batchNo ?? '非批次管理'} / {selected.locationName}</dd></div>
            <div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-gray-500">盘点时系统库存 → 实盘数量</dt><dd className="font-medium tabular-nums text-gray-900">{formatQuantity(selected.quantity)} → {formatQuantity(actual)} {selected.unit}</dd></div>
            <div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-gray-500">差异</dt><dd className="font-semibold tabular-nums text-blue-700">{deltaText(selected.quantity, actual, selected.unit)}</dd></div>
          </dl>
        </div>
      ) : null}
    </StocktakingDialog>
  )
}
