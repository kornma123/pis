import { Upload } from 'lucide-react'
import { useCallback } from 'react'
import { useInventoryPage } from './hooks/useInventoryPage'
import { InventoryTable } from './components/InventoryTable'
import { OutboundModal } from './components/OutboundModal'
import { MaterialSelectorModal } from './components/MaterialSelectorModal'
import { InventoryDetailModal } from './components/InventoryDetailModal'
import { BatchOutboundModal } from './components/BatchOutboundModal'
import { BatchScrapModal } from './components/BatchScrapModal'
import { canAccess } from '@/lib/permissions'

export default function InventoryList() {
  const page = useInventoryPage()
  const canWriteOutbound = canAccess('outbound', 'W')
  const canWriteScrap = canAccess('scraps', 'W')
  const closeOutboundModal = useCallback(() => page.setOutboundModalOpen(false), [page.setOutboundModalOpen])
  const closeDetailModal = useCallback(() => page.setDetailModalOpen(false), [page.setDetailModalOpen])

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight">库存列表</h1>
          <p className="text-sm text-gray-500 mt-1">浏览正库存物料缓存、FEFO 起始候选与登记库位证据</p>
        </div>
        {canWriteOutbound ? (
          <button
            type="button"
            onClick={page.openEmptyOutboundModal}
            disabled={page.loading || Boolean(page.error)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-150 ease text-sm font-medium shadow-sm"
          >
            <Upload className="w-4 h-4" />
            出库登记
          </button>
        ) : (
          <p className="text-sm text-gray-500">当前账号仅可查看库存证据，没有出库写权限。</p>
        )}
      </div>

      <InventoryTable
        data={page.data}
        loading={page.loading}
        error={page.error}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        keyword={page.keyword}
        category={page.category}
        location={page.location}
        quickFilter={page.quickFilter}
        sortField={page.sortField}
        sortDirection={page.sortDirection}
        selectedIds={page.selectedIds}
        expandedGroups={page.expandedGroups}
        stats={page.computedStats}
        quickFilterCounts={page.quickFilterCounts}
        statsError={page.statsError}
        canOutbound={canWriteOutbound}
        canScrap={canWriteScrap}
        onKeywordChange={page.setKeyword}
        onCategoryChange={page.setCategory}
        onLocationChange={page.setLocation}
        onQuickFilter={page.handleQuickFilter}
        onSort={page.handleSort}
        onSearch={page.handleSearch}
        onReset={page.handleReset}
        onToggleSelectAll={page.toggleSelectAll}
        onToggleSelectOne={page.toggleSelectOne}
        onClearSelection={page.clearSelection}
        onToggleGroup={page.toggleGroup}
        onDetail={page.viewDetail}
        onOutbound={page.openOutboundModal}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onBatchOutbound={page.openBatchOutbound}
        onBatchScrap={() => page.setBatchScrapModalOpen(true)}
        onRetry={page.refresh}
        onRetryStats={page.retryStats}
      />

      <OutboundModal
        open={page.outboundModalOpen}
        materials={page.outboundMaterials}
        remark={page.outboundRemark}
        projectList={page.projectList}
        submitting={page.outboundSubmitting}
        submitError={page.outboundSubmitError}
        onClose={closeOutboundModal}
        onAddMaterial={page.openMaterialSelector}
        onRemoveItem={page.removeOutboundItem}
        onUpdateQuantity={page.updateOutboundQuantity}
        onUpdateProject={page.updateOutboundProject}
        onUpdateUsage={page.updateOutboundUsage}
        onUpdateReceiver={page.updateOutboundReceiver}
        onChangeRemark={page.setOutboundRemark}
        onConfirm={page.confirmOutbound}
      />

      <MaterialSelectorModal
        open={page.materialSelectorOpen}
        tab={page.materialSelectorTab}
        materialList={page.materialList}
        materialLoading={page.materialLoading}
        materialKeyword={page.materialKeyword}
        checkedMaterialIds={page.checkedMaterialIds}
        selectedMaterials={page.selectedMaterials}
        bomList={page.bomList}
        selectedBomId={page.selectedBomId}
        bomMaterials={page.bomMaterials}
        bomLoading={page.bomLoading}
        onClose={() => page.setMaterialSelectorOpen(false)}
        onSwitchTab={(tab) => {
          page.setMaterialSelectorTab(tab)
          if (tab === 'bom') page.fetchBomList()
        }}
        onChangeKeyword={page.setMaterialKeyword}
        onToggleCheck={page.toggleCheckMaterial}
        onToggleCheckAll={page.toggleCheckAllMaterials}
        onRemoveSelected={page.removeSelectedMaterial}
        onAddChecked={page.addCheckedToSelected}
        onConfirm={page.confirmAddMaterials}
        onSelectBom={(id) => {
          page.setSelectedBomId(id)
          page.loadBomDetail(id)
        }}
        filteredMaterialList={page.filteredMaterialList}
      />

      <InventoryDetailModal
        open={page.detailModalOpen}
        item={page.selectedItem}
        canOutbound={canWriteOutbound && !page.error}
        onClose={closeDetailModal}
        onOutbound={() => page.selectedItem && page.openOutboundModal(page.selectedItem)}
      />

      <BatchOutboundModal
        open={page.batchOutboundModalOpen}
        selectedCount={page.selectedIds.size}
        onClose={() => page.setBatchOutboundModalOpen(false)}
        onConfirm={page.confirmBatchOutboundOnly}
      />

      <BatchScrapModal
        open={page.batchScrapModalOpen}
        items={page.data.filter(i => page.selectedIds.has(i.id))}
        scrapReason={page.scrapReason}
        scrapRemark={page.scrapRemark}
        onClose={() => page.setBatchScrapModalOpen(false)}
        onConfirm={page.confirmBatchScrap}
        onChangeReason={page.setScrapReason}
        onChangeRemark={page.setScrapRemark}
      />
    </div>
  )
}
