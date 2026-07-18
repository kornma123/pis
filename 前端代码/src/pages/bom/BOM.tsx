import { Plus, Layers, CheckCircle, AlertTriangle, XCircle } from 'lucide-react'
import { useBOMPage } from './hooks/useBOMPage'
import { StatCard } from './components/StatCard'
import { BOMTable } from './components/BOMTable'
import { BOMFormModal } from './components/BOMFormModal'
import { BOMDetailModal } from './components/BOMDetailModal'
import { BOMCopyModal } from './components/BOMCopyModal'
import { BOMDeleteModal } from './components/BOMDeleteModal'
import { BOMBatchDeleteModal } from './components/BOMBatchDeleteModal'

export default function BOMPage() {
  const page = useBOMPage()

  return (
    <div className="space-y-5">
      {/* 页面头部 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">
            BOM清单
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理物料清单，配置检测服务所需耗材
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={page.openCreate}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors h-10 shadow-sm"
          >
            <Plus className="w-4 h-4" />
            新建BOM
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="BOM总数" value={page.stats.total} icon={Layers} colorClass="bg-blue-50 text-blue-600" />
        <StatCard label="物料充足" value={page.stats.sufficient} icon={CheckCircle} colorClass="bg-green-50 text-green-600" />
        <StatCard label="库存偏低" value={page.stats.low} icon={AlertTriangle} colorClass="bg-yellow-50 text-yellow-600" />
        <StatCard label="库存不足" value={page.stats.insufficient} icon={XCircle} colorClass="bg-red-50 text-red-600" />
      </div>

      {/* 表格区域 */}
      <BOMTable
        data={page.data}
        loading={page.loading}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        searchInput={page.searchInput}
        filterType={page.filterType}
        filterStatus={page.filterStatus}
        quickFilter={page.quickFilter}
        selectedIds={page.selectedIds}
        isAllSelected={page.isAllSelected}
        isIndeterminate={page.isIndeterminate}
        onSearchInputChange={page.setSearchInput}
        onSearch={page.handleSearch}
        onReset={page.handleReset}
        onFilterTypeChange={(v) => { page.setFilterType(v); page.setPage(1) }}
        onFilterStatusChange={(v) => { page.setFilterStatus(v); page.setPage(1) }}
        onQuickFilterChange={(v) => { page.setQuickFilter(v as any); page.setFilterStatus(''); page.setPage(1) }}
        onToggleSelectAll={page.toggleSelectAll}
        onToggleSelectRow={page.toggleSelectRow}
        onClearSelection={page.cancelSelection}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onOpenDetail={page.openDetail}
        onOpenEdit={page.openEdit}
        onOpenCopy={page.openCopy}
        onOpenDelete={page.openDelete}
        onBatchDelete={page.openBatchDelete}
      />

      {/* 弹窗 */}
      <BOMFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        detailBom={page.detailBom}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      <BOMDetailModal
        open={page.modalType === 'detail'}
        bom={page.detailBom}
        tab={page.detailTab}
        onClose={() => page.setModalType(null)}
        onChangeTab={page.setDetailTab}
        onEdit={() => {
          if (page.detailBom) page.openEdit(page.detailBom)
        }}
      />

      <BOMCopyModal
        open={page.modalType === 'copy'}
        editingId={page.editingId}
        copyForm={page.copyForm}
        data={page.data}
        onClose={() => page.setModalType(null)}
        onChange={page.setCopyForm}
        onConfirm={page.handleCopy}
      />

      <BOMDeleteModal
        open={page.modalType === 'delete'}
        editingId={page.editingId}
        data={page.data}
        onClose={() => page.setModalType(null)}
        onConfirm={page.handleDelete}
      />

      <BOMBatchDeleteModal
        open={page.modalType === 'batchDelete'}
        selectedCount={page.selectedIds.size}
        onClose={() => page.setModalType(null)}
        onConfirm={page.handleBatchDelete}
      />

    </div>
  )
}
