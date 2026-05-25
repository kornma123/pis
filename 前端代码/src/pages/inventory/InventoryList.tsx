import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import {
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
  Trash2,
  Upload,
  ChevronRight,
  Plus,
  Check,
} from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import { inventoryApi, outboundApi, depletionApi, scrapApi } from '@/api/inventory'
import { bomApi } from '@/api/master'
import { materialApi, projectApi, userApi } from '@/api/master'
import type { InventoryItem, InventoryStats, Project } from '@/types'
import { toast } from 'sonner'

// 扩展 InventoryItem 以支持设计稿中的字段
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

export default function InventoryList() {
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

  // ===== 耗尽跟踪弹窗状态 =====
  const [editRemainModalOpen, setEditRemainModalOpen] = useState(false)
  const [confirmDepleteModalOpen, setConfirmDepleteModalOpen] = useState(false)
  const [selectedDepletionItem, setSelectedDepletionItem] = useState<any | null>(null)
  const [editRemainValue, setEditRemainValue] = useState('')
  const [editRemainReason, setEditRemainReason] = useState('')
  const [depleteType, setDepleteType] = useState<'normal' | 'expired'>('normal')
  const [depleteRemainValue, setDepleteRemainValue] = useState('0')
  const [expiredReason, setExpiredReason] = useState('')
  const [expiredRemark, setExpiredRemark] = useState('')

  // ===== Tab 切换 =====
  const [activeTab, setActiveTab] = useState<'in-stock' | 'in-use' | 'depleted'>('in-stock')

  // ===== 分组展开状态 =====
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // ===== 耗尽跟踪数据 =====
  const [depletionTracking, setDepletionTracking] = useState<any[]>([])
  // ===== 已耗尽记录 =====
  const [depletedRecords, setDepletedRecords] = useState<any[]>([])

  // ===== 项目和用户列表（从API获取，禁止硬编码）=====
  const [projectList, setProjectList] = useState<Project[]>([])
  const [userList, setUserList] = useState<{ id: string; real_name: string }[]>([])

  // ===== 物料选择弹窗状态 =====
  const [materialSelectorOpen, setMaterialSelectorOpen] = useState(false)
  const [materialList, setMaterialList] = useState<Array<{
    id: string
    code: string
    name: string
    spec: string
    categoryName: string
    unit: string
    stock: number
  }>>([])
  const [materialKeyword, setMaterialKeyword] = useState('')
  const [checkedMaterialIds, setCheckedMaterialIds] = useState<Set<string>>(new Set())
  const [materialLoading, setMaterialLoading] = useState(false)
  const [materialSelectorTab, setMaterialSelectorTab] = useState<'list' | 'bom'>('list')
  const [selectedMaterials, setSelectedMaterials] = useState<Array<{
    id: string
    code: string
    name: string
    spec: string
    unit: string
    stock: number
  }>>([])

  // ===== BOM 选择状态 =====
  const [bomList, setBomList] = useState<Array<{ id: string; code: string; name: string; type: string }>>([])
  const [selectedBomId, setSelectedBomId] = useState('')
  const [bomMaterials, setBomMaterials] = useState<Array<{
    id: string
    code: string
    name: string
    spec: string
    unit: string
    stock: number
    usagePerSample: number
  }>>([])
  const [bomLoading, setBomLoading] = useState(false)

  // ===== 出库登记弹窗状态 =====
  const [outboundRemark, setOutboundRemark] = useState('')
  const [outboundMaterials, setOutboundMaterials] = useState<Array<{
    rowId: number
    materialId: string
    name: string
    spec: string
    batch?: string
    stock: number
    quantity: number
    unit: string
    project: string
    user: string
    usage: 'self' | 'external'
    receiver: string
  }>>([])

  // ===== 分页数据 =====
  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

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
    fetchFn: async ({ page, pageSize }) => {
      const res: any = await inventoryApi.getList({
        page,
        pageSize,
        keyword: keyword || undefined,
      })
      const list = (res?.list || []).map((item: any) => ({
        ...item,
        batch: item.batch || item.batchNo || '-',
        expiry: item.expiry || item.expiryDate || '-',
      })) as InventoryRow[]
      return { list, pagination: res?.pagination }
    },
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

  const fetchDepletionTracking = useCallback(async () => {
    try {
      const res: any = await depletionApi.getTracking({ status: 'in-use' })
      setDepletionTracking(res?.list || [])
    } catch (e) {
      console.error(e)
    }
  }, [])

  const fetchDepletedRecords = useCallback(async () => {
    try {
      const res: any = await depletionApi.getDepletion()
      setDepletedRecords(res?.list || [])
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
    fetchDepletionTracking()
    fetchDepletedRecords()
  }, [fetchStats, fetchProjects, fetchUsers, fetchDepletionTracking, fetchDepletedRecords])

  // ===== 计算统计 =====
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
    // 后端返回直接可用的计数
    return {
      total: stats.totalStockCount ?? stats.totalMaterials ?? 0,
      normal: stats.normalCount ?? 0,
      low: stats.lowStockCount ?? 0,
      warning: stats.expiringCount ?? 0,
      expired: stats.expiredCount ?? 0,
      outOfStock: 0,
    }
  }, [stats, data])

  // ===== 快速筛选计数 =====
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

  // ===== 排序后的数据 =====
  const sortedData = useMemo(() => {
    const list = [...data]
    if (sortField) {
      list.sort((a, b) => {
        let aVal: any, bVal: any
        if (sortField === 'quantity') {
          aVal = a.stock || 0
          bVal = b.stock || 0
        } else if (sortField === 'expiry') {
          aVal = a.expiry || '9999-12-31'
          bVal = b.expiry || '9999-12-31'
        }
        if (sortDirection === 'asc') {
          return aVal > bVal ? 1 : -1
        }
        return aVal < bVal ? 1 : -1
      })
    }
    return list
  }, [data, sortField, sortDirection])

  // ===== 按物料名称分组 =====
  const groupedData = useMemo(() => {
    const groups: Record<string, InventoryRow[]> = {}
    sortedData.forEach(item => {
      if (!groups[item.name]) groups[item.name] = []
      groups[item.name].push(item)
    })
    return groups
  }, [sortedData])

  const toggleGroup = (name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // ===== 处理排序 =====
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  // ===== 选择处理 =====
  const toggleSelectAll = () => {
    if (selectedIds.size === sortedData.length && sortedData.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sortedData.map(r => r.id)))
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

  // ===== 筛选处理 =====
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

  // ===== 状态判断 =====
  const getStatusInfo = (item: InventoryRow) => {
    const today = new Date()
    const expiry = item.expiry && item.expiry !== '-' ? new Date(item.expiry) : null
    const daysLeft = expiry ? Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : 999

    if (item.stock === 0) {
      return { label: '已缺货', badgeClass: 'bg-red-50 text-red-600' }
    }
    if (expiry && daysLeft < 0) {
      return { label: '已过期', badgeClass: 'bg-red-50 text-red-600' }
    }
    if (item.stock <= item.minStock) {
      return { label: '库存不足', badgeClass: 'bg-orange-50 text-orange-600' }
    }
    if (expiry && daysLeft <= 30) {
      return { label: '即将过期', badgeClass: 'bg-yellow-50 text-yellow-700' }
    }
    return { label: '正常', badgeClass: 'bg-green-50 text-green-600' }
  }

  const getStockLevelIndicator = (item: InventoryRow) => {
    if (item.stock === 0) return <span className="ml-2 text-[11px] text-red-500">缺货</span>
    if (item.stock <= item.minStock) return <span className="ml-2 text-[11px] text-orange-500">偏低</span>
    if (item.stock < item.minStock * 2) return <span className="ml-2 text-[11px] text-green-500">正常</span>
    return <span className="ml-2 text-[11px] text-green-500">充足</span>
  }

  const getExpiryTag = (item: InventoryRow) => {
    const today = new Date()
    const expiry = item.expiry && item.expiry !== '-' ? new Date(item.expiry) : null
    if (!expiry) return null
    const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    if (daysLeft < 0) return <span className="ml-2 text-[11px] text-red-500">已过期</span>
    if (daysLeft <= 7) return <span className="ml-2 text-[11px] text-red-500">剩{daysLeft}天</span>
    if (daysLeft <= 30) return <span className="ml-2 text-[11px] text-yellow-600">剩{daysLeft}天</span>
    return null
  }

  // ===== 出库登记弹窗操作 =====
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
    // 合并已选物料和当前勾选的物料
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

  const [scrapReason, setScrapReason] = useState('expired')
  const [scrapRemark, setScrapRemark] = useState('')

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


  // ===== 渲染 =====
  return (
    <div className="space-y-6">
      {/* ===== 页面头部 ===== */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight">库存列表</h1>
          <p className="text-sm text-gray-500 mt-1">管理实验室耗材库存，实时监控库存状态和有效期</p>
        </div>
        <button
          onClick={() => setOutboundModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-all duration-150 ease text-sm font-medium shadow-sm"
        >
          <Upload className="w-4 h-4" />
          出库登记
        </button>
      </div>

      {/* ===== Tab 切换 ===== */}
      <div className="flex items-center gap-0 border-b border-gray-200">
        {[
          { key: 'in-stock', label: '在库' },
          { key: 'in-use', label: '使用中' },
          { key: 'depleted', label: '已耗尽' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as any)}
            className={`px-5 py-3 text-sm font-medium transition-all duration-150 ease relative ${
              activeTab === tab.key
                ? 'text-blue-500'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
            )}
          </button>
        ))}
      </div>

      {activeTab === 'in-stock' && (
      <>
      {/* ===== 统计卡片 ===== */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { key: 'all', label: '总库存数量', value: computedStats.total, color: 'border-l-4 border-l-[#3b82f6]' },
          { key: 'normal', label: '正常', value: computedStats.normal, color: 'border-l-4 border-l-green-500' },
          { key: 'low-stock', label: '库存不足', value: computedStats.low, color: 'border-l-4 border-l-orange-500' },
          { key: 'warning', label: '即将过期', value: computedStats.warning, color: 'border-l-4 border-l-yellow-500' },
          { key: 'expired', label: '已过期', value: computedStats.expired, color: 'border-l-4 border-l-red-500' },
        ].map(stat => (
          <button
            key={stat.key}
            onClick={() => handleQuickFilter(stat.key as QuickFilterType)}
            className={`bg-white rounded-lg shadow-sm p-5 text-left transition-all duration-150 ease hover:shadow-md ${stat.color}`}
          >
            <div className="text-[28px] font-semibold text-gray-900">{stat.value}</div>
            <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
          </button>
        ))}
      </div>

      {/* ===== 快速筛选 ===== */}
      <div className="flex items-center gap-2 flex-wrap">
        {[
          { key: 'all', label: '全部', count: quickFilterCounts.all },
          { key: 'low-stock', label: '库存不足', count: quickFilterCounts['low-stock'] },
          { key: 'expiring-soon', label: '本周过期', count: quickFilterCounts['expiring-soon'] },
          { key: 'expiring-month', label: '本月过期', count: quickFilterCounts['expiring-month'] },
          { key: 'expired', label: '已过期', count: quickFilterCounts.expired },
          { key: 'out-of-stock', label: '缺货', count: quickFilterCounts['out-of-stock'] },
        ].map(filter => (
          <button
            key={filter.key}
            onClick={() => handleQuickFilter(filter.key as QuickFilterType)}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-150 ease ${
              quickFilter === filter.key
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {filter.label}
            <span className={`${quickFilter === filter.key ? 'bg-white/20' : 'bg-gray-100'} px-1.5 py-0.5 rounded text-[11px]`}>
              {filter.count}
            </span>
          </button>
        ))}
      </div>
      </>
      )}

      {activeTab === 'in-stock' && (
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {/* 卡片头部 - 筛选栏 */}
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between gap-4 flex-wrap">
          <span className="text-base font-semibold text-gray-900">库存明细</span>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索耗材名称/批号/供应商..."
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="w-[260px] pl-10 pr-4 h-10 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
              />
            </div>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease bg-white"
            >
              <option>全部分类</option>
              <option>试剂</option>
              <option>耗材</option>
              <option>设备</option>
            </select>
            <select
              value={location}
              onChange={e => setLocation(e.target.value)}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease bg-white"
            >
              <option>全部库位</option>
              <option>A区-试剂冷藏</option>
              <option>B区-常温耗材</option>
              <option>C区-设备配件</option>
            </select>
            <button
              onClick={handleSearch}
              className="h-10 px-4 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-all duration-150 ease font-medium"
            >
              查询
            </button>
            <button
              onClick={handleReset}
              className="h-10 px-4 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-all duration-150 ease font-medium"
            >
              重置
            </button>
          </div>
        </div>

        {/* 批量操作栏 */}
        {selectedIds.size > 0 && (
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
            <span className="text-sm text-gray-700">
              已选择 <strong className="text-blue-500">{selectedIds.size}</strong> 项
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={openBatchOutbound}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white hover:shadow-sm rounded-md transition-all duration-150 ease"
              >
                <Upload className="w-3.5 h-3.5" />
                批量出库
              </button>
              <button
                onClick={() => setBatchScrapModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white hover:shadow-sm rounded-md transition-all duration-150 ease"
              >
                <Trash2 className="w-3.5 h-3.5" />
                批量报废
              </button>
              <button
                onClick={clearSelection}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white hover:shadow-sm rounded-md transition-all duration-150 ease"
              >
                <X className="w-3.5 h-3.5" />
                取消选择
              </button>
            </div>
          </div>
        )}

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === sortedData.length && sortedData.length > 0}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">耗材名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">批号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">库位</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  <button onClick={() => handleSort('quantity')} className="inline-flex items-center gap-1 hover:text-gray-700 transition-colors">
                    库存数量
                    {sortField === 'quantity' ? (
                      sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                    ) : (
                      <ArrowUpDown className="w-3 h-3 opacity-50" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  <button onClick={() => handleSort('expiry')} className="inline-flex items-center gap-1 hover:text-gray-700 transition-colors">
                    有效期
                    {sortField === 'expiry' ? (
                      sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                    ) : (
                      <ArrowUpDown className="w-3 h-3 opacity-50" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">状态</th>
                <th className="w-[140px] px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#3b82f6] rounded-full animate-spin" />
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : sortedData.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="flex flex-col items-center justify-center py-16">
                      <svg className="w-16 h-16 text-gray-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                      </svg>
                      <div className="text-base font-medium text-gray-900 mb-1">暂无库存数据</div>
                      <div className="text-sm text-gray-500 mb-4">当前筛选条件下没有找到库存记录，请尝试调整筛选条件或添加入库记录</div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => { window.location.href = '/inbound' }}
                          className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease"
                        >
                          添加入库
                        </button>
                        <button
                          onClick={handleReset}
                          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
                        >
                          清除筛选
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                Object.entries(groupedData).map(([groupName, batches]) => {
                  const isExpanded = expandedGroups.has(groupName)
                  const first = batches[0]
                  const totalStock = batches.reduce((sum, b) => sum + (b.stock || 0), 0)
                  const minStock = first?.minStock || 0
                  return (
                    <Fragment key={groupName}>
                      {/* 分组汇总行 */}
                      <tr
                        className="hover:bg-gray-50 transition-colors duration-150 cursor-pointer bg-gray-50/50"
                        onClick={() => toggleGroup(groupName)}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                            onChange={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                              <ChevronRight className="w-3 h-3" strokeWidth={3} />
                            </span>
                            <div>
                              <div className="font-semibold text-gray-900">{first?.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{first?.spec || ''}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                            {batches.length} 批次
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-sm">{first?.locationName || first?.locationId || '-'}</td>
                        <td className="px-4 py-3">
                          <span className="font-semibold text-gray-900">{totalStock}</span>
                          <span className="text-xs text-green-500 ml-1">{totalStock >= minStock ? '充足' : '不足'}</span>
                        </td>
                        <td className="px-4 py-3"></td>
                        <td className="px-4 py-3"></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <button onClick={(e) => { e.stopPropagation(); viewDetail(first!) }} className="text-sm text-gray-600 hover:text-gray-900 transition-colors">详情</button>
                            <button onClick={(e) => { e.stopPropagation(); openOutboundModal(first!) }} className="text-sm text-blue-500 hover:text-blue-600 transition-colors">出库</button>
                          </div>
                        </td>
                      </tr>
                      {/* 批次明细行 */}
                      {isExpanded && batches.map(row => {
                        const statusInfo = getStatusInfo(row)
                        const isSelected = selectedIds.has(row.id)
                        return (
                          <tr
                            key={row.id}
                            className="hover:bg-gray-50 transition-colors duration-150"
                          >
                            <td className="px-4 py-3 pl-8">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelectOne(row.id)}
                                className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                              />
                            </td>
                            <td className="px-4 py-3 pl-12">
                              <span className="text-gray-400 text-xs mr-1">└</span>
                              <span className="font-medium text-gray-900">{row.name}</span>
                            </td>
                            <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.batch || '-'}</td>
                            <td className="px-4 py-3 text-gray-600 text-sm">{row.locationName || row.locationId || '-'}</td>
                            <td className="px-4 py-3">
                              <span className="font-medium text-gray-900">{row.stock}</span>
                              {getStockLevelIndicator(row)}
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-gray-600">{row.expiry || '-'}</span>
                              {getExpiryTag(row)}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusInfo.badgeClass}`}>
                                {statusInfo.label}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <button onClick={() => viewDetail(row)} className="text-sm text-gray-600 hover:text-gray-900 transition-colors">详情</button>
                                <button onClick={() => openOutboundModal(row)} className="text-sm text-blue-500 hover:text-blue-600 transition-colors">出库</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="px-5 py-4 border-t border-gray-200 flex items-center justify-between">
          <span className="text-sm text-gray-500">共 {total} 条记录</span>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChangePage={setPage}
            onChangePageSize={setPageSize}
          />
        </div>
      </div>
      )}

      {/* ===== 使用中 Tab ===== */}
      {activeTab === 'in-use' && (
        <div className="space-y-4">
          {depletionTracking.map(dep => (
            <div key={dep.id} className="bg-white rounded-lg shadow-sm p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-base font-semibold text-gray-900">{dep.materialName}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{dep.spec} · 批次: {dep.batch}</div>
                </div>
                <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                  dep.status === 'warning' ? 'bg-orange-50 text-orange-600' : 'bg-green-50 text-green-600'
                }`}>
                  {dep.status === 'warning' ? '即将耗尽' : '使用中'}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-4 mb-3">
                <div>
                  <div className="text-xs text-gray-500">总用量</div>
                  <div className="text-sm font-medium text-gray-900">{dep.totalQty} {dep.unit}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">剩余量</div>
                  <div className="text-sm font-medium text-gray-900">{dep.remaining} {dep.unit}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">已用天数</div>
                  <div className="text-sm font-medium text-gray-900">{dep.daysUsed} 天</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">预计剩余</div>
                  <div className="text-sm font-medium text-gray-900">{dep.expectedDays - dep.daysUsed} 天</div>
                </div>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${
                    dep.progress > 90 ? 'bg-orange-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${dep.progress}%` }}
                />
              </div>
              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={() => {
                    setSelectedDepletionItem(dep)
                    setEditRemainValue(String(dep.remaining))
                    setEditRemainReason('')
                    setEditRemainModalOpen(true)
                  }}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
                >
                  修改剩余量
                </button>
                <button
                  onClick={() => {
                    setSelectedDepletionItem(dep)
                    setDepleteType('normal')
                    setDepleteRemainValue('0')
                    setExpiredReason('')
                    setExpiredRemark('')
                    setConfirmDepleteModalOpen(true)
                  }}
                  className="px-3 py-1.5 text-sm text-blue-500 hover:text-blue-600 transition-colors"
                >
                  确认耗尽
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ===== 已耗尽 Tab ===== */}
      {activeTab === 'depleted' && (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200">
            <span className="text-base font-semibold text-gray-900">已耗尽记录</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">物料名称</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">批次号</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">耗尽类型</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">总用量</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">实际剩余</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">使用周期</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">实际天数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {depletedRecords.map(rec => (
                  <tr key={rec.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{rec.materialName}</div>
                      <div className="text-xs text-gray-500">{rec.spec}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600 text-xs">{rec.batch}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                        rec.depleteType === '正常用完' ? 'bg-green-50 text-green-600' : 'bg-orange-50 text-orange-600'
                      }`}>
                        {rec.depleteType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-900">{rec.totalQty} {rec.unit}</td>
                    <td className="px-4 py-3 text-gray-900">{rec.remainQty} {rec.unit}</td>
                    <td className="px-4 py-3 text-gray-600">{rec.startDate} ~ {rec.endDate}</td>
                    <td className="px-4 py-3 text-gray-900">{rec.actualDays} 天</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== 出库登记弹窗 ===== */}
      {/* ===== 出库登记弹窗 ===== */}
      {outboundModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/[0.6]">
          <div className="absolute inset-0" onClick={() => setOutboundModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-lg w-full max-w-[1100px] max-h-[90vh] flex flex-col overflow-hidden">
            {/* 弹窗头部 */}
            <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 tracking-normal">出库登记</h3>
              <button
                onClick={() => setOutboundModalOpen(false)}
                className="w-9 h-9 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-all duration-150 ease"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 弹窗内容 */}
            <div className="flex-1 overflow-auto p-6">
              <div className="mb-5">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-base font-semibold text-gray-900">出库明细</h4>
                  <button
                    onClick={openMaterialSelector}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    添加物料
                  </button>
                </div>

                {outboundMaterials.length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    <svg className="w-12 h-12 mx-auto mb-3 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                    </svg>
                    <div className="text-sm">请选择物料或点击"添加物料"按钮</div>
                  </div>
                ) : (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full text-[13px] border-collapse">
                      <thead>
                        <tr>
                          <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">物料名称</th>
                          <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">关联项目</th>
                          <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">批次号</th>
                          <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200">库存</th>
                          <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200 w-[90px]">出库数量</th>
                          <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200 w-[120px]">领用人</th>
                          <th className="bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700 tracking-wide border-b border-gray-200 w-[50px]">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#f3f4f6]">
                        {outboundMaterials.map(m => (
                          <tr key={m.rowId} className="hover:bg-gray-50 transition-colors duration-150 ease">
                            <td className="px-4 py-3">
                              <div className="font-medium text-gray-900">{m.name}</div>
                              <div className="text-xs text-gray-500">{m.spec}</div>
                            </td>
                            <td className="px-4 py-3">
                              <select
                                value={m.project}
                                onChange={e => updateOutboundProject(m.rowId, e.target.value)}
                                className="h-8 px-3 border border-gray-300 rounded-md text-xs bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                              >
                                <option value="">公共成本</option>
                                {projectList.map(p => (
                                  <option key={p.id} value={p.name}>{p.name}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-4 py-3 text-gray-600">{m.batch || '-'}</td>
                            <td className="px-4 py-3 text-gray-900">{m.stock}</td>
                            <td className="px-4 py-3">
                              <input
                                type="number"
                                value={m.quantity}
                                min={1}
                                max={m.stock}
                                onChange={e => updateOutboundQuantity(m.rowId, e.target.value)}
                                className="w-[70px] h-8 px-3 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                              />
                            </td>
                            <td className="px-4 py-3">
                              <select
                                value={m.user}
                                onChange={e => updateOutboundUser(m.rowId, e.target.value)}
                                className="h-8 px-3 border border-gray-300 rounded-md text-xs bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                              >
                                <option value="">选择领用人</option>
                                {userList.map(u => (
                                  <option key={u.id} value={u.real_name}>{u.real_name}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-4 py-3">
                              <select
                                value={m.usage}
                                onChange={e => updateOutboundUsage(m.rowId, e.target.value as 'self' | 'external')}
                                className="h-8 px-3 border border-gray-300 rounded-md text-xs bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                              >
                                <option value="self">自用</option>
                                <option value="external">外给</option>
                              </select>
                            </td>
                            <td className="px-4 py-3">
                              <input
                                type="text"
                                value={m.receiver}
                                onChange={e => updateOutboundReceiver(m.rowId, e.target.value)}
                                placeholder={m.usage === 'external' ? '接收方名称' : '-'}
                                disabled={m.usage === 'self'}
                                className="w-[120px] h-8 px-3 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100 disabled:text-gray-400 transition-all duration-150 ease"
                              />
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button
                                onClick={() => removeOutboundItem(m.rowId)}
                                className="text-red-500 hover:text-red-600 transition-colors duration-150 ease"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="mt-5">
                <label className="block text-[13px] font-medium text-gray-700 mb-1.5">备注</label>
                <textarea
                  value={outboundRemark}
                  onChange={e => setOutboundRemark(e.target.value)}
                  rows={2}
                  placeholder="请输入出库备注信息（可选）"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease resize-none"
                />
              </div>
            </div>

            {/* 弹窗底部 */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3 bg-gray-50">
              <button
                onClick={() => setOutboundModalOpen(false)}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease shadow-sm focus:outline-none focus:ring-2 focus:ring-gray-400/30"
              >
                取消
              </button>
              <button
                onClick={confirmOutbound}
                disabled={outboundMaterials.length === 0}
                className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                确认出库
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 物料选择弹窗 ===== */}
      {materialSelectorOpen && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-16">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMaterialSelectorOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden">
            {/* 弹窗头部 */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">添加物料</h3>
              <button
                onClick={() => setMaterialSelectorOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none"
              >
                &times;
              </button>
            </div>

            {/* 弹窗内容 - 左右布局 */}
            <div className="flex-1 overflow-auto p-0">
              <div className="flex h-full" style={{ minHeight: '500px' }}>
                {/* 左侧 */}
                <div className="flex-1 p-6 border-r border-gray-200">
                  {/* Tab 切换 */}
                  <div className="flex items-center gap-0 border-b border-gray-200 mb-4">
                    <button
                      onClick={() => setMaterialSelectorTab('list')}
                      className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-150 ease relative ${
                        materialSelectorTab === 'list' ? 'text-blue-500' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="8" y1="6" x2="21" y2="6"/>
                        <line x1="8" y1="12" x2="21" y2="12"/>
                        <line x1="8" y1="18" x2="21" y2="18"/>
                        <line x1="3" y1="6" x2="3.01" y2="6"/>
                        <line x1="3" y1="12" x2="3.01" y2="12"/>
                        <line x1="3" y1="18" x2="3.01" y2="18"/>
                      </svg>
                      物料列表
                    </button>
                    <button
                      onClick={() => {
                        setMaterialSelectorTab('bom')
                        fetchBomList()
                      }}
                      className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-150 ease relative ${
                        materialSelectorTab === 'bom' ? 'text-blue-500' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      </svg>
                      按检测项目添加
                    </button>
                  </div>

                  {materialSelectorTab === 'list' && (
                    <>
                      {/* 搜索 */}
                      <div className="relative mb-3">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                          type="text"
                          placeholder="搜索物料名称或编号..."
                          value={materialKeyword}
                          onChange={e => setMaterialKeyword(e.target.value)}
                          className="w-full pl-10 pr-4 h-9 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                        />
                      </div>
                      {/* 表格 */}
                      <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <table className="w-full text-[13px]">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="w-10 px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={filteredMaterialList.length > 0 && checkedMaterialIds.size === filteredMaterialList.length}
                                  onChange={toggleCheckAllMaterials}
                                  className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                                />
                              </th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">规格</th>
                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库存</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {materialLoading ? (
                              <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400 text-sm">加载中...</td></tr>
                            ) : filteredMaterialList.length === 0 ? (
                              <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400 text-sm">暂无数据</td></tr>
                            ) : (
                              filteredMaterialList.map(m => (
                                <tr key={m.id} className={`hover:bg-gray-50 transition-colors cursor-pointer ${checkedMaterialIds.has(m.id) ? 'bg-blue-50' : ''}`} onClick={() => toggleCheckMaterial(m.id)}>
                                  <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                                    <input type="checkbox" checked={checkedMaterialIds.has(m.id)} onChange={() => toggleCheckMaterial(m.id)} className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500" />
                                  </td>
                                  <td className="px-3 py-2 font-medium text-gray-900">{m.name}</td>
                                  <td className="px-3 py-2 text-gray-600">{m.spec}</td>
                                  <td className="px-3 py-2 text-gray-900">{m.stock} {m.unit}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                      {/* 底部 */}
                      <div className="mt-3 flex items-center justify-between">
                        <div className="text-sm text-gray-500">已勾选 <strong className="text-blue-500">{checkedMaterialIds.size}</strong> 项</div>
                        <button
                          onClick={addCheckedToSelected}
                          disabled={checkedMaterialIds.size === 0}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          添加到已选
                        </button>
                      </div>
                    </>
                  )}

                  {materialSelectorTab === 'bom' && (
                    <>
                      <div className="mb-4">
                        <select
                          value={selectedBomId}
                          onChange={e => {
                            setSelectedBomId(e.target.value)
                            loadBomDetail(e.target.value)
                          }}
                          className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:border-blue-500"
                        >
                          <option value="">请选择检测项目/BOM</option>
                          {bomList.map(b => (
                            <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                          ))}
                        </select>
                      </div>
                      {bomLoading ? (
                        <div className="text-center py-12 text-gray-400 text-sm">加载中...</div>
                      ) : selectedBomId && bomMaterials.length === 0 ? (
                        <div className="text-center py-12 text-gray-400 text-sm">该BOM暂无物料</div>
                      ) : selectedBomId ? (
                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                          <table className="w-full text-[13px]">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">规格</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单样本用量</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库存</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {bomMaterials.map(m => (
                                <tr
                                  key={m.id}
                                  className={`hover:bg-gray-50 transition-colors cursor-pointer ${checkedMaterialIds.has(m.id) ? 'bg-blue-50' : ''}`}
                                  onClick={() => toggleCheckMaterial(m.id)}
                                >
                                  <td className="px-3 py-2">
                                    <div className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={checkedMaterialIds.has(m.id)}
                                        onChange={() => toggleCheckMaterial(m.id)}
                                        className="w-4 h-4 rounded border-gray-300 text-blue-500"
                                      />
                                      <span className="font-medium text-gray-900">{m.name}</span>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 text-gray-500">{m.spec}</td>
                                  <td className="px-3 py-2 text-gray-500">{m.usagePerSample}{m.unit}</td>
                                  <td className="px-3 py-2 text-gray-500">{m.stock}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="text-center py-12 text-gray-400">
                          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                          </svg>
                          <div className="text-sm">请先选择检测项目</div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* 右侧 - 已选物料 */}
                <div className="w-[300px] p-6 bg-gray-50 flex flex-col">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-semibold text-gray-900">已选物料</span>
                    <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded-full">{selectedMaterials.length} 项</span>
                  </div>
                  <div className="flex-1 overflow-auto space-y-2 min-h-0">
                    {selectedMaterials.length === 0 ? (
                      <div className="text-center py-8 text-gray-400">
                        <svg className="w-10 h-10 mx-auto mb-2 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                        </svg>
                        <p className="text-xs">从左侧勾选物料添加</p>
                        <p className="text-[11px] text-gray-400 mt-1">支持同时使用"物料列表"和"BOM"两种方式</p>
                      </div>
                    ) : (
                      selectedMaterials.map(m => (
                        <div key={m.id} className="bg-white rounded-lg p-3 border border-gray-200 shadow-sm">
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-gray-900 truncate">{m.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{m.spec}</div>
                            </div>
                            <button onClick={() => removeSelectedMaterial(m.id)} className="text-gray-400 hover:text-red-500 transition-colors ml-2 flex-shrink-0">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {selectedMaterials.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-200 space-y-1">
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <span>物料种类</span>
                        <span className="font-medium text-gray-900">{selectedMaterials.length}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 弹窗底部 */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              <button
                onClick={() => setMaterialSelectorOpen(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
              >
                取消
              </button>
              <button
                onClick={confirmAddMaterials}
                disabled={selectedMaterials.length === 0 && checkedMaterialIds.size === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease shadow-sm"
              >
                <Check className="w-3.5 h-3.5" />
                确认添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 库存详情弹窗 ===== */}
      {detailModalOpen && selectedItem && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDetailModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">库存详情</h3>
              <button
                onClick={() => setDetailModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none"
              >
                &times;
              </button>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-500">物料名称</label>
                  <div className="text-sm font-medium text-gray-900 mt-0.5">{selectedItem.name}</div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">物料编码</label>
                  <div className="text-sm font-mono text-gray-900 mt-0.5">{selectedItem.code}</div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">规格</label>
                  <div className="text-sm text-gray-900 mt-0.5">{selectedItem.spec || '-'}</div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">单位</label>
                  <div className="text-sm text-gray-900 mt-0.5">{selectedItem.unit}</div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">库存数量</label>
                  <div className="text-sm font-medium text-gray-900 mt-0.5">{selectedItem.stock}</div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">安全库存</label>
                  <div className="text-sm text-gray-900 mt-0.5">{selectedItem.minStock}</div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">库位</label>
                  <div className="text-sm text-gray-900 mt-0.5">{selectedItem.locationName || '-'}</div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">供应商</label>
                  <div className="text-sm text-gray-900 mt-0.5">{selectedItem.supplierName || '-'}</div>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              <button
                onClick={() => setDetailModalOpen(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
              >
                关闭
              </button>
              <button
                onClick={() => { setDetailModalOpen(false); openOutboundModal(selectedItem) }}
                className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm"
              >
                出库
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 批量出库弹窗 ===== */}
      {batchOutboundModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="absolute inset-0 bg-black/40" onClick={() => setBatchOutboundModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">批量出库</h3>
              <button
                onClick={() => setBatchOutboundModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none"
              >
                &times;
              </button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-600">确认对选中的 <strong>{selectedIds.size}</strong> 项物料进行批量出库操作？</p>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              <button
                onClick={() => setBatchOutboundModalOpen(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
              >
                取消
              </button>
              <button
                onClick={confirmBatchOutboundOnly}
                className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm"
              >
                确认出库
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 批量报废弹窗 ===== */}
      {batchScrapModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="absolute inset-0 bg-black/40" onClick={() => setBatchScrapModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden max-h-[80vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">批量报废</h3>
              <button
                onClick={() => setBatchScrapModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none"
              >
                &times;
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="mb-4">
                <div className="text-sm font-medium text-gray-700 mb-2">选中物料 ({selectedIds.size})</div>
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">编码</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">数量</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {data.filter(i => selectedIds.has(i.id)).map(item => (
                        <tr key={item.id}>
                          <td className="px-3 py-2 text-gray-900">{item.materialName}</td>
                          <td className="px-3 py-2 text-gray-500 font-mono text-xs">{item.materialCode}</td>
                          <td className="px-3 py-2 text-right text-gray-700">{item.totalQuantity} {item.unit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  报废原因 <span className="text-red-500">*</span>
                </label>
                <select
                  value={scrapReason}
                  onChange={e => setScrapReason(e.target.value)}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:border-blue-500"
                >
                  <option value="expired">过期</option>
                  <option value="damaged">损坏</option>
                  <option value="spoiled">变质</option>
                  <option value="other">其他</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">备注（可选）</label>
                <textarea
                  value={scrapRemark}
                  onChange={e => setScrapRemark(e.target.value)}
                  rows={2}
                  placeholder="请输入备注信息"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3 flex-shrink-0">
              <button
                onClick={() => setBatchScrapModalOpen(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
              >
                取消
              </button>
              <button
                onClick={confirmBatchScrap}
                className="px-4 py-2 bg-red-500 text-white rounded-md text-sm font-medium hover:bg-red-600 transition-all duration-150 ease shadow-sm"
              >
                确认报废
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 修改剩余量弹窗 ===== */}
      {editRemainModalOpen && selectedDepletionItem && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="absolute inset-0 bg-black/40" onClick={() => setEditRemainModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">修改预计剩余量</h3>
              <button onClick={() => setEditRemainModalOpen(false)} className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none">&times;</button>
            </div>
            <div className="p-6 space-y-5">
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-[13px] text-gray-500 mb-1">当前物料</div>
                <div className="font-semibold text-gray-900">{selectedDepletionItem.materialName}（{selectedDepletionItem.batch}）</div>
                <div className="text-xs text-gray-500 mt-1">{selectedDepletionItem.totalQty}{selectedDepletionItem.unit} · 已用 {selectedDepletionItem.totalQty - selectedDepletionItem.remaining}{selectedDepletionItem.unit} · 当前预计剩余约 {selectedDepletionItem.remaining}{selectedDepletionItem.unit}</div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">调整后预计剩余 <span className="text-red-500">*</span></label>
                <div className="flex gap-2">
                  <input type="number" value={editRemainValue} onChange={e => setEditRemainValue(e.target.value)} className="flex-1 h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease" />
                  <select className="w-24 h-10 px-2 border border-gray-300 rounded-md text-sm bg-white">
                    <option>ml</option><option>μl</option><option>g</option><option>mg</option>
                  </select>
                </div>
                <div className="text-xs text-gray-500 mt-1">修改后将重新计算消耗进度，但不会标记为耗尽</div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">修改原因（可选）</label>
                <textarea value={editRemainReason} onChange={e => setEditRemainReason(e.target.value)} rows={2} placeholder="如：复染次数增加、稀释比例调整等" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease resize-none" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              <button onClick={() => setEditRemainModalOpen(false)} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease">取消</button>
              <button onClick={() => { toast.success('预计剩余量已更新'); setEditRemainModalOpen(false); }} className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm">保存修改</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 确认耗尽弹窗 ===== */}
      {confirmDepleteModalOpen && selectedDepletionItem && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmDepleteModalOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">确认物料耗尽</h3>
              <button onClick={() => setConfirmDepleteModalOpen(false)} className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none">&times;</button>
            </div>
            <div className="p-6 space-y-5">
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-[13px] text-gray-500 mb-1">当前物料</div>
                <div className="font-semibold text-gray-900">{selectedDepletionItem.materialName}（{selectedDepletionItem.batch}）</div>
                <div className="text-xs text-gray-500 mt-1">{selectedDepletionItem.totalQty}{selectedDepletionItem.unit} · 出库时间：{selectedDepletionItem.startDate} · 已用{selectedDepletionItem.daysUsed}天</div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">耗尽类型 <span className="text-red-500">*</span></label>
                <div className="flex gap-3">
                  <label onClick={() => setDepleteType('normal')} className={`flex items-center gap-2 cursor-pointer px-4 py-2 rounded-lg border-2 transition-all ${depleteType === 'normal' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <input type="radio" checked={depleteType === 'normal'} onChange={() => setDepleteType('normal')} className="accent-[#3b82f6]" />
                    <span className="text-sm font-medium">正常用完</span>
                  </label>
                  <label onClick={() => setDepleteType('expired')} className={`flex items-center gap-2 cursor-pointer px-4 py-2 rounded-lg border-2 transition-all ${depleteType === 'expired' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <input type="radio" checked={depleteType === 'expired'} onChange={() => setDepleteType('expired')} className="accent-[#3b82f6]" />
                    <span className="text-sm font-medium">过期废弃</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">实际剩余量 <span className="text-red-500">*</span></label>
                <div className="flex gap-2">
                  <input type="number" value={depleteRemainValue} onChange={e => setDepleteRemainValue(e.target.value)} className="flex-1 h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease" />
                  <select className="w-24 h-10 px-2 border border-gray-300 rounded-md text-sm bg-white">
                    <option>ml</option><option>μl</option><option>g</option><option>mg</option>
                  </select>
                </div>
                <div className="text-xs text-gray-500 mt-1">输入 0 表示完全耗尽，如有剩余请输入具体数量</div>
              </div>
              {depleteType === 'expired' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">过期原因 <span className="text-red-500">*</span></label>
                    <select value={expiredReason} onChange={e => setExpiredReason(e.target.value)} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white mb-2 focus:outline-none focus:border-blue-500">
                      <option value="">选择原因</option>
                      <option value="expired">物料已过有效期</option>
                      <option value="quality">物料变质/污染</option>
                      <option value="excess">采购过量，无法在效期内用完</option>
                      <option value="project-cancel">关联项目取消/暂停</option>
                      <option value="other">其他</option>
                    </select>
                    <textarea rows={2} placeholder="请补充说明具体情况" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease resize-none" />
                  </div>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <div className="text-[13px] text-red-600"><strong>注意：</strong>标记为"过期废弃"后，该批次剩余量（<span>{depleteRemainValue}</span>）将计入损耗成本，不影响BOM对账的正常消耗统计。</div>
                  </div>
                </>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">备注（可选）</label>
                <textarea value={expiredRemark} onChange={e => setExpiredRemark(e.target.value)} rows={2} placeholder="如有特殊情况请备注" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease resize-none" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
              <button onClick={() => setConfirmDepleteModalOpen(false)} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease">取消</button>
              <button onClick={() => { toast.success('物料已确认耗尽'); setConfirmDepleteModalOpen(false); }} className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm">确认耗尽</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
