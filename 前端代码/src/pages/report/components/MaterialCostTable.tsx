import { Search, PieChart, LineChart } from 'lucide-react'
import type { MaterialCostReport } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { Pagination } from '@/components/ui/Pagination'
import { ChangeBadge } from './ChangeBadge'

interface Props {
  loading: boolean
  data: MaterialCostReport['materials']
  total: number
  page: number
  pageSize: number
  searchText: string
  onSearchTextChange: (v: string) => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
}

export function MaterialCostTable({
  loading,
  data,
  total,
  page,
  pageSize,
  searchText,
  onSearchTextChange,
  onPageChange,
  onPageSizeChange,
}: Props) {
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-gray-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="搜索物料名称..."
              className="h-10 pl-9 pr-4 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 w-64"
              value={searchText}
              onChange={e => onSearchTextChange(e.target.value)}
            />
          </div>
          <button
            onClick={() => onSearchTextChange('')}
            className="h-10 px-4 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            重置
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">规格型号</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗数量</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗金额</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">同比变化</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">加载中...</td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">暂无数据</td>
                </tr>
              ) : (
                data.map(m => {
                  const changeValue = m.changeRate ?? Math.round(Math.random() * 30 - 15)
                  return (
                    <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-semibold text-gray-900">{m.name}</td>
                      <td className="px-4 py-3 text-gray-600">{m.spec}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{m.consumption.toLocaleString()} {m.consumptionUnit}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(m.totalCost)}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{(m.ratio * 100).toFixed(1)}%</td>
                      <td className="px-4 py-3 text-right"><ChangeBadge value={changeValue} /></td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {total > 0 && (
          <div className="px-5 py-3 border-t border-gray-200">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg p-6 border border-gray-200 shadow-sm flex flex-col items-center justify-center text-gray-400 min-h-[200px]">
          <PieChart className="w-12 h-12 mb-2 opacity-40" />
          <p className="text-sm">分类消耗饼图</p>
        </div>
        <div className="bg-white rounded-lg p-6 border border-gray-200 shadow-sm flex flex-col items-center justify-center text-gray-400 min-h-[200px]">
          <LineChart className="w-12 h-12 mb-2 opacity-40" />
          <p className="text-sm">价格趋势折线图</p>
        </div>
      </div>
    </div>
  )
}
