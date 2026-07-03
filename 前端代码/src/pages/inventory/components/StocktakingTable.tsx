import { Search, FolderOpen, Loader2, Trash2 } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { getStocktakingStatusDisplay, type StocktakingRecord } from '../hooks/useStocktakingPage'

interface Props {
  data: StocktakingRecord[]
  loading: boolean
  total: number
  page: number
  pageSize: number
  keyword: string
  statusFilter: string
  scopeFilter: string
  statusOptions: { value: string; label: string }[]
  scopeOptions: { value: string; label: string }[]
  onKeywordChange: (v: string) => void
  onStatusFilterChange: (v: string) => void
  onScopeFilterChange: (v: string) => void
  onQuery: () => void
  onReset: () => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onOpenDetail: (row: StocktakingRecord) => void
  onOpenAdjust: (row: StocktakingRecord) => void
  onOpenDelete: (row: StocktakingRecord) => void
}

export function StocktakingTable({
  data, loading, total, page, pageSize,
  keyword, statusFilter, scopeFilter,
  statusOptions, scopeOptions,
  onKeywordChange, onStatusFilterChange, onScopeFilterChange,
  onQuery, onReset,
  onPageChange, onPageSizeChange,
  onOpenDetail, onOpenAdjust, onOpenDelete,
}: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <span className="text-base font-semibold text-gray-900">盘点记录</span>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="搜索盘点编号/盘点名称..." value={keyword} onChange={e => onKeywordChange(e.target.value)} className="w-56 pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
          </div>
          <select value={statusFilter} onChange={e => onStatusFilterChange(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500">
            {statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={scopeFilter} onChange={e => onScopeFilterChange(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500">
            {scopeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={onQuery} className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium transition-colors">查询</button>
          <button onClick={onReset} className="px-4 py-2 text-gray-500 hover:text-gray-700 text-sm font-medium transition-colors">重置</button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点编号</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点范围</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点方式</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点进度</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">差异数量</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">负责人</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">创建时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400"><div className="flex items-center justify-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />加载中...</div></td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400"><FolderOpen className="w-10 h-10 mx-auto mb-2 text-gray-300" /><div>暂无盘点记录</div><div className="text-xs mt-1">点击"新建盘点"创建盘点任务</div></td></tr>
            ) : data.map(row => (
              <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.stocktakingNo}</td>
                <td className="px-4 py-3 font-medium text-gray-900">{row.materialName ? `${row.materialName}盘点` : row.stocktakingNo}</td>
                <td className="px-4 py-3 text-gray-500">全部物料</td>
                <td className="px-4 py-3 text-gray-500">全盘</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full" style={{ width: '100%' }} />
                    </div>
                    <span className="text-xs text-gray-500">1/1</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-sm font-medium ${row.difference === 0 ? 'text-gray-400' : row.difference > 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {row.difference === 0 ? '0项' : `${Math.abs(row.difference)}项`}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-700">{row.operator || '-'}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-') : '-'}</td>
                <td className="px-4 py-3">
                  {(() => { const s = getStocktakingStatusDisplay(row.status); return (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${s.cls}`}>{s.label}</span>
                  ) })()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <button onClick={() => onOpenDetail(row)} className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors">详情</button>
                    {row.status === 'pending' && row.difference !== 0 && (
                      <button onClick={() => onOpenAdjust(row)} className="px-2 py-1 text-blue-500 hover:text-blue-600 text-xs font-medium transition-colors">处理差异</button>
                    )}
                    <button onClick={() => onOpenDelete(row)} className="px-2 py-1 text-gray-400 hover:text-red-600 text-xs font-medium transition-colors" title="撤销">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </div>
  )
}
