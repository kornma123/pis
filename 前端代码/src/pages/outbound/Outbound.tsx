import { useState, useEffect, useMemo } from 'react'
import { Printer, Package } from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { outboundApi } from '@/api/inventory'
import { materialApi, projectApi } from '@/api/master'
import type { OutboundRecord, Material, Project } from '@/types'
import { toast } from 'sonner'
import OutboundFormModal, { type FormData } from './components/OutboundFormModal'
import OutboundDetailModal from './components/OutboundDetailModal'
import OutboundCancelModal from './components/OutboundCancelModal'
import OutboundDeleteModal from './components/OutboundDeleteModal'
import OutboundStats from './components/OutboundStats'
import OutboundQuickFilters from './components/OutboundQuickFilters'
import OutboundFilterBar from './components/OutboundFilterBar'
import OutboundTable from './components/OutboundTable'

type QuickFilter = 'all' | 'today' | 'week' | 'month'
type StatusFilter = '' | 'completed' | 'pending' | 'cancelled'

export default function Outbound() {
  const { get, getNumber, setMultiple } = useUrlParams()

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 10))
    ? getNumber('pageSize', 10)
    : 10

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

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 10 ? pageSize : null,
      status: statusFilter || null,
    })
  }, [page, pageSize, statusFilter, setMultiple])

  const [materials, setMaterials] = useState<Material[]>([])
  const [projects, setProjects] = useState<Project[]>([])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const selectAll = useMemo(() => data.length > 0 && data.every(d => selectedIds.has(d.id)), [data, selectedIds])

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

  const toggleSelectAll = () => {
    const next = new Set(selectedIds)
    data.forEach(d => selectAll ? next.delete(d.id) : next.add(d.id))
    setSelectedIds(next)
  }
  const toggleSelectRow = (id: string) => {
    const next = new Set(selectedIds)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelectedIds(next)
  }
  const clearSelection = () => setSelectedIds(new Set())

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

  const batchExport = () => selectedIds.size > 0 && toast.success(`正在导出 ${selectedIds.size} 条出库记录...`)
  const batchPrint = () => selectedIds.size > 0 && toast.success('正在生成打印预览...')
  const handlePrintRecord = (_record: OutboundRecord) => toast.success('正在生成打印预览...')

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
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 text-sm font-medium transition-colors duration-150"
          >
            <Printer className="w-4 h-4" />
            打印记录
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium transition-colors duration-150"
          >
            <Package className="w-4 h-4" />
            出库登记
          </button>
        </div>
      </div>

      <OutboundStats stats={stats} statusFilter={statusFilter} onStatusChange={setStatusFilter} />

      <OutboundQuickFilters quickFilter={quickFilter} counts={quickFilterCounts} onChange={setQuickFilter} />

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <OutboundFilterBar
          searchText={searchText}
          materialFilter={materialFilter}
          typeFilter={typeFilter}
          statusFilter={statusFilter}
          startDate={startDate}
          endDate={endDate}
          materials={materials}
          onSearchChange={setSearchText}
          onMaterialChange={setMaterialFilter}
          onTypeChange={setTypeFilter}
          onStatusChange={setStatusFilter}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onQuery={() => setPage(1)}
          onReset={() => {
            setSearchText('')
            setMaterialFilter('')
            setTypeFilter('')
            setStatusFilter('')
            setStartDate('')
            setEndDate('')
            setPage(1)
          }}
        />

        <OutboundTable
          loading={loading}
          filteredData={filteredData}
          selectedIds={selectedIds}
          selectAll={selectAll}
          total={total}
          page={page}
          pageSize={pageSize}
          onToggleSelectAll={toggleSelectAll}
          onToggleSelectRow={toggleSelectRow}
          onClearSelection={clearSelection}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onOpenDetail={openDetail}
          onOpenEdit={openEdit}
          onOpenDelete={openDelete}
          onOpenCancel={openCancel}
          onPrintRecord={handlePrintRecord}
          onBatchExport={batchExport}
          onBatchPrint={batchPrint}
        />
      </div>

      <OutboundFormModal
        open={createModalOpen}
        editRecordId={editRecordId}
        form={form}
        materials={materials}
        projects={projects}
        onClose={() => setCreateModalOpen(false)}
        onSubmit={handleSubmit}
        onFormChange={setForm}
      />

      <OutboundDetailModal
        open={detailModalOpen}
        record={detailRecord}
        onClose={() => setDetailModalOpen(false)}
        onPrint={handlePrintRecord}
      />

      <OutboundCancelModal
        open={cancelModalOpen}
        record={cancelRecord}
        cancelReason={cancelReason}
        cancelRemark={cancelRemark}
        onReasonChange={setCancelReason}
        onRemarkChange={setCancelRemark}
        onCancel={handleCancel}
        onClose={() => setCancelModalOpen(false)}
      />

      <OutboundDeleteModal
        open={deleteConfirmOpen}
        record={deleteRecord}
        onDelete={handleDelete}
        onClose={() => setDeleteConfirmOpen(false)}
      />
    </div>
  )
}
