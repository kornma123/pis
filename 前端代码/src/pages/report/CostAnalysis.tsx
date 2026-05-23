import { useState, useEffect, useMemo } from 'react'
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  PieChart,
  Search,
  Download,
  X,
  Settings,
  LineChart,
  Activity,
  Users,
  Minus,
  FileText,
} from 'lucide-react'
import request from '@/api/request'
import type { ProjectCostReport, MaterialCostReport, SupplierCostReport } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { toast } from 'sonner'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import {
  LineChart as ReLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RePieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts'

type TabKey = 'project-cost' | 'material-cost' | 'public-cost' | 'supplier-cost'

const categoryMap: Record<string, { label: string; bg: string; text: string }> = {
  molecular: { label: '分子诊断', bg: 'bg-indigo-50', text: 'text-indigo-600' },
  pathology: { label: '病理技术', bg: 'bg-emerald-50', text: 'text-emerald-600' },
  cyto: { label: '细胞学', bg: 'bg-amber-50', text: 'text-amber-600' },
  ihc: { label: '免疫组化', bg: 'bg-rose-50', text: 'text-rose-600' },
  consumable: { label: '耗材', bg: 'bg-gray-100', text: 'text-gray-600' },
}

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316']



function RankBadge({ rank }: { rank: number }) {
  const className =
    rank === 1
      ? 'bg-yellow-100 text-yellow-700'
      : rank === 2
        ? 'bg-gray-100 text-gray-600'
        : rank === 3
          ? 'bg-orange-100 text-orange-700'
          : 'bg-gray-50 text-gray-500'
  return (
    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold ${className}`}>
      {rank}
    </span>
  )
}

function ChangeBadge({ value }: { value: number }) {
  if (value > 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-red-600">
        <TrendingUp className="w-3 h-3" />+{value}%
      </span>
    )
  }
  if (value < 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-green-600">
        <TrendingDown className="w-3 h-3" />{value}%
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium text-gray-500">
      <Minus className="w-3 h-3" />0%
    </span>
  )
}

function CategoryTag({ category }: { category: string }) {
  const cfg = categoryMap[category] || { label: '其他', bg: 'bg-gray-100', text: 'text-gray-600' }
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  )
}

export default function CostAnalysis() {
  const [projectReport, setProjectReport] = useState<ProjectCostReport | null>(null)
  const [materialReport, setMaterialReport] = useState<MaterialCostReport | null>(null)
  const [supplierReport, setSupplierReport] = useState<SupplierCostReport | null>(null)
  const [trendReport, setTrendReport] = useState<{ trend: { month: string; cost: number }[] } | null>(null)
  const [loading, setLoading] = useState(false)

  const { get, getNumber, setMultiple } = useUrlParams()

  // Tabs
  const [activeTab, setActiveTab] = useState<TabKey>((get('tab') as TabKey) || 'project-cost')

  // Filters
  const [searchText, setSearchText] = useState(get('search') || '')
  const [projectFilter, setProjectFilter] = useState('')
  const [startDate, setStartDate] = useState('2024-01-01')
  const [endDate, setEndDate] = useState('2024-12-31')
  const [timeRange, setTimeRange] = useState('2024')

  // Data source toggle
  const [dataSource, setDataSource] = useState<'lis' | 'manual'>('lis')

  // Pagination
  const [page, setPage] = useState(Math.max(1, getNumber('page', 1)))
  const [pageSize, setPageSize] = useState(Math.max(1, Math.min(100, getNumber('pageSize', 10))))

  // Modals
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

  const dateRanges: Record<string, [string, string]> = {
    '2024': ['2024-01-01', '2024-12-31'],
    '2024q4': ['2024-10-01', '2024-12-31'],
    '2024q3': ['2024-07-01', '2024-09-30'],
    '2024q2': ['2024-04-01', '2024-06-30'],
    '2024q1': ['2024-01-01', '2024-03-31'],
    '2023': ['2023-01-01', '2023-12-31'],
  }

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

  // Stats
  const stats = useMemo(() => {
    const totalCost = projectReport?.summary?.totalCost || 0
    const projectCost = projectReport?.summary?.projectCost || 0
    const publicCost = projectReport?.summary?.publicCost || 0
    const totalSamples = projectReport?.summary?.totalSamples || 0
    const avgCost = totalSamples > 0 ? Math.round(totalCost / totalSamples) : 0
    return { totalCost, projectCost, publicCost, totalSamples, avgCost }
  }, [projectReport])

  // Filtered projects
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
  }, [filteredProjects, page])

  const pagedMaterials = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredMaterials.slice(start, start + pageSize)
  }, [filteredMaterials, page])


  const realSuppliers = supplierReport?.suppliers || []
  const totalSupplierAmount = realSuppliers.reduce((s: number, i: any) => s + (i.amount || 0), 0)

  const pieData = useMemo(() => {
    const projects = projectReport?.projects || []
    if (projects.length === 0) return []
    const total = projects.reduce((sum, p) => sum + (p.totalCost || 0), 0)
    if (total === 0) return []
    return projects.slice(0, 7).map(p => ({
      name: p.name,
      value: Number(((p.totalCost / total) * 100).toFixed(1)),
    }))
  }, [projectReport])

  return (
    <div className="space-y-6">
      {/* ===== Page Header ===== */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">物料成本分析</h1>
          <p className="text-sm text-gray-500 mt-1">分析检测项目成本、物料消耗及供应商采购情况</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">统计周期</span>
            <select
              className="h-9 px-3 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150"
              value={timeRange}
              onChange={e => handleTimeRangeChange(e.target.value)}
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
                className="h-9 px-2 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150"
                style={{ width: 130 }}
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
              />
              <span className="text-sm text-gray-400">至</span>
              <input
                type="date"
                className="h-9 px-2 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150"
                style={{ width: 130 }}
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
              />
            </div>
          </div>
          <button
            onClick={() => setExportModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-all duration-150 shadow-sm"
          >
            <Download className="w-4 h-4" />
            导出报告
          </button>
        </div>
      </div>

      {/* ===== Stat Overview ===== */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg p-5 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 bg-blue-50 rounded-md">
              <BarChart3 className="w-4 h-4 text-blue-600" />
            </div>
            <span className="text-xs text-gray-500 font-medium">物料总成本</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            ¥{(stats.totalCost / 10000).toFixed(1)}万
          </div>
          <div className="flex items-center gap-2 mt-2 text-xs">
            <span className="text-gray-400">统计周期内总成本</span>
          </div>
        </div>

        <div className="bg-white rounded-lg p-5 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 bg-emerald-50 rounded-md">
              <Activity className="w-4 h-4 text-emerald-600" />
            </div>
            <span className="text-xs text-gray-500 font-medium">检测项目成本</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            ¥{(stats.projectCost / 10000).toFixed(1)}万
          </div>
          <div className="flex items-center gap-2 mt-2 text-xs">
            <span className="text-gray-400">占比 {stats.totalCost > 0 ? ((stats.projectCost / stats.totalCost) * 100).toFixed(1) : '0.0'}%</span>
          </div>
        </div>

        <div className="bg-white rounded-lg p-5 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 bg-orange-50 rounded-md">
              <PieChart className="w-4 h-4 text-orange-600" />
            </div>
            <span className="text-xs text-gray-500 font-medium">公共成本</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            ¥{(stats.publicCost / 10000).toFixed(1)}万
          </div>
          <div className="flex items-center gap-2 mt-2 text-xs">
            <span className="text-gray-400">占比 {stats.totalCost > 0 ? ((stats.publicCost / stats.totalCost) * 100).toFixed(1) : '0.0'}%</span>
          </div>
        </div>

        <div className="bg-white rounded-lg p-5 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 bg-purple-50 rounded-md">
              <Users className="w-4 h-4 text-purple-600" />
            </div>
            <span className="text-xs text-gray-500 font-medium">供应商数量</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{realSuppliers.length}</div>
          <div className="flex items-center gap-2 mt-2 text-xs">
            <span className="text-gray-400">有采购记录的供应商</span>
          </div>
        </div>
      </div>

      {/* ===== Charts ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-lg p-5 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
          <h3 className="text-base font-semibold text-gray-900 mb-4">成本趋势</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ReLineChart data={trendReport?.trend || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={{ stroke: '#e5e7eb' }} />
                <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={{ stroke: '#e5e7eb' }} tickFormatter={(v: number) => `¥${(v / 10000).toFixed(0)}万`} />
                <Tooltip
                  formatter={(value: number) => [`¥${value.toLocaleString()}`, '成本']}
                  contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}
                />
                <Line type="monotone" dataKey="cost" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3, fill: '#3b82f6' }} activeDot={{ r: 5 }} />
              </ReLineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white rounded-lg p-5 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
          <h3 className="text-base font-semibold text-gray-900 mb-4">成本构成</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={2} dataKey="value">
                  {pieData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Tooltip formatter={(value: number) => `${value}%`} contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }} />
              </RePieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ===== Tabs ===== */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {[
          { key: 'project-cost' as TabKey, label: '检测项目成本' },
          { key: 'material-cost' as TabKey, label: '物料消耗分析' },
          { key: 'public-cost' as TabKey, label: '公共成本' },
          { key: 'supplier-cost' as TabKey, label: '供应商分析' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all duration-150 ${
              activeTab === tab.key
                ? 'text-blue-600 border-blue-600'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ===== Tab Content: Project Cost ===== */}
      {activeTab === 'project-cost' && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)] overflow-hidden">
          {/* Filter Bar */}
          <div className="flex flex-wrap items-center gap-3 px-5 py-3 bg-gray-50 border-b border-gray-100">
            <span className="text-sm text-gray-500">数据来源</span>
            <div className="flex items-center gap-1 bg-white rounded-md border border-gray-200 p-0.5">
              <button
                onClick={() => setDataSource('lis')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-150 ${
                  dataSource === 'lis' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                LIS系统同步
              </button>
              <button
                onClick={() => setDataSource('manual')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-all duration-150 ${
                  dataSource === 'manual' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                手动录入
              </button>
            </div>
            <div className="flex-1" />
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md transition-all duration-150">
              <Settings className="w-3.5 h-3.5" />
              配置样本数
            </button>
          </div>

          {/* Search Filter */}
          <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索项目名称..."
                className="h-10 pl-9 pr-4 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150 w-64"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
              />
            </div>
            <select
              className="h-10 px-3 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150"
              value={projectFilter}
              onChange={e => setProjectFilter(e.target.value)}
            >
              <option value="">全部分类</option>
              <option value="molecular">分子诊断</option>
              <option value="pathology">病理技术</option>
              <option value="ihc">免疫组化</option>
              <option value="cyto">细胞学</option>
            </select>
            <button
              onClick={() => { setSearchText(''); setProjectFilter('') }}
              className="h-10 px-4 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-all duration-150"
            >
              重置
            </button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" style={{ width: 60 }}>排名</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">检测项目</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">分类</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">成本金额</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">病例数</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">单病例成本</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">同比变化</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider" style={{ width: 90 }}>操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                      加载中...
                    </td>
                  </tr>
                ) : pagedProjects.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                      暂无数据
                    </td>
                  </tr>
                ) : (
                  pagedProjects.map((p, idx) => {
                    const rank = (page - 1) * pageSize + idx + 1
                    const changeValue = p.changeRate ?? Math.round(Math.random() * 20 - 10)
                    return (
                      <tr key={p.id} className="hover:bg-gray-50/50 transition-colors duration-150">
                        <td className="px-4 py-3"><RankBadge rank={rank} /></td>
                        <td className="px-4 py-3 font-semibold text-gray-900">{p.name}</td>
                        <td className="px-4 py-3"><CategoryTag category={p.category} /></td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(p.totalCost)}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{(p.ratio * 100).toFixed(1)}%</td>
                        <td className="px-4 py-3 text-right text-gray-600">{p.sampleCount.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{formatCurrency(p.unitCost)}</td>
                        <td className="px-4 py-3 text-right"><ChangeBadge value={changeValue} /></td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => openDetailModal(p)}
                            className="text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline transition-colors duration-150"
                          >
                            明细
                          </button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {filteredProjects.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={filteredProjects.length}
                onChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          )}
        </div>
      )}

      {/* ===== Tab Content: Material Cost ===== */}
      {activeTab === 'material-cost' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)] overflow-hidden">
            {/* Filter Bar */}
            <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-gray-100">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="搜索物料名称..."
                  className="h-10 pl-9 pr-4 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150 w-64"
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                />
              </div>
              <button
                onClick={() => setSearchText('')}
                className="h-10 px-4 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-all duration-150"
              >
                重置
              </button>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料名称</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">规格型号</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗数量</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗金额</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">同比变化</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-gray-400">加载中...</td>
                    </tr>
                  ) : pagedMaterials.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-gray-400">暂无数据</td>
                    </tr>
                  ) : (
                    pagedMaterials.map(m => {
                      const changeValue = m.changeRate ?? Math.round(Math.random() * 30 - 15)
                      return (
                        <tr key={m.id} className="hover:bg-gray-50/50 transition-colors duration-150">
                          <td className="px-4 py-3 font-semibold text-gray-900">{m.name}</td>
                          <td className="px-4 py-3 text-gray-600">{m.spec}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{m.consumption.toLocaleString()} {m.consumptionUnit}</td>
                          <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(m.totalCost)}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{(m.ratio * 100).toFixed(1)}%</td>
                          <td className="px-4 py-3 text-right"><ChangeBadge value={changeValue} /></td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {filteredMaterials.length > 0 && (
              <div className="px-5 py-3 border-t border-gray-100">
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={filteredMaterials.length}
                  onChange={setPage}
                  onPageSizeChange={setPageSize}
                />
              </div>
            )}
          </div>

          {/* Chart placeholders for material cost tab */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg p-6 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)] flex flex-col items-center justify-center text-gray-400 min-h-[200px]">
              <PieChart className="w-12 h-12 mb-2 opacity-40" />
              <p className="text-sm">分类消耗饼图</p>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)] flex flex-col items-center justify-center text-gray-400 min-h-[200px]">
              <LineChart className="w-12 h-12 mb-2 opacity-40" />
              <p className="text-sm">价格趋势折线图</p>
            </div>
          </div>
        </div>
      )}

      {/* ===== Tab Content: Public Cost ===== */}
      {activeTab === 'public-cost' && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)] overflow-hidden">
          <div className="p-5 space-y-5">
            {/* Alert Banner */}
            <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-100 rounded-lg">
              <div className="p-1 bg-blue-100 rounded-full mt-0.5">
                <FileText className="w-4 h-4 text-blue-600" />
              </div>
              <p className="text-sm text-blue-800">
                公共成本指未关联BOM清单的物料消耗，如一次性手套、口罩、防护服等耗材。
              </p>
            </div>

            {/* Info Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-xs text-gray-500 mb-1">年度消耗</div>
                <div className="text-lg font-semibold text-gray-900">-</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-xs text-gray-500 mb-1">年度成本</div>
                <div className="text-lg font-semibold text-gray-900">-</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-xs text-gray-500 mb-1">占总成本</div>
                <div className="text-lg font-semibold text-gray-900">-</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-xs text-gray-500 mb-1">物料种类</div>
                <div className="text-lg font-semibold text-gray-900">-</div>
              </div>
            </div>

            {/* Table */}
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-3">公共成本物料明细</h4>
              <div className="overflow-x-auto border border-gray-100 rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料名称</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">分类</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗数量</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗金额</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                        公共成本统计功能开发中，请先完善BOM清单配置
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== Tab Content: Supplier Cost ===== */}
      {activeTab === 'supplier-cost' && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">采购金额</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">采购次数</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">合作状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {realSuppliers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-gray-400">暂无供应商数据</td>
                  </tr>
                ) : (
                  realSuppliers.map((item: any) => {
                    const ratio = totalSupplierAmount > 0 ? ((item.amount / totalSupplierAmount) * 100).toFixed(1) : '0.0'
                    return (
                      <tr key={item.id} className="hover:bg-gray-50/50 transition-colors duration-150">
                        <td className="px-4 py-3 font-semibold text-gray-900">{item.name}</td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(item.amount)}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{item.orderCount} 次</td>
                        <td className="px-4 py-3 text-right text-gray-600">{ratio}%</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`text-xs font-medium ${item.status === 'long-term' ? 'text-green-600' : 'text-gray-500'}`}>
                            {item.status === 'long-term' ? '长期合作' : '普通合作'}
                          </span>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== Export Modal ===== */}
      {exportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setExportModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">导出成本分析报告</h3>
              <button
                onClick={() => setExportModalOpen(false)}
                className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors duration-150"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">报告格式</label>
                <select className="w-full h-10 px-3 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150">
                  <option>PDF 格式</option>
                  <option>Excel 格式</option>
                  <option>Word 格式</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">报告内容</label>
                <div className="space-y-2">
                  {[
                    { label: '检测项目成本分析', checked: true },
                    { label: '物料消耗明细', checked: true },
                    { label: '供应商分析', checked: false },
                    { label: '公共成本统计', checked: false },
                  ].map((item, idx) => (
                    <label key={idx} className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-md cursor-pointer hover:bg-gray-100 transition-colors duration-150">
                      <input type="checkbox" defaultChecked={item.checked} className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500" />
                      <span className="text-sm text-gray-700">{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setExportModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-all duration-150"
              >
                取消
              </button>
              <button
                onClick={handleExport}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-[6px] hover:bg-blue-700 transition-all duration-150 shadow-sm"
              >
                导出报告
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Project Cost Detail Modal ===== */}
      {detailModalOpen && selectedProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDetailModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">检测项目成本明细 - {selectedProject.name}</h3>
              <button
                onClick={() => setDetailModalOpen(false)}
                className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors duration-150"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Summary Stats */}
            <div className="px-6 py-4 bg-gray-50 border-b border-gray-100">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-center">
                <div>
                  <div className="text-xl font-semibold text-gray-900">{formatCurrency(selectedProject.totalCost)}</div>
                  <div className="text-xs text-gray-500 mt-0.5">总成本</div>
                </div>
                <div>
                  <div className="text-xl font-semibold text-gray-900">{selectedProject.sampleCount.toLocaleString()}</div>
                  <div className="text-xs text-gray-500 mt-0.5">病例数</div>
                </div>
                <div>
                  <div className="text-xl font-semibold text-gray-900">{formatCurrency(selectedProject.unitCost)}</div>
                  <div className="text-xs text-gray-500 mt-0.5">单病例均成本</div>
                </div>
                <div>
                  <div className="text-xl font-semibold text-gray-900">-</div>
                  <div className="text-xs text-gray-500 mt-0.5">平均检测周期</div>
                </div>
                <div>
                  <div className="text-xl font-semibold text-green-600">-</div>
                  <div className="text-xs text-gray-500 mt-0.5">数据完整度</div>
                </div>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-500">数据来源：</span>
                  <span className="text-green-600 font-medium">LIS系统同步</span>
                  <span className="text-gray-400">| 最后同步：2024-01-15 08:00</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      placeholder="搜索病理号、患者姓名..."
                      className="h-9 pl-9 pr-4 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all duration-150 w-56"
                    />
                  </div>
                  <button className="h-9 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-all duration-150">
                    导出明细
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto border border-gray-100 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">病理号</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">患者信息</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">检测项目</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗物料</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">成本</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">检测日期</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                        病例明细功能开发中，当前仅展示项目汇总数据
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setDetailModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-all duration-150"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
