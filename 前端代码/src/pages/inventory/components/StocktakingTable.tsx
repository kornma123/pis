import { ClipboardCheck, Loader2, Search } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import {
  formatQuantity,
  getStocktakingStatusDisplay,
  type StocktakingRecord,
} from '../hooks/useStocktakingPage'

interface Props {
  data: StocktakingRecord[]
  loading: boolean
  total: number
  page: number
  pageSize: number
  keyword: string
  statusFilter: string
  statusOptions: Array<{ value: string; label: string }>
  canRecord: boolean
  canAdjust: boolean
  onKeywordChange: (value: string) => void
  onStatusFilterChange: (value: string) => void
  onQuery: () => void
  onReset: () => void
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onOpenCreate: () => void
  onOpenDetail: (row: StocktakingRecord) => void
  onOpenAdjust: (row: StocktakingRecord) => void
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replaceAll('/', '-')
}

function differenceText(value: number) {
  if (value > 0) return `+${formatQuantity(value)}`
  if (value < 0) return `−${formatQuantity(Math.abs(value))}`
  return '0'
}

export function StocktakingTable(props: Props) {
  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-gray-200 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
        <div><h2 className="text-base font-semibold text-gray-900">盘点记录</h2><p className="mt-1 text-xs text-gray-500">按最新记录排序。“待处理”表示盘点结果已保存，但库存还没有调整。</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input value={props.keyword} onChange={event => props.onKeywordChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') props.onQuery() }} placeholder="搜索物料、批次或盘点编号" className="h-10 w-full rounded-md border border-gray-300 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10" />
          </div>
          <select aria-label="盘点状态" value={props.statusFilter} onChange={event => props.onStatusFilterChange(event.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10">
            {props.statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button type="button" onClick={props.onQuery} className="h-10 rounded-md border border-gray-300 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">查询</button>
          <button type="button" onClick={props.onReset} className="h-10 px-3 text-sm font-medium text-gray-500 transition-colors hover:text-gray-900">重置</button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              {['盘点编号', '物料 / 位置', '批次', '盘点时系统库存', '实盘数量', '差异', '状态', '盘点人 / 时间', '操作'].map((label, index) => (
                <th key={label} className={`px-4 py-3 text-xs font-medium text-gray-500 ${[3, 4, 5].includes(index) ? 'text-right' : 'text-left'}`}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {props.loading ? (
              <tr><td colSpan={9} className="px-4 py-14 text-center text-gray-500"><span className="inline-flex items-center gap-2"><Loader2 className="h-5 w-5 animate-spin" />正在加载盘点记录…</span></td></tr>
            ) : props.data.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-14 text-center"><ClipboardCheck className="mx-auto h-11 w-11 text-gray-300" /><h3 className="mt-3 font-medium text-gray-900">还没有盘点记录</h3><p className="mt-1 text-sm text-gray-500">选择系统中已有的库存位置开始盘点。账实相符也会保存盘点人和时间。</p>{props.canRecord ? <button type="button" onClick={props.onOpenCreate} className="mt-4 h-10 rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600">新建第一笔盘点</button> : null}</td></tr>
            ) : props.data.map(row => {
              const status = getStocktakingStatusDisplay(row.status)
              const unit = row.unit || ''
              return (
                <tr key={row.id} className="transition-colors hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-600">{row.stocktakingNo}</td>
                  <td className="px-4 py-3"><strong className="block text-gray-900">{row.materialName}</strong><span className="mt-0.5 block text-xs text-gray-500">{row.locationName ?? '库位待核实'} · {unit || '未设单位'}</span></td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-600">{row.batchNo ?? '非批次管理'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{formatQuantity(row.systemStock)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{formatQuantity(row.actualStock)}</td>
                  <td className={`px-4 py-3 text-right font-semibold tabular-nums ${row.difference > 0 ? 'text-blue-700' : row.difference < 0 ? 'text-rose-700' : 'text-gray-500'}`}>{differenceText(row.difference)}</td>
                  <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${status.cls}`}>{status.label}</span></td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-700">{row.operator}<span className="mt-0.5 block text-xs text-gray-500">{formatDate(row.createdAt)}</span></td>
                  <td className="whitespace-nowrap px-4 py-3"><button id={`stock-detail-${row.id}`} type="button" onClick={() => props.onOpenDetail(row)} className="px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:text-blue-600">详情</button>{row.status === 'pending' && props.canAdjust ? <button type="button" onClick={() => props.onOpenAdjust(row)} className="px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:text-blue-700">调整库存</button> : null}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-gray-200 px-5 py-3 text-xs text-gray-500">如果找不到对应的批次或库位，请取消本次盘点，并联系管理员补充资料。本页不能新建批次或库位。</div>
      <Pagination page={props.page} pageSize={props.pageSize} total={props.total} onChange={props.onPageChange} onPageSizeChange={props.onPageSizeChange} />
    </section>
  )
}
