import type { KeyboardEvent } from 'react'
import { Download, Lock, Upload } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
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

function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || [])
  if (!tabs.length) return
  event.preventDefault()
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[nextIndex]?.focus()
  tabs[nextIndex]?.click()
}

export default function Reconciliation() {
  const page = useReconciliationPage()
  const isPeriodTab = page.activeTab === 'reconcile' || page.activeTab === 'material'

  if (!page.canRead) {
    return <EmptyState icon={Lock} title="无权限访问" description="消耗对账需要「对账」模块的查看权限，请联系管理员。" />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">消耗对账</h1>
          <p className="mt-1 text-sm text-gray-500">选择期间后，对比 BOM 理论消耗与实际出库事实，定位差异并复核留痕。</p>
        </div>
        {page.canWrite && (
          <button
            type="button"
            onClick={() => page.setImportModalOpen(true)}
            disabled={page.mutationBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            导入 LIS 数据
          </button>
        )}
      </div>

      {!page.canWrite && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          当前为只读模式：可以查看和导出已加载事实，不能导入、修改、提交或审核。
        </div>
      )}

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <strong>对账口径：</strong>出库按规格单位记录，不能据此伪造逐病理号耗用。当前只对比“期间病例数 × BOM 理论”与“期间实际出库”的来源事实。
      </div>

      <div className="overflow-x-auto border-b border-gray-200">
        <div className="flex min-w-max" role="tablist" aria-label="消耗对账视图">
          {TABS.map((tab, index) => {
            const active = page.activeTab === tab.key
            return (
              <button
                key={tab.key}
                id={`reconciliation-tab-${tab.key}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`reconciliation-panel-${tab.key}`}
                tabIndex={active ? 0 : -1}
                onKeyDown={event => handleTabKeyDown(event, index)}
                onClick={() => page.setActiveTab(tab.key)}
                className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors sm:px-6 ${
                  active
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {isPeriodTab && (
        <section className="rounded-lg border border-gray-200 bg-white p-4" aria-label="对账期间与来源摘要">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-2" aria-label="快捷期间">
                {PERIODS.map(item => (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={page.period === item.key}
                    onClick={() => page.setPeriod(item.key)}
                    className={`rounded-md border px-4 py-1.5 text-sm transition-colors ${
                      page.period === item.key
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="hidden text-gray-300 sm:inline" aria-hidden="true">|</span>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                开始
                <input
                  type="date"
                  value={page.startDate}
                  onChange={event => page.setStartDate(event.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                结束
                <input
                  type="date"
                  value={page.endDate}
                  onChange={event => page.setEndDate(event.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={page.handleExport}
              disabled={!page.periodReady}
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              导出本期对账 CSV
            </button>
          </div>

          {page.periodError && (
            <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <span>{page.periodError}。当前期间不展示旧数据，也不开放导出。</span>
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => void page.fetchPeriodData()}>重试</button>
            </div>
          )}

          {page.loading && !page.periodError && (
            <div role="status" className="mt-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
              正在加载 {page.startDate} 至 {page.endDate} 的来源事实…
            </div>
          )}

          {page.periodReady && page.summary && (
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <div className="mb-1 text-xs text-gray-500">LIS 病例总数</div>
                <div className="text-2xl font-bold text-gray-900">{page.summary.totalCases}</div>
                <div className="mt-1 text-xs text-gray-400">{page.startDate} 至 {page.endDate}</div>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <div className="mb-1 text-xs text-gray-500">系统出库关联数</div>
                <div className="text-2xl font-bold text-green-600">{page.summary.linkedOutbounds}</div>
                <div className="mt-1 text-xs text-gray-400">出库已关联项目</div>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <div className="mb-1 text-xs text-gray-500">未关联出库</div>
                <div className="text-2xl font-bold text-yellow-600">{page.summary.unlinkedOutbounds}</div>
                <div className="mt-1 text-xs text-gray-400">通用领用或损耗</div>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <div className="mb-1 text-xs text-gray-500">病例缺失</div>
                <div className="text-2xl font-bold text-red-600">{page.summary.projectsWithoutBom}</div>
                <div className="mt-1 text-xs text-gray-400">有出库、无 LIS 记录</div>
              </div>
            </div>
          )}
        </section>
      )}

      {page.activeTab === 'reconcile' && !page.periodError && (
        <div id="reconciliation-panel-reconcile" role="tabpanel" aria-labelledby="reconciliation-tab-reconcile">
          <ReconcileProjectTab
            loading={page.loading}
            projects={page.projects}
            expandedProject={page.expandedProject}
            projectMaterials={page.projectMaterials}
            projectMaterialLoading={page.projectMaterialLoading}
            projectMaterialErrors={page.projectMaterialErrors}
            onToggleProject={page.loadProjectMaterials}
            getDiffClass={page.getDiffClass}
            onFixBom={page.openFixBomModal}
            canWrite={page.canWrite}
          />
        </div>
      )}

      {page.activeTab === 'material' && !page.periodError && (
        <div id="reconciliation-panel-material" role="tabpanel" aria-labelledby="reconciliation-tab-material">
          <MaterialSummaryTab loading={page.loading} materials={page.materials} getDiffClass={page.getDiffClass} />
        </div>
      )}

      {page.activeTab === 'case' && (
        <div id="reconciliation-panel-case" role="tabpanel" aria-labelledby="reconciliation-tab-case">
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
            canWrite={page.canWrite}
          />
        </div>
      )}

      {page.activeTab === 'log' && (
        <div id="reconciliation-panel-log" role="tabpanel" aria-labelledby="reconciliation-tab-log">
          <LogListTab
            logPagination={page.logPagination}
            currentUsername={page.currentUsername}
            canApprove={page.canApprove}
            mutationBusy={page.mutationBusy}
            onApprove={page.handleApproveProposal}
            onReject={page.handleRejectProposal}
          />
        </div>
      )}

      {page.canWrite && (
        <>
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
        </>
      )}
    </div>
  )
}
