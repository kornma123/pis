import { useState, useEffect, useMemo, useCallback } from 'react'
import { toast } from 'sonner'
import request from '@/api/request'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { getRoles } from '@/lib/permissions'

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
export type PeriodType = 'week' | 'month' | 'quarter' | 'year'

export function useReconciliationPage() {
  const [activeTab, setActiveTab] = useState<TabType>('reconcile')
  const [period, setPeriod] = useState<PeriodType>('month')
  const [startDate, setStartDate] = useState('2026-04-01')
  const [endDate, setEndDate] = useState('2026-04-30')
  const [loading, setLoading] = useState(false)

  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [projects, setProjects] = useState<ProjectReconcile[]>([])
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [projectMaterials, setProjectMaterials] = useState<Record<string, MaterialDiff[]>>({})
  const [materials, setMaterials] = useState<MaterialSummary[]>([])

  const [caseSearch, setCaseSearch] = useState('')
  const [caseFilterProject, setCaseFilterProject] = useState('')
  const [caseFilterStatus, setCaseFilterStatus] = useState('')

  const [importModalOpen, setImportModalOpen] = useState(false)
  const [fixBomModalOpen, setFixBomModalOpen] = useState(false)
  const [editCaseModalOpen, setEditCaseModalOpen] = useState(false)
  const [importData, setImportData] = useState('')
  const [fixTarget, setFixTarget] = useState<MaterialDiff | null>(null)
  const [fixTargetProjectId, setFixTargetProjectId] = useState<string | null>(null)
  const [fixNewUsage, setFixNewUsage] = useState<number>(0)
  const [fixNewUnit, setFixNewUnit] = useState<string>('')
  const [fixReason, setFixReason] = useState<string>('')
  const [editCaseTarget, setEditCaseTarget] = useState<LisCase | null>(null)
  const [editCaseProjectId, setEditCaseProjectId] = useState<string>('')
  const [editCaseStatus, setEditCaseStatus] = useState<string>('')

  const dateParams = useMemo(() => ({ startDate, endDate }), [startDate, endDate])

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

  const { getNumber, setMultiple } = useUrlParams()

  const casePagination = usePagination<LisCase>({
    fetchFn: async ({ page, pageSize }) => {
      if (activeTab !== 'case') return { list: [], pagination: { total: 0, page, pageSize } }
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
    deps: [activeTab, caseSearch, caseFilterProject, caseFilterStatus],
  })

  const logPagination = usePagination<ReconcileLog>({
    fetchFn: async ({ page, pageSize }) => {
      if (activeTab !== 'log') return { list: [], pagination: { total: 0, page, pageSize } }
      const res: any = await request.get('/reconciliation/logs', { params: { page, pageSize } })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    initialPage: Math.max(1, getNumber('lpage', 1)),
    initialPageSize: Math.max(1, Math.min(100, getNumber('lpageSize', 20))),
    deps: [activeTab],
  })

  useEffect(() => {
    fetchSummary()
    if (activeTab === 'reconcile') fetchProjects()
    if (activeTab === 'material') fetchMaterials()
  }, [activeTab, fetchSummary, fetchProjects, fetchMaterials])

  useEffect(() => {
    setMultiple({
      cpage: casePagination.page === 1 ? null : String(casePagination.page),
      cpageSize: casePagination.pageSize === 20 ? null : String(casePagination.pageSize),
      csearch: caseSearch || null,
      cproject: caseFilterProject || null,
      cstatus: caseFilterStatus || null,
      lpage: logPagination.page === 1 ? null : String(logPagination.page),
      lpageSize: logPagination.pageSize === 20 ? null : String(logPagination.pageSize),
    })
  }, [casePagination.page, casePagination.pageSize, caseSearch, caseFilterProject, caseFilterStatus, logPagination.page, logPagination.pageSize])

  const loadProjectMaterials = async (projectId: string) => {
    if (projectMaterials[projectId]) {
      setExpandedProject(expandedProject === projectId ? null : projectId)
      return
    }
    try {
      const res: any = await request.get(`/reconciliation/projects/${projectId}/materials`, { params: dateParams })
      setProjectMaterials(prev => ({ ...prev, [projectId]: res?.list || [] }))
      setExpandedProject(projectId)
    } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
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
      if (activeTab === 'case') casePagination.refresh()
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

  const handleFixBom = async () => {
    if (!fixTarget || !fixTargetProjectId) return
    if (!fixReason.trim()) {
      toast.error('请填写修正原因')
      return
    }
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
      // 现为「提议→审核」：提交不立即改 BOM，须独立审核人通过后生效（SoD）
      toast.success('修正已提交，待审核')
      setFixBomModalOpen(false)
      setFixTarget(null)
      setFixTargetProjectId(null)
    } catch (e: any) {
      toast.error(e?.message || '提交失败')
    }
  }

  // 当前登录用户（用于 SoD 前端提示：不能审核自己提交的提案）
  const currentUsername = (() => {
    try {
      return JSON.parse(localStorage.getItem('user') || '{}')?.username || ''
    } catch { return '' }
  })()
  // 对账核准 = 成本核准角色（admin/finance/lab_director），多角色按并集（与后端 requireAnyRole 一致）
  const canApprove = getRoles().some((r) => ['admin', 'finance', 'lab_director'].includes(r))

  const handleApproveProposal = async (id: string, effectiveScope: 'future_only' | 'retroactive') => {
    try {
      const res: any = await request.post(`/reconciliation/logs/${id}/approve`, { effectiveScope })
      const retro = res?.retroactive
      toast.success(
        retro && retro.recalculatedMonths > 0
          ? `已审核通过并追溯重算 ${retro.recalculatedMonths} 个月${retro.closedMonths > 0 ? `（${retro.closedMonths} 个已关账月需走调整单）` : ''}`
          : '已审核通过，自下次生效',
      )
      logPagination.refresh()
    } catch (e: any) {
      toast.error(e?.message || '审核失败')
    }
  }

  const handleRejectProposal = async (id: string) => {
    try {
      await request.post(`/reconciliation/logs/${id}/reject`, {})
      toast.success('提案已驳回')
      logPagination.refresh()
    } catch (e: any) {
      toast.error(e?.message || '驳回失败')
    }
  }

  const handleEditCase = async () => {
    if (!editCaseTarget) return
    try {
      await request.put(`/reconciliation/cases/${editCaseTarget.id}`, {
        projectId: editCaseProjectId || undefined,
        status: editCaseStatus || undefined,
      })
      toast.success('病例信息已更新')
      setEditCaseModalOpen(false)
      setEditCaseTarget(null)
      casePagination.refresh()
    } catch (e: any) {
      toast.error(e?.message || '更新失败')
    }
  }

  const openFixBomModal = (mat: MaterialDiff, projectId: string) => {
    setFixTarget(mat)
    setFixTargetProjectId(projectId)
    setFixNewUsage(mat.bomUsagePerSample)
    setFixNewUnit(mat.bomUnit)
    setFixReason('')
    setFixBomModalOpen(true)
  }

  const openEditCaseModal = (c: LisCase) => {
    setEditCaseTarget(c)
    setEditCaseProjectId(c.project_id || '')
    setEditCaseStatus(c.status || '')
    setEditCaseModalOpen(true)
  }

  const resetCaseFilters = () => {
    setCaseSearch('')
    setCaseFilterProject('')
    setCaseFilterStatus('')
    casePagination.setPage(1)
  }

  return {
    activeTab,
    setActiveTab,
    period,
    setPeriod,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    loading,
    summary,
    projects,
    expandedProject,
    projectMaterials,
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
    fetchSummary,
    fetchMaterials,
    setProjectMaterials,
  }
}
