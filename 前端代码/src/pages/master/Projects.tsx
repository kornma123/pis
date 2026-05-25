import { Upload, Plus } from 'lucide-react'
import { useProjectsPage } from './hooks/useProjectsPage'
import { ProjectTable } from './components/ProjectTable'
import { ProjectCreateModal } from './components/ProjectCreateModal'
import { ProjectEditModal } from './components/ProjectEditModal'
import { ProjectCopyModal } from './components/ProjectCopyModal'
import { ProjectDeleteModal } from './components/ProjectDeleteModal'
import { ProjectImportModal } from './components/ProjectImportModal'

export default function Projects() {
  const page = useProjectsPage()

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">
            检测服务
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            管理病理实验室检测服务类型和BOM清单关联，监控物料成本与库存支撑能力
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => page.setModalType('import')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium shadow-sm transition-colors"
          >
            <Upload className="w-4 h-4" />导入
          </button>
          <button
            onClick={page.openCreate}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />新建服务
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-blue-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-blue-600">{page.stats.total}</div>
          <div className="mt-1 text-sm text-gray-500">检测服务总数</div>
        </div>
        <div className="bg-white rounded-lg border border-green-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-green-600">{page.stats.active}</div>
          <div className="mt-1 text-sm text-gray-500">已启用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-gray-600">{page.stats.inactive}</div>
          <div className="mt-1 text-sm text-gray-500">已停用</div>
        </div>
        <div className="bg-white rounded-lg border border-amber-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-amber-600">{page.stats.noBom}</div>
          <div className="mt-1 text-sm text-gray-500">BOM未配置</div>
        </div>
      </div>

      {/* Table */}
      <ProjectTable
        data={page.data}
        loading={page.loading}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        keyword={page.keyword}
        typeFilter={page.typeFilter}
        statusFilter={page.statusFilter}
        bomFilter={page.bomFilter}
        selectedIds={page.selectedIds}
        onKeywordChange={page.setKeyword}
        onTypeFilterChange={(v) => { page.setTypeFilter(v); page.setPage(1) }}
        onStatusFilterChange={(v) => { page.setStatusFilter(v); page.setPage(1) }}
        onBomFilterChange={(v) => { page.setBomFilter(v); page.setPage(1) }}
        onQuery={page.handleQuery}
        onReset={page.handleReset}
        onToggleSelectAll={page.toggleSelectAll}
        onToggleSelectOne={page.toggleSelectOne}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onOpenEdit={page.openEdit}
        onOpenCopy={page.openCopy}
        onBatchEnable={page.batchEnable}
        onBatchDisable={page.batchDisable}
        onClearSelection={() => page.setSelectedIds(new Set())}
        onSetEditingRow={page.setEditingRow}
        onSetModalType={(t) => page.setModalType(t)}
      />

      {/* Modals */}
      <ProjectCreateModal
        open={page.modalType === 'create'}
        form={page.form}
        createStep={page.createStep}
        bomOption={page.bomOption}
        selectedBomId={page.selectedBomId}
        boms={page.boms}
        selectedBom={page.selectedBom}
        isSubmitting={page.isSubmitting}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSetCreateStep={page.setCreateStep}
        onSetBomOption={page.setBomOption}
        onSetSelectedBomId={page.setSelectedBomId}
        onSubmit={page.handleSubmit}
      />

      <ProjectEditModal
        open={page.modalType === 'edit'}
        editingRow={page.editingRow}
        form={page.form}
        editTab={page.editTab}
        boms={page.boms}
        isSubmitting={page.isSubmitting}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSetEditTab={page.setEditTab}
        onSubmit={page.handleSubmit}
        onOpenDelete={page.openDelete}
      />

      <ProjectCopyModal
        open={page.modalType === 'copy'}
        editingRow={page.editingRow}
        form={page.form}
        isSubmitting={page.isSubmitting}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onConfirm={page.handleSubmit}
      />

      <ProjectDeleteModal
        open={page.modalType === 'delete'}
        editingRow={page.editingRow}
        onClose={() => page.setModalType(null)}
        onConfirm={page.handleDeleteConfirm}
      />

      <ProjectImportModal
        open={page.modalType === 'import'}
        onClose={() => page.setModalType(null)}
      />
    </div>
  )
}
