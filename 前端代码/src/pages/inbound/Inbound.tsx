import { Link, useNavigate } from 'react-router-dom'
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
import { PURCHASE_INBOUND_UNAVAILABLE_REASON } from './hooks/useInboundPage'
import { canAccess } from '@/lib/permissions'

export default function Inbound() {
  const navigate = useNavigate()
  const page = useInboundPage()
  const canWrite = canAccess('inbound', 'W')

  const handleFilterStatus = (status: string) => {
    if (status === 'pending') {
      navigate('/purchase-orders?status=pending')
      return
    }
    page.setFilterStatus(status)
  }

  return (
    <div className="space-y-5">
      {/* 页面头部 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">入库记录</h1>
          <p className="text-sm text-gray-500 mt-1">管理已落库记录与现有直接入库能力</p>
        </div>
      </div>

      {page.purchaseContext.purchaseOrderId && (
        <section aria-labelledby="purchase-context-title" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 id="purchase-context-title" className="font-semibold">采购单入库上下文</h2>
              <p className="mt-1 text-sm">
                {page.purchaseContext.state === 'loading' && '正在核实采购单…'}
                {page.purchaseContext.state === 'ready' && `采购单 ${page.purchaseContext.order?.orderNo || page.purchaseContext.order?.order_no || page.purchaseContext.purchaseOrderId}`}
                {page.purchaseContext.state === 'error' && `采购单未能核实：${page.purchaseContext.error}`}
              </p>
              <p className="mt-2 text-sm font-medium">{PURCHASE_INBOUND_UNAVAILABLE_REASON}</p>
              <p className="mt-1 text-xs text-amber-800">当前列表只按来源类型与物料显示候选记录；后端不支持 purchaseOrderId 筛选，因此不能把它称为该采购单的完整关联记录。</p>
            </div>
            <Link to={page.purchaseContext.returnTo} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-amber-400 bg-white px-4 text-sm font-medium hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-600">返回采购订单</Link>
          </div>
        </section>
      )}

      {!canWrite && (
        <div role="note" className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">当前账号只有入库读取权限。新增、扫码、导入、编辑、删除和恢复操作已隐藏。</div>
      )}
      {page.refsError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">引用数据未能加载：{page.refsError}</div>
      )}

      {/* 快捷操作栏 */}
      <div className="flex flex-wrap gap-3">
        {canWrite && <>
        <button
          onClick={page.openCreate}
          disabled={page.refsLoading}
          className="inline-flex min-h-11 items-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
        >
          <Plus className="w-[18px] h-[18px]" /> 新增入库
        </button>
        <button
          onClick={() => page.setModalType('scan')}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <QrCode /> 扫码入库
        </button>
        <button
          onClick={page.openImport}
          disabled={page.refsLoading}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <Upload /> 批量导入
        </button>
        </>}
        <button
          onClick={() => page.setModalType('print')}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <Printer /> 打印记录
        </button>
      </div>

      {/* 统计卡片 */}
      <InboundStats
        total={page.stats?.total ?? null}
        amount={page.stats?.amount ?? null}
        pendingOrders={page.stats?.pendingOrders ?? null}
        supplierCount={page.stats?.supplierCount ?? null}
        error={page.statsError}
        onFilterStatus={handleFilterStatus}
      />

      {/* 快速筛选 */}
      {!page.listError && <InboundQuickFilters
        items={[
          { key: 'all', label: '全部', count: page.quickFilterCounts.all },
          { key: 'today', label: '今日', count: page.quickFilterCounts.today },
          { key: 'week', label: '本周', count: page.quickFilterCounts.week },
          { key: 'month', label: '本月', count: page.quickFilterCounts.month },
        ]}
        activeKey={page.activeQuickFilter}
        onChange={page.setActiveQuickFilter}
      />}

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
          error={page.listError}
          onRetry={page.refresh}
          canWrite={canWrite}
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
        selectedRecord={page.selectedRecord}
        submitting={page.submitting}
        onClose={() => { if (!page.submitting) page.closeModal() }}
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
            suppliers={page.suppliers}
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
