import { Search } from 'lucide-react'
import type { OperationLog } from '@/types'
import { Pagination } from '@/components/ui/Pagination'

interface Props {
  data: OperationLog[]
  loading: boolean
  total: number
  page: number
  pageSize: number
  typeFilter: string
  moduleFilter: string
  userFilter: string
  startDate: string
  endDate: string
  logTypes: { value: string; label: string }[]
  modules: { value: string; label: string }[]
  users: { value: string; label: string }[]
  getLogType: (op: string) => { value: string; label: string; className: string }
  getAvatarChar: (name: string) => string
  getModuleLabel: (moduleVal: string) => string
  onTypeFilterChange: (v: string) => void
  onModuleFilterChange: (v: string) => void
  onUserFilterChange: (v: string) => void
  onStartDateChange: (v: string) => void
  onEndDateChange: (v: string) => void
  onSearch: () => void
  onReset: () => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onOpenDetail: (row: OperationLog) => void
}

export function LogsTable({
  data, loading, total, page, pageSize,
  typeFilter, moduleFilter, userFilter, startDate, endDate,
  logTypes, modules, users,
  getLogType, getAvatarChar, getModuleLabel,
  onTypeFilterChange, onModuleFilterChange, onUserFilterChange,
  onStartDateChange, onEndDateChange,
  onSearch, onReset,
  onPageChange, onPageSizeChange,
  onOpenDetail,
}: Props) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between flex-wrap gap-3">
        <span className="text-base font-semibold text-gray-900">操作记录</span>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={typeFilter}
            onChange={e => onTypeFilterChange(e.target.value)}
            className="h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
          >
            <option value="">全部操作类型</option>
            {logTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select
            value={moduleFilter}
            onChange={e => onModuleFilterChange(e.target.value)}
            className="h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
          >
            {modules.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select
            value={userFilter}
            onChange={e => onUserFilterChange(e.target.value)}
            className="h-10 px-3 pr-8 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 appearance-none cursor-pointer"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
          >
            {users.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
          <input
            type="date"
            value={startDate}
            onChange={e => onStartDateChange(e.target.value)}
            className="h-10 px-3 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
          />
          <span className="text-gray-500">至</span>
          <input
            type="date"
            value={endDate}
            onChange={e => onEndDateChange(e.target.value)}
            className="h-10 px-3 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
          />
          <button onClick={onSearch} className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">查询</button>
          <button onClick={onReset} className="h-10 px-4 text-sm font-medium text-gray-700 bg-transparent hover:bg-gray-100 rounded-md transition-all">重置</button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {['操作时间', '操作用户', '操作类型', '操作模块', '操作内容', 'IP地址', '操作'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">加载中...</td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">暂无日志数据</td></tr>
            ) : data.map(row => {
              const logType = getLogType(row.operation)
              return (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3.5 font-mono text-[13px] text-gray-700">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 bg-blue-50 rounded-full flex items-center justify-center text-blue-500 text-xs font-medium">
                        {getAvatarChar(row.username)}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-gray-900">{row.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${logType.className}`}>
                      {logType.label}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-medium">{getModuleLabel(row.requestData?.module as string || '')}</span>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="text-sm text-gray-900">{row.description}</div>
                    {row.requestData && (
                      <div className="text-xs text-gray-500 mt-0.5">{JSON.stringify(row.requestData).slice(0, 60)}...</div>
                    )}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-[13px] text-gray-500">{row.ip}</td>
                  <td className="px-4 py-3.5">
                    <button onClick={() => onOpenDetail(row)} className="h-8 px-3 text-[13px] text-gray-700 hover:bg-gray-100 rounded-md transition-colors">详情</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200 bg-gray-50">
        <span className="text-sm text-gray-500">共 {total} 条记录</span>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChangePage={onPageChange}
          onChangePageSize={onPageSizeChange}
        />
      </div>
    </div>
  )
}
