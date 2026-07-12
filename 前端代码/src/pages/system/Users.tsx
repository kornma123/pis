import { Plus } from 'lucide-react'
import { useUsersPage } from './hooks/useUsersPage'
import { UsersTable } from './components/UsersTable'
import { UserFormModal } from './components/UserFormModal'
import { UserDetailModal } from './components/UserDetailModal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export default function Users() {
  const page = useUsersPage()

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">用户管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理系统用户、角色和权限分配</p>
        </div>
        <button onClick={page.openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium shadow-sm transition-all">
          <Plus className="w-4 h-4" /> 新建用户
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-gray-900">{page.stats.totalUsers}</div>
          <div className="text-sm text-gray-500 mt-1">用户总数</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-green-500">{page.stats.activeUsers}</div>
          <div className="text-sm text-gray-500 mt-1">启用用户</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-gray-600">{page.stats.inactiveUsers}</div>
          <div className="text-sm text-gray-500 mt-1">停用用户</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-blue-500">{page.stats.adminUsers}</div>
          <div className="text-sm text-gray-500 mt-1">管理员</div>
        </div>
      </div>

      {/* Table */}
      <UsersTable
        data={page.data}
        loading={page.loading}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        keyword={page.keyword}
        roleFilter={page.roleFilter}
        statusFilter={page.statusFilter}
        selectedRoleId={page.selectedRoleId}
        roles={page.roles}
        onKeywordChange={page.setKeyword}
        onRoleFilterChange={page.setRoleFilter}
        onStatusFilterChange={page.setStatusFilter}
        onSelectedRoleIdChange={page.setSelectedRoleId}
        onSearch={page.handleSearch}
        onReset={page.handleReset}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onOpenDetail={page.openDetail}
        onOpenEdit={page.openEdit}
        onToggleStatus={page.handleToggleStatus}
        onDelete={page.handleDelete}
      />

      {/* Create / Edit Modal */}
      <UserFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      {/* Detail Modal */}
      <UserDetailModal
        open={page.modalType === 'detail'}
        user={page.detailUser}
        onClose={() => page.setModalType(null)}
        onEdit={page.openEdit}
      />

      {/* ConfirmDialog */}
      {page.confirmOpen && page.confirmProps && (
        <ConfirmDialog
          open={page.confirmOpen}
          title={page.confirmProps.title}
          description={page.confirmProps.description}
          confirmText={page.confirmProps.confirmText}
          confirmVariant={page.confirmProps.confirmVariant}
          onConfirm={() => {
            page.setConfirmOpen(false)
            page.confirmProps?.onConfirm()
          }}
          onCancel={() => page.setConfirmOpen(false)}
        />
      )}
    </div>
  )
}
