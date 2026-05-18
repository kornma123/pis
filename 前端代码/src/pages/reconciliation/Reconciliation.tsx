import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, Upload, Download, ChevronDown, ChevronUp, FileSpreadsheet, X } from 'lucide-react'
import { toast } from 'sonner'
import request from '@/api/request'

interface SummaryData {
  totalCases: number
  linkedOutbounds: number
  unlinkedOutbounds: number
  projectsWithoutBom: number
}

interface ProjectReconcile {
  id: string
  code: string
  name: string
  bom_id: string
  type: string
  case_count: number
  outbound_count: number
  hasBom: boolean
  boms: { id: string; code: string; name: string }[]
}

interface MaterialDiff {
  materialId: string
  materialName: string
  spec: string
  bomUsagePerSample: number
  bomUnit: string
  theoryQty: number
  actualQty: number
  actualUnit: string
  diff: number
  diffRate: number
  status: string
  price: number
  theoryUnit: string
}

interface MaterialSummary {
  materialId: string
  materialName: string
  spec: string
  unit: string
  projectCount: number
  theoryTotal: number
  actualTotal: number
  diff: number
  diffRate: string
  status: string
  price: number
}

interface LisCase {
  id: string
  case_no: string
  project_id: string
  project_name: string
  operator: string
  operate_time: string
  status: string
  projectName: string
  hasBom: boolean
}

interface ReconcileLog {
  id: string
  type: string
  target_id: string
  target_name: string
  field: string
  old_value: string
  new_value: string
  reason: string
  operator: string
  created_at: string
}

type TabType = 'reconcile' | 'material' | 'case' | 'log'
type PeriodType = 'week' | 'month' | 'quarter' | 'year'

export default function Reconciliation() {
  const [activeTab, setActiveTab] = useState<TabType>('reconcile')
  const [period, setPeriod] = useState<PeriodType>('month')
  const [startDate, setStartDate] = useState('2026-04-01')
  const [endDate, setEndDate] = useState('2026-04-30')
  const [loading, setLoading] = useState(false)

  // Summary
  const [summary, setSummary] = useState<SummaryData | null>(null)

  // Project reconcile
  const [projects, setProjects] = useState<ProjectReconcile[]>([])
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [projectMaterials, setProjectMaterials] = useState<Record<string, MaterialDiff[]>>({})

  // Material summary
  const [materials, setMaterials] = useState<MaterialSummary[]>([])

  // Cases
  const [cases, setCases] = useState<LisCase[]>([])
  const [caseSearch, setCaseSearch] = useState('')
  const [caseFilterProject, setCaseFilterProject] = useState('')
  const [caseFilterStatus, setCaseFilterStatus] = useState('')
  const [casePage, setCasePage] = useState(1)
  const [caseTotal, setCaseTotal] = useState(0)

  // Logs
  const [logs, setLogs] = useState<ReconcileLog[]>([])
  const [logPage, setLogPage] = useState(1)
  const [logTotal, setLogTotal] = useState(0)

  // Modals
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [fixBomModalOpen, setFixBomModalOpen] = useState(false)
  const [editCaseModalOpen, setEditCaseModalOpen] = useState(false)
  const [importData, setImportData] = useState('')
  const [fixTarget, setFixTarget] = useState<MaterialDiff | null>(null)

  const dateParams = useMemo(() => ({
    startDate,
    endDate,
  }), [startDate, endDate])

  const fetchSummary = useCallback(async () => {
    try {
      const res: any = await request.get('/reconciliation/summary', { params: dateParams })
      setSummary(res)
    } catch (e) { console.error(e) }
  }, [dateParams])

  const fetchProjects = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await request.get('/reconciliation/projects', { params: dateParams })
      setProjects(res?.list || [])
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [dateParams])

  const fetchMaterials = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await request.get('/reconciliation/materials', { params: dateParams })
      setMaterials(res?.list || [])
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [dateParams])

  const fetchCases = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await request.get('/reconciliation/cases', {
        params: { page: casePage, pageSize: 20, search: caseSearch || undefined, projectId: caseFilterProject || undefined, status: caseFilterStatus || undefined },
      })
      setCases(res?.list || [])
      setCaseTotal(res?.pagination?.total || 0)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [casePage, caseSearch, caseFilterProject, caseFilterStatus])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await request.get('/reconciliation/logs', { params: { page: logPage, pageSize: 20 } })
      setLogs(res?.list || [])
      setLogTotal(res?.pagination?.total || 0)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [logPage])

  useEffect(() => {
    fetchSummary()
    if (activeTab === 'reconcile') fetchProjects()
    if (activeTab === 'material') fetchMaterials()
    if (activeTab === 'case') fetchCases()
    if (activeTab === 'log') fetchLogs()
  }, [activeTab, fetchSummary, fetchProjects, fetchMaterials, fetchCases, fetchLogs])

  const loadProjectMaterials = async (projectId: string) => {
    if (projectMaterials[projectId]) {
      setExpandedProject(expandedProject === projectId ? null : projectId)
      return
    }
    try {
      const res: any = await request.get(`/reconciliation/projects/${projectId}/materials`, { params: dateParams })
      setProjectMaterials(prev => ({ ...prev, [projectId]: res?.list || [] }))
      setExpandedProject(projectId)
    } catch (e) { toast.error('加载物料明细失败') }
  }

  const handleImport = async () => {
    try {
      const lines = importData.trim().split('\n')
      const items = lines.map(line => {
        const [caseNo, projectName, operateTime, operator] = line.split(/[,\t]/)
        return { caseNo: caseNo?.trim(), projectName: projectName?.trim(), operateTime: operateTime?.trim(), operator: operator?.trim() }
      }).filter(i => i.caseNo)

      await request.post('/reconciliation/cases/import', { items })
      toast.success(`成功导入 ${items.length} 条病例数据`)
      setImportModalOpen(false)
      setImportData('')
      fetchSummary()
      if (activeTab === 'case') fetchCases()
    } catch (e: any) {
      toast.error(e?.message || '导入失败')
    }
  }

  const getDiffClass = (status: string) => {
    switch (status) {
      case 'match': return 'text-green-600 bg-green-50'
      case 'warn': return 'text-yellow-600 bg-yellow-50'
      case 'danger': return 'text-red-600 bg-red-50'
      default: return 'text-gray-600 bg-gray-50'
    }
  }

  const getStatusBadge = (status: string) => {
    const map: Record<string, string> = {
      normal: 'bg-green-50 text-green-600',
      modified: 'bg-yellow-50 text-yellow-600',
      unmatched: 'bg-red-50 text-red-600',
      partial: 'bg-yellow-50 text-yellow-600',
    }
    return map[status] || 'bg-gray-50 text-gray-600'
  }

  const getStatusLabel = (status: string) => {
    const map: Record<string, string> = {
      normal: '正常', modified: '已修改', unmatched: '未关联', partial: '部分异常',
    }
    return map[status] || status
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">消耗对账</h1>
          <p className="text-sm text-gray-500 mt-1">期间内 BOM理论消耗总量 vs 实际出库总量 对比</p>
        </div>
        <button
          onClick={() => setImportModalOpen(true)}
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
          {[
            { key: 'reconcile', label: '按项目对账' },
            { key: 'material', label: '按物料汇总' },
            { key: 'case', label: '按病理号查看' },
            { key: 'log', label: '修正日志' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as TabType)}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
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
      {(activeTab === 'reconcile' || activeTab === 'material') && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {([
                { key: 'week', label: '本周' },
                { key: 'month', label: '本月' },
                { key: 'quarter', label: '本季' },
                { key: 'year', label: '本年' },
              ] as { key: PeriodType; label: string }[]).map(p => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={`px-4 py-1.5 text-sm rounded-md border transition-colors ${
                    period === p.key
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
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              />
              <span className="text-gray-500 text-sm">至</span>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              />
            </div>
            <button className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
              <Download className="w-4 h-4" />
              导出报表
            </button>
          </div>

          {/* Summary Cards */}
          {summary && (
            <div className="grid grid-cols-4 gap-4 mt-4">
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">LIS病例总数</div>
                <div className="text-2xl font-bold text-gray-900">{summary.totalCases}</div>
                <div className="text-xs text-gray-400 mt-1">{period === 'month' ? '4月全部检测项目' : '当前期间'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">系统出库关联数</div>
                <div className="text-2xl font-bold text-green-600">{summary.linkedOutbounds}</div>
                <div className="text-xs text-gray-400 mt-1">出库时关联了项目</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">未关联出库</div>
                <div className="text-2xl font-bold text-yellow-600">{summary.unlinkedOutbounds}</div>
                <div className="text-xs text-gray-400 mt-1">通用领用/损耗</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="text-xs text-gray-500 mb-1">病例缺失</div>
                <div className="text-2xl font-bold text-red-600">{summary.projectsWithoutBom}</div>
                <div className="text-xs text-gray-400 mt-1">有出库无LIS记录</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab Content: Reconcile by Project */}
      {activeTab === 'reconcile' && (
        <div className="space-y-4">
          {loading ? (
            <div className="text-center py-12 text-gray-400">加载中...</div>
          ) : projects.length === 0 ? (
            <div className="text-center py-12 text-gray-400">暂无数据</div>
          ) : (
            projects.map(proj => (
              <div key={proj.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div
                  className="px-5 py-4 bg-gray-50 border-b border-gray-200 flex items-center justify-between cursor-pointer"
                  onClick={() => loadProjectMaterials(proj.id)}
                >
                  <div>
                    <div className="font-semibold text-gray-900">{proj.name}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      LIS病例：{proj.case_count}例 | 关联出库：{proj.outbound_count}例 | 涉及物料：{(proj.boms?.length || 0)}种BOM
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {proj.boms?.map(b => (
                      <span key={b.id} className="px-2.5 py-1 text-xs font-medium bg-blue-50 text-blue-600 rounded-full">
                        {b.name}
                      </span>
                    ))}
                    {!proj.hasBom && (
                      <span className="px-2.5 py-1 text-xs font-medium bg-red-50 text-red-600 rounded-full">
                        未配置BOM
                      </span>
                    )}
                    {expandedProject === proj.id ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
                  </div>
                </div>

                {expandedProject === proj.id && (
                  <div className="p-5">
                    {!proj.hasBom ? (
                      <div className="text-sm text-gray-500 py-4">
                        该检测项目尚未关联BOM，无法计算理论消耗。请到 <strong>BOM清单</strong> 页面配置。
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                              <th className="px-3 py-2 text-left">物料</th>
                              <th className="px-3 py-2 text-center">理论消耗</th>
                              <th className="px-3 py-2 text-center">实际出库</th>
                              <th className="px-3 py-2 text-center">差异</th>
                              <th className="px-3 py-2 text-center">原因分析</th>
                              <th className="px-3 py-2 text-center">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {(projectMaterials[proj.id] || []).map((mat, idx) => (
                              <tr key={idx} className="hover:bg-gray-50">
                                <td className="px-3 py-3">
                                  <div className="font-medium text-gray-900">{mat.materialName}</div>
                                  <div className="text-xs text-gray-500">{mat.spec} · {mat.bomUsagePerSample}{mat.bomUnit}/例</div>
                                </td>
                                <td className="px-3 py-3 text-center">
                                  <span className="inline-block px-2 py-1 rounded text-blue-700 bg-blue-50 font-semibold text-xs">
                                    {mat.theoryQty.toFixed(1)} {mat.theoryUnit}
                                  </span>
                                </td>
                                <td className="px-3 py-3 text-center">
                                  <span className="inline-block px-2 py-1 rounded text-orange-700 bg-orange-50 font-semibold text-xs">
                                    {mat.actualQty.toFixed(1)} {mat.actualUnit}
                                  </span>
                                </td>
                                <td className="px-3 py-3 text-center">
                                  <span className={`inline-block px-2 py-1 rounded font-semibold text-xs ${getDiffClass(mat.status)}`}>
                                    {mat.diff > 0 ? '+' : ''}{mat.diff.toFixed(1)}
                                    <br />
                                    <span className="text-[10px] opacity-75">{mat.diffRate}%</span>
                                  </span>
                                </td>
                                <td className="px-3 py-3 text-center text-xs text-gray-500">
                                  {mat.status === 'match' ? '按规格出库，正常余量' : mat.diff > 0 ? '按规格出库，剩余在库' : '实际用量偏大'}
                                </td>
                                <td className="px-3 py-3 text-center">
                                  {mat.status !== 'match' && (
                                    <button
                                      onClick={() => { setFixTarget(mat); setFixBomModalOpen(true) }}
                                      className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                                    >
                                      修正BOM
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab Content: Material Summary */}
      {activeTab === 'material' && (
        <div className="space-y-4">
          {loading ? (
            <div className="text-center py-12 text-gray-400">加载中...</div>
          ) : materials.length === 0 ? (
            <div className="text-center py-12 text-gray-400">暂无数据</div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-200">
                      <th className="px-4 py-3 text-left">物料名称</th>
                      <th className="px-4 py-3 text-left">规格</th>
                      <th className="px-4 py-3 text-center">涉及项目</th>
                      <th className="px-4 py-3 text-center">BOM理论</th>
                      <th className="px-4 py-3 text-center">实际出库</th>
                      <th className="px-4 py-3 text-center">差异量</th>
                      <th className="px-4 py-3 text-center">差异率</th>
                      <th className="px-4 py-3 text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {materials.map((mat, idx) => (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{mat.materialName}</td>
                        <td className="px-4 py-3 text-gray-500">{mat.spec}</td>
                        <td className="px-4 py-3 text-center">{mat.projectCount}</td>
                        <td className="px-4 py-3 text-center">{mat.theoryTotal.toFixed(1)} {mat.unit}</td>
                        <td className="px-4 py-3 text-center">{mat.actualTotal.toFixed(1)} {mat.unit}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-block px-2 py-1 rounded font-semibold text-xs ${getDiffClass(mat.status)}`}>
                            {mat.diff > 0 ? '+' : ''}{mat.diff.toFixed(1)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-block px-2 py-1 rounded text-xs ${getDiffClass(mat.status)}`}>
                            {parseFloat(mat.diffRate) > 0 ? '+' : ''}{mat.diffRate}%
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {mat.status !== 'match' ? (
                            <button
                              onClick={() => { setFixTarget(mat as any); setFixBomModalOpen(true) }}
                              className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                            >
                              调整BOM
                            </button>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab Content: Cases */}
      {activeTab === 'case' && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="搜索病理号..."
                    value={caseSearch}
                    onChange={e => setCaseSearch(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && fetchCases()}
                    className="pl-9 pr-4 h-9 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500 w-48"
                  />
                </div>
                <select
                  value={caseFilterProject}
                  onChange={e => setCaseFilterProject(e.target.value)}
                  className="h-9 px-3 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
                >
                  <option value="">全部检测项目</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={caseFilterStatus}
                  onChange={e => setCaseFilterStatus(e.target.value)}
                  className="h-9 px-3 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
                >
                  <option value="">全部状态</option>
                  <option value="normal">正常</option>
                  <option value="modified">已修改</option>
                  <option value="unmatched">未关联BOM</option>
                </select>
                <button onClick={fetchCases} className="h-9 px-4 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200">查询</button>
                <button onClick={() => { setCaseSearch(''); setCaseFilterProject(''); setCaseFilterStatus(''); }} className="h-9 px-4 text-sm text-gray-500 hover:text-gray-700">重置</button>
              </div>
              <button className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
                <Download className="w-4 h-4" />
                导出
              </button>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-200">
                    <th className="px-4 py-3 text-left">病理号</th>
                    <th className="px-4 py-3 text-left">检测项目</th>
                    <th className="px-4 py-3 text-left">操作时间</th>
                    <th className="px-4 py-3 text-left">操作人</th>
                    <th className="px-4 py-3 text-center">状态</th>
                    <th className="px-4 py-3 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {cases.map(c => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono font-semibold text-gray-900">{c.case_no}</td>
                      <td className="px-4 py-3">
                        <span className="inline-block px-2 py-0.5 text-xs bg-blue-50 text-blue-600 rounded mb-1">
                          {c.projectName || c.project_name || '-'}
                        </span>
                        {!c.hasBom && (
                          <div className="text-xs text-red-500">未关联BOM</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{c.operate_time || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{c.operator || '-'}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-1 text-xs rounded-full ${getStatusBadge(c.status)}`}>
                          {getStatusLabel(c.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => setEditCaseModalOpen(true)}
                          className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                        >
                          修改
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cases.length === 0 && !loading && (
              <div className="text-center py-12 text-gray-400">暂无病例数据，请先导入LIS数据</div>
            )}
            {caseTotal > 20 && (
              <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
                <span className="text-sm text-gray-500">共 {caseTotal} 条记录</span>
                <div className="flex gap-1">
                  <button onClick={() => setCasePage(p => Math.max(1, p - 1))} disabled={casePage === 1} className="px-3 py-1 text-sm border rounded hover:bg-gray-50 disabled:opacity-50">上一页</button>
                  <span className="px-3 py-1 text-sm">{casePage}</span>
                  <button onClick={() => setCasePage(p => p + 1)} disabled={casePage * 20 >= caseTotal} className="px-3 py-1 text-sm border rounded hover:bg-gray-50 disabled:opacity-50">下一页</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab Content: Logs */}
      {activeTab === 'log' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">BOM修正记录</h3>
          </div>
          <div className="p-5">
            {logs.length === 0 ? (
              <div className="text-center py-8 text-gray-400">暂无修正记录</div>
            ) : (
              <div className="space-y-4">
                {logs.map(log => (
                  <div key={log.id} className="flex gap-3 pb-4 border-b border-gray-100 last:border-0">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${log.type === 'bom_fix' ? 'bg-blue-500' : 'bg-green-500'}`} />
                    <div className="flex-1">
                      <div className="text-sm text-gray-800">
                        <strong>{log.type === 'bom_fix' ? '修正 BOM' : '新增关联'}</strong>：
                        {log.target_name}
                        {log.field && ` · ${log.field}`}
                        {log.old_value && log.new_value && (
                          <span> 从 <span className="line-through text-gray-400">{log.old_value}</span> 调整为 <strong>{log.new_value}</strong></span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        {log.created_at} · {log.operator} · 原因：{log.reason}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import Modal */}
      {importModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setImportModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">导入LIS病例数据</h3>
              <button onClick={() => setImportModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <div className="p-6">
              <div
                className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 hover:bg-blue-50 transition-colors cursor-pointer"
                onClick={() => toast.info('请直接粘贴数据到下方')}
              >
                <Upload className="w-12 h-12 mx-auto text-gray-400 mb-2" />
                <div className="font-medium text-gray-700">点击粘贴LIS数据</div>
                <div className="text-sm text-gray-500 mt-1">支持 病理号,检测项目,操作时间,操作人 格式</div>
              </div>
              <textarea
                value={importData}
                onChange={e => setImportData(e.target.value)}
                placeholder={`P24050187,HE制片,2026-04-15 14:30,张三\nP24050188,免疫组化-IHC,2026-04-15 15:00,李四`}
                rows={6}
                className="w-full mt-4 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setImportModalOpen(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">取消</button>
              <button onClick={handleImport} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">确认导入</button>
            </div>
          </div>
        </div>
      )}

      {/* Fix BOM Modal */}
      {fixBomModalOpen && fixTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setFixBomModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">修正BOM用量</h3>
              <button onClick={() => setFixBomModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-gray-50 p-3 rounded-md">
                <div className="text-xs text-gray-500">当前物料</div>
                <div className="font-semibold text-sm">{fixTarget.materialName}</div>
                <div className="text-xs text-gray-400">{fixTarget.spec}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">原用量/例</label>
                  <input type="text" value={`${fixTarget.bomUsagePerSample} ${fixTarget.bomUnit}`} disabled className="w-full px-3 py-2 text-sm border rounded-md bg-gray-100" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">建议用量/例</label>
                  <input type="text" value={`${fixTarget.bomUsagePerSample * 1.2} ${fixTarget.bomUnit}`} disabled className="w-full px-3 py-2 text-sm border rounded-md bg-gray-100 text-amber-700" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">修正为 <span className="text-red-500">*</span></label>
                <div className="flex gap-2">
                  <input type="number" defaultValue={fixTarget.bomUsagePerSample} className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:border-blue-500" />
                  <select defaultValue={fixTarget.bomUnit} className="w-24 px-3 py-2 text-sm border rounded-md">
                    <option>ml</option><option>μl</option><option>L</option><option>g</option><option>mg</option><option>片</option><option>支</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">修正原因 <span className="text-red-500">*</span></label>
                <textarea rows={2} placeholder="请说明修正原因" className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:border-blue-500" />
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800">
                <strong>提示：</strong>修正后，该BOM的历史对账数据将同步更新，差异记录保留在日志中。
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setFixBomModalOpen(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">取消</button>
              <button onClick={() => { toast.success('BOM用量已修正！'); setFixBomModalOpen(false) }} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">确认修正</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Case Modal */}
      {editCaseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setEditCaseModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">修改病例消耗信息</h3>
              <button onClick={() => setEditCaseModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <div className="p-6">
              <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800">
                <strong>说明：</strong>修改仅影响本病例的成本归集，不会修改BOM标准。如需修改标准用量，请使用"修正BOM"功能。
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setEditCaseModalOpen(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">取消</button>
              <button onClick={() => { toast.success('病例信息已修改！'); setEditCaseModalOpen(false) }} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">保存修改</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
