import { Plus, Search } from 'lucide-react'
import { useRolesPage } from './hooks/useRolesPage'
import { RolesGrid } from './components/RolesGrid'
import { RoleFormModal } from './components/RoleFormModal'
import { RoleDetailModal } from './components/RoleDetailModal'
import { RoleDeleteModal } from './components/RoleDeleteModal'
import { Pagination } from '@/components/ui/Pagination'

export default function Roles() {
  const page = useRolesPage()

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">角色管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理系统角色和权限配置</p>
        </div>
        {page.canWrite && (
          <button onClick={page.openCreate} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium shadow-sm transition-all h-10">
            <Plus className="w-4 h-4" /> 新建角色
          </button>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">{page.error ? '—' : page.stats.totalRoles}</div>
          <div className="text-sm text-gray-500 mt-1">角色总数</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-blue-600 leading-tight tracking-tight">{page.error ? '—' : page.stats.pageRoles}</div>
          <div className="text-sm text-gray-500 mt-1">本页已加载</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-green-600 leading-tight tracking-tight">{page.error ? '—' : page.stats.activeRoles}</div>
          <div className="text-sm text-gray-500 mt-1">本页启用</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-gray-600 leading-tight tracking-tight">{page.error ? '—' : page.stats.inactiveRoles}</div>
          <div className="text-sm text-gray-500 mt-1">本页停用</div>
        </div>
      </div>

      {/* Role Cards */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between flex-wrap gap-3">
          <span className="text-base font-semibold text-gray-900">角色列表</span>
          <div className="relative w-[280px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              aria-label="搜索角色"
              type="text"
              placeholder="筛选当前页角色名称或标识..."
              value={page.keyword}
              onChange={e => page.setKeyword(e.target.value)}
              className="w-full h-10 pl-10 pr-4 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
        </div>
        <div className="p-5">
          <RolesGrid
            data={page.filteredData}
            loading={page.loading}
            error={page.error}
            canWrite={page.canWrite}
            onRetry={page.refresh}
            onDetail={page.openDetail}
            onEdit={page.openEdit}
            onDelete={page.openDelete}
          />
        </div>
        {!page.error && <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
          <span className="text-sm text-gray-500">共 {page.total} 条记录</span>
          <Pagination
            page={page.page}
            pageSize={page.pageSize}
            total={page.total}
            onChangePage={page.setPage}
            onChangePageSize={page.setPageSize}
          />
        </div>}
      </div>

      {/* Create / Edit Modal */}
      <RoleFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        error={page.formError}
        onClose={() => page.setModalType(null)}
        onChange={form => { page.setForm(form); page.setFormError('') }}
        onSubmit={page.handleSubmit}
        onSetPermLevel={page.setPermLevel}
      />

      {/* Detail Modal */}
      <RoleDetailModal
        open={page.modalType === 'detail'}
        role={page.detailRole}
        onClose={() => page.setModalType(null)}
      />

      {/* Delete Modal */}
      <RoleDeleteModal
        open={page.modalType === 'delete'}
        role={page.deleteRole}
        onClose={() => page.setModalType(null)}
        onConfirm={page.handleDelete}
      />
    </div>
  )
}
