import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { inventoryApi, outboundApi, scrapApi } from '@/api/inventory'
import { bomApi } from '@/api/master'
import { projectApi } from '@/api/master'
import type { InventoryItem, InventoryStats, Project } from '@/types'
import { toast } from 'sonner'

interface InventoryRow extends InventoryItem {
  batch?: string
  expiry?: string
  totalQuantity?: number
  materialName?: string
  materialCode?: string
  quantity?: number
}

type SortField = 'quantity' | 'expiry' | null
type SortDirection = 'asc' | 'desc'
type QuickFilterType = 'all' | 'low-stock' | 'expiring-soon' | 'expiring-month' | 'expired' | 'out-of-stock'

export function useInventoryPage() {
  const inventoryRetryPendingRef = useRef(false)
  const outboundSubmitPendingRef = useRef<Promise<void> | null>(null)
  // ===== URL 参数同步 =====
  const { get, getNumber, setMultiple } = useUrlParams()

  // ===== 数据状态 =====
  const [stats, setStats] = useState<InventoryStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)

  // ===== 筛选状态 =====
  const initialKeyword = get('keyword', '')
  const [keyword, setKeyword] = useState(initialKeyword)
  const [appliedKeyword, setAppliedKeyword] = useState(initialKeyword)
  const [category, setCategory] = useState('全部分类')
  const [location, setLocation] = useState('全部库位')
  const [quickFilter, setQuickFilter] = useState<QuickFilterType>('all')

  // ===== 排序状态 =====
  const [sortField, setSortField] = useState<SortField>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  // ===== 选择状态 =====
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // ===== 弹窗状态 =====
  const [outboundModalOpen, setOutboundModalOpen] = useState(false)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [batchOutboundModalOpen, setBatchOutboundModalOpen] = useState(false)
  const [batchScrapModalOpen, setBatchScrapModalOpen] = useState(false)
  const [selectedItem, setSelectedItem] = useState<InventoryRow | null>(null)

  // ===== 分组展开状态 =====
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // ===== 项目列表（仅在打开出库表单时按需加载） =====
  const [projectList, setProjectList] = useState<Project[]>([])
  const projectListLoadedRef = useRef(false)
  const projectListRequestRef = useRef<Promise<void> | null>(null)

  // ===== 物料选择弹窗状态 =====
  const [materialSelectorOpen, setMaterialSelectorOpen] = useState(false)
  const [materialList, setMaterialList] = useState<Array<{
    id: string; code: string; name: string; spec: string; categoryName: string; unit: string; stock: number
  }>>([])
  const [materialKeyword, setMaterialKeyword] = useState('')
  const [checkedMaterialIds, setCheckedMaterialIds] = useState<Set<string>>(new Set())
  const [materialLoading, setMaterialLoading] = useState(false)
  const [materialSelectorTab, setMaterialSelectorTab] = useState<'list' | 'bom'>('list')
  const [selectedMaterials, setSelectedMaterials] = useState<Array<{
    id: string; code: string; name: string; spec: string; unit: string; stock: number
  }>>([])

  // ===== BOM 选择状态 =====
  const [bomList, setBomList] = useState<Array<{ id: string; code: string; name: string; type: string }>>([])
  const [selectedBomId, setSelectedBomId] = useState('')
  const [bomMaterials, setBomMaterials] = useState<Array<{
    id: string; code: string; name: string; spec: string; unit: string; stock: number; usagePerSample: number
  }>>([])
  const [bomLoading, setBomLoading] = useState(false)

  // ===== 出库登记弹窗状态 =====
  const [outboundRemark, setOutboundRemark] = useState('')
  const [outboundSubmitting, setOutboundSubmitting] = useState(false)
  const [outboundSubmitError, setOutboundSubmitError] = useState<string | null>(null)
  const [outboundMaterials, setOutboundMaterials] = useState<Array<{
    rowId: number; materialId: string; name: string; spec: string; batch?: string
    stock: number; quantity: number; unit: string; project: string; user: string
    usage: 'self' | 'external'; receiver: string
  }>>([])

  const [scrapReason, setScrapReason] = useState('expired')
  const [scrapRemark, setScrapRemark] = useState('')

  // ===== 分页数据 =====
  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

  const fetchFn = useCallback(
    async (params: { page: number; pageSize: number }) => {
      const res: any = await inventoryApi.getList({
        page: params.page,
        pageSize: params.pageSize,
        keyword: appliedKeyword || undefined,
        status: quickFilter === 'low-stock'
          ? 'low-stock'
          : quickFilter === 'expired'
            ? 'expired'
            : quickFilter === 'expiring-soon' || quickFilter === 'expiring-month'
              ? 'expiring-soon'
              : undefined,
      })
      const list = (res?.list || []).map((item: any) => ({
        ...item,
        batch: item.batch || item.batchNo || '-',
        expiry: item.expiry || item.expiryDate || '-',
      })) as InventoryRow[]
      return { list, pagination: res?.pagination }
    },
    [appliedKeyword, quickFilter]
  )

  const {
    data,
    loading,
    error,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<InventoryRow>({
    fetchFn,
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [appliedKeyword, quickFilter],
  })

  const retryInventory = useCallback(() => {
    if (inventoryRetryPendingRef.current || loading) return
    inventoryRetryPendingRef.current = true
    refresh()
  }, [loading, refresh])

  useEffect(() => {
    if (!loading) inventoryRetryPendingRef.current = false
  }, [loading])

  // 同步分页/筛选状态到 URL
  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: appliedKeyword || null,
    })
  }, [page, pageSize, appliedKeyword, setMultiple])

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await inventoryApi.getStats()
      setStats(res || {})
      setStatsError(null)
    } catch {
      setStatsError('库存统计没能加载')
    }
  }, [])

  const fetchProjects = useCallback(() => {
    if (projectListLoadedRef.current) return Promise.resolve()
    if (projectListRequestRef.current) return projectListRequestRef.current

    const request = (async () => {
      try {
        const res: any = await projectApi.getList({ pageSize: 999 })
        setProjectList(res?.list || [])
        projectListLoadedRef.current = true
      } catch (e) {
        console.error(e)
      }
    })()

    projectListRequestRef.current = request
    void request.finally(() => {
      if (projectListRequestRef.current === request) {
        projectListRequestRef.current = null
      }
    })
    return request
  }, [])

  const fetchBomList = useCallback(async () => {
    setBomLoading(true)
    try {
      const res: any = await bomApi.getList({ pageSize: 999 })
      setBomList(res?.list || [])
    } catch (e) {
      console.error(e)
    } finally {
      setBomLoading(false)
    }
  }, [])

  const loadBomDetail = useCallback(async (bomId: string) => {
    if (!bomId) {
      setBomMaterials([])
      return
    }
    setBomLoading(true)
    try {
      const res: any = await bomApi.getDetail(bomId)
      const materials = (res?.materials || []).map((m: any) => ({
        id: m.id,
        code: m.code || '-',
        name: m.name,
        spec: m.spec || '-',
        unit: m.unit || '-',
        stock: m.stock || 0,
        usagePerSample: m.usagePerSample || 0,
      }))
      setBomMaterials(materials)
    } catch (e) {
      console.error(e)
    } finally {
      setBomLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  const computedStats = useMemo(() => {
    if (!stats) {
      return {
        total: null,
        normal: null,
        low: null,
        warning: null,
        expired: null,
        outOfStock: null,
      }
    }
    return {
      total: stats.totalStockCount ?? stats.totalMaterials ?? 0,
      normal: stats.normalCount ?? 0,
      low: stats.lowStockCount ?? 0,
      warning: stats.expiringCount ?? 0,
      expired: stats.expiredCount ?? 0,
      outOfStock: null,
    }
  }, [stats])

  const quickFilterCounts = useMemo(() => {
    return {
      all: computedStats.total,
      'low-stock': computedStats.low,
      'expiring-soon': computedStats.warning,
      'expiring-month': computedStats.warning,
      expired: computedStats.expired,
      'out-of-stock': null,
    }
  }, [computedStats])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const visibleIds = useMemo(() => new Set(data.map(item => item.id)), [data])
  const visibleSelectedIds = useMemo(
    () => new Set([...selectedIds].filter(id => visibleIds.has(id))),
    [selectedIds, visibleIds]
  )

  const toggleGroup = (name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (visibleSelectedIds.size === data.length && data.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map(r => r.id)))
    }
  }

  const toggleSelectOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const changePage = useCallback((nextPage: number) => {
    setSelectedIds(new Set())
    setPage(nextPage)
  }, [setPage])

  const changePageSize = useCallback((nextPageSize: number) => {
    setSelectedIds(new Set())
    setPageSize(nextPageSize)
  }, [setPageSize])

  const ensureFreshInventory = () => {
    if (!error) return true
    toast.error('库存数据不是最新状态，请刷新成功后再操作')
    return false
  }

  const handleSearch = () => {
    setAppliedKeyword(keyword.trim())
    clearSelection()
    setPage(1)
  }

  const handleReset = () => {
    setKeyword('')
    setAppliedKeyword('')
    setCategory('全部分类')
    setLocation('全部库位')
    setQuickFilter('all')
    setPage(1)
  }

  const handleQuickFilter = (filter: QuickFilterType) => {
    setQuickFilter(filter)
    clearSelection()
    setPage(1)
  }

  const openEmptyOutboundModal = () => {
    if (!ensureFreshInventory()) return Promise.resolve()
    setOutboundSubmitError(null)
    setOutboundModalOpen(true)
    return fetchProjects()
  }

  const openOutboundModal = (item: InventoryRow) => {
    if (!ensureFreshInventory()) return
    setOutboundSubmitError(null)
    if (projectList.length === 0) void fetchProjects()
    const existing = outboundMaterials.find(m => m.materialId === item.materialId)
    if (existing) return
    const newRow = {
      rowId: Date.now(),
      materialId: item.materialId,
      name: item.name,
      spec: item.spec,
      batch: item.batch,
      stock: item.stock,
      quantity: 1,
      unit: item.unit,
      project: '',
      user: '',
      usage: 'self' as 'self' | 'external',
      receiver: '',
    }
    setOutboundMaterials(prev => [...prev, newRow])
    setOutboundModalOpen(true)
  }

  const openBatchOutbound = () => {
    if (!ensureFreshInventory()) return
    setOutboundSubmitError(null)
    if (projectList.length === 0) void fetchProjects()
    const selectedItems = data.filter(i => visibleSelectedIds.has(i.id))
    const newMaterials = selectedItems
      .filter(item => item.stock > 0)
      .filter(item => !outboundMaterials.find(m => m.materialId === item.materialId))
      .map(item => ({
        rowId: Date.now() + Math.random(),
        materialId: item.materialId,
        name: item.name,
        spec: item.spec,
        batch: item.batch,
        stock: item.stock,
        quantity: 1,
        unit: item.unit,
        project: '',
        user: '',
        usage: 'self' as 'self' | 'external',
        receiver: '',
      }))
    setOutboundMaterials(prev => [...prev, ...newMaterials])
    setBatchOutboundModalOpen(false)
    setOutboundModalOpen(true)
    clearSelection()
  }

  const openMaterialSelector = async () => {
    setMaterialSelectorOpen(true)
    setMaterialSelectorTab('list')
    setCheckedMaterialIds(new Set())
    setMaterialLoading(true)
    try {
      const res: any = await inventoryApi.getList({ page: 1, pageSize: 200 })
      const list = (res?.list || []).map((item: any) => ({
        id: item.id,
        code: item.code || '-',
        name: item.name,
        spec: item.spec || '-',
        categoryName: '-',
        unit: item.unit || '-',
        stock: item.stock || 0,
      }))
      setMaterialList(list)
    } catch (e) {
      console.error(e)
    } finally {
      setMaterialLoading(false)
    }
  }

  const toggleCheckMaterial = (id: string) => {
    setCheckedMaterialIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleCheckAllMaterials = () => {
    if (checkedMaterialIds.size === filteredMaterialList.length && filteredMaterialList.length > 0) {
      setCheckedMaterialIds(new Set())
    } else {
      setCheckedMaterialIds(new Set(filteredMaterialList.map(m => m.id)))
    }
  }

  const filteredMaterialList = useMemo(() => {
    if (!materialKeyword.trim()) return materialList
    const kw = materialKeyword.toLowerCase()
    return materialList.filter(m =>
      m.name.toLowerCase().includes(kw) ||
      m.code.toLowerCase().includes(kw) ||
      m.spec.toLowerCase().includes(kw)
    )
  }, [materialList, materialKeyword])

  const addCheckedToSelected = () => {
    const allMaterials = [...materialList, ...bomMaterials]
    const checked = allMaterials.filter(m => checkedMaterialIds.has(m.id))
    const newItems = checked.filter(m => !selectedMaterials.find(sm => sm.id === m.id))
    const mapped = newItems.map(m => ({
      id: m.id,
      code: m.code || '-',
      name: m.name,
      spec: m.spec || '-',
      unit: m.unit || '-',
      stock: m.stock || 0,
    }))
    setSelectedMaterials(prev => [...prev, ...mapped])
    setCheckedMaterialIds(new Set())
    return mapped
  }

  const removeSelectedMaterial = (id: string) => {
    setSelectedMaterials(prev => prev.filter(m => m.id !== id))
  }

  const confirmAddMaterials = () => {
    const newlyAdded = addCheckedToSelected()
    const allSelected = [...selectedMaterials, ...newlyAdded]
    const newItems = allSelected
      .filter(m => !outboundMaterials.find(om => om.materialId === m.id))
      .map(m => ({
        rowId: Date.now() + Math.random(),
        materialId: m.id,
        name: m.name,
        spec: m.spec,
        batch: '-',
        stock: m.stock,
        quantity: 1,
        unit: m.unit,
        project: '',
        user: '',
        usage: 'self' as 'self' | 'external',
        receiver: '',
      }))
    setOutboundMaterials(prev => [...prev, ...newItems])
    setMaterialSelectorOpen(false)
    setSelectedMaterials([])
    setCheckedMaterialIds(new Set())
    setMaterialKeyword('')
  }

  const removeOutboundItem = (rowId: number) => {
    setOutboundMaterials(prev => prev.filter(m => m.rowId !== rowId))
  }

  const updateOutboundQuantity = (rowId: number, value: string) => {
    const qty = parseInt(value) || 1
    setOutboundMaterials(prev => prev.map(m => {
      if (m.rowId !== rowId) return m
      return { ...m, quantity: Math.min(qty, m.stock) }
    }))
  }

  const updateOutboundProject = (rowId: number, value: string) => {
    void rowId
    setOutboundMaterials(prev => prev.map(m => ({ ...m, project: value })))
  }

  const updateOutboundUser = (rowId: number, value: string) => {
    setOutboundMaterials(prev => prev.map(m =>
      m.rowId === rowId ? { ...m, user: value } : m
    ))
  }

  const updateOutboundUsage = (rowId: number, value: 'self' | 'external') => {
    setOutboundMaterials(prev => prev.map(m =>
      m.rowId === rowId ? { ...m, usage: value, receiver: value === 'self' ? '' : m.receiver } : m
    ))
  }

  const updateOutboundReceiver = (rowId: number, value: string) => {
    setOutboundMaterials(prev => prev.map(m =>
      m.rowId === rowId ? { ...m, receiver: value } : m
    ))
  }

  const confirmOutbound = () => {
    if (outboundSubmitPendingRef.current) return outboundSubmitPendingRef.current
    if (!ensureFreshInventory()) return Promise.resolve()
    if (outboundMaterials.length === 0) return Promise.resolve()
    setOutboundSubmitError(null)
    for (const item of outboundMaterials) {
      if (!item.quantity || item.quantity <= 0) {
        setOutboundSubmitError(`请填写“${item.name}”的有效出库数量。`)
        return Promise.resolve()
      }
      if (item.quantity > item.stock) {
        setOutboundSubmitError(`“${item.name}”的数量超过当前成功加载的正库存缓存，请调整后重试。`)
        return Promise.resolve()
      }
      if (item.usage === 'external' && (!item.receiver || item.receiver.trim() === '')) {
        setOutboundSubmitError(`请填写“${item.name}”的接收方。`)
        return Promise.resolve()
      }
    }
    const projects = [...new Set(outboundMaterials.map(item => item.project).filter(Boolean))]
    if (projects.length > 1) {
      setOutboundSubmitError('一张出库单只能关联一个项目，请统一后重试。')
      return Promise.resolve()
    }

    const submit = (async () => {
      setOutboundSubmitting(true)
      try {
        await outboundApi.create({
          type: 'direct',
          projectId: projects[0] || undefined,
          remark: outboundRemark,
          items: outboundMaterials.map(item => ({
            materialId: item.materialId,
            quantity: item.quantity,
            usage: item.usage,
            receiver: item.usage === 'external' ? item.receiver.trim() : null,
          })),
        } as any)
        toast.success('出库登记成功')
        setOutboundMaterials([])
        setOutboundRemark('')
        setOutboundModalOpen(false)
        refresh()
        void fetchStats()
      } catch (cause) {
        const error = cause as {
          response?: { status?: number; data?: { error?: { message?: string; code?: string } } }
          message?: string
        }
        if (error.response?.status === 422) {
          setOutboundSubmitError('可用批次库存不足，整单未出库。请调整数量后重试；系统不会静默换成不符合条件的批次。')
        } else if (error.response?.status === 403) {
          setOutboundSubmitError('当前账号没有出库写权限，整单未出库。')
        } else {
          setOutboundSubmitError(error.response?.data?.error?.message || error.message || '出库没有完成，整单未出库。请稍后重试。')
        }
      } finally {
        setOutboundSubmitting(false)
      }
    })()
    outboundSubmitPendingRef.current = submit
    void submit.finally(() => {
      if (outboundSubmitPendingRef.current === submit) outboundSubmitPendingRef.current = null
    })
    return submit
  }

  const confirmBatchScrap = async () => {
    if (!ensureFreshInventory()) return
    const selectedItems = data.filter(i => visibleSelectedIds.has(i.id))
    if (selectedItems.length === 0) {
      toast.error('请先选择要报废的物料')
      return
    }
    if (!scrapReason) {
      toast.error('请选择报废原因')
      return
    }
    const operator = JSON.parse(localStorage.getItem('user') || '{}')?.name || 'system'
    let successCount = 0
    let failCount = 0
    for (const item of selectedItems) {
      try {
        await scrapApi.create({
          materialId: item.materialId,
          quantity: item.totalQuantity || item.quantity || 1,
          reason: scrapReason,
          operator,
          remark: scrapRemark || undefined,
        })
        successCount++
      } catch (e: any) {
        failCount++
        console.error(`报废 ${item.materialName} 失败:`, e)
      }
    }
    if (failCount === 0) {
      toast.success(`成功报废 ${successCount} 项物料`)
    } else {
      toast.success(`成功 ${successCount} 项，失败 ${failCount} 项`)
    }
    setBatchScrapModalOpen(false)
    setScrapRemark('')
    clearSelection()
    refresh()
    fetchStats()
  }

  const confirmBatchOutboundOnly = async () => {
    setBatchOutboundModalOpen(false)
    clearSelection()
    refresh()
    fetchStats()
  }

  const viewDetail = (item: InventoryRow) => {
    setSelectedItem(item)
    setDetailModalOpen(true)
  }

  return {
    // 数据
    data,
    loading,
    error,
    page,
    pageSize,
    total,
    stats,
    statsError,
    computedStats,
    quickFilterCounts,
    projectList,

    // 筛选/排序/选择状态
    keyword,
    category,
    location,
    quickFilter,
    sortField,
    sortDirection,
    selectedIds: visibleSelectedIds,
    expandedGroups,

    // 弹窗状态
    outboundModalOpen,
    detailModalOpen,
    batchOutboundModalOpen,
    batchScrapModalOpen,
    selectedItem,
    materialSelectorOpen,
    materialList,
    materialKeyword,
    checkedMaterialIds,
    materialLoading,
    materialSelectorTab,
    selectedMaterials,
    bomList,
    selectedBomId,
    bomMaterials,
    bomLoading,
    outboundRemark,
    outboundMaterials,
    outboundSubmitting,
    outboundSubmitError,
    scrapReason,
    scrapRemark,
    filteredMaterialList,

    // Setters
    setKeyword,
    setCategory,
    setLocation,
    setQuickFilter,
    setSortField,
    setSortDirection,
    setSelectedIds,
    setExpandedGroups,
    setOutboundModalOpen,
    setDetailModalOpen,
    setBatchOutboundModalOpen,
    setBatchScrapModalOpen,
    setSelectedItem,
    setMaterialSelectorOpen,
    setMaterialList,
    setMaterialKeyword,
    setCheckedMaterialIds,
    setMaterialLoading,
    setMaterialSelectorTab,
    setSelectedMaterials,
    setSelectedBomId,
    setBomMaterials,
    setOutboundRemark,
    setOutboundMaterials,
    setScrapReason,
    setScrapRemark,
    setPage: changePage,
    setPageSize: changePageSize,

    // Actions
    refresh: retryInventory,
    retryStats: fetchStats,
    handleSort,
    toggleGroup,
    toggleSelectAll,
    toggleSelectOne,
    clearSelection,
    handleSearch,
    handleReset,
    handleQuickFilter,
    openEmptyOutboundModal,
    openOutboundModal,
    openBatchOutbound,
    openMaterialSelector,
    toggleCheckMaterial,
    toggleCheckAllMaterials,
    addCheckedToSelected,
    removeSelectedMaterial,
    confirmAddMaterials,
    removeOutboundItem,
    updateOutboundQuantity,
    updateOutboundProject,
    updateOutboundUser,
    updateOutboundUsage,
    updateOutboundReceiver,
    confirmOutbound,
    confirmBatchScrap,
    confirmBatchOutboundOnly,
    viewDetail,
    fetchBomList,
    loadBomDetail,
  }
}
