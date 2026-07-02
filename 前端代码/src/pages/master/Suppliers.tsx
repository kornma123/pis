import { Plus } from 'lucide-react'
import { useSuppliersPage } from './hooks/useSuppliersPage'
import { SupplierTable } from './components/SupplierTable'
import { SupplierFormModal } from './components/SupplierFormModal'
import { SupplierDetailModal } from './components/SupplierDetailModal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export default function Suppliers() {
  const page = useSuppliersPage()

  return (
    <div className="space-y-5">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">
            供应商管理
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理供应商信息，维护采购渠道
          </p>
        </div>
        <button
          onClick={page.openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          新增供应商
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { value: page.stats.total, label: '供应商总数', color: 'text-gray-900' as const },
          { value: page.stats.active, label: '合作中', color: 'text-green-600' as const },
          { value: page.stats.inactive, label: '已终止', color: 'text-gray-600' as const },
          { value: page.stats.newThisMonth, label: '本月新增', color: 'text-blue-600' as const },
        ].map((stat, i) => (
          <div
            key={i}
            className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm"
          >
            <div className={`text-2xl font-semibold ${stat.color}`}>
              {stat.value}
            </div>
            <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* 表格 */}
      <SupplierTable
        data={page.data}
        loading={page.loading}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        selectedIds={page.selectedIds}
        searchKeyword={page.searchKeyword}
        searchStatus={page.searchStatus}
        getAvatarColor={page.getAvatarColor}
        onSearchKeywordChange={page.setSearchKeyword}
        onSearchStatusChange={page.setSearchStatus}
        onSearch={page.handleSearch}
        onReset={page.handleReset}
        onToggleSelectAll={page.toggleSelectAll}
        onToggleSelect={page.toggleSelect}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onOpenDetail={page.openDetail}
        onOpenEdit={page.openEdit}
        onToggleStatus={page.handleToggleStatus}
        onDelete={page.handleDelete}
      />

      {/* 新建/编辑弹窗 */}
      <SupplierFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      {/* 详情弹窗 */}
      <SupplierDetailModal
        open={page.modalType === 'detail'}
        row={page.detailRow}
        getAvatarColor={page.getAvatarColor}
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
