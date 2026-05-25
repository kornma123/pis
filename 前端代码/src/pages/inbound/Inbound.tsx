import { QrCode, Plus, Upload, Printer } from 'lucide-react'
import ImportInboundModal from './components/ImportInboundModal'
import InboundFormModal from './components/InboundFormModal'
import InboundDetailModal from './components/InboundDetailModal'
import InboundRestoreModal from './components/InboundRestoreModal'
import InboundScanModal from './components/InboundScanModal'
import InboundPrintModal from './components/InboundPrintModal'
import InboundTable from './components/InboundTable'
import InboundFilterBar from './components/InboundFilterBar'
import InboundStats from './components/InboundStats'
import InboundQuickFilters from './components/InboundQuickFilters'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useInboundPage } from './hooks/useInboundPage'

export default function Inbound() {
  const page = useInboundPage()

  return (
    <div className="space-y-5">
      {/* 页面头部 */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">入库记录</h1>
          <p className="text-sm text-gray-500 mt-1">管理物料入库记录，跟踪采购入库流程</p>
        </div>
      </div>

      {/* 快捷操作栏 */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={page.openCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-colors shadow-sm"
        >
          <Plus className="w-[18px] h-[18px]" /> 新增入库
        </button>
        <button
          onClick={() => page.setModalType('scan')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <QrCode /> 扫码入库
        </button>
        <button
          onClick={() => page.setModalType('import')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <Upload /> 批量导入
        </button>
        <button
          onClick={() => page.setModalType('print')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <Printer /> 打印记录
        </button>
      </div>

      {/* 统计卡片 */}
      <InboundStats
        total={page.stats.total}
        amount={page.stats.amount}
        pendingOrders={page.stats.pendingOrders}
        supplierCount={page.stats.supplierCount}
        onFilterStatus={page.setFilterStatus}
      />

      {/* 快速筛选 */}
      <InboundQuickFilters
        items={[
          { key: 'all', label: '全部', count: page.quickFilterCounts.all },
          { key: 'today', label: '今日', count: page.quickFilterCounts.today },
          { key: 'week', label: '本周', count: page.quickFilterCounts.week },
          { key: 'month', label: '本月', count: page.quickFilterCounts.month },
        ]}
        activeKey={page.activeQuickFilter}
        onChange={page.setActiveQuickFilter}
      />

      {/* 主卡片 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <InboundFilterBar
          searchKeyword={page.searchKeyword}
          onSearchChange={page.setSearchKeyword}
          filterMaterial={page.filterMaterial}
          onMaterialChange={page.setFilterMaterial}
          filterStatus={page.filterStatus}
          onStatusChange={page.setFilterStatus}
          filterType={page.filterType}
          onTypeChange={page.setFilterType}
          filterStartDate={page.filterStartDate}
          onStartDateChange={page.setFilterStartDate}
          filterEndDate={page.filterEndDate}
          onEndDateChange={page.setFilterEndDate}
          onQuery={() => page.setPage(1)}
          onReset={page.handleResetFilters}
          materials={page.materials}
        />
        <InboundTable
          data={page.data}
          loading={page.loading}
          selectedIds={page.selectedIds}
          onToggleSelectAll={page.toggleSelectAll}
          onToggleSelectOne={page.toggleSelectOne}
          isAllSelected={page.isAllSelected}
          isIndeterminate={page.isIndeterminate}
          onClearSelection={page.clearSelection}
          onDetail={page.openDetail}
          onEdit={page.openEdit}
          onDelete={page.handleDelete}
          onRestore={page.openRestore}
          onPrint={page.handlePrintRecord}
          onBatchExport={page.handleBatchExport}
          onBatchPrint={page.handleBatchPrint}
          page={page.page}
          pageSize={page.pageSize}
          total={page.total}
          onPageChange={page.setPage}
          onPageSizeChange={page.setPageSize}
        />
      </div>

      {/* 弹窗区域 */}
      <InboundFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        modalType={page.modalType as 'create' | 'edit'}
        form={page.form}
        setForm={page.setForm}
        materials={page.materials}
        locations={page.locations}
        suppliers={page.suppliers}
        purchaseOrders={page.purchaseOrders}
        selectedOrderId={page.selectedOrderId}
        setSelectedOrderId={page.setSelectedOrderId}
        selectedRecord={page.selectedRecord}
        submitting={page.submitting}
        onClose={page.closeModal}
        onSubmit={page.handleSubmit}
      />

      <InboundDetailModal
        open={page.modalType === 'detail'}
        record={page.selectedRecord}
        materials={page.materials}
        onClose={page.closeModal}
        onPrint={() => page.setModalType('print')}
      />

      <InboundRestoreModal
        open={page.modalType === 'restore'}
        record={page.selectedRecord}
        onClose={page.closeModal}
        onConfirm={page.handleRestoreInbound}
      />

      <InboundScanModal
        open={page.modalType === 'scan'}
        onClose={page.closeModal}
        onManualInput={() => { page.closeModal(); page.openCreate() }}
        onScanSuccess={(materialId) => {
          page.closeModal()
          page.openCreate()
          page.setForm(prev => ({ ...prev, materialId, type: 'direct' }))
        }}
      />

      {page.modalType === 'import' && (
        <Modal onClose={page.closeModal} title="批量导入入库" size="lg">
          <ImportInboundModal
            onClose={page.closeModal}
            onSuccess={() => { page.closeModal(); page.refresh() }}
            materials={page.materials}
            locations={page.locations}
          />
        </Modal>
      )}

      <InboundPrintModal
        open={page.modalType === 'print'}
        data={page.data}
        selectedRecord={page.selectedRecord}
        onClose={page.closeModal}
      />

      <ConfirmDialog
        open={page.confirmModal.open}
        title={page.confirmModal.title}
        message={page.confirmModal.message}
        confirmText="确认"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={() => {
          page.confirmModal.onConfirm?.()
          page.closeConfirmModal()
        }}
        onCancel={page.closeConfirmModal}
      />
    </div>
  )
}
