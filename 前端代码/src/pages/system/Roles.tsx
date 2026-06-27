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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">角色管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理系统角色和权限配置</p>
        </div>
        <button
          onClick={page.openCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium shadow-sm transition-all h-10"
        >
          <Plus className="w-4 h-4" /> 新建角色
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">{page.stats.totalRoles}</div>
          <div className="text-sm text-gray-500 mt-1">角色总数</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-blue-500 leading-tight tracking-tight">{page.stats.systemRoles}</div>
          <div className="text-sm text-gray-500 mt-1">系统角色</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-gray-500 leading-tight tracking-tight">{page.stats.customRoles}</div>
          <div className="text-sm text-gray-500 mt-1">自定义角色</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-[28px] font-semibold text-green-500 leading-tight tracking-tight">{page.stats.assignedUsers}</div>
          <div className="text-sm text-gray-500 mt-1">已分配用户</div>
        </div>
      </div>

      {/* Role Cards */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between flex-wrap gap-3">
          <span className="text-base font-semibold text-gray-900">角色列表</span>
          <div className="relative w-[280px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="搜索角色名称..."
              value={page.keyword}
              onChange={e => page.setKeyword(e.target.value)}
              className="w-full h-10 pl-10 pr-4 text-sm text-gray-900 bg-white border border-gray-200 rounded-md outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
        </div>
        <div className="p-5">
          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-200 mb-5">
            {[
              { key: 'all' as const, label: '全部角色' },
              { key: 'system' as const, label: '系统角色' },
              { key: 'custom' as const, label: '自定义角色' },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => page.setTabType(t.key)}
                className={`px-5 py-3 text-sm font-medium border-b-2 transition-all ${page.tabType === t.key ? 'text-blue-500 border-blue-500' : 'text-gray-500 border-transparent hover:text-gray-900 hover:bg-gray-50'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <RolesGrid
            data={page.filteredData}
            loading={page.loading}
            onDetail={page.openDetail}
            onEdit={page.openEdit}
            onDelete={page.openDelete}
            getDataScopeLabel={page.getDataScopeLabel}
          />
        </div>
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200 bg-gray-50">
          <span className="text-sm text-gray-500">共 {page.total} 条记录</span>
          <Pagination
            page={page.page}
            pageSize={page.pageSize}
            total={page.total}
            onChangePage={page.setPage}
            onChangePageSize={page.setPageSize}
          />
        </div>
      </div>

      {/* Create / Edit Modal */}
      <RoleFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
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
