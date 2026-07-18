import { Search } from 'lucide-react'
import type { ProjectCostReport } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { Pagination } from '@/components/ui/Pagination'
import { RankBadge } from './RankBadge'
import { ChangeBadge } from './ChangeBadge'

export type SampleDataSource = 'all' | 'lis' | 'manual'
type SampleCountSource = 'lis' | 'manual' | 'unavailable'
type ProjectCostRow = ProjectCostReport['projects'][number] & {
  sampleCountSource?: SampleCountSource
}

const PROJECT_TYPES: Record<string, { label: string; className: string }> = {
  he: { label: '病理技术-HE制片', className: 'bg-blue-50 text-blue-600' },
  ihc: { label: '病理技术-免疫组化', className: 'bg-indigo-50 text-indigo-600' },
  ss: { label: '病理技术-特殊染色', className: 'bg-teal-50 text-teal-600' },
  mp: { label: '分子诊断', className: 'bg-purple-50 text-purple-600' },
  cyto: { label: '病理诊断-细胞学检测', className: 'bg-amber-50 text-amber-600' },
}

const SAMPLE_SOURCE_LABELS: Record<SampleCountSource, string> = {
  lis: 'LIS 已映射病例',
  manual: '手工样本数',
  unavailable: '无可用样本数',
}

function formatPercentage(value: unknown): string {
  if (value === null || value === undefined || value === '') return '不可计算'
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 100) return '不可计算'
  return `${number.toFixed(1)}%`
}

function formatNumber(value: unknown): string {
  if (value === null || value === undefined || value === '') return '不可计算'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString() : '不可计算'
}

function formatCost(value: unknown): string {
  if (value === null || value === undefined || value === '') return '不可计算'
  const number = Number(value)
  return Number.isFinite(number) ? formatCurrency(number) : '不可计算'
}

interface Props {
  loading: boolean
  data: ProjectCostReport['projects']
  total: number
  page: number
  pageSize: number
  searchText: string
  projectFilter: string
  dataSource: SampleDataSource
  onSearchTextChange: (v: string) => void
  onProjectFilterChange: (v: string) => void
  onDataSourceChange: (v: SampleDataSource) => void
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
        <span className="text-sm text-gray-500">样本数来源</span>
        <div className="flex items-center gap-1 bg-white rounded-md border border-gray-200 p-0.5">
          <button
            onClick={() => onDataSourceChange('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              dataSource === 'all' ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            LIS优先，无数据时手工
          </button>
          <button
            onClick={() => onDataSourceChange('lis')}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              dataSource === 'lis' ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            仅LIS已映射病例
          </button>
          <button
            onClick={() => onDataSourceChange('manual')}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              dataSource === 'manual' ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            仅手工样本数
          </button>
        </div>
        <span className="text-xs text-gray-400">LIS 仅统计已映射到项目的病例</span>
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
          <option value="he">病理技术-HE制片</option>
          <option value="ihc">病理技术-免疫组化</option>
          <option value="ss">病理技术-特殊染色</option>
          <option value="mp">分子诊断</option>
          <option value="cyto">病理诊断-细胞学检测</option>
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
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">样本数</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">单样本成本</th>
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
                const row = p as ProjectCostRow
                const changeValue = typeof p.changeRate === 'number' && Number.isFinite(p.changeRate)
                  ? p.changeRate
                  : null
                const category = PROJECT_TYPES[p.category] || {
                  label: p.category || '其他',
                  className: 'bg-gray-100 text-gray-600',
                }
                const sampleSource = row.sampleCountSource || 'unavailable'
                return (
                  <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3"><RankBadge rank={rank} /></td>
                    <td className="px-4 py-3 font-semibold text-gray-900">{p.name}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${category.className}`}>
                        {category.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(p.totalCost)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatPercentage(p.ratio)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      <div>{sampleSource === 'unavailable' ? '不可计算' : formatNumber(p.sampleCount)}</div>
                      <div className="text-[11px] text-gray-400">{SAMPLE_SOURCE_LABELS[sampleSource]}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {sampleSource === 'unavailable' ? '不可计算' : formatCost(p.unitCost)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {changeValue === null
                        ? <span className="text-xs text-gray-400">不可计算</span>
                        : <ChangeBadge value={changeValue} />}
                    </td>
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
