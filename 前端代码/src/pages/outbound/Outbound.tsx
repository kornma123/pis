import { useState, useEffect, useMemo } from 'react'
import {
  Printer,
  Package,
  Search,
  X,
  Plus,
  Download,
  Trash2,
  Eye,
  Calendar,
} from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import { outboundApi } from '@/api/inventory'
import { materialApi, projectApi } from '@/api/master'
import type { OutboundRecord, OutboundItem, Material, Project } from '@/types'
import { formatDate, formatCurrency } from '@/lib/utils'
import { toast } from 'sonner'

interface OutboundItemForm {
  materialId: string
  quantity: number
}

interface FormData {
  type: 'project' | 'transfer' | 'scrap'
  projectId: string
  items: OutboundItemForm[]
  remark: string
}

type QuickFilter = 'all' | 'today' | 'week' | 'month'
type StatusFilter = '' | 'completed' | 'pending' | 'cancelled'

const statusConfig: Record<string, { label: string; bg: string; text: string }> = {
  completed: { label: '已完成', bg: 'bg-green-50', text: 'text-green-600' },
  pending: { label: '待出库', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  cancelled: { label: '已取消', bg: 'bg-red-50', text: 'text-red-600' },
}

const typeConfig: Record<string, string> = {
  project: '项目出库',
  transfer: '调拨出库',
  scrap: '报废出库',
}

export default function Outbound() {
  // URL params
  const { get, getNumber, setMultiple } = useUrlParams()

  // Data & loading
  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 10))
    ? getNumber('pageSize', 10)
    : 10

  // Filters (must declare before usePagination which depends on statusFilter)
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [searchText, setSearchText] = useState('')
  const [materialFilter, setMaterialFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<'' | 'project' | 'transfer' | 'scrap'>('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<OutboundRecord>({
    fetchFn: async ({ page, pageSize }) => {
      const res: any = await outboundApi.getList({
        page,
        pageSize,
        status: statusFilter || undefined,
      })
      return { list: res.list || [], pagination: res.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [statusFilter],
  })

  // Sync to URL
  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 10 ? pageSize : null,
      status: statusFilter || null,
    })
  }, [page, pageSize, statusFilter, setMultiple])

  // References
  const [materials, setMaterials] = useState<Material[]>([])
  const [projects, setProjects] = useState<Project[]>([])

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const selectAll = useMemo(() => data.length > 0 && data.every(d => selectedIds.has(d.id)), [data, selectedIds])

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [editRecordId, setEditRecordId] = useState<string | null>(null)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [detailRecord, setDetailRecord] = useState<OutboundRecord | null>(null)
  const [cancelModalOpen, setCancelModalOpen] = useState(false)
  const [cancelRecord, setCancelRecord] = useState<OutboundRecord | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelRemark, setCancelRemark] = useState('')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteRecord, setDeleteRecord] = useState<OutboundRecord | null>(null)

  // Form
  const [form, setForm] = useState<FormData>({
    type: 'project',
    projectId: '',
    items: [{ materialId: '', quantity: 0 }],
    remark: '',
  })

  const fetchRefs = async () => {
    try {
      const [mRes, pRes]: any = await Promise.all([
        materialApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        projectApi.getList({ page: 1, pageSize: 999, status: 'active' }),
      ])
      setMaterials(mRes?.list || [])
      setProjects(pRes?.list || [])
    } catch (e) {
      console.error(e)
    }
  }

  useEffect(() => {
    fetchRefs()
  }, [])

  // Selection handlers
  const toggleSelectAll = () => {
    if (selectAll) {
      const next = new Set(selectedIds)
      data.forEach(d => next.delete(d.id))
      setSelectedIds(next)
    } else {
      const next = new Set(selectedIds)
      data.forEach(d => next.add(d.id))
      setSelectedIds(next)
    }
  }

  const toggleSelectRow = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const clearSelection = () => setSelectedIds(new Set())

  // Stats (mock based on data length for now)
  const stats = useMemo(() => {
    const completed = data.filter(d => d.status === 'completed').length
    const pending = data.filter(d => d.status === 'pending').length
    const cancelled = data.filter(d => d.status === 'cancelled').length
    return {
      monthTotal: total || data.length,
      completed,
      pending,
      cancelled,
    }
  }, [data, total])

  // Filtered data (client-side search/filter)
  const filteredData = useMemo(() => {
    let result = [...data]
    if (searchText.trim()) {
      const kw = searchText.trim().toLowerCase()
      result = result.filter(
        r =>
          r.outboundNo.toLowerCase().includes(kw) ||
          r.items?.some(i => i.materialName?.toLowerCase().includes(kw)) ||
          false
      )
    }
    if (materialFilter) {
      result = result.filter(r => r.items?.some(i => i.materialId === materialFilter))
    }
    if (typeFilter) {
      result = result.filter(r => r.type === typeFilter)
    }
    if (startDate) {
      result = result.filter(r => r.createdAt >= startDate)
    }
    if (endDate) {
      result = result.filter(r => r.createdAt <= endDate + 'T23:59:59')
    }
    return result
  }, [data, searchText, materialFilter, typeFilter, startDate, endDate])

  // Quick filter counts
  const quickFilterCounts = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    return {
      all: data.length,
      today: data.filter(d => d.createdAt?.startsWith(today)).length,
      week: data.filter(d => d.createdAt >= weekAgo).length,
      month: data.filter(d => d.createdAt >= monthAgo).length,
    }
  }, [data])

  // Modal handlers
  const openCreate = () => {
    setEditRecordId(null)
    setForm({
      type: 'project',
      projectId: '',
      items: [{ materialId: materials[0]?.id || '', quantity: 1 }],
      remark: '',
    })
    fetchRefs()
    setCreateModalOpen(true)
  }

  const openEdit = (record: OutboundRecord) => {
    setEditRecordId(record.id)
    setForm({
      type: record.type as any,
      projectId: record.projectId || '',
      items: record.items?.map(i => ({ materialId: i.materialId, quantity: i.quantity })) || [{ materialId: materials[0]?.id || '', quantity: 1 }],
      remark: record.remark || '',
    })
    fetchRefs()
    setCreateModalOpen(true)
  }

  const openDelete = (record: OutboundRecord) => {
    setDeleteRecord(record)
    setDeleteConfirmOpen(true)
  }

  const openDetail = (record: OutboundRecord) => {
    setDetailRecord(record)
    setDetailModalOpen(true)
  }

  const openCancel = (record: OutboundRecord) => {
    setCancelRecord(record)
    setCancelReason('')
    setCancelRemark('')
    setCancelModalOpen(true)
  }

  const addItem = () =>
    setForm(prev => ({
      ...prev,
      items: [...prev.items, { materialId: materials[0]?.id || '', quantity: 1 }],
    }))

  const removeItem = (idx: number) =>
    setForm(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }))

  const updateItem = (idx: number, field: keyof OutboundItemForm, value: string | number) => {
    setForm(prev => ({
      ...prev,
      items: prev.items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)),
    }))
  }

  const handleSubmit = async () => {
    const validItems = form.items.filter(i => i.materialId && i.quantity > 0)
    if (validItems.length === 0) {
      toast.error('请添加至少一个有效物料')
      return
    }
    try {
      if (editRecordId) {
        await outboundApi.update(editRecordId, { ...form, items: validItems })
        toast.success('出库更新成功')
      } else {
        await outboundApi.create({ ...form, items: validItems })
        toast.success('出库登记成功')
      }
      setCreateModalOpen(false)
      setEditRecordId(null)
      refresh()
    } catch (e) {
      toast.error(editRecordId ? '出库更新失败' : '出库登记失败')
    }
  }

  const handleDelete = async () => {
    if (!deleteRecord) return
    try {
      await outboundApi.delete(deleteRecord.id)
      toast.success('删除成功')
      setDeleteConfirmOpen(false)
      setDeleteRecord(null)
      refresh()
    } catch (e) {
      toast.error('删除失败')
    }
  }

  const handleCancel = async () => {
    if (!cancelRecord) return
    if (!cancelReason) {
      toast.error('请选择取消原因')
      return
    }
    try {
      await outboundApi.delete(cancelRecord.id)
      toast.success('出库已取消')
      setCancelModalOpen(false)
      refresh()
    } catch (e) {
      toast.error('取消失败')
    }
  }

  const batchExport = () => {
    if (selectedIds.size === 0) return
    toast.success(`正在导出 ${selectedIds.size} 条出库记录...`)
  }

  const batchPrint = () => {
    if (selectedIds.size === 0) return
    toast.success('正在生成打印预览...')
  }

  const handlePrintRecord = (record: OutboundRecord) => {
    toast.success('正在生成打印预览...')
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">出库记录</h1>
          <p className="text-sm text-gray-500 mt-1">查看和管理所有出库操作记录</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={batchPrint}
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 text-sm font-medium transition-all duration-150"
          >
            <Printer className="w-4 h-4" />
            打印记录
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium transition-all duration-150"
          >
            <Package className="w-4 h-4" />
            出库登记
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          onClick={() => setStatusFilter('')}
          className={`cursor-pointer bg-white rounded-lg border p-5 shadow-[0_1px_3px_rgba(0,0,0,0.1)] transition-all duration-150 hover:shadow-md ${
            statusFilter === '' ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200'
          }`}
        >
          <div className="text-2xl font-semibold text-gray-900">{stats.monthTotal}</div>
          <div className="text-sm text-gray-500 mt-1">本月出库</div>
        </div>
        <div
          onClick={() => setStatusFilter('completed')}
          className={`cursor-pointer bg-white rounded-lg border p-5 shadow-[0_1px_3px_rgba(0,0,0,0.1)] transition-all duration-150 hover:shadow-md ${
            statusFilter === 'completed' ? 'border-green-500 ring-1 ring-green-500' : 'border-gray-200'
          }`}
        >
          <div className="text-2xl font-semibold text-green-600">{stats.completed}</div>
          <div className="text-sm text-gray-500 mt-1">已完成</div>
        </div>
        <div
          onClick={() => setStatusFilter('pending')}
          className={`cursor-pointer bg-white rounded-lg border p-5 shadow-[0_1px_3px_rgba(0,0,0,0.1)] transition-all duration-150 hover:shadow-md ${
            statusFilter === 'pending' ? 'border-yellow-500 ring-1 ring-yellow-500' : 'border-gray-200'
          }`}
        >
          <div className="text-2xl font-semibold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500 mt-1">待出库</div>
        </div>
        <div
          onClick={() => setStatusFilter('cancelled')}
          className={`cursor-pointer bg-white rounded-lg border p-5 shadow-[0_1px_3px_rgba(0,0,0,0.1)] transition-all duration-150 hover:shadow-md ${
            statusFilter === 'cancelled' ? 'border-red-500 ring-1 ring-red-500' : 'border-gray-200'
          }`}
        >
          <div className="text-2xl font-semibold text-red-600">{stats.cancelled}</div>
          <div className="text-sm text-gray-500 mt-1">已取消</div>
        </div>
      </div>

      {/* Quick Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        {([
          { key: 'all', label: '全部' },
          { key: 'today', label: '今日' },
          { key: 'week', label: '本周' },
          { key: 'month', label: '本月' },
        ] as { key: QuickFilter; label: string }[]).map(f => (
          <button
            key={f.key}
            onClick={() => setQuickFilter(f.key)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-all duration-150 ${
              quickFilter === f.key
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
            <span className={`text-xs ${quickFilter === f.key ? 'text-blue-100' : 'text-gray-400'}`}>
              {quickFilterCounts[f.key]}
            </span>
          </button>
        ))}
      </div>

      {/* Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-[0_1px_3px_rgba(0,0,0,0.1)] overflow-hidden">
        {/* Card Header / Filter Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 p-4 border-b border-gray-200">
          <span className="text-base font-medium text-gray-900">出库记录</span>
          <div className="flex-1 flex flex-wrap items-center gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索出库单号/耗材名称/批号..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="pl-9 pr-3 h-10 w-64 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            {/* Material Select */}
            <select
              value={materialFilter}
              onChange={e => setMaterialFilter(e.target.value)}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部耗材</option>
              {materials.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {/* Type Select */}
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as any)}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部类型</option>
              <option value="project">项目出库</option>
              <option value="transfer">调拨出库</option>
              <option value="scrap">报废出库</option>
            </select>
            {/* Status Select */}
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as StatusFilter)}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部状态</option>
              <option value="completed">已完成</option>
              <option value="pending">待出库</option>
              <option value="cancelled">已取消</option>
            </select>
            {/* Date Range */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="pl-8 pr-2 h-10 w-[130px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <span className="text-gray-400">-</span>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="pl-8 pr-2 h-10 w-[130px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            {/* Query / Reset */}
            <button
              onClick={() => {
                setPage(1)
              }}
              className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md text-sm hover:bg-gray-50 transition-all duration-150"
            >
              查询
            </button>
            <button
              onClick={() => {
                setSearchText('')
                setMaterialFilter('')
                setTypeFilter('')
                setStatusFilter('')
                setStartDate('')
                setEndDate('')
                setPage(1)
              }}
              className="h-10 px-4 text-gray-500 rounded-md text-sm hover:text-gray-700 hover:bg-gray-50 transition-all duration-150"
            >
              重置
            </button>
          </div>
        </div>

        {/* Batch Actions Bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between px-4 py-3 bg-blue-50 border-b border-blue-100">
            <div className="text-sm text-blue-700">
              已选择 <strong>{selectedIds.size}</strong> 项
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={batchExport}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-white rounded-md transition-all duration-150"
              >
                <Download className="w-3.5 h-3.5" />
                导出
              </button>
              <button
                onClick={batchPrint}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-white rounded-md transition-all duration-150"
              >
                <Printer className="w-3.5 h-3.5" />
                打印
              </button>
              <button
                onClick={clearSelection}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-white rounded-md transition-all duration-150"
              >
                <X className="w-3.5 h-3.5" />
                取消选择
              </button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={selectAll}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  出库单号
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  耗材名称
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  批号
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  出库类型
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  数量
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  领用项目
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  领用人
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  出库时间
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  状态
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[140px]">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                    加载中...
                  </td>
                </tr>
              ) : filteredData.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                    暂无数据
                  </td>
                </tr>
              ) : (
                filteredData.map(row => {
                  const firstItem = row.items?.[0]
                  const cfg = statusConfig[row.status] || statusConfig.completed
                  return (
                    <tr
                      key={row.id}
                      className={`hover:bg-gray-50 transition-colors duration-150 ${
                        selectedIds.has(row.id) ? 'bg-blue-50' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleSelectRow(row.id)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-600">{row.outboundNo}</td>
                      <td className="px-4 py-3">
                        <strong className="text-gray-900">
                          {firstItem?.materialName || '-'}
                        </strong>
                        {(row.items?.length || 0) > 1 && (
                          <span className="text-xs text-gray-400 ml-1">等{row.items?.length}项</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-500">{firstItem?.batchNo || '-'}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-xs bg-purple-50 text-purple-700">
                          {typeConfig[row.type] || row.type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {row.items?.reduce((sum, i) => sum + i.quantity, 0) || 0} {firstItem?.unit || '件'}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{row.projectName || '-'}</td>
                      <td className="px-4 py-3 text-gray-700">{row.operator}</td>
                      <td className="px-4 py-3 text-gray-500">{formatDate(row.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}
                        >
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openDetail(row)}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors duration-150"
                          >
                            详情
                          </button>
                          <button
                            onClick={() => handlePrintRecord(row)}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors duration-150"
                          >
                            打印
                          </button>
                          {row.status === 'completed' && (
                            <>
                              <button
                                onClick={() => openEdit(row)}
                                className="px-2 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors duration-150"
                              >
                                编辑
                              </button>
                              <button
                                onClick={() => openDelete(row)}
                                className="px-2 py-1 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors duration-150"
                              >
                                删除
                              </button>
                            </>
                          )}
                          {row.status === 'pending' && (
                            <button
                              onClick={() => openCancel(row)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors duration-150"
                            >
                              取消出库
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

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
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

      {/* ==================== Create Modal ==================== */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">{editRecordId ? '编辑出库' : '出库登记'}</h3>
              <button
                onClick={() => setCreateModalOpen(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors duration-150"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">出库类型</label>
                  <select
                    value={form.type}
                    onChange={e => setForm({ ...form, type: e.target.value as any })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="project">项目出库</option>
                    <option value="transfer">调拨出库</option>
                    <option value="scrap">报废出库</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">关联项目</label>
                  <select
                    value={form.projectId}
                    onChange={e => setForm({ ...form, projectId: e.target.value })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">请选择</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">出库明细 *</label>
                  <button
                    onClick={addItem}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-500 text-white text-xs rounded-md hover:bg-blue-600 transition-colors duration-150"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    添加物料
                  </button>
                </div>
                <div className="space-y-2">
                  {form.items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2 p-3 bg-gray-50 rounded-md">
                      <select
                        value={item.materialId}
                        onChange={e => updateItem(idx, 'materialId', e.target.value)}
                        className="flex-1 h-9 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">选择物料</option>
                        {materials.map(m => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({m.code})
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        placeholder="数量"
                        min={1}
                        value={item.quantity || ''}
                        onChange={e => updateItem(idx, 'quantity', Number(e.target.value))}
                        className="w-24 h-9 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      {form.items.length > 1 && (
                        <button
                          onClick={() => removeItem(idx)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors duration-150"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                <textarea
                  value={form.remark}
                  onChange={e => setForm({ ...form, remark: e.target.value })}
                  rows={2}
                  placeholder="请输入出库备注信息（可选）"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button
                onClick={() => setCreateModalOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                className="px-4 py-2 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors duration-150"
              >
                {editRecordId ? '确认更新' : '确认出库'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Detail Modal ==================== */}
      {detailModalOpen && detailRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">出库详情</h3>
              <button
                onClick={() => setDetailModalOpen(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors duration-150"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="text-xl font-semibold text-gray-900">{detailRecord.outboundNo}</div>
                <span
                  className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${
                    statusConfig[detailRecord.status]?.bg
                  } ${statusConfig[detailRecord.status]?.text}`}
                >
                  {statusConfig[detailRecord.status]?.label}
                </span>
              </div>
              <div className="text-sm text-gray-500">出库时间: {formatDate(detailRecord.createdAt)}</div>

              <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 rounded-md">
                <div>
                  <div className="text-xs text-gray-500 mb-1">关联项目</div>
                  <div className="text-sm font-medium text-gray-900">{detailRecord.projectName || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">领用人</div>
                  <div className="text-sm font-medium text-gray-900">{detailRecord.operator}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">操作人</div>
                  <div className="text-sm font-medium text-gray-900">{detailRecord.operator}</div>
                </div>
              </div>

              <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">批号</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">出库数量</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">单位</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">单价</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">金额</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {detailRecord.items?.map((item: OutboundItem, i: number) => (
                    <tr key={i}>
                      <td className="px-4 py-2 font-medium text-gray-900">{item.materialName || '-'}</td>
                      <td className="px-4 py-2 font-mono text-gray-500">{item.batchNo || '-'}</td>
                      <td className="px-4 py-2">{item.quantity}</td>
                      <td className="px-4 py-2 text-gray-500">{item.unit}</td>
                      <td className="px-4 py-2">{formatCurrency(item.unitCost)}</td>
                      <td className="px-4 py-2 font-medium">{formatCurrency(item.totalCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 font-semibold">
                    <td colSpan={5} className="px-4 py-2 text-right text-gray-700">
                      合计:
                    </td>
                    <td className="px-4 py-2 text-gray-900">{formatCurrency(detailRecord.totalCost)}</td>
                  </tr>
                </tfoot>
              </table>

              {detailRecord.remark && (
                <div className="p-3 bg-gray-50 rounded-md">
                  <div className="text-xs text-gray-500 mb-1">备注</div>
                  <div className="text-sm text-gray-700">{detailRecord.remark}</div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button
                onClick={() => setDetailModalOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
              >
                关闭
              </button>
              <button
                onClick={() => handlePrintRecord(detailRecord)}
                className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
              >
                打印
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Cancel Modal ==================== */}
      {cancelModalOpen && cancelRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">取消出库</h3>
              <button
                onClick={() => setCancelModalOpen(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors duration-150"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-500">取消后，该出库单将标记为"已取消"状态。</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  取消原因 <span className="text-red-500">*</span>
                </label>
                <select
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">请选择原因</option>
                  <option value="request">申请人取消需求</option>
                  <option value="stock">库存不足</option>
                  <option value="error">录入错误</option>
                  <option value="other">其他原因</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                <textarea
                  value={cancelRemark}
                  onChange={e => setCancelRemark(e.target.value)}
                  rows={2}
                  placeholder="可选填"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button
                onClick={() => setCancelModalOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
              >
                取消
              </button>
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded-md hover:bg-red-600 transition-colors duration-150"
              >
                确认取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Delete Confirm Modal ==================== */}
      {deleteConfirmOpen && deleteRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors duration-150"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                确定要删除出库单 <strong>{deleteRecord.outboundNo}</strong> 吗？
              </p>
              <p className="text-sm text-gray-500">删除后将恢复库存并清除出库记录。此操作不可撤销。</p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors duration-150"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded-md hover:bg-red-600 transition-colors duration-150"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
