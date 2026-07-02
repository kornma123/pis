import { useState, useEffect, useMemo, useCallback } from 'react'
import { inboundApi, purchaseOrderApi } from '@/api/inventory'
import { materialApi, supplierApi, locationApi } from '@/api/master'
import type { InboundRecord, Material, Supplier, Location } from '@/types'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { toast } from 'sonner'
import { formatDateTime } from '@/lib/utils'
import type { FormData } from '../components/InboundFormModal'

type ModalType = 'create' | 'edit' | 'detail' | 'restore' | 'scan' | 'import' | 'print' | null

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

export function useInboundPage() {
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

  // 表单状态
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const [form, setForm] = useState<FormData>({
    type: 'purchase', materialId: '', batchNo: '', quantity: 0, price: 0,
    supplierId: '', locationId: '', fromLocationId: '', fromLocationName: '',
    productionDate: '', expiryDate: '', remark: '', purchaseOrderId: ''
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

  const fetchFn = useCallback(
    async (params: { page: number; pageSize: number }) => {
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
    [
      effectiveStatus,
      effectiveType,
      effectiveMaterialId,
      effectiveKeyword,
      effectiveStartDate,
      effectiveEndDate,
    ]
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
  } = usePagination<InboundRecord>({
    fetchFn,
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

  // 筛选变化自动重置页码的包装 setter
  const setSearchKeyword = (v: string) => { setSearchKeywordRaw(v); setPage(1) }
  const setFilterMaterial = (v: string) => { setFilterMaterialRaw(v); setPage(1) }
  const setFilterStatus = (v: string) => { setFilterStatusRaw(v); setPage(1) }
  const setFilterType = (v: string) => { setFilterTypeRaw(v); setPage(1) }
  const setFilterStartDate = (v: string) => { setFilterStartDateRaw(v); setPage(1) }
  const setFilterEndDate = (v: string) => { setFilterEndDateRaw(v); setPage(1) }
  const setActiveQuickFilter = (v: string) => { setActiveQuickFilterRaw(v); setPage(1) }

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

  // 统计数据（从后端获取，非当前页计算）
  const [stats, setStats] = useState({
    total: 0, completed: 0, cancelled: 0, amount: 0, supplierCount: 0, pendingOrders: 0,
  })

  const fetchStats = async () => {
    try {
      const res: any = await inboundApi.getStats()
      setStats(res.data || res)
    } catch (e) { console.error(e) }
  }

  useEffect(() => {
    fetchStats()
  }, [])

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
      setPurchaseOrders(res?.list || [])
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

  // 确认弹窗
  const openConfirmModal = (title: string, message: string, onConfirm: () => void) => {
    setConfirmModal({ open: true, title, message, onConfirm })
  }

  const closeConfirmModal = () => {
    setConfirmModal(prev => ({ ...prev, open: false, onConfirm: null }))
  }

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
      purchaseOrderId: '',
    })
    fetchRefs()
    setModalType('edit')
  }

  const handleDelete = async (record: InboundRecord) => {
    try {
      const check = await inboundApi.checkDeletable(record.id)
      if (!check?.canDelete) {
        const reasons = check?.reasons || ['该记录不可删除']
        openConfirmModal('不可删除', reasons.join('；'), () => {})
        return
      }
      openConfirmModal(
        '删除确认',
        `确定删除入库记录 ${record.inboundNo} 吗？删除后不可恢复。`,
        async () => {
          try {
            await inboundApi.delete(record.id)
            toast.success('删除成功')
            refresh()
          } catch {
            /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
          }
        }
      )
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
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

  const selectedOrder = useMemo(() =>
    purchaseOrders.find(o => o.id === selectedOrderId),
    [purchaseOrders, selectedOrderId]
  )

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
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
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
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
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

  return {
    // 引用数据
    materials, suppliers, locations,
    // 筛选
    searchKeyword, setSearchKeyword,
    filterMaterial, setFilterMaterial,
    filterStatus, setFilterStatus,
    filterType, setFilterType,
    filterStartDate, setFilterStartDate,
    filterEndDate, setFilterEndDate,
    activeQuickFilter, setActiveQuickFilter,
    // 选择
    selectedIds, toggleSelectAll, toggleSelectOne, clearSelection,
    isAllSelected, isIndeterminate,
    // 弹窗
    modalType, setModalType, selectedRecord, setSelectedRecord,
    confirmModal, openConfirmModal, closeConfirmModal,
    // 表单
    purchaseOrders, selectedOrderId, setSelectedOrderId,
    form, setForm, submitting, handleSubmit,
    // 数据
    data, loading, page, pageSize, total, setPage, setPageSize,
    refresh: () => { refresh(); fetchStats() },
    // 统计
    stats, quickFilterCounts,
    // 操作
    openCreate, openDetail, openEdit, handleDelete, openRestore, closeModal,
    handleRestoreInbound, handleBatchExport, handleBatchPrint, handlePrintRecord,
    handleResetFilters,
  }
}
