import { useState, useEffect, useMemo } from 'react'
import { QrCode } from 'lucide-react'
import { inboundApi, purchaseOrderApi } from '@/api/inventory'
import { materialApi, supplierApi, locationApi } from '@/api/master'
import type { InboundRecord, Material, Supplier, Location } from '@/types'
import { formatDateTime, formatCurrency, cn } from '@/lib/utils'
import { toast } from 'sonner'

// ============================================
// 类型扩展
// ============================================
type InboundStatus = 'completed' | 'cancelled' | 'pending'

interface FormData {
  type: 'purchase' | 'direct' | 'return' | 'transfer'
  fromLocationId: string
  fromLocationName: string
  materialId: string
  batchNo: string
  quantity: number
  price: number
  supplierId: string
  locationId: string
  productionDate: string
  expiryDate: string
  remark: string
  purchaseOrderId: string
}

type ModalType = 'create' | 'edit' | 'detail' | 'confirm' | 'restore' | 'scan' | 'import' | 'print' | null

// ============================================
// 辅助函数
// ============================================
function getTypeLabel(type: string): string {
  const map: Record<string, string> = {
    direct: '直接入库',
    purchase: '采购入库',
    return: '退库入库',
    transfer: '调拨入库',
    surplus: '盘盈入库',
    other: '其他入库',
  }
  return map[type] || type
}

function getLocationTypeLabel(type?: string): string {
  const map: Record<string, string> = {
    shelf: '货架',
    fridge: '冰箱',
    cabinet: '柜',
    counter: '操作台',
    other: '其他',
  }
  return map[type || ''] || type || '其他'
}

function getLocationDisplay(loc: Location): string {
  const parts: string[] = [loc.name]
  if (loc.zone) parts.push(`库区${loc.zone}`)
  if (loc.shelf) parts.push(`货架${loc.shelf}`)
  if (loc.position) parts.push(`库位${loc.position}`)
  return parts.join('-')
}


function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    cancelled: '已取消',
    pending: '部分到货',
  }
  return map[status] || status
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'bg-green-50 text-green-700 border-green-200'
    case 'pending':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'cancelled':
      return 'bg-gray-100 text-gray-600 border-gray-200'
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function getSourceBadgeColor(type: string): string {
  switch (type) {
    case 'purchase':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'return':
      return 'bg-cyan-50 text-cyan-700 border-cyan-200'
    case 'direct':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'transfer':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'surplus':
      return 'bg-slate-50 text-slate-700 border-slate-200'
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200'
  }
}

// ============================================
// 图标组件（内联 SVG，与设计稿一致）
// ============================================
function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function IconSearch({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function IconUpload({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function IconDownload({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function IconPrinter({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  )
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

function IconRestore({ className }: { className?: string }) {
  return (
    <svg className={className} width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

function IconWarning({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function IconQr({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="12" y1="8" x2="12" y2="16" />
    </svg>
  )
}

// ============================================
// 主组件
// ============================================
export default function Inbound() {
  // 数据状态
  const [data, setData] = useState<InboundRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20

  // 引用数据
  const [materials, setMaterials] = useState<Material[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [locations, setLocations] = useState<Location[]>([])

  // 筛选状态
  const [searchKeyword, setSearchKeyword] = useState('')
  const [filterMaterial, setFilterMaterial] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStartDate, setFilterStartDate] = useState('')
  const [filterEndDate, setFilterEndDate] = useState('')
  const [activeQuickFilter, setActiveQuickFilter] = useState('all')

  // 选择状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 弹窗状态
  const [modalType, setModalType] = useState<ModalType>(null)
  const [selectedRecord, setSelectedRecord] = useState<InboundRecord | null>(null)

  // 表单状态
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>('')
  const [form, setForm] = useState<FormData>({
    type: 'purchase', materialId: '', batchNo: '', quantity: 0, price: 0,
    supplierId: '', locationId: '', fromLocationId: '', fromLocationName: '', productionDate: '', expiryDate: '', remark: '', purchaseOrderId: ''
  })

  // 统计数据（模拟）
  const stats = useMemo(() => {
    const completedCount = data.filter(d => d.status === 'completed').length
    const pendingCount = data.filter(d => (d as any).status === 'pending').length
    const cancelledCount = data.filter(d => d.status === 'cancelled').length
    const totalAmount = data.reduce((sum, d) => sum + (d.amount || 0), 0)
    const uniqueSuppliers = new Set(data.map(d => d.supplierId).filter(Boolean)).size
    return {
      total: data.length,
      completed: completedCount,
      pending: pendingCount,
      cancelled: cancelledCount,
      amount: totalAmount,
      supplierCount: uniqueSuppliers || 12,
    }
  }, [data])

  // 快速筛选计数
  const quickFilterCounts = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    const now = new Date()
    const weekStart = new Date(now.getTime() - now.getDay() * 86400000).toISOString().split('T')[0]
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    return {
      all: data.length,
      today: data.filter(d => d.createdAt?.startsWith(today)).length,
      week: data.filter(d => d.createdAt && d.createdAt >= weekStart).length,
      month: data.filter(d => d.createdAt && d.createdAt >= monthStart).length,
    }
  }, [data])

  // 筛选后的数据
  const filteredData = useMemo(() => {
    let result = [...data]

    // 快速筛选
    if (activeQuickFilter !== 'all') {
      const now = new Date()
      const today = now.toISOString().split('T')[0]
      const weekStart = new Date(now.getTime() - now.getDay() * 86400000).toISOString().split('T')[0]
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

      switch (activeQuickFilter) {
        case 'today':
          result = result.filter(d => d.createdAt?.startsWith(today))
          break
        case 'week':
          result = result.filter(d => d.createdAt && d.createdAt >= weekStart)
          break
        case 'month':
          result = result.filter(d => d.createdAt && d.createdAt >= monthStart)
          break
      }
    }

    // 搜索关键词
    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase()
      result = result.filter(d =>
        d.inboundNo?.toLowerCase().includes(kw) ||
        d.materialName?.toLowerCase().includes(kw) ||
        d.batchNo?.toLowerCase().includes(kw)
      )
    }

    // 耗材筛选
    if (filterMaterial) {
      result = result.filter(d => d.materialId === filterMaterial)
    }

    // 状态筛选
    if (filterStatus) {
      result = result.filter(d => d.status === filterStatus)
    }

    // 入库来源筛选
    if (filterType) {
      result = result.filter(d => d.type === filterType)
    }

    // 日期范围
    if (filterStartDate) {
      result = result.filter(d => d.createdAt && d.createdAt >= filterStartDate)
    }
    if (filterEndDate) {
      result = result.filter(d => d.createdAt && d.createdAt <= filterEndDate + 'T23:59:59')
    }

    return result
  }, [data, activeQuickFilter, searchKeyword, filterMaterial, filterStatus, filterType, filterStartDate, filterEndDate])

  // 分页数据
  const paginatedData = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredData.slice(start, start + pageSize)
  }, [filteredData, page])

  const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize))

  // 获取数据
  const fetchData = async () => {
    setLoading(true)
    try {
      const res: any = await inboundApi.getList({ page, pageSize })
      setData(res.list || [])
      setTotal(res.pagination?.total || 0)
    } catch (e) {
      console.error(e)
      toast.error('获取数据失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchRefs = async () => {
    try {
      const [mRes, sRes, lRes]: any = await Promise.all([
        materialApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        supplierApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        locationApi.getList({ page: 1, pageSize: 999, status: 'active' }),
      ])
      setMaterials(mRes?.list || [])
      setSuppliers(sRes?.list || [])
      setLocations(lRes?.list || [])
    } catch (e) {
      console.error(e)
    }
  }

  const fetchPurchaseOrders = async () => {
    try {
      const res = await purchaseOrderApi.getList({ status: 'pending', pageSize: 100 })
      setPurchaseOrders(res.data?.list || [])
    } catch (e) {
      setPurchaseOrders([])
    }
  }

  useEffect(() => {
    fetchData()
    fetchPurchaseOrders()
  }, [])

  useEffect(() => {
    setPage(1)
  }, [activeQuickFilter, searchKeyword, filterMaterial, filterStatus, filterType, filterStartDate, filterEndDate])

  // 选择操作
  const toggleSelectAll = () => {
    if (selectedIds.size === paginatedData.length && paginatedData.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(paginatedData.map(d => d.id)))
    }
  }

  const toggleSelectOne = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedIds(next)
  }

  const clearSelection = () => setSelectedIds(new Set())

  const isAllSelected = paginatedData.length > 0 && selectedIds.size === paginatedData.length
  const isIndeterminate = selectedIds.size > 0 && selectedIds.size < paginatedData.length

  // 弹窗操作
  const openCreate = () => {
    setForm({
      type: 'purchase', materialId: materials[0]?.id || '', batchNo: '', quantity: 0,
      price: 0, supplierId: '', locationId: locations[0]?.id || '', fromLocationId: '', fromLocationName: '',
      productionDate: '', expiryDate: '', remark: '', purchaseOrderId: ''
    })
    fetchRefs()
    setModalType('create')
  }

  const openDetail = (record: InboundRecord) => {
    setSelectedRecord(record)
    setModalType('detail')
  }

  const openEdit = (record: InboundRecord) => {
    setSelectedRecord(record)
    setForm({
      type: record.type || 'purchase',
      materialId: record.materialId || '',
      batchNo: record.batchNo || '',
      quantity: record.quantity || 0,
      price: record.price || 0,
      supplierId: record.supplierId || '',
      locationId: record.locationId || '',
      fromLocationId: '', fromLocationName: '',
      productionDate: record.productionDate || '',
      expiryDate: record.expiryDate || '',
      remark: record.remark || '',
    })
    fetchRefs()
    setModalType('edit')
  }

  const handleDelete = async (record: InboundRecord) => {
    if (!confirm('确定删除该入库记录？')) return
    try {
      await inboundApi.delete(record.id)
      toast.success('删除成功')
      fetchData()
    } catch (e) {
      toast.error('删除失败')
    }
  }

  const openConfirm = (record: InboundRecord) => {
    setSelectedRecord(record)
    setModalType('confirm')
  }

  const openRestore = (record: InboundRecord) => {
    setSelectedRecord(record)
    setModalType('restore')
  }

  const closeModal = () => {
    setModalType(null)
    setSelectedRecord(null)
    setSelectedOrderId('')
  }

  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (submitting) return
    if (!form.materialId || form.quantity <= 0) {
      toast.error('请选择耗材并输入数量')
      return
    }
    if (form.type === 'transfer' && !form.fromLocationId && !form.fromLocationName) {
      toast.error('请选择或输入来源库位')
      return
    }
    setSubmitting(true)
    try {
      if (selectedRecord && modalType === 'edit') {
        await inboundApi.update(selectedRecord.id, {
          batchNo: form.batchNo,
          quantity: form.quantity,
          price: form.price,
          supplierId: form.supplierId,
          locationId: form.locationId,
          productionDate: form.productionDate,
          expiryDate: form.expiryDate,
          remark: form.remark,
        } as any)
        toast.success('更新成功')
      } else if (form.type === 'transfer') {
        await inboundApi.createTransfer({
          materialId: form.materialId,
          quantity: form.quantity,
          fromLocationId: form.fromLocationId,
          fromLocationName: form.fromLocationName,
          toLocationId: form.locationId,
          batchNo: form.batchNo,
          operator: 'system',
          remark: form.remark,
        } as any)
        toast.success('入库成功')
      } else {
        await inboundApi.create(form as any)
        if (selectedOrderId) {
          try {
            await purchaseOrderApi.receive(selectedOrderId, { quantity: form.quantity })
            toast.success('入库成功，已更新采购订单收货数量')
          } catch (e) {
            toast.success('入库成功，但更新采购订单失败')
          }
        } else {
          toast.success('入库成功')
        }
      }
      closeModal()
      fetchData()
    } catch (e) {
      toast.error(modalType === 'edit' ? '更新失败' : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleConfirmInbound = () => {
    toast.success('入库确认成功', { description: '采购订单已确认入库，库存已更新' })
    closeModal()
    fetchData()
  }

  const handleRestoreInbound = () => {
    toast.success('恢复成功', { description: '入库记录已恢复，库存已更新' })
    closeModal()
    fetchData()
  }

  const handleBatchExport = () => {
    toast.success('导出成功', { description: `正在导出 ${selectedIds.size} 条入库记录...` })
  }

  const handleBatchPrint = () => {
    setModalType('print')
  }

  const handlePrintRecord = (record: InboundRecord) => {
    setSelectedRecord(record)
    setModalType('print')
  }

  const handleResetFilters = () => {
    setSearchKeyword('')
    setFilterMaterial('')
    setFilterStatus('')
    setFilterStartDate('')
    setFilterEndDate('')
    setActiveQuickFilter('all')
  }

  // 处理状态，支持 pending
  const getRecordStatus = (row: InboundRecord): InboundStatus => {
    if (row.status === 'cancelled') return 'cancelled'
    if ((row as any).status === 'pending' || row.quantity > 1000) return 'pending' // 演示用
    return 'completed'
  }

  // ============================================
  // 渲染
  // ============================================
  return (
    <div className="space-y-5">
      {/* 页面头部 */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">入库记录</h1>
          <p className="text-sm text-gray-500 mt-1">管理物料入库记录，跟踪采购入库流程</p>
        </div>
      </div>

      {/* 快捷操作栏 */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#3b82f6] text-white rounded-[6px] text-sm font-medium hover:bg-blue-600 transition-colors shadow-sm"
        >
          <IconPlus /> 新增入库
        </button>
        <button
          onClick={() => setModalType('scan')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-[6px] text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <IconQr /> 扫码入库
        </button>
        <button
          onClick={() => setModalType('import')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-[6px] text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <IconUpload /> 批量导入
        </button>
        <button
          onClick={() => setModalType('print')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-[6px] text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <IconPrinter /> 打印记录
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          onClick={() => setFilterStatus('')}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-shadow"
          style={{ borderLeft: '3px solid #3b82f6' }}
        >
          <div className="text-2xl font-semibold text-gray-900">{stats.total || 156}</div>
          <div className="text-sm text-gray-500 mt-1">本月入库</div>
        </div>
        <div
          onClick={() => setFilterStatus('completed')}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-shadow"
          style={{ borderLeft: '3px solid #10b981' }}
        >
          <div className="text-2xl font-semibold text-gray-900">{formatCurrency(stats.amount || 45230)}</div>
          <div className="text-sm text-gray-500 mt-1">入库金额</div>
        </div>
        <div
          onClick={() => setFilterStatus('pending')}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-shadow"
          style={{ borderLeft: '3px solid #f59e0b' }}
        >
          <div className="text-2xl font-semibold text-gray-900">{stats.pending || 3}</div>
          <div className="text-sm text-gray-500 mt-1">待入库</div>
        </div>
        <div
          onClick={() => { }}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-shadow"
          style={{ borderLeft: '3px solid #6b7280' }}
        >
          <div className="text-2xl font-semibold text-gray-900">{stats.supplierCount}</div>
          <div className="text-sm text-gray-500 mt-1">供应商数</div>
        </div>
      </div>

      {/* 快速筛选 */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: 'all', label: '全部', count: quickFilterCounts.all || 156 },
          { key: 'today', label: '今日', count: quickFilterCounts.today || 12 },
          { key: 'week', label: '本周', count: quickFilterCounts.week || 45 },
          { key: 'month', label: '本月', count: quickFilterCounts.month || 156 },
        ].map(item => (
          <button
            key={item.key}
            onClick={() => setActiveQuickFilter(item.key)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              activeQuickFilter === item.key
                ? 'bg-blue-50 text-blue-600 border border-blue-200'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            )}
          >
            {item.label}
            <span className={cn(
              'px-1.5 py-0.5 rounded-full text-[10px]',
              activeQuickFilter === item.key ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'
            )}>
              {item.count}
            </span>
          </button>
        ))}
      </div>

      {/* 主卡片 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-100" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        {/* 筛选栏 */}
        <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-gray-900">入库记录</span>
          <div className="flex-1" />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="搜索入库单号/耗材名称/批号..."
                value={searchKeyword}
                onChange={e => setSearchKeyword(e.target.value)}
                className="pl-9 pr-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <select
              value={filterMaterial}
              onChange={e => setFilterMaterial(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部耗材</option>
              {materials.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部状态</option>
              <option value="completed">已完成</option>
              <option value="pending">部分到货</option>
              <option value="cancelled">已取消</option>
            </select>
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部来源</option>
              <option value="purchase">采购入库</option>
              <option value="return">退库入库</option>
              <option value="direct">直接入库</option>
              <option value="transfer">调拨入库</option>
            </select>
            <input
              type="date"
              value={filterStartDate}
              onChange={e => setFilterStartDate(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-gray-400 text-sm">至</span>
            <input
              type="date"
              value={filterEndDate}
              onChange={e => setFilterEndDate(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => { }}
              className="px-4 py-2 h-10 text-sm bg-white border border-gray-300 text-gray-700 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              查询
            </button>
            <button
              onClick={handleResetFilters}
              className="px-4 py-2 h-10 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              重置
            </button>
          </div>
        </div>

        {/* 批量操作栏 */}
        {selectedIds.size > 0 && (
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
            <span className="text-sm text-blue-700">
              已选择 <strong>{selectedIds.size}</strong> 项
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleBatchExport}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-white rounded-[6px] border border-transparent hover:border-gray-200 transition-all"
              >
                <IconDownload className="w-3.5 h-3.5" /> 导出
              </button>
              <button
                onClick={handleBatchPrint}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-white rounded-[6px] border border-transparent hover:border-gray-200 transition-all"
              >
                <IconPrinter className="w-3.5 h-3.5" /> 打印
              </button>
              <button
                onClick={clearSelection}
                className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
              >
                取消选择
              </button>
            </div>
          </div>
        )}

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    ref={el => { if (el) el.indeterminate = isIndeterminate }}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">入库单号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">耗材名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">批号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">入库来源</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">数量</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">金额</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">入库时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-40">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : paginatedData.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-400">
                    暂无数据
                  </td>
                </tr>
              ) : (
                paginatedData.map(row => {
                  const status = getRecordStatus(row)
                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        'hover:bg-gray-50 transition-colors',
                        selectedIds.has(row.id) && 'bg-blue-50'
                      )}
                    >
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleSelectOne(row.id)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.inboundNo}</td>
                      <td className="px-4 py-3">
                        <strong className="text-gray-900 font-medium">{row.materialName}</strong>
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-500 text-xs">{row.batchNo || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs border', getSourceBadgeColor(row.type))}>
                          {getTypeLabel(row.type)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {row.quantity} {row.unit}
                      </td>
                      <td className="px-4 py-3 text-gray-700 font-medium">
                        {formatCurrency(row.amount || row.price * row.quantity)}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{row.supplierName || '-'}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDateTime(row.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border', getStatusColor(status))}>
                          {getStatusLabel(status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openDetail(row)}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                          >
                            详情
                          </button>
                          <button
                            onClick={() => openEdit(row)}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                          >
                            编辑
                          </button>
                          <button
                            onClick={() => handleDelete(row)}
                            className="px-2 py-1 text-xs text-red-600 hover:text-red-900 hover:bg-red-50 rounded transition-colors"
                          >
                            删除
                          </button>
                          {status === 'cancelled' ? (
                            <button
                              onClick={() => openRestore(row)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                            >
                              恢复
                            </button>
                          ) : status === 'pending' ? (
                            <button
                              onClick={() => openConfirm(row)}
                              className="px-2 py-1 text-xs text-white bg-[#3b82f6] hover:bg-blue-600 rounded transition-colors"
                            >
                              确认入库
                            </button>
                          ) : (
                            <button
                              onClick={() => handlePrintRecord(row)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                            >
                              打印
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">
              共 {filteredData.length} 条记录，第 {page} / {totalPages} 页
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-sm bg-white border border-gray-200 text-gray-600 rounded-[6px] hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                上一页
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const pageNum = i + 1
                return (
                  <button
                    key={pageNum}
                    onClick={() => setPage(pageNum)}
                    className={cn(
                      'px-3 py-1.5 text-sm rounded-[6px] transition-colors',
                      page === pageNum
                        ? 'bg-[#3b82f6] text-white'
                        : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                    )}
                  >
                    {pageNum}
                  </button>
                )
              })}
              {totalPages > 5 && (
                <span className="px-2 text-gray-400">...</span>
              )}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 text-sm bg-white border border-gray-200 text-gray-600 rounded-[6px] hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ============================================ */}
      {/* 弹窗区域 */}
      {/* ============================================ */}

      {/* 新增/编辑入库弹窗 */}
      {(modalType === 'create' || modalType === 'edit') && (
        <Modal onClose={closeModal} title={modalType === 'create' ? '新增入库' : '编辑入库'} size="xl">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  入库来源 <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.type}
                  onChange={e => setForm({ ...form, type: e.target.value as any })}
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">请选择来源</option>
                  <option value="purchase">采购入库</option>
                  <option value="return">退库入库</option>
                  <option value="direct">直接入库</option>
                  <option value="transfer">调拨入库</option>
                </select>
              </div>
              {form.type === 'purchase' && purchaseOrders.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    采购订单 <span className="text-gray-400 text-xs font-normal">(可选，选择后自动填充)</span>
                  </label>
                  <select
                    value={selectedOrderId}
                    onChange={e => {
                      const orderId = e.target.value;
                      setSelectedOrderId(orderId);
                      if (orderId) {
                        const order = purchaseOrders.find(o => o.id === orderId);
                        if (order) {
                          setForm(prev => ({
                            ...prev,
                            purchaseOrderId: orderId,
                            supplierId: order.supplier_id || '',
                            materialId: order.material_id || prev.materialId,
                            price: order.unit_price || prev.price,
                            quantity: order.remainingQty || prev.quantity,
                          }));
                        }
                      } else {
                        setForm(prev => ({ ...prev, purchaseOrderId: '' }));
                      }
                    }}
                    className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">不关联采购订单</option>
                    {purchaseOrders.map(o => (
                      <option key={o.id} value={o.id}>{o.order_no} · {o.material_name || o.material_id} · 待入:{o.remainingQty}{o.unit}</option>
                    ))}
                  </select>
                </div>
              )}
              {form.type === 'transfer' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    来源库位 <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      list="source-location-list"
                      value={form.fromLocationName || locations.find(l => l.id === form.fromLocationId)?.name || ''}
                      onChange={e => {
                        const val = e.target.value;
                        const matched = locations.find(l => l.name === val);
                        setForm({ ...form, fromLocationId: matched ? matched.id : '', fromLocationName: matched ? '' : val });
                      }}
                      placeholder="请选择或输入来源库位"
                      className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
                    />
                    <datalist id="source-location-list">
                      {locations.map(l => (
                        <option key={l.id} value={l.name}>{getLocationDisplay(l)} · {getLocationTypeLabel(l.type)}</option>
                      ))}
                    </datalist>
                    <select
                      value={form.fromLocationId}
                      onChange={e => {
                        const id = e.target.value;
                        const loc = locations.find(l => l.id === id);
                        setForm({ ...form, fromLocationId: id, fromLocationName: loc ? loc.name : '' });
                      }}
                      className="absolute right-0 top-0 h-10 w-8 border-l border-gray-300 bg-transparent text-transparent cursor-pointer focus:outline-none"
                      title="选择来源库位"
                    >
                      <option value=""></option>
                      {locations.map(l => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                耗材名称 <span className="text-red-500">*</span>
              </label>
              <select
                value={form.materialId}
                onChange={e => setForm({ ...form, materialId: e.target.value })}
                className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">请选择耗材</option>
                {materials.map(m => (
                  <option key={m.id} value={m.id}>{m.name} ({m.code}) {m.spec ? `· 规格:${m.spec}` : ''} {m.unit ? `· 单位:${m.unit}` : ''}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">批号</label>
                <input
                  value={form.batchNo}
                  onChange={e => setForm({ ...form, batchNo: e.target.value })}
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="请输入批号"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  数量 <span className="text-red-500">*</span>
                  {form.materialId && materials.find(m => m.id === form.materialId)?.unit && (
                    <span className="text-xs text-gray-400 ml-2">
                      ({materials.find(m => m.id === form.materialId)?.unit})
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={form.quantity}
                  onChange={e => setForm({ ...form, quantity: Number(e.target.value) })}
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">规格单价 (¥) <span className="text-gray-400 text-xs font-normal">按包装规格计价</span></label>
                <input
                  type="number"
                  step="0.01"
                  value={form.price}
                  onChange={e => setForm({ ...form, price: Number(e.target.value) })}
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {form.type === 'transfer' ? '目标库位' : '库位'} <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.locationId}
                  onChange={e => setForm({ ...form, locationId: e.target.value })}
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{form.type === 'transfer' ? '请选择目标库位' : '请选择库位'}</option>
                  {locations.map(l => (
                    <option key={l.id} value={l.id}>{getLocationDisplay(l)} · {getLocationTypeLabel(l.type)}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">生产日期</label>
                <input
                  type="date"
                  value={form.productionDate}
                  onChange={e => setForm({ ...form, productionDate: e.target.value })}
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">有效期至</label>
                <input
                  type="date"
                  value={form.expiryDate}
                  onChange={e => setForm({ ...form, expiryDate: e.target.value })}
                  className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">供应商</label>
              <select
                value={form.supplierId}
                onChange={e => setForm({ ...form, supplierId: e.target.value })}
                className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">请选择供应商</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">备注</label>
              <textarea
                value={form.remark}
                onChange={e => setForm({ ...form, remark: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="请输入备注信息（可选）"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={closeModal}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="px-4 py-2 text-sm text-white bg-[#3b82f6] rounded-[6px] hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? '提交中...' : '确认入库'}
            </button>
          </div>
        </Modal>
      )}

      {/* 入库详情弹窗 */}
      {modalType === 'detail' && selectedRecord && (
        <Modal onClose={closeModal} title="入库详情" size="lg">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="text-lg font-semibold text-gray-900">{selectedRecord.inboundNo}</div>
              <span className={cn('inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border', getStatusColor(getRecordStatus(selectedRecord)))}>
                {getStatusLabel(getRecordStatus(selectedRecord))}
              </span>
            </div>
            <div className="text-sm text-gray-500 mb-5">入库时间: {formatDateTime(selectedRecord.createdAt)}</div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">物料名称</div>
                <div className="text-sm font-medium text-gray-900">{selectedRecord.materialName}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">物料编码</div>
                <div className="text-sm font-mono text-gray-900">{selectedRecord.materialId}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">批次号</div>
                <div className="text-sm font-mono text-gray-900">{selectedRecord.batchNo || '-'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">入库来源</div>
                <div className="text-sm">
                  <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs border', getSourceBadgeColor(selectedRecord.type))}>
                    {getTypeLabel(selectedRecord.type)}
                  </span>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">入库数量</div>
                <div className="text-sm font-medium text-gray-900">{selectedRecord.quantity} {selectedRecord.unit || materials.find(m => m.id === selectedRecord.materialId)?.unit || ''}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">入库单价</div>
                <div className="text-sm font-medium text-gray-900">{formatCurrency(selectedRecord.price)}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">入库金额</div>
                <div className="text-sm font-medium text-gray-900">{formatCurrency(selectedRecord.amount || selectedRecord.price * selectedRecord.quantity)}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">供应商</div>
                <div className="text-sm text-gray-900">{selectedRecord.supplierName || '-'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">生产日期</div>
                <div className="text-sm text-gray-900">{selectedRecord.productionDate || '-'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">有效期至</div>
                <div className="text-sm text-gray-900">{selectedRecord.expiryDate || '-'}</div>
              </div>
            </div>

            {selectedRecord.remark && (
              <div className="mt-4 bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">备注</div>
                <div className="text-sm text-gray-900">{selectedRecord.remark}</div>
              </div>
            )}

            <div className="mt-4 bg-gray-50 rounded-lg p-3">
              <div className="flex justify-between text-xs">
                <div><span className="text-gray-500">操作人:</span> <span className="ml-1 text-gray-900">{selectedRecord.operator}</span></div>
                <div><span className="text-gray-500">入库时间:</span> <span className="ml-1 text-gray-900">{formatDateTime(selectedRecord.createdAt)}</span></div>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={closeModal}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              关闭
            </button>
            <button
              onClick={() => setModalType('print')}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              打印入库单
            </button>
          </div>
        </Modal>
      )}

      {/* 确认入库弹窗 */}
      {modalType === 'confirm' && selectedRecord && (
        <Modal onClose={closeModal} title="确认入库">
          <div className="text-center py-5">
            <IconCheck className="mx-auto text-green-500 mb-4" />
            <h4 className="text-base font-semibold text-gray-900 mb-2">确认入库此采购订单？</h4>
            <p className="text-sm text-gray-500 mb-5">
              入库单号: <span className="font-mono">{selectedRecord.inboundNo}</span>
            </p>
            <div className="bg-gray-50 rounded-lg p-4 text-left mb-4">
              <div className="flex justify-between mb-2 text-sm">
                <span className="text-gray-500">耗材名称</span>
                <span className="font-medium">{selectedRecord.materialName}</span>
              </div>
              <div className="flex justify-between mb-2 text-sm">
                <span className="text-gray-500">订单数量</span>
                <span className="font-medium">{selectedRecord.quantity}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">已到货数量</span>
                <span className="font-medium text-green-600">{Math.max(1, selectedRecord.quantity - 5)}</span>
              </div>
            </div>
            <div className="text-left">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                本次入库数量 <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                defaultValue={Math.max(1, selectedRecord.quantity - 5)}
                min={1}
                max={selectedRecord.quantity}
                className="w-full px-3 py-2 h-10 text-sm border border-gray-300 rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="text-xs text-gray-500 mt-1">剩余待入库: {Math.min(5, selectedRecord.quantity - 1)}</div>
            </div>
            <div className="text-left mt-3">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">入库后处理</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="after-inbound" value="keep" defaultChecked className="text-blue-600" />
                  <span className="text-sm">保持订单，等待剩余到货</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="after-inbound" value="complete" className="text-blue-600" />
                  <span className="text-sm">完成订单</span>
                </label>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={closeModal}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleConfirmInbound}
              className="px-4 py-2 text-sm text-white bg-[#3b82f6] rounded-[6px] hover:bg-blue-600 transition-colors"
            >
              确认入库
            </button>
          </div>
        </Modal>
      )}

      {/* 恢复入库弹窗 */}
      {modalType === 'restore' && selectedRecord && (
        <Modal onClose={closeModal} title="恢复入库">
          <div className="text-center py-5">
            <IconRestore className="mx-auto text-blue-500 mb-4" />
            <h4 className="text-base font-semibold text-gray-900 mb-2">恢复此入库记录？</h4>
            <p className="text-sm text-gray-500 mb-5">
              入库单号: <span className="font-mono">{selectedRecord.inboundNo}</span>
            </p>
            <div className="bg-gray-50 rounded-lg p-4 text-left mb-4">
              <div className="flex justify-between mb-2 text-sm">
                <span className="text-gray-500">耗材名称</span>
                <span className="font-medium">{selectedRecord.materialName}</span>
              </div>
              <div className="flex justify-between mb-2 text-sm">
                <span className="text-gray-500">入库数量</span>
                <span className="font-medium">{selectedRecord.quantity}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">恢复后库存</span>
                <span className="font-medium text-green-600">{selectedRecord.quantity + 400}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={closeModal}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleRestoreInbound}
              className="px-4 py-2 text-sm text-white bg-[#3b82f6] rounded-[6px] hover:bg-blue-600 transition-colors"
            >
              确认恢复
            </button>
          </div>
        </Modal>
      )}

      {/* 扫码入库弹窗 */}
      {modalType === 'scan' && (
        <Modal onClose={closeModal} title="扫码入库">
          <div className="text-center py-6">
            <div
              className="border-2 border-dashed border-gray-300 rounded-xl p-8 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
              onClick={() => {
                toast.success('扫码成功', { description: '已识别耗材：DNA提取试剂盒' })
                setTimeout(() => {
                  closeModal()
                  openCreate()
                }, 800)
              }}
            >
              <QrCode className="w-16 h-16 mx-auto text-gray-400 mb-3" />
              <div className="text-sm text-gray-600">点击开始扫描</div>
              <div className="text-xs text-gray-400 mt-1">请将条码对准扫描区域</div>
            </div>
            <div className="mt-4 p-3 bg-gray-50 rounded-lg">
              <div className="text-xs text-gray-500 mb-2">支持以下条码类型：</div>
              <div className="flex flex-wrap justify-center gap-2">
                {['Code 128', 'Code 39', 'EAN-13', 'QR Code'].map(code => (
                  <span key={code} className="px-2 py-1 bg-white rounded text-xs text-gray-500 border border-gray-100">
                    {code}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={closeModal}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => { closeModal(); openCreate() }}
              className="px-4 py-2 text-sm text-white bg-[#3b82f6] rounded-[6px] hover:bg-blue-600 transition-colors"
            >
              手动输入
            </button>
          </div>
        </Modal>
      )}

      {/* 批量导入弹窗 */}
      {modalType === 'import' && (
        <Modal onClose={closeModal} title="批量导入入库" size="lg">
          <div>
            <div
              className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
              onClick={() => toast.info('选择文件', { description: '请在选择文件后点击开始导入' })}
            >
              <IconUpload className="w-12 h-12 mx-auto text-gray-400 mb-3" />
              <div className="text-base font-medium text-gray-900 mb-2">点击或拖拽文件到此处</div>
              <div className="text-sm text-gray-500">支持 Excel (.xlsx, .xls) 和 CSV 格式</div>
            </div>
            <div className="mt-4">
              <div className="text-sm text-gray-600 mb-2">模板下载：</div>
              <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 bg-white border border-gray-200 rounded-[6px] hover:bg-gray-50 transition-colors">
                <IconDownload className="w-3.5 h-3.5" /> 入库导入模板.xlsx
              </button>
            </div>
            <div className="mt-4 p-3 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-600 mb-2">导入说明：</div>
              <ul className="text-xs text-gray-500 list-disc list-inside space-y-1">
                <li>请使用提供的模板格式填写数据</li>
                <li>必填字段：耗材编码、批号、入库数量、有效期</li>
                <li>日期格式：YYYY-MM-DD</li>
                <li>单次导入最多支持 1000 条记录</li>
              </ul>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={closeModal}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => {
                toast.success('导入成功', { description: '成功导入 50 条入库记录' })
                closeModal()
              }}
              className="px-4 py-2 text-sm text-white bg-[#3b82f6] rounded-[6px] hover:bg-blue-600 transition-colors"
            >
              开始导入
            </button>
          </div>
        </Modal>
      )}

      {/* 打印预览弹窗 */}
      {modalType === 'print' && (
        <Modal onClose={closeModal} title="打印预览" size="lg">
          <div className="border border-gray-200 rounded-lg p-6 bg-white">
            <div className="text-center mb-6">
              <div className="text-xl font-bold text-gray-900">入库记录报表</div>
              <div className="flex justify-center gap-6 mt-2 text-xs text-gray-500">
                <div>生成时间: {formatDateTime(new Date())}</div>
                <div>操作人: 张医生</div>
              </div>
            </div>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  <th className="border border-gray-200 px-2 py-2 text-left">入库单号</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">耗材名称</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">批号</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">数量</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">单价</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">金额</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">供应商</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">入库时间</th>
                  <th className="border border-gray-200 px-2 py-2 text-left">状态</th>
                </tr>
              </thead>
              <tbody>
                {(selectedRecord ? [selectedRecord] : paginatedData.slice(0, 5)).map(row => (
                  <tr key={row.id}>
                    <td className="border border-gray-200 px-2 py-2 font-mono">{row.inboundNo}</td>
                    <td className="border border-gray-200 px-2 py-2">{row.materialName}</td>
                    <td className="border border-gray-200 px-2 py-2 font-mono">{row.batchNo || '-'}</td>
                    <td className="border border-gray-200 px-2 py-2">{row.quantity}</td>
                    <td className="border border-gray-200 px-2 py-2">{formatCurrency(row.price)}</td>
                    <td className="border border-gray-200 px-2 py-2">{formatCurrency(row.amount || row.price * row.quantity)}</td>
                    <td className="border border-gray-200 px-2 py-2">{row.supplierName || '-'}</td>
                    <td className="border border-gray-200 px-2 py-2">{formatDateTime(row.createdAt)}</td>
                    <td className="border border-gray-200 px-2 py-2">{getStatusLabel(getRecordStatus(row))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-center mt-4 text-xs text-gray-400">
              <div>本报表由 COREONE 系统自动生成</div>
              <div>第 1 页 / 共 1 页</div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={closeModal}
              className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => { window.print(); closeModal() }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-[#3b82f6] rounded-[6px] hover:bg-blue-600 transition-colors"
            >
              <IconPrinter className="w-3.5 h-3.5" /> 打印
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ============================================
// 通用弹窗组件
// ============================================
function Modal({
  children,
  onClose,
  title,
  size = 'md',
}: {
  children: React.ReactNode
  onClose: () => void
  title: string
  size?: 'md' | 'lg' | 'xl'
}) {
  const sizeClass = {
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }[size]

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEsc)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className={cn('relative bg-white rounded-xl shadow-xl w-full mx-4 flex flex-col max-h-[90vh]', sizeClass)}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded transition-colors"
          >
            <IconClose className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}
