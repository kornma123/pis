import { Search, Download } from 'lucide-react'
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
}: Props) {
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索病理号..."
                value={caseSearch}
                onChange={e => setCaseSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && casePagination.setPage(1)}
                className="pl-9 pr-4 h-9 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500 w-48"
              />
            </div>
            <select
              value={caseFilterProject}
              onChange={e => setCaseFilterProject(e.target.value)}
              className="h-9 px-3 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
            >
              <option value="">全部检测项目</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              value={caseFilterStatus}
              onChange={e => setCaseFilterStatus(e.target.value)}
              className="h-9 px-3 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
            >
              <option value="">全部状态</option>
              <option value="normal">正常</option>
              <option value="modified">已修改</option>
              <option value="unmatched">未关联BOM</option>
            </select>
            <button onClick={() => casePagination.setPage(1)} className="h-9 px-4 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200">查询</button>
            <button onClick={onReset} className="h-9 px-4 text-sm text-gray-500 hover:text-gray-700">重置</button>
          </div>
          <button className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
            <Download className="w-4 h-4" />
            导出
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-200">
                <th className="px-4 py-3 text-left">病理号</th>
                <th className="px-4 py-3 text-left">检测项目</th>
                <th className="px-4 py-3 text-left">操作时间</th>
                <th className="px-4 py-3 text-left">操作人</th>
                <th className="px-4 py-3 text-center">状态</th>
                <th className="px-4 py-3 text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {casePagination.data.map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono font-semibold text-gray-900">{c.case_no}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 text-xs bg-blue-50 text-blue-600 rounded mb-1">
                      {c.projectName || c.project_name || '-'}
                    </span>
                    {!c.hasBom && (
                      <div className="text-xs text-red-500">未关联BOM</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.operate_time || '-'}</td>
                  <td className="px-4 py-3 text-gray-600">{c.operator || '-'}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block px-2 py-1 text-xs rounded-full ${getStatusBadge(c.status)}`}>
                      {getStatusLabel(c.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => onEditCase(c)}
                      className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                    >
                      修改
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {casePagination.data.length === 0 && !casePagination.loading && (
          <div className="text-center py-12 text-gray-400">暂无病例数据，请先导入LIS数据</div>
        )}
        <div className="px-4 py-3 border-t border-gray-200">
          <Pagination
            page={casePagination.page}
            pageSize={casePagination.pageSize}
            total={casePagination.total}
            onChange={casePagination.setPage}
            onPageSizeChange={casePagination.setPageSize}
          />
        </div>
      </div>
    </div>
  )
}
