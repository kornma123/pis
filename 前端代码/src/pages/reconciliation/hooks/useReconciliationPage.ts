import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import request from '@/api/request'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { canAccess, getRoles } from '@/lib/permissions'
import { downloadTextFile } from '@/lib/utils'

export interface SummaryData {
  totalCases: number
  linkedOutbounds: number
  unlinkedOutbounds: number
  projectsWithoutBom: number
}

export interface ProjectReconcile {
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

export interface MaterialDiff {
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

export interface MaterialSummary {
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

export interface LisCase {
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

export interface ReconcileLog {
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
  status?: string
  reviewed_by?: string
  proposed_usage?: number
}

export type TabType = 'reconcile' | 'material' | 'case' | 'log'
export type PeriodType = 'week' | 'month' | 'quarter' | 'year' | 'custom'

const TABS: TabType[] = ['reconcile', 'material', 'case', 'log']
const PRESET_PERIODS: Exclude<PeriodType, 'custom'>[] = ['week', 'month', 'quarter', 'year']

function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function periodRange(period: Exclude<PeriodType, 'custom'>, now = new Date()): [string, string] {
  const year = now.getFullYear()
  const month = now.getMonth()
  if (period === 'week') {
    const mondayOffset = (now.getDay() + 6) % 7
    const start = new Date(year, month, now.getDate() - mondayOffset)
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
    return [toLocalIsoDate(start), toLocalIsoDate(end)]
  }
  if (period === 'quarter') {
    const quarterStart = Math.floor(month / 3) * 3
    return [toLocalIsoDate(new Date(year, quarterStart, 1)), toLocalIsoDate(new Date(year, quarterStart + 3, 0))]
  }
  if (period === 'year') {
    return [`${year}-01-01`, `${year}-12-31`]
  }
  return [toLocalIsoDate(new Date(year, month, 1)), toLocalIsoDate(new Date(year, month + 1, 0))]
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

function startsWithSpreadsheetFormula(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? Number.POSITIVE_INFINITY
    if (codePoint <= 0x1f || /\s/u.test(character)) continue
    return '=+-@'.includes(character)
  }
  return false
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (startsWithSpreadsheetFormula(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',')
}

function readErrorMessage(): string {
  return typeof navigator !== 'undefined' && navigator.onLine === false
    ? '数据服务未连接，请检查网络后重试'
    : '对账数据没能加载，请重试'
}

export function useReconciliationPage() {
  const { get, getNumber, setMultiple } = useUrlParams()
  const periodParam = get('period')
  const initialPeriod: PeriodType = PRESET_PERIODS.includes(periodParam as Exclude<PeriodType, 'custom'>)
    ? periodParam as Exclude<PeriodType, 'custom'>
    : periodParam === 'custom'
      ? 'custom'
      : 'month'
  const fallbackRange = periodRange(initialPeriod === 'custom' ? 'month' : initialPeriod)
  const urlStart = get('startDate')
  const urlEnd = get('endDate')
  const initialStart = isIsoDate(urlStart) ? urlStart : fallbackRange[0]
  const initialEnd = isIsoDate(urlEnd) && urlEnd >= initialStart ? urlEnd : fallbackRange[1]
  const tabParam = get('tab') as TabType

  const canRead = canAccess('reconciliation', 'R')
  const canWrite = canAccess('reconciliation', 'W')
  const [activeTab, setActiveTabState] = useState<TabType>(TABS.includes(tabParam) ? tabParam : 'reconcile')
  const [period, setPeriodState] = useState<PeriodType>(initialPeriod)
  const [startDate, setStartDateState] = useState(initialStart)
  const [endDate, setEndDateState] = useState(initialEnd)
  const [loading, setLoading] = useState(false)
  const [periodError, setPeriodError] = useState<string | null>(null)
  const [loadedPeriodKey, setLoadedPeriodKey] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [projects, setProjects] = useState<ProjectReconcile[]>([])
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [projectMaterials, setProjectMaterials] = useState<Record<string, MaterialDiff[]>>({})
  const [projectMaterialLoading, setProjectMaterialLoading] = useState<Record<string, boolean>>({})
  const [projectMaterialErrors, setProjectMaterialErrors] = useState<Record<string, string | null>>({})
  const [materials, setMaterials] = useState<MaterialSummary[]>([])

  const [caseSearch, setCaseSearchState] = useState(get('csearch'))
  const [caseFilterProject, setCaseFilterProjectState] = useState(get('cproject'))
  const [caseFilterStatus, setCaseFilterStatusState] = useState(get('cstatus'))

  const [importModalOpen, setImportModalOpen] = useState(false)
  const [fixBomModalOpen, setFixBomModalOpen] = useState(false)
  const [editCaseModalOpen, setEditCaseModalOpen] = useState(false)
  const [importData, setImportData] = useState('')
  const [fixTarget, setFixTarget] = useState<MaterialDiff | null>(null)
  const [fixTargetProjectId, setFixTargetProjectId] = useState<string | null>(null)
  const [fixNewUsage, setFixNewUsage] = useState(0)
  const [fixNewUnit, setFixNewUnit] = useState('')
  const [fixReason, setFixReason] = useState('')
  const [editCaseTarget, setEditCaseTarget] = useState<LisCase | null>(null)
  const [editCaseProjectId, setEditCaseProjectId] = useState('')
  const [editCaseStatus, setEditCaseStatus] = useState('')
  const mutationRef = useRef(false)
  const [mutationBusy, setMutationBusy] = useState(false)

  const currentPeriodKey = `${startDate}|${endDate}`
  const currentPeriodKeyRef = useRef(currentPeriodKey)
  currentPeriodKeyRef.current = currentPeriodKey
  const periodReady = loadedPeriodKey === currentPeriodKey && !loading && !periodError
  const dateParams = useMemo(() => ({ startDate, endDate }), [startDate, endDate])

  const fetchPeriodData = useCallback(async () => {
    if (!canRead || !isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
      setPeriodError(startDate > endDate ? '开始日期不能晚于结束日期' : '对账期间无效')
      return
    }
    const version = ++requestVersion.current
    const requestedKey = `${startDate}|${endDate}`
    const params = { startDate, endDate }
    setLoading(true)
    setPeriodError(null)
    setLoadedPeriodKey(null)
    setSummary(null)
    setProjects([])
    setMaterials([])
    setExpandedProject(null)
    setProjectMaterials({})
    setProjectMaterialErrors({})
    try {
      const [summaryResponse, projectResponse, materialResponse] = await Promise.all([
        request.get('/reconciliation/summary', { params }),
        request.get('/reconciliation/projects', { params }),
        request.get('/reconciliation/materials', { params }),
      ]) as [SummaryData, { list?: ProjectReconcile[] }, { list?: MaterialSummary[] }]
      if (version !== requestVersion.current) return
      setSummary(summaryResponse)
      setProjects(projectResponse?.list || [])
      setMaterials(materialResponse?.list || [])
      setLoadedPeriodKey(requestedKey)
    } catch (caught) {
      if (version !== requestVersion.current) return
      console.error(caught)
      setSummary(null)
      setProjects([])
      setMaterials([])
      setPeriodError(readErrorMessage())
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [canRead, startDate, endDate])

  const casePagination = usePagination<LisCase>({
    fetchFn: async ({ page, pageSize }) => {
      if (activeTab !== 'case' || !canRead) return { list: [], pagination: { total: 0, page, pageSize } }
      const res: any = await request.get('/reconciliation/cases', {
        params: {
          page,
          pageSize,
          search: caseSearch || undefined,
          projectId: caseFilterProject || undefined,
          status: caseFilterStatus || undefined,
        },
      })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    initialPage: Math.max(1, getNumber('cpage', 1)),
    initialPageSize: Math.max(1, Math.min(100, getNumber('cpageSize', 20))),
    deps: [activeTab, canRead, caseSearch, caseFilterProject, caseFilterStatus],
  })

  const logPagination = usePagination<ReconcileLog>({
    fetchFn: async ({ page, pageSize }) => {
      if (activeTab !== 'log' || !canRead) return { list: [], pagination: { total: 0, page, pageSize } }
      const res: any = await request.get('/reconciliation/logs', { params: { page, pageSize } })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    initialPage: Math.max(1, getNumber('lpage', 1)),
    initialPageSize: Math.max(1, Math.min(100, getNumber('lpageSize', 20))),
    deps: [activeTab, canRead],
  })

  useEffect(() => {
    void fetchPeriodData()
  }, [fetchPeriodData])

  useEffect(() => {
    setMultiple({
      tab: activeTab === 'reconcile' ? null : activeTab,
      period: period === 'month' ? null : period,
      startDate,
      endDate,
      cpage: casePagination.page === 1 ? null : String(casePagination.page),
      cpageSize: casePagination.pageSize === 20 ? null : String(casePagination.pageSize),
      csearch: caseSearch || null,
      cproject: caseFilterProject || null,
      cstatus: caseFilterStatus || null,
      lpage: logPagination.page === 1 ? null : String(logPagination.page),
      lpageSize: logPagination.pageSize === 20 ? null : String(logPagination.pageSize),
    })
  }, [activeTab, period, startDate, endDate, casePagination.page, casePagination.pageSize, caseSearch, caseFilterProject, caseFilterStatus, logPagination.page, logPagination.pageSize, setMultiple])

  const setActiveTab = useCallback((nextTab: TabType) => {
    setActiveTabState(nextTab)
  }, [])

  const setPeriod = useCallback((nextPeriod: PeriodType) => {
    setPeriodState(nextPeriod)
    if (nextPeriod !== 'custom') {
      const [nextStart, nextEnd] = periodRange(nextPeriod)
      setStartDateState(nextStart)
      setEndDateState(nextEnd)
    }
  }, [])

  const setStartDate = useCallback((value: string) => {
    setPeriodState('custom')
    setStartDateState(value)
  }, [])

  const setEndDate = useCallback((value: string) => {
    setPeriodState('custom')
    setEndDateState(value)
  }, [])

  const setCaseSearch = useCallback((value: string) => {
    setCaseSearchState(value)
    casePagination.setPage(1)
  }, [casePagination.setPage])

  const setCaseFilterProject = useCallback((value: string) => {
    setCaseFilterProjectState(value)
    casePagination.setPage(1)
  }, [casePagination.setPage])

  const setCaseFilterStatus = useCallback((value: string) => {
    setCaseFilterStatusState(value)
    casePagination.setPage(1)
  }, [casePagination.setPage])

  const loadProjectMaterials = useCallback(async (projectId: string) => {
    if (expandedProject === projectId && !projectMaterialErrors[projectId]) {
      setExpandedProject(null)
      return
    }
    if (projectMaterials[projectId]) {
      setExpandedProject(projectId)
      return
    }
    const requestedKey = currentPeriodKey
    setExpandedProject(projectId)
    setProjectMaterialLoading(prev => ({ ...prev, [projectId]: true }))
    setProjectMaterialErrors(prev => ({ ...prev, [projectId]: null }))
    try {
      const res: any = await request.get(`/reconciliation/projects/${projectId}/materials`, { params: dateParams })
      if (requestedKey !== currentPeriodKeyRef.current) return
      setProjectMaterials(prev => ({ ...prev, [projectId]: res?.list || [] }))
    } catch (caught) {
      if (requestedKey !== currentPeriodKeyRef.current) return
      console.error(caught)
      setProjectMaterialErrors(prev => ({ ...prev, [projectId]: '项目物料明细没能加载，请重试' }))
    } finally {
      if (requestedKey === currentPeriodKeyRef.current) {
        setProjectMaterialLoading(prev => ({ ...prev, [projectId]: false }))
      }
    }
  }, [expandedProject, projectMaterials, projectMaterialErrors, currentPeriodKey, dateParams])

  const beginMutation = useCallback(() => {
    if (!canWrite) {
      toast.error('当前为只读模式，不能提交变更')
      return false
    }
    if (mutationRef.current) return false
    mutationRef.current = true
    setMutationBusy(true)
    return true
  }, [canWrite])

  const endMutation = useCallback(() => {
    mutationRef.current = false
    setMutationBusy(false)
  }, [])

  const handleImport = useCallback(async () => {
    if (!beginMutation()) return
    try {
      const lines = importData.trim().split('\n')
      const items = lines.map(line => {
        const [caseNo, projectName, operateTime, operator] = line.split(/[,\t]/)
        return { caseNo: caseNo?.trim(), projectName: projectName?.trim(), operateTime: operateTime?.trim(), operator: operator?.trim() }
      }).filter(item => item.caseNo)
      const result: any = await request.post('/reconciliation/cases/import', { items })
      const confirmedCount = Number(result?.count)
      toast.success(Number.isFinite(confirmedCount) ? `已导入 ${confirmedCount} 条病例数据` : '病例导入已完成')
      setImportModalOpen(false)
      setImportData('')
      await fetchPeriodData()
      if (activeTab === 'case') casePagination.refresh()
    } catch (caught: any) {
      toast.error(caught?.message || '导入失败')
    } finally {
      endMutation()
    }
  }, [activeTab, beginMutation, casePagination.refresh, endMutation, fetchPeriodData, importData])

  const getDiffClass = useCallback((status: string) => {
    switch (status) {
      case 'match': return 'text-green-600 bg-green-50'
      case 'warn': return 'text-yellow-600 bg-yellow-50'
      case 'danger': return 'text-red-600 bg-red-50'
      default: return 'text-gray-600 bg-gray-50'
    }
  }, [])

  const getStatusBadge = useCallback((status: string) => {
    const map: Record<string, string> = {
      normal: 'bg-green-50 text-green-600',
      modified: 'bg-yellow-50 text-yellow-600',
      unmatched: 'bg-red-50 text-red-600',
      partial: 'bg-yellow-50 text-yellow-600',
    }
    return map[status] || 'bg-gray-50 text-gray-600'
  }, [])

  const getStatusLabel = useCallback((status: string) => {
    const map: Record<string, string> = {
      normal: '正常', modified: '已修改', unmatched: '未关联', partial: '部分异常',
    }
    return map[status] || status
  }, [])

  const handleFixBom = useCallback(async () => {
    if (!fixTarget || !fixTargetProjectId) return
    if (!fixReason.trim()) {
      toast.error('请填写修正原因')
      return
    }
    if (!beginMutation()) return
    try {
      await request.post('/reconciliation/logs', {
        type: 'bom_fix',
        targetId: fixTarget.materialId,
        targetName: fixTarget.materialName,
        field: 'usage_per_sample',
        oldValue: String(fixTarget.bomUsagePerSample),
        newValue: String(fixNewUsage),
        reason: fixReason,
        projectId: fixTargetProjectId,
        materialId: fixTarget.materialId,
        newUsage: fixNewUsage,
      })
      toast.success('修正已提交，待审核')
      setFixBomModalOpen(false)
      setFixTarget(null)
      setFixTargetProjectId(null)
      if (activeTab === 'log') logPagination.refresh()
    } catch (caught: any) {
      toast.error(caught?.message || '提交失败')
    } finally {
      endMutation()
    }
  }, [activeTab, beginMutation, endMutation, fixNewUsage, fixReason, fixTarget, fixTargetProjectId, logPagination.refresh])

  const currentUsername = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('user') || '{}')?.username || ''
    } catch {
      return ''
    }
  }, [])
  const canApprove = canWrite && getRoles().some(role => ['admin', 'finance', 'lab_director'].includes(role))

  const handleApproveProposal = useCallback(async (id: string, effectiveScope: 'future_only' | 'retroactive') => {
    if (!beginMutation()) return
    try {
      const res: any = await request.post(`/reconciliation/logs/${id}/approve`, { effectiveScope })
      const retro = res?.retroactive
      toast.success(
        retro && retro.recalculatedMonths > 0
          ? `已审核通过并追溯重算 ${retro.recalculatedMonths} 个月${retro.closedMonths > 0 ? `（${retro.closedMonths} 个已关账月需走调整单）` : ''}`
          : '已审核通过，自下次生效',
      )
      logPagination.refresh()
    } catch (caught: any) {
      toast.error(caught?.message || '审核失败')
    } finally {
      endMutation()
    }
  }, [beginMutation, endMutation, logPagination.refresh])

  const handleRejectProposal = useCallback(async (id: string) => {
    if (!beginMutation()) return
    try {
      await request.post(`/reconciliation/logs/${id}/reject`, {})
      toast.success('提案已驳回')
      logPagination.refresh()
    } catch (caught: any) {
      toast.error(caught?.message || '驳回失败')
    } finally {
      endMutation()
    }
  }, [beginMutation, endMutation, logPagination.refresh])

  const handleEditCase = useCallback(async () => {
    if (!editCaseTarget || !beginMutation()) return
    try {
      await request.put(`/reconciliation/cases/${editCaseTarget.id}`, {
        projectId: editCaseProjectId || undefined,
        status: editCaseStatus || undefined,
      })
      toast.success('病例信息已更新')
      setEditCaseModalOpen(false)
      setEditCaseTarget(null)
      casePagination.refresh()
    } catch (caught: any) {
      toast.error(caught?.message || '更新失败')
    } finally {
      endMutation()
    }
  }, [beginMutation, casePagination.refresh, editCaseProjectId, editCaseStatus, editCaseTarget, endMutation])

  const openFixBomModal = useCallback((material: MaterialDiff, projectId: string) => {
    if (!canWrite) return
    setFixTarget(material)
    setFixTargetProjectId(projectId)
    setFixNewUsage(material.bomUsagePerSample)
    setFixNewUnit(material.bomUnit)
    setFixReason('')
    setFixBomModalOpen(true)
  }, [canWrite])

  const openEditCaseModal = useCallback((item: LisCase) => {
    if (!canWrite) return
    setEditCaseTarget(item)
    setEditCaseProjectId(item.project_id || '')
    setEditCaseStatus(item.status || '')
    setEditCaseModalOpen(true)
  }, [canWrite])

  const resetCaseFilters = useCallback(() => {
    setCaseSearchState('')
    setCaseFilterProjectState('')
    setCaseFilterStatusState('')
    casePagination.setPage(1)
  }, [casePagination.setPage])

  const handleExport = useCallback(() => {
    if (!periodReady || !summary) {
      toast.error('当前期间数据尚未加载完成，无法导出')
      return
    }
    try {
      const rows: unknown[][] = [
        ['对账期间', `${startDate} 至 ${endDate}`],
        [],
        ['来源摘要'],
        ['LIS病例总数', '系统出库关联数', '未关联出库', '病例缺失'],
        [summary.totalCases, summary.linkedOutbounds, summary.unlinkedOutbounds, summary.projectsWithoutBom],
        [],
        ['按项目对账'],
        ['项目编码', '项目名称', 'LIS病例', '关联出库', '是否配置BOM'],
        ...projects.map(project => [project.code, project.name, project.case_count, project.outbound_count, project.hasBom ? '是' : '否']),
        [],
        ['按物料汇总'],
        ['物料名称', '规格', '涉及项目', 'BOM理论', '实际出库', '差异量', '差异率'],
        ...materials.map(material => [
          material.materialName,
          material.spec,
          material.projectCount,
          `${material.theoryTotal} ${material.unit}`,
          `${material.actualTotal} ${material.unit}`,
          material.diff,
          `${material.diffRate}%`,
        ]),
      ]
      const content = rows.map(csvRow).join('\r\n')
      downloadTextFile(`消耗对账_${startDate}_${endDate}.csv`, content, 'text/csv;charset=utf-8')
      toast.success('对账 CSV 已生成，下载已开始')
    } catch (caught) {
      console.error(caught)
      toast.error('对账 CSV 生成失败，请重试')
    }
  }, [endDate, materials, periodReady, projects, startDate, summary])

  return {
    canRead,
    canWrite,
    activeTab,
    setActiveTab,
    period,
    setPeriod,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    loading,
    periodError,
    periodReady,
    summary,
    projects,
    expandedProject,
    projectMaterials,
    projectMaterialLoading,
    projectMaterialErrors,
    materials,
    caseSearch,
    setCaseSearch,
    caseFilterProject,
    setCaseFilterProject,
    caseFilterStatus,
    setCaseFilterStatus,
    casePagination,
    logPagination,
    importModalOpen,
    setImportModalOpen,
    fixBomModalOpen,
    setFixBomModalOpen,
    editCaseModalOpen,
    setEditCaseModalOpen,
    importData,
    setImportData,
    fixTarget,
    fixTargetProjectId,
    fixNewUsage,
    setFixNewUsage,
    fixNewUnit,
    setFixNewUnit,
    fixReason,
    setFixReason,
    editCaseTarget,
    editCaseProjectId,
    setEditCaseProjectId,
    editCaseStatus,
    setEditCaseStatus,
    mutationBusy,
    loadProjectMaterials,
    handleImport,
    handleFixBom,
    handleApproveProposal,
    handleRejectProposal,
    currentUsername,
    canApprove,
    handleEditCase,
    getDiffClass,
    getStatusBadge,
    getStatusLabel,
    openFixBomModal,
    openEditCaseModal,
    resetCaseFilters,
    dateParams,
    fetchSummary: fetchPeriodData,
    fetchMaterials: fetchPeriodData,
    fetchPeriodData,
    handleExport,
    setProjectMaterials,
  }
}
