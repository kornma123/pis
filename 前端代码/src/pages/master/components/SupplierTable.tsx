import { Search } from 'lucide-react'
import type { Supplier } from '@/types'
import { Pagination } from '@/components/ui/Pagination'

interface Props {
  data: Supplier[]
  loading: boolean
  total: number
  page: number
  pageSize: number
  selectedIds: Set<string>
  searchKeyword: string
  searchStatus: string
  getAvatarColor: (name: string) => { bg: string; text: string }
  onSearchKeywordChange: (v: string) => void
  onSearchStatusChange: (v: string) => void
  onSearch: () => void
  onReset: () => void
  onToggleSelectAll: () => void
  onToggleSelect: (id: string) => void
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onOpenDetail: (row: Supplier) => void
  onOpenEdit: (row: Supplier) => void
  onToggleStatus: (row: Supplier) => void
  onDelete: (id: string) => void
}

export function SupplierTable({
  data, loading, total, page, pageSize, selectedIds,
  searchKeyword, searchStatus,
  getAvatarColor,
  onSearchKeywordChange, onSearchStatusChange, onSearch, onReset,
  onToggleSelectAll, onToggleSelect,
  onPageChange, onPageSizeChange,
  onOpenDetail, onOpenEdit, onToggleStatus, onDelete,
}: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-200">
        <span className="text-sm font-medium text-gray-900">供应商列表</span>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="搜索供应商名称"
              value={searchKeyword}
              onChange={(e) => onSearchKeywordChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              className="w-56 h-10 pl-9 pr-3 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={searchStatus}
            onChange={(e) => onSearchStatusChange(e.target.value)}
            className="h-10 px-3 border border-gray-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">全部状态</option>
            <option value="active">合作中</option>
            <option value="inactive">已终止</option>
          </select>
          <button
            onClick={onSearch}
            className="h-10 px-4 text-sm text-gray-700 hover:bg-gray-50 rounded-md border border-gray-200 transition-colors"
          >
            查询
          </button>
          <button
            onClick={onReset}
            className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-200 transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* 表格 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left w-10">
                <input
                  type="checkbox"
                  checked={data.length > 0 && selectedIds.size === data.length}
                  onChange={onToggleSelectAll}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                供应商名称/编码
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                联系人
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                联系电话
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                合作状态
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                创建时间
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  加载中...
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              data.map((row) => {
                const avatarColor = getAvatarColor(row.name)
                const firstChar = row.name.charAt(0)
                return (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={() => onToggleSelect(row.id)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center font-semibold text-sm shrink-0"
                          style={{ backgroundColor: avatarColor.bg, color: avatarColor.text }}
                        >
                          {firstChar}
                        </div>
                        <div>
                          <div className="font-medium text-gray-900">{row.name}</div>
                          <div className="text-xs text-gray-500">{row.code}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{row.contact || '-'}</td>
                    <td className="px-4 py-3 text-gray-600">{row.phone || '-'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        row.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {row.status === 'active' ? '合作中' : '已终止'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {row.createdAt ? row.createdAt.split('T')[0] : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onOpenDetail(row)}
                          className="px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        >
                          详情
                        </button>
                        <button
                          onClick={() => onOpenEdit(row)}
                          className="px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => onToggleStatus(row)}
                          className="px-2 py-1 text-xs text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors"
                        >
                          {row.status === 'active' ? '停用' : '启用'}
                        </button>
                        <button
                          onClick={() => onDelete(row.id)}
                          className="px-2 py-1 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200">
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
