import { Plus, ChevronDown, ChevronUp } from 'lucide-react'
import { useCategoriesPage } from './hooks/useCategoriesPage'
import { CategoryTree } from './components/CategoryTree'
import { CategoryDetail } from './components/CategoryDetail'
import { CategoryFormModal } from './components/CategoryFormModal'
import { CategoryDeleteModal } from './components/CategoryDeleteModal'

export default function Categories() {
  const page = useCategoriesPage()

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">
            物料分类
          </h1>
          <p className="text-sm text-gray-500 mt-1">病理实验室物料三级分类管理</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={page.expandAll}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 text-sm font-medium shadow-sm transition-all h-10"
          >
            <ChevronDown className="w-4 h-4" />
            展开全部
          </button>
          <button
            onClick={page.collapseAll}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 text-sm font-medium shadow-sm transition-all h-10"
          >
            <ChevronUp className="w-4 h-4" />
            收起全部
          </button>
          <button
            onClick={() => page.openCreate(null, 1)}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium shadow-sm transition-all h-10"
          >
            <Plus className="w-4 h-4" />
            新建分类
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-blue-500">{page.stats.total}</div>
          <div className="text-sm text-gray-500 mt-1">分类总数</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-green-500">{page.stats.active}</div>
          <div className="text-sm text-gray-500 mt-1">已启用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-gray-500">{page.stats.inactive}</div>
          <div className="text-sm text-gray-500 mt-1">已停用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <div className="text-2xl font-semibold text-blue-500">{page.stats.totalMaterials}</div>
          <div className="text-sm text-gray-500 mt-1">关联物料数</div>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex gap-5 min-h-[500px]">
        <CategoryTree
          tree={page.tree}
          loading={page.loading}
          expandedIds={page.expandedIds}
          selectedId={page.selectedId}
          searchKeyword={page.searchKeyword}
          onToggleExpand={page.toggleExpand}
          onSelectNode={page.setSelectedId}
          onSearchKeywordChange={page.setSearchKeyword}
          onOpenCreate={page.openCreate}
          onOpenEdit={page.openEdit}
          onOpenDelete={page.openDelete}
          onContextMenu={page.handleContextMenu}
          filterMatch={page.filterMatch}
        />

        <div className="flex-1 bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <CategoryDetail
            node={page.selectedNode}
            breadcrumb={page.selectedNode ? page.getBreadcrumb(page.selectedNode.id) : []}
            onEdit={page.openEdit}
            onAddChild={page.openCreate}
          />
        </div>
      </div>

      {/* Context Menu */}
      {page.contextMenu && (
        <div
          ref={page.contextRef}
          className="fixed z-[60] bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[140px]"
          style={{ left: page.contextMenu.x, top: page.contextMenu.y }}
        >
          {page.contextMenu.node.level < 3 && (
            <button
              onClick={() => {
                page.openCreate(page.contextMenu!.node.id, page.contextMenu!.node.level + 1)
                page.setContextMenu(null)
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              添加子分类
            </button>
          )}
          <button
            onClick={() => {
              page.openEdit(page.contextMenu!.node)
              page.setContextMenu(null)
            }}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
          >
            <Edit2 className="w-4 h-4" />
            编辑分类
          </button>
          <div className="h-px bg-gray-200 my-1" />
          <button
            onClick={() => {
              page.openDelete(page.contextMenu!.node)
              page.setContextMenu(null)
            }}
            className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-red-50 flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            删除分类
          </button>
        </div>
      )}

      {/* Create/Edit Modal */}
      <CategoryFormModal
        open={page.modalOpen}
        editingId={page.editingId}
        form={page.form}
        flatList={page.flatList}
        onClose={() => page.setModalOpen(false)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      {/* Delete Confirm Modal */}
      <CategoryDeleteModal
        open={page.deleteModalOpen}
        target={page.deleteTarget}
        onClose={() => page.setDeleteModalOpen(false)}
        onConfirm={page.confirmDelete}
      />
    </div>
  )
}
