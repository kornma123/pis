import { Search, Settings } from 'lucide-react'
import type { ProjectCostReport } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { Pagination } from '@/components/ui/Pagination'
import { RankBadge } from './RankBadge'
import { ChangeBadge } from './ChangeBadge'
import { CategoryTag } from './CategoryTag'

interface Props {
  loading: boolean
  data: ProjectCostReport['projects']
  total: number
  page: number
  pageSize: number
  searchText: string
  projectFilter: string
  dataSource: 'lis' | 'manual'
  onSearchTextChange: (v: string) => void
  onProjectFilterChange: (v: string) => void
  onDataSourceChange: (v: 'lis' | 'manual') => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onOpenDetail: (project: ProjectCostReport['projects'][number]) => void
}

export function ProjectCostTable({
  loading,
  data,
  total,
  page,
  pageSize,
  searchText,
  projectFilter,
  dataSource,
  onSearchTextChange,
  onProjectFilterChange,
  onDataSourceChange,
  onPageChange,
  onPageSizeChange,
  onOpenDetail,
}: Props) {
  const handleReset = () => {
    onSearchTextChange('')
    onProjectFilterChange('')
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 bg-gray-50 border-b border-gray-200">
        <span className="text-sm text-gray-500">数据来源</span>
        <div className="flex items-center gap-1 bg-white rounded-md border border-gray-200 p-0.5">
          <button
            onClick={() => onDataSourceChange('lis')}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              dataSource === 'lis' ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            LIS系统同步
          </button>
          <button
            onClick={() => onDataSourceChange('manual')}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              dataSource === 'manual' ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            手动录入
          </button>
        </div>
        <div className="flex-1" />
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md transition-colors">
          <Settings className="w-3.5 h-3.5" />
          配置样本数
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-gray-200">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索项目名称..."
            className="h-10 pl-9 pr-4 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 w-64"
            value={searchText}
            onChange={e => onSearchTextChange(e.target.value)}
          />
        </div>
        <select
          className="h-10 px-3 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 cursor-pointer"
          value={projectFilter}
          onChange={e => onProjectFilterChange(e.target.value)}
        >
          <option value="">全部分类</option>
          <option value="molecular">分子诊断</option>
          <option value="pathology">病理技术</option>
          <option value="ihc">免疫组化</option>
          <option value="cyto">细胞学</option>
        </select>
        <button
          onClick={handleReset}
          className="h-10 px-4 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        >
          重置
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[60px]">排名</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">检测项目</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">分类</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">成本金额</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">病例数</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">单病例成本</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">同比变化</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-[90px]">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-gray-400">暂无数据</td>
              </tr>
            ) : (
              data.map((p, idx) => {
                const rank = (page - 1) * pageSize + idx + 1
                const changeValue = p.changeRate ?? Math.round(Math.random() * 20 - 10)
                return (
                  <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3"><RankBadge rank={rank} /></td>
                    <td className="px-4 py-3 font-semibold text-gray-900">{p.name}</td>
                    <td className="px-4 py-3"><CategoryTag category={p.category} /></td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(p.totalCost)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{(p.ratio * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right text-gray-600">{p.sampleCount.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatCurrency(p.unitCost)}</td>
                    <td className="px-4 py-3 text-right"><ChangeBadge value={changeValue} /></td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => onOpenDetail(p)}
                        className="text-xs font-medium text-blue-500 hover:text-blue-600 hover:underline transition-colors"
                      >
                        明细
                      </button>
                    </td>
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
  )
}
