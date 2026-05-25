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
                onChange={e => page.setStartDate(e.target.value)}
              />
              <span className="text-sm text-gray-400">至</span>
              <input
                type="date"
                className="h-10 px-3 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 w-[130px]"
                value={page.endDate}
                onChange={e => page.setEndDate(e.target.value)}
              />
            </div>
          </div>
          <button
            onClick={() => page.setExportModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors shadow-sm h-10"
          >
            <Download className="w-4 h-4" />
            导出报告
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <CostStatsCards stats={page.stats} supplierCount={page.realSuppliers.length} />

      {/* Charts */}
      <CostCharts trendReport={page.trendReport} pieData={page.pieData} />

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab.key}
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
      </div>

      {/* Tab Content */}
      {page.activeTab === 'project-cost' && (
        <ProjectCostTable
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
        />
      )}

      {page.activeTab === 'material-cost' && (
        <MaterialCostTable
          loading={page.loading}
          data={page.pagedMaterials}
          total={page.filteredMaterials.length}
          page={page.page}
          pageSize={page.pageSize}
          searchText={page.searchText}
          onSearchTextChange={page.setSearchText}
          onPageChange={page.setPage}
          onPageSizeChange={page.setPageSize}
        />
      )}

      {page.activeTab === 'public-cost' && <PublicCostPanel />}

      {page.activeTab === 'supplier-cost' && (
        <SupplierCostTable
          data={page.realSuppliers}
          totalAmount={page.totalSupplierAmount}
        />
      )}

      {/* Export Modal */}
      <CostExportModal
        open={page.exportModalOpen}
        onClose={() => page.setExportModalOpen(false)}
        onExport={page.handleExport}
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
