import { Search } from 'lucide-react'
import type { User } from '@/types'
import { Pagination } from '@/components/ui/Pagination'
import type { RoleItem } from '../hooks/useUsersPage'

interface Props {
  data: User[]
  loading: boolean
  error?: string | null
  total: number
  page: number
  pageSize: number
  keyword: string
  roles: RoleItem[]
  canWrite: boolean
  onKeywordChange: (value: string) => void
  onSearch: () => void
  onReset: () => void
  onRetry?: () => void
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onOpenDetail: (row: User) => void
  onOpenEdit: (row: User) => void
  onToggleStatus: (row: User) => void
  onDelete: (id: string) => void
}

export function UsersTable({
  data, loading, error = null, total, page, pageSize, keyword, roles, canWrite,
  onKeywordChange, onSearch, onReset, onRetry,
  onPageChange, onPageSizeChange, onOpenDetail, onOpenEdit, onToggleStatus, onDelete,
}: Props) {
  const roleNames = new Map(roles.map(role => [role.code, role.name]))
  const getRoleLabel = (code: string) => roleNames.get(code) || code

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 sm:px-5 py-4 border-b border-gray-200 bg-gray-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <span className="text-base font-semibold text-gray-900">用户列表</span>
          <p className="mt-1 text-xs text-gray-500">筛选能力以当前用户接口为准：用户名或姓名关键字</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="relative sm:w-[280px]">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              aria-label="搜索用户"
              type="search"
              placeholder="搜索用户名、姓名..."
              value={keyword}
              onChange={event => onKeywordChange(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') onSearch() }}
              className="w-full h-10 pl-10 pr-4 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <div className="flex gap-2">
            <button onClick={onSearch} className="h-10 px-4 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 shadow-sm transition-all">查询</button>
            <button onClick={onReset} className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition-all">重置</button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {['用户名', '姓名', '部门', '角色', '状态', '最近登录', '操作'].map(heading => (
                <th key={heading} scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-500">正在加载用户...</td></tr>
            ) : error ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center">
                  <div role="alert" className="inline-flex flex-col items-center gap-3 text-sm text-red-700">
                    <span>{error}</span>
                    {onRetry && <button onClick={onRetry} className="h-9 px-3 rounded-md border border-red-200 bg-white hover:bg-red-50">重新加载</button>}
                  </div>
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-500">当前没有已记录用户</td></tr>
            ) : data.map(row => {
              const assignedRoles = Array.isArray((row as User & { roles?: string[] }).roles)
                ? (row as User & { roles?: string[] }).roles!
                : [row.role]
              return (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 56px' }}>
                  <td className="px-4 py-3.5 font-medium text-gray-900">{row.username}</td>
                  <td className="px-4 py-3.5 text-gray-900">{row.realName}</td>
                  <td className="px-4 py-3.5 text-gray-700">{row.department || '未填写'}</td>
                  <td className="px-4 py-3.5 text-gray-700">{assignedRoles.map(getRoleLabel).join('、')}</td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${row.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-600'}`}>
                      {row.status === 'active' ? '正常' : '禁用'}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-gray-500">接口未提供</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-1">
                      <button onClick={() => onOpenDetail(row)} className="h-8 px-3 text-[13px] text-gray-700 hover:bg-gray-100 rounded-md transition-colors">详情</button>
                      {canWrite && (
                        <>
                          <button onClick={() => onOpenEdit(row)} className="h-8 px-3 text-[13px] text-gray-700 hover:bg-gray-100 rounded-md transition-colors">编辑</button>
                          <button onClick={() => onToggleStatus(row)} className="h-8 px-3 text-[13px] text-gray-700 hover:bg-gray-100 rounded-md transition-colors">{row.status === 'active' ? '停用' : '启用'}</button>
                          <button onClick={() => onDelete(row.id)} className="h-8 px-3 text-[13px] text-red-600 hover:bg-red-50 rounded-md transition-colors">删除</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!error && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 py-4 border-t border-gray-200 bg-gray-50">
          <span className="text-sm text-gray-500">共 {total} 条记录</span>
          <Pagination page={page} pageSize={pageSize} total={total} onChangePage={onPageChange} onChangePageSize={onPageSizeChange} />
        </div>
      )}
    </div>
  )
}
