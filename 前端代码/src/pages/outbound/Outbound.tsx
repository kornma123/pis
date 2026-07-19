import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Package, Printer, RefreshCw } from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { outboundApi } from '@/api/inventory'
import { materialApi, projectApi } from '@/api/master'
import { canAccess } from '@/lib/permissions'
import type { Material, OutboundRecord, Project } from '@/types'
import { toast } from 'sonner'
import { formatDateTime } from '@/lib/utils'
import OutboundFormModal, { type FormData } from './components/OutboundFormModal'
import OutboundDetailModal from './components/OutboundDetailModal'
import OutboundDeleteModal from './components/OutboundDeleteModal'
import OutboundStats from './components/OutboundStats'
import OutboundQuickFilters from './components/OutboundQuickFilters'
import OutboundFilterBar from './components/OutboundFilterBar'
import OutboundTable, { type OutboundSortField, type OutboundSortOrder } from './components/OutboundTable'
import { printOutboundRecord } from './Outbound.print'

type QuickFilter = 'all' | 'today' | 'week' | 'month'
type StatusFilter = '' | 'completed' | 'pending' | 'cancelled'
type TypeFilter = '' | 'project' | 'transfer' | 'scrap'
type StatsState = { total: number | null; completed: number | null; pending: number | null; cancelled: number | null; totalCost: number | null }

const EMPTY_STATS: StatsState = { total: null, completed: null, pending: null, cancelled: null, totalCost: null }

function apiStatus(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status
}

function normalizeStats(response: any): StatsState {
  const source = response?.data ?? response ?? {}
  const value = (key: keyof StatsState) => typeof source[key] === 'number' ? source[key] : null
  return { total: value('total'), completed: value('completed'), pending: value('pending'), cancelled: value('cancelled'), totalCost: value('totalCost') }
}

function validEnum<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

export default function Outbound() {
  const { get, getNumber, setMultiple } = useUrlParams()
  const initialPage = Math.max(1, getNumber('page', 1))
  const requestedPageSize = getNumber('pageSize', 10)
  const initialPageSize = [10, 20, 50, 100].includes(requestedPageSize) ? requestedPageSize : 10
  const canWrite = canAccess('outbound', 'W')

  const [quickFilter, setQuickFilter] = useState<QuickFilter>(() => validEnum(get('quickFilter'), ['all', 'today', 'week', 'month'] as const, 'all'))
  const [searchText, setSearchText] = useState(() => get('keyword'))
  const [appliedKeyword, setAppliedKeyword] = useState(() => get('keyword').trim())
  const [materialFilter, setMaterialFilter] = useState(() => get('materialId'))
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(() => validEnum(get('type'), ['', 'project', 'transfer', 'scrap'] as const, ''))
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => validEnum(get('status'), ['', 'completed', 'pending', 'cancelled'] as const, ''))
  const [startDate, setStartDate] = useState(() => get('startDate'))
  const [endDate, setEndDate] = useState(() => get('endDate'))
  const [sortField, setSortField] = useState<OutboundSortField>(() => validEnum(get('sortField'), ['createdAt', 'totalCost', 'quantity'] as const, 'createdAt'))
  const [sortOrder, setSortOrder] = useState<OutboundSortOrder>(() => get('sortOrder') === 'asc' ? 'asc' : 'desc')

  const quickFilterDates = useMemo(() => {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const weekStart = new Date(now.getTime() - now.getDay() * 86400000).toISOString().slice(0, 10)
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    if (quickFilter === 'today') return { from: today, to: today }
    if (quickFilter === 'week') return { from: weekStart, to: today }
    if (quickFilter === 'month') return { from: monthStart, to: today }
    return { from: startDate, to: endDate }
  }, [quickFilter, startDate, endDate])

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
  } = usePagination<OutboundRecord>({
    fetchFn: async ({ page: requestedPage, pageSize: requestedSize }) => {
      const response: any = await outboundApi.getList({
        page: requestedPage,
        pageSize: requestedSize,
        status: statusFilter || undefined,
        keyword: appliedKeyword || undefined,
        materialId: materialFilter || undefined,
        type: typeFilter || undefined,
        startDate: quickFilterDates.from || undefined,
        endDate: quickFilterDates.to || undefined,
        sortField,
        sortOrder,
      })
      return { list: response?.list ?? [], pagination: response?.pagination }
    },
    initialPage,
    initialPageSize,
    deps: [statusFilter, appliedKeyword, materialFilter, typeFilter, quickFilterDates.from, quickFilterDates.to, sortField, sortOrder],
  })

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 10 ? pageSize : null,
      status: statusFilter || null,
      keyword: appliedKeyword || null,
      materialId: materialFilter || null,
      type: typeFilter || null,
      startDate: startDate || null,
      endDate: endDate || null,
      quickFilter: quickFilter !== 'all' ? quickFilter : null,
      sortField: sortField !== 'createdAt' ? sortField : null,
      sortOrder: sortField !== 'createdAt' || sortOrder !== 'desc' ? sortOrder : null,
    })
  }, [page, pageSize, statusFilter, appliedKeyword, materialFilter, typeFilter, startDate, endDate, quickFilter, sortField, sortOrder, setMultiple])

  const [materials, setMaterials] = useState<Material[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [refsLoading, setRefsLoading] = useState(false)
  const [refsError, setRefsError] = useState<string | null>(null)
  const refsLoadedRef = useRef(false)
  const refsRequestRef = useRef<Promise<void> | null>(null)
  const fetchRefs = useCallback((force = false) => {
    if (refsLoadedRef.current && !force) return Promise.resolve()
    if (refsRequestRef.current) return refsRequestRef.current
    const request = (async () => {
      setRefsLoading(true)
      setRefsError(null)
      try {
        const [materialResponse, projectResponse]: any = await Promise.all([
          materialApi.getList({ page: 1, pageSize: 999, status: 'active' }),
          projectApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        ])
        setMaterials(materialResponse?.list ?? [])
        setProjects(projectResponse?.list ?? [])
        refsLoadedRef.current = true
      } catch {
        setRefsError('选项加载失败')
      } finally {
        setRefsLoading(false)
      }
    })()
    refsRequestRef.current = request
    void request.finally(() => {
      if (refsRequestRef.current === request) refsRequestRef.current = null
    })
    return request
  }, [])
  useEffect(() => { void fetchRefs() }, [fetchRefs])

  const [stats, setStats] = useState<StatsState>(EMPTY_STATS)
  const [statsError, setStatsError] = useState<string | null>(null)
  const fetchStats = useCallback(async () => {
    try {
      setStats(normalizeStats(await outboundApi.getStats()))
      setStatsError(null)
    } catch {
      setStatsError('统计加载失败')
    }
  }, [])
  useEffect(() => { void fetchStats() }, [fetchStats])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const visibleSelectedIds = useMemo(() => {
    const visible = new Set(data.map(record => record.id))
    return new Set([...selectedIds].filter(id => visible.has(id)))
  }, [data, selectedIds])
  const selectAll = data.length > 0 && data.every(record => visibleSelectedIds.has(record.id))
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  const changePage = (nextPage: number) => { clearSelection(); setPage(nextPage) }
  const changePageSize = (size: number) => { clearSelection(); setPageSize(size) }
  const toggleSelectAll = () => setSelectedIds(selectAll ? new Set() : new Set(data.map(record => record.id)))
  const toggleSelectRow = (id: string) => setSelectedIds(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const [formOpen, setFormOpen] = useState(false)
  const [editRecordId, setEditRecordId] = useState<string | null>(null)
  const [detailRecord, setDetailRecord] = useState<OutboundRecord | null>(null)
  const [deleteRecord, setDeleteRecord] = useState<OutboundRecord | null>(null)
  const [form, setForm] = useState<FormData>({ type: 'project', projectId: '', items: [{ materialId: '', quantity: 1 }], remark: '' })
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const submitRef = useRef<Promise<void> | null>(null)

  const openCreate = () => {
    if (!canWrite || error) return
    setEditRecordId(null)
    setForm({ type: 'project', projectId: '', items: [{ materialId: '', quantity: 1 }], remark: '' })
    setSubmitError(null)
    setFormOpen(true)
    void fetchRefs()
  }
  const openEdit = (record: OutboundRecord) => {
    if (!canWrite || error) return
    setEditRecordId(record.id)
    setForm({ type: record.type, projectId: record.projectId || '', items: record.items?.map(item => ({ materialId: item.materialId, quantity: item.quantity })) || [{ materialId: '', quantity: 1 }], remark: record.remark || '' })
    setSubmitError(null)
    setFormOpen(true)
    void fetchRefs()
  }
  const closeForm = useCallback(() => { if (!submitting) setFormOpen(false) }, [submitting])
  const closeDetail = useCallback(() => setDetailRecord(null), [])
  const closeDelete = useCallback(() => setDeleteRecord(null), [])

  const refreshWithStats = () => {
    clearSelection()
    refresh()
    void fetchStats()
  }

  const handleSubmit = () => {
    if (submitRef.current) return submitRef.current
    const validItems = form.items.filter(item => item.materialId && item.quantity > 0)
    if (validItems.length === 0) {
      setSubmitError('请至少填写一条物料与正数数量。')
      return Promise.resolve()
    }
    if (new Set(validItems.map(item => item.materialId)).size !== validItems.length) {
      setSubmitError('同一物料不能在一张出库单中重复添加。')
      return Promise.resolve()
    }
    const request = (async () => {
      setSubmitting(true)
      setSubmitError(null)
      try {
        const payload = { ...form, projectId: form.projectId || undefined, items: validItems }
        if (editRecordId) await outboundApi.update(editRecordId, payload)
        else await outboundApi.create(payload)
        toast.success(editRecordId ? '出库单更新成功' : '出库登记成功')
        setFormOpen(false)
        setEditRecordId(null)
        refreshWithStats()
      } catch (requestError) {
        const status = apiStatus(requestError)
        if (status === 422) setSubmitError('可用批次库存不足，整单未出库。请调整数量后重试；本次失败没有产生部分出库。')
        else if (status === 403) setSubmitError('当前账号没有出库写权限，表单已保留。')
        else setSubmitError('出库单没能提交，表单已保留，请稍后重试。')
      } finally {
        setSubmitting(false)
      }
    })()
    submitRef.current = request
    void request.finally(() => { if (submitRef.current === request) submitRef.current = null })
    return request
  }

  const handleDelete = async () => {
    if (!deleteRecord || !canWrite || error) return
    try {
      await outboundApi.delete(deleteRecord.id)
      toast.success('出库记录已删除，相关库存已由后端恢复')
      setDeleteRecord(null)
      refreshWithStats()
    } catch {
      // 全局响应拦截器保留后端原因；对话框保持打开，避免伪成功。
    }
  }

  const handleSort = (field: OutboundSortField) => {
    clearSelection()
    setSortOrder(current => sortField === field ? current === 'asc' ? 'desc' : 'asc' : 'asc')
    setSortField(field)
    setPage(1)
  }
  const applySearch = () => { clearSelection(); setAppliedKeyword(searchText.trim()); setPage(1) }
  const changeQuickFilter = (filter: QuickFilter) => { clearSelection(); setQuickFilter(filter); setPage(1) }
  const resetFilters = () => {
    clearSelection(); setSearchText(''); setAppliedKeyword(''); setMaterialFilter(''); setTypeFilter(''); setStatusFilter(''); setStartDate(''); setEndDate(''); setQuickFilter('all'); setPage(1)
  }

  const handlePrintRecord = (record: OutboundRecord) => printOutboundRecord(record)
  const batchPrint = () => {
    if (visibleSelectedIds.size === 0) return toast.error('请先选择要打印的记录')
    data.filter(record => visibleSelectedIds.has(record.id)).forEach((record, index) => setTimeout(() => handlePrintRecord(record), index * 500))
  }
  const batchExport = async () => {
    const exportData = visibleSelectedIds.size ? data.filter(record => visibleSelectedIds.has(record.id)) : data
    if (!exportData.length) return toast.error('没有可导出的记录')
    try {
      const XLSX = await import('xlsx')
      const rows = exportData.map(record => ({
        出库单号: record.outboundNo,
        类型: record.type,
        项目: record.projectName || '公共成本',
        物料与批次分配: record.items?.map(item => `${item.materialName || item.materialId}/${item.batchNo || '批次未提供'}×${item.quantity}`).join(', ') || '未提供',
        总金额: typeof record.totalCost === 'number' ? record.totalCost : '未提供',
        操作人: record.operator || '未提供',
        出库时间: formatDateTime(record.createdAt),
        状态: record.status,
        备注: record.remark || '',
      }))
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '出库记录')
      XLSX.writeFile(workbook, `出库记录_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
      toast.success('导出成功', { description: `已导出 ${rows.length} 条记录` })
    } catch {
      toast.error('导出失败')
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">出库记录</h1>
          <p className="mt-1 text-sm text-gray-500">登记整单出库，并在成功后核对全部 FEFO 批次分配</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={batchPrint} className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"><Printer className="h-4 w-4" />打印已选</button>
          {canWrite && <button type="button" onClick={openCreate} disabled={Boolean(error)} className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-4 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"><Package className="h-4 w-4" />出库登记</button>}
        </div>
      </header>

      {!canWrite && <div role="note" className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">你可以查看出库记录，但当前账号没有出库写权限。</div>}

      <OutboundStats stats={stats} error={statsError} statusFilter={statusFilter} onStatusChange={status => { clearSelection(); setStatusFilter(status); setPage(1) }} onRetry={fetchStats} />
      <OutboundQuickFilters quickFilter={quickFilter} onChange={changeQuickFilter} />

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm" aria-labelledby="outbound-list-title">
        <OutboundFilterBar
          searchText={searchText}
          materialFilter={materialFilter}
          typeFilter={typeFilter}
          statusFilter={statusFilter}
          startDate={startDate}
          endDate={endDate}
          materials={materials}
          onSearchChange={setSearchText}
          onMaterialChange={value => { clearSelection(); setMaterialFilter(value); setPage(1) }}
          onTypeChange={value => { clearSelection(); setTypeFilter(value); setPage(1) }}
          onStatusChange={value => { clearSelection(); setStatusFilter(value); setPage(1) }}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onQuery={applySearch}
          onReset={resetFilters}
        />

        {error && data.length === 0 ? (
          <div role="alert" className="flex flex-col items-center px-4 py-14 text-center">
            <div className="font-medium text-gray-900">出库记录没能加载</div>
            <div className="mt-1 text-sm text-gray-500">请求失败没有被当成空记录。</div>
            <button type="button" aria-label="重新加载出库记录" onClick={refresh} className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-4 text-sm font-medium text-white hover:bg-blue-600"><RefreshCw className="h-4 w-4" />重新加载</button>
          </div>
        ) : (
          <>
            {error && <div role="alert" className="flex flex-col gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between"><span>当前显示上次成功加载的陈旧数据；刷新成功前已停用编辑和删除。</span><button type="button" onClick={refresh} className="font-medium underline">重新加载出库记录</button></div>}
            <OutboundTable
              loading={loading}
              stale={Boolean(error)}
              canWrite={canWrite}
              data={data}
              selectedIds={visibleSelectedIds}
              selectAll={selectAll}
              total={total}
              page={page}
              pageSize={pageSize}
              sortField={sortField}
              sortOrder={sortOrder}
              onSort={handleSort}
              onToggleSelectAll={toggleSelectAll}
              onToggleSelectRow={toggleSelectRow}
              onClearSelection={clearSelection}
              onPageChange={changePage}
              onPageSizeChange={changePageSize}
              onOpenDetail={setDetailRecord}
              onOpenEdit={openEdit}
              onOpenDelete={setDeleteRecord}
              onPrintRecord={handlePrintRecord}
              onBatchExport={batchExport}
              onBatchPrint={batchPrint}
            />
          </>
        )}
      </section>

      <OutboundFormModal open={formOpen} editRecordId={editRecordId} form={form} materials={materials} projects={projects} refsLoading={refsLoading} refsError={refsError} submitting={submitting} submitError={submitError} onClose={closeForm} onSubmit={handleSubmit} onRetryRefs={() => fetchRefs(true)} onFormChange={setForm} />
      <OutboundDetailModal open={Boolean(detailRecord)} record={detailRecord} onClose={closeDetail} onPrint={handlePrintRecord} />
      <OutboundDeleteModal open={Boolean(deleteRecord)} record={deleteRecord} onDelete={handleDelete} onClose={closeDelete} />
    </div>
  )
}
