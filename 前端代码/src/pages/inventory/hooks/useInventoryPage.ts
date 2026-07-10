import { useState, useEffect, useMemo, useCallback } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { inventoryApi, outboundApi, scrapApi } from '@/api/inventory'
import { bomApi } from '@/api/master'
import { materialApi, projectApi, userApi } from '@/api/master'
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
  // ===== URL 参数同步 =====
  const { get, getNumber, setMultiple } = useUrlParams()

  // ===== 数据状态 =====
  const [stats, setStats] = useState<InventoryStats | null>(null)

  // ===== 筛选状态 =====
  const [keyword, setKeyword] = useState(get('keyword', ''))
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

  // ===== 项目和用户列表 =====
  const [projectList, setProjectList] = useState<Project[]>([])
  const [userList, setUserList] = useState<{ id: string; real_name: string }[]>([])

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
        keyword: keyword || undefined,
      })
      const list = (res?.list || []).map((item: any) => ({
        ...item,
        batch: item.batch || item.batchNo || '-',
        expiry: item.expiry || item.expiryDate || '-',
      })) as InventoryRow[]
      return { list, pagination: res?.pagination }
    },
    [keyword]
  )

  const {
    data,
    loading,
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
    deps: [keyword],
  })

  // 同步分页/筛选状态到 URL
  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
    })
  }, [page, pageSize, keyword, setMultiple])

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await inventoryApi.getStats()
      setStats(res || {})
    } catch (e) {
      console.error(e)
    }
  }, [])

  const fetchProjects = useCallback(async () => {
    try {
      const res: any = await projectApi.getList({ pageSize: 999 })
      setProjectList(res?.list || [])
    } catch (e) {
      console.error(e)
    }
  }, [])

  const fetchUsers = useCallback(async () => {
    try {
      const res: any = await userApi.getList({ pageSize: 999 })
      setUserList((res?.list || []).map((u: any) => ({
        id: u.id,
        real_name: u.realName || u.real_name || u.username,
      })))
    } catch (e) {
      console.error(e)
    }
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
    fetchProjects()
    fetchUsers()
  }, [fetchStats, fetchProjects, fetchUsers])

  const computedStats = useMemo(() => {
    if (!stats) {
      return {
        total: data.length,
        normal: data.filter(i => i.status === 'normal').length,
        low: data.filter(i => i.status === 'low-stock').length,
        warning: data.filter(i => i.status === 'warning').length,
        expired: data.filter(i => i.status === 'expired').length,
        outOfStock: data.filter(i => i.stock === 0).length,
      }
    }
    return {
      total: stats.totalStockCount ?? stats.totalMaterials ?? 0,
      normal: stats.normalCount ?? 0,
      low: stats.lowStockCount ?? 0,
      warning: stats.expiringCount ?? 0,
      expired: stats.expiredCount ?? 0,
      outOfStock: 0,
    }
  }, [stats, data])

  const quickFilterCounts = useMemo(() => {
    const getDaysLeft = (expiry?: string) => {
      if (!expiry || expiry === '-') return 999
      const today = new Date()
      const exp = new Date(expiry)
      return Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    }
    return {
      all: data.length,
      'low-stock': data.filter(i => i.status === 'low-stock').length,
      'expiring-soon': data.filter(i => i.status === 'warning' && getDaysLeft(i.expiry) <= 7).length,
      'expiring-month': data.filter(i => i.status === 'warning' && getDaysLeft(i.expiry) <= 30).length,
      expired: data.filter(i => i.status === 'expired').length,
      'out-of-stock': data.filter(i => i.stock === 0).length,
    }
  }, [data])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const toggleGroup = (name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === data.length && data.length > 0) {
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

  const handleSearch = () => {
    setPage(1)
  }

  const handleReset = () => {
    setKeyword('')
    setCategory('全部分类')
    setLocation('全部库位')
    setQuickFilter('all')
    setPage(1)
  }

  const handleQuickFilter = (filter: QuickFilterType) => {
    setQuickFilter(filter)
    setPage(1)
  }

  const openOutboundModal = (item: InventoryRow) => {
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
    const selectedItems = data.filter(i => selectedIds.has(i.id))
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
      const res: any = await materialApi.getList({ page: 1, pageSize: 100 })
      const list = (res?.list || []).map((item: any) => ({
        id: item.id,
        code: item.code || '-',
        name: item.name,
        spec: item.spec || '-',
        categoryName: item.categoryName || item.category || '-',
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
    setOutboundMaterials(prev => prev.map(m =>
      m.rowId === rowId ? { ...m, project: value } : m
    ))
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

  const confirmOutbound = async () => {
    if (outboundMaterials.length === 0) return
    for (const item of outboundMaterials) {
      if (!item.quantity || item.quantity <= 0) return
      if (item.quantity > item.stock) return
      if (!item.user) return
      if (item.usage === 'external' && (!item.receiver || item.receiver.trim() === '')) return
    }
    try {
      for (const item of outboundMaterials) {
        await outboundApi.create({
          type: 'direct',
          projectId: item.project || undefined,
          remark: outboundRemark,
          operator: item.user,
          items: [{
            materialId: item.materialId,
            quantity: item.quantity,
            usage: item.usage,
            receiver: item.usage === 'external' ? item.receiver : null,
          }],
        } as any)
      }
      setOutboundMaterials([])
      setOutboundRemark('')
      setOutboundModalOpen(false)
      refresh()
      fetchStats()
    } catch (e) {
      console.error(e)
    }
  }

  const confirmBatchScrap = async () => {
    const selectedItems = data.filter(i => selectedIds.has(i.id))
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
    page,
    pageSize,
    total,
    stats,
    computedStats,
    quickFilterCounts,
    projectList,
    userList,

    // 筛选/排序/选择状态
    keyword,
    category,
    location,
    quickFilter,
    sortField,
    sortDirection,
    selectedIds,
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
    setPage,
    setPageSize,

    // Actions
    refresh,
    handleSort,
    toggleGroup,
    toggleSelectAll,
    toggleSelectOne,
    clearSelection,
    handleSearch,
    handleReset,
    handleQuickFilter,
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
