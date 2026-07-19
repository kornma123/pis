import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useAlertsPage } from './hooks/useAlertsPage'
import { AlertTable } from './components/AlertTable'
import { AlertHandleModal } from './components/AlertHandleModal'
import { AlertDetailModal } from './components/AlertDetailModal'

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
            查看已记录预警，并按需明确发起一次实时生成
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={page.handleGenerate}
            disabled={page.generating}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors duration-150 h-10 disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${page.generating ? 'animate-spin' : ''}`} />
            {page.generating ? '生成中...' : '手动生成预警'}
          </button>
        </div>
      </div>

      <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <AlertTriangle aria-hidden="true" className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">自动生成与消息推送未连接</p>
          <p className="mt-1 text-amber-800">本页只显示后端已记录的预警；如需刷新风险记录，请使用“手动生成预警”。</p>
          {page.generationEvidence?.status === 'connected' && (
            <p className="mt-2 font-medium">上次手动生成证据：新增 {page.generationEvidence.generatedCount} 条；{new Date(page.generationEvidence.generatedAt).toLocaleString('zh-CN')}</p>
          )}
          {page.generationEvidence?.status === 'unknown' && (
            <p className="mt-2 font-medium">上次手动生成请求已完成，但服务未返回生成条数。</p>
          )}
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-red-500">
          <div className="text-2xl font-bold text-red-600">{page.error ? '—' : page.stats.pending}</div>
          <div className="mt-1 text-sm text-gray-500">本页待处理</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-green-500">
          <div className="text-2xl font-bold text-green-600">{page.error ? '—' : page.stats.processed}</div>
          <div className="mt-1 text-sm text-gray-500">本页已处理</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-yellow-500">
          <div className="text-2xl font-bold text-yellow-600">{page.error ? '—' : page.stats.today}</div>
          <div className="mt-1 text-sm text-gray-500">本页今日新增</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-blue-500">
          <div className="text-2xl font-bold text-blue-600">{page.error ? '—' : page.stats.total}</div>
          <div className="mt-1 text-sm text-gray-500">符合条件记录</div>
        </div>
      </div>

      {/* 表格区域 */}
      <AlertTable
        data={page.data}
        loading={page.loading}
        error={page.error}
        generating={page.generating}
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
        onRetry={page.refresh}
        hasActiveFilters={page.hasActiveFilters}
        getAlertTypeInfo={page.getAlertTypeInfo}
        getStatusInfo={page.getStatusInfo}
        formatDate={page.formatDate}
      />

      {/* 弹窗 */}
      <AlertHandleModal
        open={page.modal.type === 'handle'}
        alert={page.modal.alert}
        form={page.handleForm}
        error={page.handleError}
        onClose={page.closeModal}
        onChange={form => { page.setHandleForm(form); page.setHandleError('') }}
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

    </div>
  )
}
