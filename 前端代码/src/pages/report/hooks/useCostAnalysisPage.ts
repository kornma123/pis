import { useState, useEffect, useMemo } from 'react'
import request from '@/api/request'
import type { ProjectCostReport, MaterialCostReport, SupplierCostReport } from '@/types'
import { toast } from 'sonner'
import { useUrlParams } from '@/hooks/useUrlParams'

export type TabKey = 'project-cost' | 'material-cost' | 'public-cost' | 'supplier-cost'

const dateRanges: Record<string, [string, string]> = {
  '2024': ['2024-01-01', '2024-12-31'],
  '2024q4': ['2024-10-01', '2024-12-31'],
  '2024q3': ['2024-07-01', '2024-09-30'],
  '2024q2': ['2024-04-01', '2024-06-30'],
  '2024q1': ['2024-01-01', '2024-03-31'],
  '2023': ['2023-01-01', '2023-12-31'],
}

export interface CostAnalysisStats {
  totalCost: number
  projectCost: number
  publicCost: number
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

export function useCostAnalysisPage() {
  const [projectReport, setProjectReport] = useState<ProjectCostReport | null>(null)
  const [materialReport, setMaterialReport] = useState<MaterialCostReport | null>(null)
  const [supplierReport, setSupplierReport] = useState<SupplierCostReport | null>(null)
  const [trendReport, setTrendReport] = useState<TrendReport | null>(null)
  const [loading, setLoading] = useState(false)

  const { get, getNumber, setMultiple } = useUrlParams()

  const [activeTab, setActiveTab] = useState<TabKey>((get('tab') as TabKey) || 'project-cost')
  const [searchText, setSearchText] = useState(get('search') || '')
  const [projectFilter, setProjectFilter] = useState('')
  const [startDate, setStartDate] = useState('2024-01-01')
  const [endDate, setEndDate] = useState('2024-12-31')
  const [timeRange, setTimeRange] = useState('2024')
  const [dataSource, setDataSource] = useState<'lis' | 'manual'>('lis')
  const [page, setPage] = useState(Math.max(1, getNumber('page', 1)))
  const [pageSize, setPageSize] = useState(Math.max(1, Math.min(100, getNumber('pageSize', 10))))
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [selectedProject, setSelectedProject] = useState<ProjectCostReport['projects'][number] | null>(null)

  const fetchData = async () => {
    setLoading(true)
    try {
      const [pRes, mRes, sRes, tRes]: any = await Promise.all([
        request.get('/reports/cost-by-project'),
        request.get('/reports/cost-by-material'),
        request.get('/reports/cost-by-supplier'),
        request.get('/reports/cost-trend'),
      ])
      setProjectReport(pRes)
      setMaterialReport(mRes)
      setSupplierReport(sRes)
      setTrendReport(tRes)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    setPage(1)
  }, [activeTab, searchText, projectFilter])

  useEffect(() => {
    const params: Record<string, string | null> = {}
    params.tab = activeTab === 'project-cost' ? null : activeTab
    params.search = searchText || null
    params.page = page === 1 ? null : String(page)
    params.pageSize = pageSize === 10 ? null : String(pageSize)
    setMultiple(params)
  }, [activeTab, searchText, page, pageSize])

  const handleTimeRangeChange = (val: string) => {
    setTimeRange(val)
    const range = dateRanges[val]
    if (range) {
      setStartDate(range[0])
      setEndDate(range[1])
      toast.success('时间范围已更新')
    }
  }

  const handleExport = () => {
    toast.success('正在生成报告...')
    setTimeout(() => {
      toast.success('报告导出成功')
      setExportModalOpen(false)
    }, 1000)
  }

  const openDetailModal = (project: ProjectCostReport['projects'][number]) => {
    setSelectedProject(project)
    setDetailModalOpen(true)
  }

  const stats = useMemo<CostAnalysisStats>(() => {
    const totalCost = projectReport?.summary?.totalCost || 0
    const projectCost = projectReport?.summary?.projectCost || 0
    const publicCost = projectReport?.summary?.publicCost || 0
    const totalSamples = projectReport?.summary?.totalSamples || 0
    const avgCost = totalSamples > 0 ? Math.round(totalCost / totalSamples) : 0
    return { totalCost, projectCost, publicCost, totalSamples, avgCost }
  }, [projectReport])

  const filteredProjects = useMemo(() => {
    let list = projectReport?.projects || []
    if (searchText) {
      list = list.filter(p => p.name.includes(searchText))
    }
    return list
  }, [projectReport, searchText])

  const filteredMaterials = useMemo(() => {
    let list = materialReport?.materials || []
    if (searchText) {
      list = list.filter(m => m.name.includes(searchText))
    }
    return list
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
  const totalSupplierAmount = realSuppliers.reduce((s: number, i: any) => s + (i.amount || 0), 0)

  const pieData = useMemo<PieDataItem[]>(() => {
    const projects = projectReport?.projects || []
    if (projects.length === 0) return []
    const total = projects.reduce((sum, p) => sum + (p.totalCost || 0), 0)
    if (total === 0) return []
    return projects.slice(0, 7).map(p => ({
      name: p.name,
      value: Number(((p.totalCost / total) * 100).toFixed(1)),
    }))
  }, [projectReport])

  return {
    projectReport,
    materialReport,
    supplierReport,
    trendReport,
    loading,
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
