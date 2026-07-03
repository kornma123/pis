import { Clock, RefreshCw } from 'lucide-react'
import { useAlertsPage } from './hooks/useAlertsPage'
import { AlertTable } from './components/AlertTable'
import { AlertHandleModal } from './components/AlertHandleModal'
import { AlertConsumptionHandleModal } from './components/AlertConsumptionHandleModal'
import { AlertDetailModal } from './components/AlertDetailModal'
import { AlertConsumptionDetailModal } from './components/AlertConsumptionDetailModal'

export default function Alerts() {
  const page = useAlertsPage()

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">
            预警中心
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            查看和处理所有库存预警信息
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors duration-150 h-10">
            <Clock className="w-4 h-4" />
            查看历史
          </button>
          <button
            onClick={page.handleGenerate}
            disabled={page.loading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors duration-150 h-10 disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${page.loading ? 'animate-spin' : ''}`} />
            刷新预警
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-red-500">
          <div className="text-2xl font-bold text-red-600">{page.stats.pending}</div>
          <div className="mt-1 text-sm text-gray-500">待处理</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-green-500">
          <div className="text-2xl font-bold text-green-600">{page.stats.processed}</div>
          <div className="mt-1 text-sm text-gray-500">已处理</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-yellow-500">
          <div className="text-2xl font-bold text-yellow-600">{page.stats.today}</div>
          <div className="mt-1 text-sm text-gray-500">今日预警</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-blue-500">
          <div className="text-2xl font-bold text-blue-600">{page.stats.total}</div>
          <div className="mt-1 text-sm text-gray-500">本月预警</div>
        </div>
      </div>

      {/* 表格区域 */}
      <AlertTable
        data={page.data}
        loading={page.loading}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        filter={page.filter}
        quickFilter={page.quickFilter}
        selectedIds={page.selectedIds}
        onFilterChange={page.setFilter}
        onQuickFilterChange={(v) => { page.setQuickFilter(v); page.setPage(1) }}
        onSelect={page.handleSelect}
        onSelectAll={page.handleSelectAll}
        onClearSelection={page.clearSelection}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onBatchProcess={page.handleBatchProcess}
        onOpenModal={page.openModal}
        onIgnore={page.handleIgnore}
        onGenerate={page.handleGenerate}
        hasActiveFilters={page.hasActiveFilters}
        getAlertTypeInfo={page.getAlertTypeInfo}
        getStatusInfo={page.getStatusInfo}
        isConsumption={page.isConsumption}
        formatDate={page.formatDate}
      />

      {/* 弹窗 */}
      <AlertHandleModal
        open={page.modal.type === 'handle'}
        alert={page.modal.alert}
        form={page.handleForm}
        onClose={page.closeModal}
        onChange={page.setHandleForm}
        onConfirm={page.submitHandle}
      />

      <AlertConsumptionHandleModal
        open={page.modal.type === 'consumption-handle'}
        alert={page.modal.alert}
        form={page.handleForm}
        onClose={page.closeModal}
        onChange={page.setHandleForm}
        onConfirm={page.submitHandle}
      />

      <AlertDetailModal
        open={page.modal.type === 'detail'}
        alert={page.modal.alert}
        onClose={page.closeModal}
        onHandle={() => {
          if (page.modal.alert) page.openModal('handle', page.modal.alert)
        }}
        formatDate={page.formatDate}
      />

      <AlertConsumptionDetailModal
        open={page.modal.type === 'consumption-detail'}
        alert={page.modal.alert}
        onClose={page.closeModal}
        onHandle={() => {
          if (page.modal.alert) page.openModal('consumption-handle', page.modal.alert)
        }}
      />
    </div>
  )
}
