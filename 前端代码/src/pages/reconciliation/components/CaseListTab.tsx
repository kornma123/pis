import { Search } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import type { UsePaginationReturn } from '@/hooks/usePagination'
import type { ProjectReconcile, LisCase } from '../hooks/useReconciliationPage'

interface Props {
  caseSearch: string
  setCaseSearch: (v: string) => void
  caseFilterProject: string
  setCaseFilterProject: (v: string) => void
  caseFilterStatus: string
  setCaseFilterStatus: (v: string) => void
  casePagination: UsePaginationReturn<LisCase>
  projects: ProjectReconcile[]
  getStatusBadge: (status: string) => string
  getStatusLabel: (status: string) => string
  onEditCase: (c: LisCase) => void
  onReset: () => void
  canWrite: boolean
}

export function CaseListTab({
  caseSearch,
  setCaseSearch,
  caseFilterProject,
  setCaseFilterProject,
  caseFilterStatus,
  setCaseFilterStatus,
  casePagination,
  projects,
  getStatusBadge,
  getStatusLabel,
  onEditCase,
  onReset,
  canWrite,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">搜索病理号</span>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索病理号..."
              value={caseSearch}
              onChange={event => setCaseSearch(event.target.value)}
              className="h-9 w-48 rounded-md border border-gray-300 pl-9 pr-4 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label>
            <span className="sr-only">检测项目筛选</span>
            <select value={caseFilterProject} onChange={event => setCaseFilterProject(event.target.value)} className="h-9 rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none">
              <option value="">全部检测项目</option>
              {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">病例状态筛选</span>
            <select value={caseFilterStatus} onChange={event => setCaseFilterStatus(event.target.value)} className="h-9 rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none">
              <option value="">全部状态</option>
              <option value="normal">正常</option>
              <option value="modified">已修改</option>
              <option value="unmatched">未关联 BOM</option>
            </select>
          </label>
          <button type="button" onClick={onReset} className="h-9 px-3 text-sm text-gray-500 hover:text-gray-700">重置</button>
        </div>
      </div>

      {casePagination.error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>病例数据没能加载。{casePagination.data.length ? '下表是上次成功结果，仅供回看，修改已关闭。' : '当前筛选不显示为空结果。'}</span>
          <button type="button" className="font-medium underline underline-offset-2" onClick={casePagination.refresh}>重试</button>
        </div>
      )}
      {casePagination.loading && <div role="status" className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">病例数据加载中…</div>}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">按病理号查看的 LIS 病例及关联状态</caption>
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
                <th scope="col" className="px-4 py-3 text-left">病理号</th>
                <th scope="col" className="px-4 py-3 text-left">检测项目</th>
                <th scope="col" className="px-4 py-3 text-left">操作时间</th>
                <th scope="col" className="px-4 py-3 text-left">操作人</th>
                <th scope="col" className="px-4 py-3 text-center">状态</th>
                {canWrite && <th scope="col" className="px-4 py-3 text-center">处理</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {casePagination.data.map(item => (
                <tr key={item.id} className="hover:bg-gray-50" style={{ contentVisibility: 'auto' }}>
                  <th scope="row" className="px-4 py-3 text-left font-mono font-semibold text-gray-900">{item.case_no}</th>
                  <td className="px-4 py-3">
                    <span className="mb-1 inline-block rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600">{item.projectName || item.project_name || '未关联'}</span>
                    {!item.hasBom && <div className="text-xs text-red-500">未关联 BOM</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{item.operate_time || '未提供'}</td>
                  <td className="px-4 py-3 text-gray-600">{item.operator || '未提供'}</td>
                  <td className="px-4 py-3 text-center"><span className={`inline-block rounded-full px-2 py-1 text-xs ${getStatusBadge(item.status)}`}>{getStatusLabel(item.status)}</span></td>
                  {canWrite && (
                    <td className="px-4 py-3 text-center">
                      <button type="button" disabled={!!casePagination.error || casePagination.loading} onClick={() => onEditCase(item)} className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50">修改</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {casePagination.data.length === 0 && !casePagination.loading && !casePagination.error && (
          <div className="py-12 text-center text-gray-400">当前筛选没有病例数据</div>
        )}
        <div className="border-t border-gray-200 px-4 py-3">
          <Pagination page={casePagination.page} pageSize={casePagination.pageSize} total={casePagination.total} onChange={casePagination.setPage} onPageSizeChange={casePagination.setPageSize} />
        </div>
      </div>
    </div>
  )
}
