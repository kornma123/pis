import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import request from '@/api/request'
import type { ProjectCostReport, MaterialCostReport, SupplierCostReport } from '@/types'
import { downloadTextFile } from '@/lib/utils'
import { toast } from 'sonner'
import { useUrlParams } from '@/hooks/useUrlParams'
import type { SampleDataSource } from '../components/ProjectCostTable'

export type TabKey = 'project-cost' | 'material-cost' | 'public-cost' | 'supplier-cost'

const dateRanges: Record<string, [string, string]> = {
  '2024': ['2024-01-01', '2024-12-31'],
  '2024q4': ['2024-10-01', '2024-12-31'],
  '2024q3': ['2024-07-01', '2024-09-30'],
  '2024q2': ['2024-04-01', '2024-06-30'],
  '2024q1': ['2024-01-01', '2024-03-31'],
  '2023': ['2023-01-01', '2023-12-31'],
}

const PROJECT_TYPE_LABELS: Record<string, string> = {
  he: '病理技术-HE制片',
  ihc: '病理技术-免疫组化',
  ss: '病理技术-特殊染色',
  mp: '分子诊断',
  cyto: '病理诊断-细胞学检测',
}

const SAMPLE_SOURCE_LABELS: Record<SampleDataSource, string> = {
  all: 'LIS优先，无数据时手工',
  lis: '仅LIS已映射病例',
  manual: '仅手工样本数',
}

type ProjectRowWithSource = ProjectCostReport['projects'][number] & {
  sampleCountSource?: 'lis' | 'manual' | 'unavailable'
}

export interface CostAnalysisStats {
  totalCost: number
  projectCost: number
  publicCost: number | null
  totalSamples: number
  avgCost: number
}

export interface TrendData {
  month: string
  cost: number
}

export interface TrendReport {
  trend: TrendData[]
}

export interface PieDataItem {
  name: string
  value: number
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',')
}

function computableNumber(value: unknown, suffix = ''): string {
  const number = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number)
    ? `${number}${suffix}`
    : '不可计算'
}

function computablePercentage(value: unknown): string {
  if (value === null || value === undefined || value === '') return '不可计算'
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 100
    ? `${number.toFixed(1)}%`
    : '不可计算'
}

function buildCostCsv(
  startDate: string,
  endDate: string,
  dataSource: SampleDataSource,
  projectFilter: string,
  projects: ProjectCostReport['projects'],
  materials: MaterialCostReport['materials'],
  suppliers: SupplierCostReport['suppliers'],
): string {
  const rows: unknown[][] = [
    ['统计期间', `${startDate} 至 ${endDate}`],
    ['样本数来源', SAMPLE_SOURCE_LABELS[dataSource]],
    ['项目分类', projectFilter ? PROJECT_TYPE_LABELS[projectFilter] || projectFilter : '全部分类'],
    [],
    ['检测项目成本'],
    ['项目名称', '分类', '样本数', '样本数实际口径', '单样本成本', '成本金额', '占比', '同比变化'],
    ...projects.map(project => {
      const source = (project as ProjectRowWithSource).sampleCountSource || 'unavailable'
      const sourceLabel = source === 'lis'
        ? 'LIS已映射病例'
        : source === 'manual'
          ? '手工样本数'
          : '不可用'
      return [
        project.name,
        PROJECT_TYPE_LABELS[project.category] || project.category,
        source === 'unavailable' ? '不可计算' : computableNumber(project.sampleCount),
        sourceLabel,
        source === 'unavailable' ? '不可计算' : computableNumber(project.unitCost),
        computableNumber(project.totalCost),
        computablePercentage(project.ratio),
        computableNumber(project.changeRate, '%'),
      ]
    }),
    [],
    ['物料消耗'],
    ['物料名称', '规格型号', '消耗数量', '单位', '消耗金额', '占比', '同比变化'],
    ...materials.map(material => [
      material.name,
      material.spec,
      computableNumber(material.consumption),
      material.consumptionUnit,
      computableNumber(material.totalCost),
      computablePercentage(material.ratio),
      computableNumber(material.changeRate, '%'),
    ]),
    [],
    ['供应商采购'],
    ['供应商', '采购金额', '占比', '订单数'],
    ...suppliers.map(supplier => [
      supplier.name,
      computableNumber(supplier.amount),
      computablePercentage(supplier.ratio),
      computableNumber(supplier.orderCount),
    ]),
  ]

  return rows.map(csvRow).join('\r\n')
}

export function useCostAnalysisPage() {
  const [projectReport, setProjectReport] = useState<ProjectCostReport | null>(null)
  const [materialReport, setMaterialReport] = useState<MaterialCostReport | null>(null)
  const [supplierReport, setSupplierReport] = useState<SupplierCostReport | null>(null)
  const [trendReport, setTrendReport] = useState<TrendReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedFilterKey, setLoadedFilterKey] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const { get, getNumber, setMultiple } = useUrlParams()
  const initialStartDate = get('startDate') || '2024-01-01'
  const initialEndDate = get('endDate') || '2024-12-31'
  const sourceParam = get('dataSource')
  const initialDataSource: SampleDataSource = sourceParam === 'lis' || sourceParam === 'manual'
    ? sourceParam
    : 'all'

  const tabParam = get('tab') as TabKey
  const [activeTab, setActiveTab] = useState<TabKey>(['project-cost', 'material-cost', 'public-cost', 'supplier-cost'].includes(tabParam) ? tabParam : 'project-cost')
  const [searchText, setSearchText] = useState(get('search') || '')
  const [projectFilter, setProjectFilter] = useState(get('projectType') || '')
  const [startDate, setStartDate] = useState(initialStartDate)
  const [endDate, setEndDate] = useState(initialEndDate)
  const [timeRange, setTimeRange] = useState(
    initialStartDate === '2024-01-01' && initialEndDate === '2024-12-31' ? '2024' : 'custom',
  )
  const [dataSource, setDataSource] = useState<SampleDataSource>(initialDataSource)
  const [page, setPage] = useState(Math.max(1, getNumber('page', 1)))
  const [pageSize, setPageSize] = useState(Math.max(1, Math.min(100, getNumber('pageSize', 10))))
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [selectedProject, setSelectedProject] = useState<ProjectCostReport['projects'][number] | null>(null)
  const currentFilterKey = `${startDate}|${endDate}|${dataSource}|${projectFilter}`
  const reportReady = loadedFilterKey === currentFilterKey

  const fetchData = useCallback(async () => {
    const version = ++requestVersion.current
    const requestedFilterKey = `${startDate}|${endDate}|${dataSource}|${projectFilter}`
    const dateParams = { startDate, endDate }
    const projectParams = {
      ...dateParams,
      dataSource,
      ...(projectFilter ? { projectType: projectFilter } : {}),
    }

    setLoadedFilterKey(null)
    setLoadError(null)
    setLoading(true)
    try {
      const [project, material, supplier, trend] = await Promise.all([
        request.get('/reports/cost-by-project', { params: projectParams }),
        request.get('/reports/cost-by-material', { params: dateParams }),
        request.get('/reports/cost-by-supplier', { params: dateParams }),
        request.get('/reports/cost-trend', { params: dateParams }),
      ]) as [ProjectCostReport, MaterialCostReport, SupplierCostReport, TrendReport]

      if (version !== requestVersion.current) return
      setProjectReport(project)
      setMaterialReport(material)
      setSupplierReport(supplier)
      setTrendReport(trend)
      setLoadedFilterKey(requestedFilterKey)
    } catch (caught) {
      if (version !== requestVersion.current) return
      console.error(caught)
      setProjectReport(null)
      setMaterialReport(null)
      setSupplierReport(null)
      setTrendReport(null)
      setDetailModalOpen(false)
      setSelectedProject(null)
      setExportModalOpen(false)
      const message = '成本报表加载失败，请重试'
      setLoadError(message)
      toast.error(message)
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [startDate, endDate, dataSource, projectFilter])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  useEffect(() => {
    setPage(1)
  }, [activeTab, searchText, projectFilter, dataSource])

  useEffect(() => {
    setMultiple({
      tab: activeTab === 'project-cost' ? null : activeTab,
      search: searchText || null,
      page: page === 1 ? null : String(page),
      pageSize: pageSize === 10 ? null : String(pageSize),
      startDate,
      endDate,
      dataSource: dataSource === 'all' ? null : dataSource,
      projectType: projectFilter || null,
    })
  }, [activeTab, searchText, page, pageSize, startDate, endDate, dataSource, projectFilter, setMultiple])

  const handleTimeRangeChange = (value: string) => {
    setTimeRange(value)
    const range = dateRanges[value]
    if (range) {
      setStartDate(range[0])
      setEndDate(range[1])
    }
  }

  const openDetailModal = (project: ProjectCostReport['projects'][number]) => {
    setSelectedProject(project)
    setDetailModalOpen(true)
  }

  const stats = useMemo<CostAnalysisStats>(() => {
    const totalCost = projectReport?.summary?.totalCost || 0
    const projectCost = projectReport?.summary?.projectCost || 0
    // 当前报表 API 的 publicCost 是固定占位值，不能当作已核验的真实零。
    const publicCost = null
    const totalSamples = projectReport?.summary?.totalSamples || 0
    const avgCost = totalSamples > 0 ? Math.round(totalCost / totalSamples) : 0
    return { totalCost, projectCost, publicCost, totalSamples, avgCost }
  }, [projectReport])

  const filteredProjects = useMemo(() => {
    const list = projectReport?.projects || []
    return searchText ? list.filter(project => project.name.includes(searchText)) : list
  }, [projectReport, searchText])

  const filteredMaterials = useMemo(() => {
    const list = materialReport?.materials || []
    return searchText ? list.filter(material => material.name.includes(searchText)) : list
  }, [materialReport, searchText])

  const pagedProjects = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredProjects.slice(start, start + pageSize)
  }, [filteredProjects, page, pageSize])

  const pagedMaterials = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredMaterials.slice(start, start + pageSize)
  }, [filteredMaterials, page, pageSize])

  const realSuppliers = supplierReport?.suppliers || []
  const totalSupplierAmount = realSuppliers.reduce((sum, supplier) => sum + (supplier.amount || 0), 0)

  const pieData = useMemo<PieDataItem[]>(() => {
    const projects = projectReport?.projects || []
    if (projects.length === 0) return []
    const total = projects.reduce((sum, project) => sum + (project.totalCost || 0), 0)
    if (total === 0) return []
    return projects.slice(0, 7).map(project => ({
      name: project.name,
      value: Number(((project.totalCost / total) * 100).toFixed(1)),
    }))
  }, [projectReport])

  const handleExport = useCallback(async () => {
    if (exporting) return
    if (!reportReady) {
      toast.error('筛选结果尚未就绪，无法导出')
      return
    }
    setExporting(true)
    try {
      const content = buildCostCsv(
        startDate,
        endDate,
        dataSource,
        projectFilter,
        filteredProjects,
        filteredMaterials,
        realSuppliers,
      )
      if (!content.trim()) throw new Error('empty export')

      downloadTextFile(
        `成本分析_${startDate}_${endDate}.csv`,
        content,
        'text/csv;charset=utf-8',
      )
      toast.success('文件已生成，下载已开始')
      setExportModalOpen(false)
    } catch (caught) {
      console.error(caught)
      toast.error('文件生成失败，请重试')
    } finally {
      setExporting(false)
    }
  }, [
    exporting,
    reportReady,
    startDate,
    endDate,
    dataSource,
    projectFilter,
    filteredProjects,
    filteredMaterials,
    realSuppliers,
  ])

  return {
    projectReport,
    materialReport,
    supplierReport,
    trendReport,
    loading,
    loadError,
    activeTab,
    setActiveTab,
    searchText,
    setSearchText,
    projectFilter,
    setProjectFilter,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    timeRange,
    setTimeRange,
    handleTimeRangeChange,
    dataSource,
    setDataSource,
    page,
    setPage,
    pageSize,
    setPageSize,
    exportModalOpen,
    setExportModalOpen,
    exporting,
    reportReady,
    detailModalOpen,
    setDetailModalOpen,
    selectedProject,
    openDetailModal,
    stats,
    filteredProjects,
    filteredMaterials,
    pagedProjects,
    pagedMaterials,
    pieData,
    realSuppliers,
    totalSupplierAmount,
    handleExport,
    fetchData,
  }
}
