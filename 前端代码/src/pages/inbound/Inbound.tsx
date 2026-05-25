import { useState, useEffect, useMemo } from 'react'
import {
  QrCode, Plus, Search, Upload, Download, Printer,
} from 'lucide-react'
import ImportInboundModal from './components/ImportInboundModal'
import InboundFormModal, { type FormData } from './components/InboundFormModal'
import InboundDetailModal from './components/InboundDetailModal'
import InboundRestoreModal from './components/InboundRestoreModal'
import InboundScanModal from './components/InboundScanModal'
import InboundPrintModal from './components/InboundPrintModal'
import { inboundApi, purchaseOrderApi } from '@/api/inventory'
import { materialApi, supplierApi, locationApi } from '@/api/master'
import type { InboundRecord, Material, Supplier, Location } from '@/types'
import { formatDateTime, formatCurrency, cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Pagination } from '@/components/ui/Pagination'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

// ============================================
// 类型扩展
// ============================================
type InboundStatus = 'completed' | 'cancelled'

type ModalType = 'create' | 'edit' | 'detail' | 'restore' | 'scan' | 'import' | 'print' | null

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

// ============================================
// 主组件
// ============================================
export default function Inbound() {
  const url = useUrlParams()

  const initialPage = Math.max(1, url.getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(url.getNumber('pageSize', 20))
    ? url.getNumber('pageSize', 20)
    : 20

  // 引用数据
  const [materials, setMaterials] = useState<Material[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [locations, setLocations] = useState<Location[]>([])

  // 筛选状态
  const [searchKeyword, setSearchKeywordRaw] = useState(url.get('keyword', ''))
  const [filterMaterial, setFilterMaterialRaw] = useState(url.get('materialId', ''))
  const [filterStatus, setFilterStatusRaw] = useState(url.get('status', ''))
  const [filterType, setFilterTypeRaw] = useState(url.get('type', ''))
  const [filterStartDate, setFilterStartDateRaw] = useState(url.get('startDate', ''))
  const [filterEndDate, setFilterEndDateRaw] = useState(url.get('endDate', ''))
  const [activeQuickFilter, setActiveQuickFilterRaw] = useState(url.get('quickFilter', 'all'))

  const setSearchKeyword = (v: string) => { setSearchKeywordRaw(v); setPage(1) }
  const setFilterMaterial = (v: string) => { setFilterMaterialRaw(v); setPage(1) }
  const setFilterStatus = (v: string) => { setFilterStatusRaw(v); setPage(1) }
  const setFilterType = (v: string) => { setFilterTypeRaw(v); setPage(1) }
  const setFilterStartDate = (v: string) => { setFilterStartDateRaw(v); setPage(1) }
  const setFilterEndDate = (v: string) => { setFilterEndDateRaw(v); setPage(1) }
  const setActiveQuickFilter = (v: string) => { setActiveQuickFilterRaw(v); setPage(1) }

  // 选择状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 弹窗状态
  const [modalType, setModalType] = useState<ModalType>(null)
  const [selectedRecord, setSelectedRecord] = useState<InboundRecord | null>(null)

  // 自定义确认弹窗状态
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean
    title: string
    message: string
    onConfirm: (() => void) | null
  }>({ open: false, title: '', message: '', onConfirm: null })

  const openConfirmModal = (title: string, message: string, onConfirm: () => void) => {
    setConfirmModal({ open: true, title, message, onConfirm })
  }

  const closeConfirmModal = () => {
    setConfirmModal(prev => ({ ...prev, open: false, onConfirm: null }))
  }

  // 表单状态
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>('')

  const selectedOrder = useMemo(() =>
    purchaseOrders.find(o => o.id === selectedOrderId),
    [purchaseOrders, selectedOrderId]
  )

  const [form, setForm] = useState<FormData>({
    type: 'purchase', materialId: '', batchNo: '', quantity: 0, price: 0,
    supplierId: '', locationId: '', fromLocationId: '', fromLocationName: '', productionDate: '', expiryDate: '', remark: '', purchaseOrderId: ''
  })

  // 快速筛选映射为日期范围
  const quickFilterDates = useMemo(() => {
    const now = new Date()
    const today = now.toISOString().split('T')[0]
    const weekStart = new Date(now.getTime() - now.getDay() * 86400000).toISOString().split('T')[0]
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    switch (activeQuickFilter) {
      case 'today': return { startDate: today, endDate: today }
      case 'week': return { startDate: weekStart, endDate: today }
      case 'month': return { startDate: monthStart, endDate: today }
      default: return { startDate: filterStartDate, endDate: filterEndDate }
    }
  }, [activeQuickFilter, filterStartDate, filterEndDate])

  const effectiveStatus = filterStatus || undefined
  const effectiveType = filterType || undefined
  const effectiveMaterialId = filterMaterial || undefined
  const effectiveKeyword = searchKeyword || undefined
  const effectiveStartDate = quickFilterDates.startDate || undefined
  const effectiveEndDate = quickFilterDates.endDate || undefined

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<InboundRecord>({
    fetchFn: async (params) => {
      const res: any = await inboundApi.getList({
        ...params,
        status: effectiveStatus,
        type: effectiveType,
        materialId: effectiveMaterialId,
        keyword: effectiveKeyword,
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
      })
      return {
        list: res?.list || [],
        pagination: res?.pagination,
      }
    },
    initialPage,
    initialPageSize,
    deps: [
      effectiveStatus,
      effectiveType,
      effectiveMaterialId,
      effectiveKeyword,
      effectiveStartDate,
      effectiveEndDate,
    ],
  })

  // URL 同步
  useEffect(() => {
    url.setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: searchKeyword || null,
      materialId: filterMaterial || null,
      status: filterStatus || null,
      type: filterType || null,
      startDate: filterStartDate || null,
      endDate: filterEndDate || null,
      quickFilter: activeQuickFilter !== 'all' ? activeQuickFilter : null,
    })
  }, [page, pageSize, searchKeyword, filterMaterial, filterStatus, filterType, filterStartDate, filterEndDate, activeQuickFilter])

  // 统计数据
  const stats = useMemo(() => {
    const completedCount = data.filter(d => d.status === 'completed').length
    const pendingCount = data.filter(d => (d as any).status === 'pending').length
    const cancelledCount = data.filter(d => d.status === 'cancelled').length
    const totalAmount = data.reduce((sum, d) => sum + (d.amount || 0), 0)
    const uniqueSuppliers = new Set(data.map(d => d.supplierId).filter(Boolean)).size
    return {
      total,
      completed: completedCount,
      pending: pendingCount,
      cancelled: cancelledCount,
      amount: totalAmount,
      supplierCount: uniqueSuppliers,
    }
  }, [data, total])

  // 快速筛选计数（基于当前页）
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
      const res = await purchaseOrderApi.getList({ status: 'pending,partial', pageSize: 100 })
      setPurchaseOrders(res.data?.list || [])
    } catch (e) {
      setPurchaseOrders([])
    }
  }

  useEffect(() => {
    fetchPurchaseOrders()
  }, [])

  // 选择操作
  const toggleSelectAll = () => {
    if (selectedIds.size === data.length && data.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map(d => d.id)))
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

  const isAllSelected = data.length > 0 && selectedIds.size === data.length
  const isIndeterminate = selectedIds.size > 0 && selectedIds.size < data.length

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

  const handleDelete = (record: InboundRecord) => {
    openConfirmModal('删除确认', `确定删除入库记录 ${record.inboundNo} 吗？删除后不可恢复。`, async () => {
      try {
        await inboundApi.delete(record.id)
        toast.success('删除成功')
        refresh()
      } catch (e) {
        toast.error('删除失败')
      }
    })
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
    if (selectedOrderId && selectedOrder && form.quantity > selectedOrder.remainingQty) {
      toast.error(`入库数量不能超过待入库数量 ${selectedOrder.remainingQty}`)
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
      refresh()
    } catch (e) {
      toast.error(modalType === 'edit' ? '更新失败' : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRestoreInbound = async () => {
    if (!selectedRecord) return
    try {
      await inboundApi.update(selectedRecord.id, { status: 'completed' } as any)
      toast.success('恢复成功', { description: '入库记录已恢复' })
      closeModal()
      refresh()
    } catch (e: any) {
      toast.error('恢复失败', { description: e?.message || '请检查后端接口是否支持状态恢复' })
    }
  }

  const handleBatchExport = async () => {
    const exportData = selectedIds.size > 0
      ? data.filter(d => selectedIds.has(d.id))
      : data
    if (exportData.length === 0) {
      toast.error('没有可导出的数据')
      return
    }
    try {
      const XLSX = await import('xlsx')
      const rows = exportData.map(row => ({
        入库单号: row.inboundNo,
        耗材名称: row.materialName,
        批号: row.batchNo || '-',
        入库来源: getTypeLabel(row.type),
        数量: row.quantity,
        单位: row.unit,
        单价: row.price,
        金额: row.amount || row.price * row.quantity,
        供应商: row.supplierName || '-',
        入库时间: formatDateTime(row.createdAt),
        状态: row.status === 'completed' ? '已完成' : '已取消',
        备注: row.remark || '-',
      }))
      const ws = XLSX.utils.json_to_sheet(rows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '入库记录')
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      XLSX.writeFile(wb, `入库记录_${dateStr}.xlsx`)
      toast.success('导出成功', { description: `已导出 ${rows.length} 条记录` })
    } catch (e) {
      toast.error('导出失败')
    }
  }

  const handleBatchPrint = () => {
    setModalType('print')
  }

  const handlePrintRecord = (record: InboundRecord) => {
    setSelectedRecord(record)
    setModalType('print')
  }

  const handleResetFilters = () => {
    setSearchKeywordRaw('')
    setFilterMaterialRaw('')
    setFilterStatusRaw('')
    setFilterStartDateRaw('')
    setFilterEndDateRaw('')
    setActiveQuickFilterRaw('all')
    setFilterTypeRaw('')
    setPage(1)
  }

  const getRecordStatus = (row: InboundRecord): InboundStatus => row.status

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
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-colors shadow-sm"
        >
          <Plus className="w-[18px] h-[18px]" /> 新增入库
        </button>
        <button
          onClick={() => setModalType('scan')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <QrCode /> 扫码入库
        </button>
        <button
          onClick={() => setModalType('import')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <Upload /> 批量导入
        </button>
        <button
          onClick={() => setModalType('print')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-200 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
        >
          <Printer /> 打印记录
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          onClick={() => setFilterStatus('')}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-blue-500 cursor-pointer hover:shadow-md transition-shadow"
        >
          <div className="text-2xl font-semibold text-gray-900">{stats.total}</div>
          <div className="text-sm text-gray-500 mt-1">本月入库</div>
        </div>
        <div
          onClick={() => setFilterStatus('completed')}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-green-500 cursor-pointer hover:shadow-md transition-shadow"
        >
          <div className="text-2xl font-semibold text-gray-900">{formatCurrency(stats.amount)}</div>
          <div className="text-sm text-gray-500 mt-1">入库金额</div>
        </div>
        <div
          onClick={() => setFilterStatus('pending')}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-amber-500 cursor-pointer hover:shadow-md transition-shadow"
        >
          <div className="text-2xl font-semibold text-gray-900">{stats.pending}</div>
          <div className="text-sm text-gray-500 mt-1">待入库</div>
        </div>
        <div
          onClick={() => { }}
          className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-gray-500 cursor-pointer hover:shadow-md transition-shadow"
        >
          <div className="text-2xl font-semibold text-gray-900">{stats.supplierCount}</div>
          <div className="text-sm text-gray-500 mt-1">供应商数</div>
        </div>
      </div>

      {/* 快速筛选 */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: 'all', label: '全部', count: quickFilterCounts.all },
          { key: 'today', label: '今日', count: quickFilterCounts.today },
          { key: 'week', label: '本周', count: quickFilterCounts.week },
          { key: 'month', label: '本月', count: quickFilterCounts.month },
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
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        {/* 筛选栏 */}
        <div className="px-5 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-gray-900">入库记录</span>
          <div className="flex-1" />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="搜索入库单号/耗材名称/批号..."
                value={searchKeyword}
                onChange={e => setSearchKeyword(e.target.value)}
                className="pl-9 pr-3 py-2 h-10 text-sm border border-gray-300 rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <select
              value={filterMaterial}
              onChange={e => setFilterMaterial(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部耗材</option>
              {materials.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部状态</option>
              <option value="completed">已完成</option>
              <option value="pending">部分到货</option>
              <option value="cancelled">已取消</option>
            </select>
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-gray-400 text-sm">至</span>
            <input
              type="date"
              value={filterEndDate}
              onChange={e => setFilterEndDate(e.target.value)}
              className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => setPage(1)}
              className="px-4 py-2 h-10 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-white rounded-md border border-transparent hover:border-gray-200 transition-all"
              >
                <Download className="w-3.5 h-3.5" /> 导出
              </button>
              <button
                onClick={handleBatchPrint}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-white rounded-md border border-transparent hover:border-gray-200 transition-all"
              >
                <Printer className="w-3.5 h-3.5" /> 打印
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
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-400">
                    暂无数据
                  </td>
                </tr>
              ) : (
                data.map(row => {
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
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* ============================================ */}
      {/* 弹窗区域 */}
      {/* ============================================ */}

      <InboundFormModal
        open={modalType === 'create' || modalType === 'edit'}
        modalType={modalType as 'create' | 'edit'}
        form={form}
        setForm={setForm}
        materials={materials}
        locations={locations}
        suppliers={suppliers}
        purchaseOrders={purchaseOrders}
        selectedOrderId={selectedOrderId}
        setSelectedOrderId={setSelectedOrderId}
        selectedRecord={selectedRecord}
        submitting={submitting}
        onClose={closeModal}
        onSubmit={handleSubmit}
      />


      <InboundDetailModal
        open={modalType === 'detail'}
        record={selectedRecord}
        materials={materials}
        onClose={closeModal}
        onPrint={() => setModalType('print')}
      />

      <InboundRestoreModal
        open={modalType === 'restore'}
        record={selectedRecord}
        onClose={closeModal}
        onConfirm={handleRestoreInbound}
      />

      <InboundScanModal
        open={modalType === 'scan'}
        onClose={closeModal}
        onManualInput={() => { closeModal(); openCreate() }}
        onScanSuccess={(materialId) => {
          closeModal()
          openCreate()
          setForm(prev => ({ ...prev, materialId, type: 'direct' }))
        }}
      />

      {/* 批量导入弹窗 */}
      {modalType === 'import' && (
        <Modal onClose={closeModal} title="批量导入入库" size="lg">
          <ImportInboundModal
            onClose={closeModal}
            onSuccess={() => { closeModal(); refresh() }}
            materials={materials}
            locations={locations}
          />
        </Modal>
      )}

      <InboundPrintModal
        open={modalType === 'print'}
        data={data}
        selectedRecord={selectedRecord}
        onClose={closeModal}
      />

      <ConfirmDialog
        open={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText="确认"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={() => {
          confirmModal.onConfirm?.()
          closeConfirmModal()
        }}
        onCancel={closeConfirmModal}
      />
    </div>
  )
}
