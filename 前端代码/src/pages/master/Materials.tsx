import { Plus } from 'lucide-react'
import { useMaterialsPage } from './hooks/useMaterialsPage'
import { MaterialTable } from './components/MaterialTable'
import { MaterialFormModal } from './components/MaterialFormModal'
import { MaterialDetailModal } from './components/MaterialDetailModal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export default function Materials() {
  const page = useMaterialsPage()

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">物料管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理耗材的基础配置信息、规格参数和供应商信息</p>
        </div>
        <button onClick={page.openCreate} className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium">
          <Plus className="w-4 h-4" />
          新建物料
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-blue-600">{page.stats.total}</div>
          <div className="text-sm text-gray-500 mt-1">物料总数</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-green-600">{page.stats.active}</div>
          <div className="text-sm text-gray-500 mt-1">已启用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-gray-600">{page.stats.inactive}</div>
          <div className="text-sm text-gray-500 mt-1">已停用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-amber-600">{page.stats.lowStock}</div>
          <div className="text-sm text-gray-500 mt-1">低库存预警</div>
        </div>
      </div>

      {/* Table */}
      <MaterialTable
        data={page.data}
        loading={page.loading}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        selectedIds={page.selectedIds}
        keyword={page.keyword}
        categoryId={page.categoryId}
        supplierId={page.supplierId}
        quickFilter={page.quickFilter}
        categories={page.categories}
        suppliers={page.suppliers}
        getCategoryName={page.getCategoryName}
        getSupplierName={page.getSupplierName}
        statusBadge={page.statusBadge}
        onKeywordChange={page.setKeyword}
        onCategoryIdChange={(v) => { page.setCategoryId(v); page.setPage(1); page.setSelectedIds(new Set()) }}
        onSupplierIdChange={(v) => { page.setSupplierId(v); page.setPage(1); page.setSelectedIds(new Set()) }}
        onQuickFilterChange={(v) => { page.setQuickFilter(v); page.setPage(1); page.setSelectedIds(new Set()) }}
        onSearch={page.handleSearch}
        onReset={page.handleReset}
        onToggleSelectAll={page.toggleSelectAll}
        onToggleSelect={page.toggleSelect}
        onClearSelection={page.clearSelection}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onOpenDetail={page.openDetail}
        onOpenEdit={page.openEdit}
        onToggleStatus={page.handleToggleStatus}
        onDelete={page.handleDelete}
        onBatchToggleStatus={page.batchToggleStatus}
        onBatchDelete={page.batchDelete}
      />

      {/* Create/Edit Modal */}
      <MaterialFormModal
        open={page.modalOpen}
        editingId={page.editingId}
        form={page.form}
        specPart={page.specPart}
        categories={page.categories}
        suppliers={page.suppliers}
        onClose={() => page.setModalOpen(false)}
        onChange={page.setForm}
        onSpecPartChange={page.setSpecPart}
        onCategoryChange={(val) => {
          if (!page.editingId && val) page.autoFillCode(val)
        }}
        onSubmit={page.handleSubmit}
      />

      {/* Detail Modal */}
      <MaterialDetailModal
        open={page.detailModalOpen}
        row={page.detailMaterial}
        getCategoryName={page.getCategoryName}
        getSupplierName={page.getSupplierName}
        statusBadge={page.statusBadge}
        onClose={() => page.setDetailModalOpen(false)}
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
