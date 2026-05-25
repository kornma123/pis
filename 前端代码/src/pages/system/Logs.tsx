import { Download } from 'lucide-react'
import { useLogsPage, LOG_TYPES, MODULES, USERS } from './hooks/useLogsPage'
import { LogsTable } from './components/LogsTable'
import { LogDetailModal } from './components/LogDetailModal'
import { LogExportModal } from './components/LogExportModal'

export default function Logs() {
  const page = useLogsPage()

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">操作日志</h1>
          <p className="text-sm text-gray-500 mt-1">查看系统操作记录，追踪用户行为</p>
        </div>
        <button onClick={() => page.setShowExport(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium shadow-sm transition-all">
          <Download className="w-4 h-4" /> 导出日志
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-gray-900">{page.stats.todayOps}</div>
          <div className="text-sm text-gray-500 mt-1">今日操作</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-blue-500">{page.stats.loginCount}</div>
          <div className="text-sm text-gray-500 mt-1">登录次数</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-yellow-600">{page.stats.dataChanges}</div>
          <div className="text-sm text-gray-500 mt-1">数据变更</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div className="text-2xl font-semibold text-green-500">{page.stats.activeUsers}</div>
          <div className="text-sm text-gray-500 mt-1">活跃用户</div>
        </div>
      </div>

      {/* Logs Table */}
      <LogsTable
        data={page.data}
        loading={page.loading}
        total={page.total}
        page={page.page}
        pageSize={page.pageSize}
        typeFilter={page.typeFilter}
        moduleFilter={page.moduleFilter}
        userFilter={page.userFilter}
        startDate={page.startDate}
        endDate={page.endDate}
        logTypes={LOG_TYPES}
        modules={MODULES}
        users={USERS}
        getLogType={page.getLogType}
        getAvatarChar={page.getAvatarChar}
        getModuleLabel={page.getModuleLabel}
        onTypeFilterChange={page.setTypeFilter}
        onModuleFilterChange={page.setModuleFilter}
        onUserFilterChange={page.setUserFilter}
        onStartDateChange={page.setStartDate}
        onEndDateChange={page.setEndDate}
        onSearch={page.handleSearch}
        onReset={page.handleReset}
        onPageChange={page.setPage}
        onPageSizeChange={page.setPageSize}
        onOpenDetail={page.openDetail}
      />

      {/* Detail Modal */}
      <LogDetailModal
        open={page.showDetail}
        log={page.detailLog}
        getLogType={page.getLogType}
        getModuleLabel={page.getModuleLabel}
        onClose={() => page.setShowDetail(false)}
      />

      {/* Export Modal */}
      <LogExportModal
        open={page.showExport}
        form={page.exportForm}
        onClose={() => page.setShowExport(false)}
        onChange={page.setExportForm}
        onExport={page.handleExport}
      />
    </div>
  )
}
