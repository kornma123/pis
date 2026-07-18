import type { KeyboardEvent } from 'react'
import { Download } from 'lucide-react'
import { useCostAnalysisPage } from './hooks/useCostAnalysisPage'
import { CostStatsCards } from './components/CostStatsCards'
import { CostCharts } from './components/CostCharts'
import { ProjectCostTable } from './components/ProjectCostTable'
import { MaterialCostTable } from './components/MaterialCostTable'
import { PublicCostPanel } from './components/PublicCostPanel'
import { SupplierCostTable } from './components/SupplierCostTable'
import { CostExportModal } from './components/CostExportModal'
import { CostDetailModal } from './components/CostDetailModal'
import type { TabKey } from './hooks/useCostAnalysisPage'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'project-cost', label: '检测项目成本' },
  { key: 'material-cost', label: '物料消耗分析' },
  { key: 'public-cost', label: '公共成本' },
  { key: 'supplier-cost', label: '供应商分析' },
]

function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || [])
  if (!tabs.length) return
  event.preventDefault()
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[nextIndex]?.focus()
  tabs[nextIndex]?.click()
}

export default function CostAnalysis() {
  const page = useCostAnalysisPage()

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">物料成本分析</h1>
          <p className="text-sm text-gray-500 mt-1">分析检测项目成本、物料消耗及供应商采购情况</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">统计周期</span>
            <select
              className="h-10 px-3 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 cursor-pointer"
              value={page.timeRange}
              onChange={e => page.handleTimeRangeChange(e.target.value)}
            >
              <option value="custom">自定义期间</option>
              <option value="2024">2024年全年</option>
              <option value="2024q4">2024年Q4</option>
              <option value="2024q3">2024年Q3</option>
              <option value="2024q2">2024年Q2</option>
              <option value="2024q1">2024年Q1</option>
              <option value="2023">2023年</option>
            </select>
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="h-10 px-3 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 w-[130px]"
                value={page.startDate}
                onChange={e => {
                  page.setStartDate(e.target.value)
                  page.setTimeRange('custom')
                }}
              />
              <span className="text-sm text-gray-400">至</span>
              <input
                type="date"
                className="h-10 px-3 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 w-[130px]"
                value={page.endDate}
                onChange={e => {
                  page.setEndDate(e.target.value)
                  page.setTimeRange('custom')
                }}
              />
            </div>
          </div>
          <button
            onClick={() => page.setExportModalOpen(true)}
            disabled={!page.reportReady}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors shadow-sm h-10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            导出报告
          </button>
        </div>
      </div>

      {page.loadError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          <span>{page.loadError}；当前筛选没有可验证结果，未展示旧数据或零值占位。</span>
          <button
            onClick={() => void page.fetchData()}
            className="h-9 rounded-md border border-red-300 bg-white px-3 font-medium hover:bg-red-100"
          >
            重试
          </button>
        </div>
      )}
      {page.loading && !page.loadError && (
        <div role="status" className="rounded-lg border border-blue-100 bg-blue-50 px-5 py-4 text-sm text-blue-700">
          成本报表加载中，完成前不展示数值或开放导出。
        </div>
      )}

      {/* Stats Cards */}
      {!page.loadError && !page.loading && <CostStatsCards stats={page.stats} supplierCount={page.realSuppliers.length} />}

      {/* Charts */}
      {!page.loadError && !page.loading && <CostCharts trendReport={page.trendReport} pieData={page.pieData} />}

      {/* Tabs */}
      {!page.loadError && !page.loading && <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-200" role="tablist" aria-label="成本报表视图">
        {TABS.map((tab, index) => (
          <button
            key={tab.key}
            id={`cost-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={page.activeTab === tab.key}
            aria-controls={`cost-panel-${tab.key}`}
            tabIndex={page.activeTab === tab.key ? 0 : -1}
            onKeyDown={event => handleTabKeyDown(event, index)}
            onClick={() => page.setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              page.activeTab === tab.key
                ? 'text-blue-500 border-blue-500'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>}

      {/* Tab Content */}
      {!page.loadError && !page.loading && page.activeTab === 'project-cost' && (
        <div id="cost-panel-project-cost" role="tabpanel" aria-labelledby="cost-tab-project-cost"><ProjectCostTable
          loading={page.loading}
          data={page.pagedProjects}
          total={page.filteredProjects.length}
          page={page.page}
          pageSize={page.pageSize}
          searchText={page.searchText}
          projectFilter={page.projectFilter}
          dataSource={page.dataSource}
          onSearchTextChange={page.setSearchText}
          onProjectFilterChange={page.setProjectFilter}
          onDataSourceChange={page.setDataSource}
          onPageChange={page.setPage}
          onPageSizeChange={page.setPageSize}
          onOpenDetail={page.openDetailModal}
        /></div>
      )}

      {!page.loadError && !page.loading && page.activeTab === 'material-cost' && (
        <div id="cost-panel-material-cost" role="tabpanel" aria-labelledby="cost-tab-material-cost"><MaterialCostTable
          loading={page.loading}
          data={page.pagedMaterials}
          total={page.filteredMaterials.length}
          page={page.page}
          pageSize={page.pageSize}
          searchText={page.searchText}
          onSearchTextChange={page.setSearchText}
          onPageChange={page.setPage}
          onPageSizeChange={page.setPageSize}
        /></div>
      )}

      {!page.loadError && !page.loading && page.activeTab === 'public-cost' && <div id="cost-panel-public-cost" role="tabpanel" aria-labelledby="cost-tab-public-cost"><PublicCostPanel /></div>}

      {!page.loadError && !page.loading && page.activeTab === 'supplier-cost' && (
        <div id="cost-panel-supplier-cost" role="tabpanel" aria-labelledby="cost-tab-supplier-cost"><SupplierCostTable
          data={page.realSuppliers}
          totalAmount={page.totalSupplierAmount}
        /></div>
      )}

      {/* Export Modal */}
      <CostExportModal
        open={page.exportModalOpen}
        onClose={() => page.setExportModalOpen(false)}
        onExport={page.handleExport}
        exporting={page.exporting}
        dataReady={page.reportReady}
      />

      {/* Detail Modal */}
      <CostDetailModal
        open={page.detailModalOpen}
        project={page.selectedProject}
        onClose={() => page.setDetailModalOpen(false)}
      />
    </div>
  )
}
