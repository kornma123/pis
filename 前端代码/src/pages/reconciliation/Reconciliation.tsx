import { Upload, Download } from 'lucide-react'
import { useReconciliationPage } from './hooks/useReconciliationPage'
import { ReconcileProjectTab } from './components/ReconcileProjectTab'
import { MaterialSummaryTab } from './components/MaterialSummaryTab'
import { CaseListTab } from './components/CaseListTab'
import { LogListTab } from './components/LogListTab'
import { ImportLisModal } from './components/ImportLisModal'
import { FixBomModal } from './components/FixBomModal'
import { EditCaseModal } from './components/EditCaseModal'

const TABS = [
  { key: 'reconcile' as const, label: '按项目对账' },
  { key: 'material' as const, label: '按物料汇总' },
  { key: 'case' as const, label: '按病理号查看' },
  { key: 'log' as const, label: '修正日志' },
]

const PERIODS = [
  { key: 'week' as const, label: '本周' },
  { key: 'month' as const, label: '本月' },
  { key: 'quarter' as const, label: '本季' },
  { key: 'year' as const, label: '本年' },
]

export default function Reconciliation() {
  const page = useReconciliationPage()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">消耗对账</h1>
          <p className="text-sm text-gray-500 mt-1">期间内 BOM理论消耗总量 vs 实际出库总量 对比</p>
        </div>
        <button
          onClick={() => page.setImportModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          <Upload className="w-4 h-4" />
          导入LIS数据
        </button>
      </div>

      {/* Warn Box */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
        <strong>对账说明：</strong>出库按规格单位（瓶/支/盒）记录，无法精确关联到每个病理号。对账以"期间总量"为维度，对比"病例数×BOM理论"与"实际出库"的差异。
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-0">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => page.setActiveTab(tab.key)}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                page.activeTab === tab.key
                  ? 'text-blue-600 border-blue-600'
                  : 'text-gray-500 border-transparent hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Period Selector */}
      {(page.activeTab === 'reconcile' || page.activeTab === 'material') && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {PERIODS.map(p => (
                <button
                  key={p.key}
                  onClick={() => page.setPeriod(p.key)}
                  className={`px-4 py-1.5 text-sm rounded-md border transition-colors ${
                    page.period === p.key
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <span className="text-gray-300">|</span>
              <input
                type="date"
                value={page.startDate}
                onChange={e => page.setStartDate(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              />
              <span className="text-gray-500 text-sm">至</span>
              <input
                type="date"
                value={page.endDate}
                onChange={e => page.setEndDate(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              />
            </div>
            <button className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
              <Download className="w-4 h-4" />
              导出报表
            </button>
          </div>

          {/* Summary Cards */}
          {page.summary && (
            <div className="grid grid-cols-4 gap-4 mt-4">
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">LIS病例总数</div>
                <div className="text-2xl font-bold text-gray-900">{page.summary.totalCases}</div>
                <div className="text-xs text-gray-400 mt-1">{page.period === 'month' ? '4月全部检测项目' : '当前期间'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">系统出库关联数</div>
                <div className="text-2xl font-bold text-green-600">{page.summary.linkedOutbounds}</div>
                <div className="text-xs text-gray-400 mt-1">出库时关联了项目</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">未关联出库</div>
                <div className="text-2xl font-bold text-yellow-600">{page.summary.unlinkedOutbounds}</div>
                <div className="text-xs text-gray-400 mt-1">通用领用/损耗</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">病例缺失</div>
                <div className="text-2xl font-bold text-red-600">{page.summary.projectsWithoutBom}</div>
                <div className="text-xs text-gray-400 mt-1">有出库无LIS记录</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab Content */}
      {page.activeTab === 'reconcile' && (
        <ReconcileProjectTab
          loading={page.loading}
          projects={page.projects}
          expandedProject={page.expandedProject}
          projectMaterials={page.projectMaterials}
          onToggleProject={page.loadProjectMaterials}
          getDiffClass={page.getDiffClass}
          onFixBom={page.openFixBomModal}
        />
      )}

      {page.activeTab === 'material' && (
        <MaterialSummaryTab
          loading={page.loading}
          materials={page.materials}
          getDiffClass={page.getDiffClass}
        />
      )}

      {page.activeTab === 'case' && (
        <CaseListTab
          caseSearch={page.caseSearch}
          setCaseSearch={page.setCaseSearch}
          caseFilterProject={page.caseFilterProject}
          setCaseFilterProject={page.setCaseFilterProject}
          caseFilterStatus={page.caseFilterStatus}
          setCaseFilterStatus={page.setCaseFilterStatus}
          casePagination={page.casePagination}
          projects={page.projects}
          getStatusBadge={page.getStatusBadge}
          getStatusLabel={page.getStatusLabel}
          onEditCase={page.openEditCaseModal}
          onReset={page.resetCaseFilters}
        />
      )}

      {page.activeTab === 'log' && (
        <LogListTab logPagination={page.logPagination} />
      )}

      {/* Modals */}
      <ImportLisModal
        open={page.importModalOpen}
        importData={page.importData}
        setImportData={page.setImportData}
        onClose={() => page.setImportModalOpen(false)}
        onConfirm={page.handleImport}
      />

      <FixBomModal
        open={page.fixBomModalOpen}
        fixTarget={page.fixTarget}
        fixTargetProjectId={page.fixTargetProjectId}
        fixNewUsage={page.fixNewUsage}
        setFixNewUsage={page.setFixNewUsage}
        fixNewUnit={page.fixNewUnit}
        setFixNewUnit={page.setFixNewUnit}
        fixReason={page.fixReason}
        setFixReason={page.setFixReason}
        onClose={() => page.setFixBomModalOpen(false)}
        onConfirm={page.handleFixBom}
      />

      <EditCaseModal
        open={page.editCaseModalOpen}
        editCaseTarget={page.editCaseTarget}
        editCaseProjectId={page.editCaseProjectId}
        setEditCaseProjectId={page.setEditCaseProjectId}
        editCaseStatus={page.editCaseStatus}
        setEditCaseStatus={page.setEditCaseStatus}
        projects={page.projects}
        onClose={() => page.setEditCaseModalOpen(false)}
        onConfirm={page.handleEditCase}
      />
    </div>
  )
}
