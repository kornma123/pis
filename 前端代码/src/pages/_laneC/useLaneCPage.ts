import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { materialApi, locationApi } from '@/api/master'
import { canAccess } from '@/lib/permissions'
import type { Material, Location } from '@/types'
import type { LaneCConfig, LaneCRecord, LaneCForm, LaneCListPayload, SortField, SortOrder } from './types'
import { emptyForm } from './types'
import {
  asLaneCRequestError,
  classifyRequestFailure,
  parseLaneCListPayload,
  parseLaneCStatsPayload,
  parseLocationsPayload,
  parseMaterialsPayload,
  requestFailureMessage,
  type RequestTruth,
} from './requestTruth'
import type { LaneCStats } from '@/api/inventory'

const PAGE_SIZES = [10, 20, 50, 100]

function truthData<T>(state: RequestTruth<T>): T | undefined {
  return state.status === 'ready' || state.status === 'stale' ? state.data : undefined
}

function referenceBlockedReason<T>(
  state: RequestTruth<T[]>,
  label: string,
  noun: string,
): string | null {
  if (state.status === 'loading') return `${label}正在加载，暂不能登记${noun}`
  if (state.status === 'error') return `${requestFailureMessage(state.failure, label)}，暂不能登记${noun}`
  if (state.status === 'stale') return `${label}刷新失败，当前仅有上次成功结果，暂不能登记${noun}`
  if (state.data.length === 0) return `当前没有可用${label.replace('选项', '')}，暂不能登记${noun}`
  return null
}

export function useLaneCPage(config: LaneCConfig) {
  const url = useUrlParams()
  const canView = canAccess(config.module, 'R')
  const canWrite = canAccess(config.module, 'W')

  const [materialsState, setMaterialsState] = useState<RequestTruth<Material[]>>({ status: 'loading' })
  const [locationsState, setLocationsState] = useState<RequestTruth<Location[]>>(
    config.needsLocations ? { status: 'loading' } : { status: 'ready', data: [] },
  )
  const [statsState, setStatsState] = useState<RequestTruth<LaneCStats>>({ status: 'loading' })
  const [listState, setListState] = useState<RequestTruth<LaneCListPayload>>({ status: 'loading' })

  const materialsSuccessRef = useRef<{ module: string; data: Material[] } | null>(null)
  const locationsSuccessRef = useRef<{ module: string; data: Location[] } | null>(null)
  const statsSuccessRef = useRef<{ module: string; data: LaneCStats } | null>(null)
  const listSuccessRef = useRef<{ key: string; data: LaneCListPayload } | null>(null)

  // ---- 筛选/排序状态（初值从 URL 读，刷新可复现） ----
  const [searchKeyword, setSearchKeywordRaw] = useState(url.get('keyword', ''))
  const [filterReason, setFilterReasonRaw] = useState(url.get('reason', ''))
  const [filterLocation, setFilterLocationRaw] = useState(url.get('locationId', ''))
  const [filterStartDate, setFilterStartDateRaw] = useState(url.get('startDate', ''))
  const [filterEndDate, setFilterEndDateRaw] = useState(url.get('endDate', ''))
  const [activeQuickFilter, setActiveQuickFilterRaw] = useState(url.get('quickFilter', 'all') || 'all')
  const [sortField, setSortField] = useState<SortField | ''>((url.get('sortField', '') as SortField) || '')
  const [sortOrder, setSortOrder] = useState<SortOrder>((url.get('sortOrder', 'desc') as SortOrder) || 'desc')

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [modalType, setModalType] = useState<null | 'create' | 'detail'>(null)
  const [selectedRecord, setSelectedRecord] = useState<LaneCRecord | null>(null)
  const [form, setForm] = useState<LaneCForm>(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [confirmModal, setConfirmModal] = useState<{ open: boolean; title: string; message: string; onConfirm?: () => void }>(
    { open: false, title: '', message: '' },
  )

  const initialPage = Math.max(1, url.getNumber('page', 1))
  const initialPageSize = PAGE_SIZES.includes(url.getNumber('pageSize', 20)) ? url.getNumber('pageSize', 20) : 20

  // ---- 快速筛选 → 日期范围（与入库页同款算法） ----
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

  const effectiveKeyword = searchKeyword || undefined
  const effectiveReason = (config.filterKind === 'reason' ? filterReason : '') || undefined
  const effectiveLocation = (config.filterKind === 'location' ? filterLocation : '') || undefined
  const effectiveStart = quickFilterDates.startDate || undefined
  const effectiveEnd = quickFilterDates.endDate || undefined
  const effectiveSortField = sortField || undefined
  const effectiveSortOrder = sortField ? sortOrder : undefined

  const fetchFn = useCallback(async ({ page, pageSize }: { page: number; pageSize: number }) => {
    const key = JSON.stringify([
      config.module, page, pageSize, effectiveKeyword, effectiveReason, effectiveLocation,
      effectiveStart, effectiveEnd, effectiveSortField, effectiveSortOrder,
    ])
    setListState({ status: 'loading' })

    try {
      if (!canView) throw asLaneCRequestError({ response: { status: 403 } })
      const response: unknown = await config.api.getList({
        page, pageSize,
        keyword: effectiveKeyword,
        reason: effectiveReason,
        locationId: effectiveLocation,
        startDate: effectiveStart,
        endDate: effectiveEnd,
        sortField: effectiveSortField,
        sortOrder: effectiveSortOrder,
      })
      const parsed = parseLaneCListPayload(response)
      listSuccessRef.current = { key, data: parsed }
      setListState({ status: 'ready', data: parsed })
      return parsed
    } catch (error) {
      const requestError = asLaneCRequestError(error)
      const previous = listSuccessRef.current
      setListState(previous?.key === key
        ? { status: 'stale', data: previous.data, failure: requestError.failure }
        : { status: 'error', failure: requestError.failure })
      throw requestError
    }
  }, [
    canView, config.api, config.module, effectiveKeyword, effectiveReason, effectiveLocation,
    effectiveStart, effectiveEnd, effectiveSortField, effectiveSortOrder,
  ])

  const { page, pageSize, setPage, setPageSize, refresh } = usePagination<LaneCRecord>({
    fetchFn,
    initialPage,
    initialPageSize,
    deps: [
      canView, config.module, effectiveKeyword, effectiveReason, effectiveLocation,
      effectiveStart, effectiveEnd, effectiveSortField, effectiveSortOrder,
    ],
  })

  // ---- 引用数据与统计：四条请求独立保留真值 ----
  const retryMaterials = useCallback(async () => {
    if (!canView) return
    setMaterialsState({ status: 'loading' })
    try {
      const parsed = parseMaterialsPayload(await materialApi.getList({ page: 1, pageSize: 999, status: 'active' }))
      materialsSuccessRef.current = { module: config.module, data: parsed }
      setMaterialsState({ status: 'ready', data: parsed })
    } catch (error) {
      const failure = classifyRequestFailure(error)
      const previous = materialsSuccessRef.current
      setMaterialsState(previous?.module === config.module
        ? { status: 'stale', data: previous.data, failure }
        : { status: 'error', failure })
    }
  }, [canView, config.module])

  const retryLocations = useCallback(async () => {
    if (!canView) return
    if (!config.needsLocations) {
      setLocationsState({ status: 'ready', data: [] })
      return
    }
    setLocationsState({ status: 'loading' })
    try {
      const parsed = parseLocationsPayload(await locationApi.getList({ page: 1, pageSize: 999, status: 'active' }))
      locationsSuccessRef.current = { module: config.module, data: parsed }
      setLocationsState({ status: 'ready', data: parsed })
    } catch (error) {
      const failure = classifyRequestFailure(error)
      const previous = locationsSuccessRef.current
      setLocationsState(previous?.module === config.module
        ? { status: 'stale', data: previous.data, failure }
        : { status: 'error', failure })
    }
  }, [canView, config.module, config.needsLocations])

  const retryStats = useCallback(async () => {
    if (!canView) return
    setStatsState({ status: 'loading' })
    try {
      const parsed = parseLaneCStatsPayload(await config.api.getStats())
      statsSuccessRef.current = { module: config.module, data: parsed }
      setStatsState({ status: 'ready', data: parsed })
    } catch (error) {
      const failure = classifyRequestFailure(error)
      const previous = statsSuccessRef.current
      setStatsState(previous?.module === config.module
        ? { status: 'stale', data: previous.data, failure }
        : { status: 'error', failure })
    }
  }, [canView, config.api, config.module])

  useEffect(() => {
    void retryMaterials()
    void retryLocations()
    void retryStats()
  }, [retryMaterials, retryLocations, retryStats])

  // ---- URL 同步（所有筛选/排序/分页写回，null 即删除） ----
  useEffect(() => {
    url.setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: searchKeyword || null,
      reason: config.filterKind === 'reason' ? (filterReason || null) : null,
      locationId: config.filterKind === 'location' ? (filterLocation || null) : null,
      startDate: filterStartDate || null,
      endDate: filterEndDate || null,
      quickFilter: activeQuickFilter !== 'all' ? activeQuickFilter : null,
      sortField: sortField || null,
      sortOrder: sortField ? sortOrder : null,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, searchKeyword, filterReason, filterLocation, filterStartDate, filterEndDate, activeQuickFilter, sortField, sortOrder])

  const listPayload = truthData(listState)
  const data = listPayload?.list ?? []
  const total = listPayload?.pagination.total ?? 0
  const materials = truthData(materialsState) ?? []
  const locations = truthData(locationsState) ?? []

  // ---- 包装 setter：改筛选 → 回第 1 页 + 清空批量勾选 ----
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  const wrap = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1); clearSelection() }
  const setSearchKeyword = wrap(setSearchKeywordRaw)
  const setFilterReason = wrap(setFilterReasonRaw)
  const setFilterLocation = wrap(setFilterLocationRaw)
  const setFilterStartDate = wrap((v: string) => { setFilterStartDateRaw(v); setActiveQuickFilterRaw('all') })
  const setFilterEndDate = wrap((v: string) => { setFilterEndDateRaw(v); setActiveQuickFilterRaw('all') })
  const setActiveQuickFilter = wrap(setActiveQuickFilterRaw)

  const handleResetFilters = () => {
    setSearchKeywordRaw(''); setFilterReasonRaw(''); setFilterLocationRaw('')
    setFilterStartDateRaw(''); setFilterEndDateRaw(''); setActiveQuickFilterRaw('all')
    setSortField(''); setSortOrder('desc')
    setPage(1); clearSelection()
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortOrder(order => (order === 'asc' ? 'desc' : 'asc'))
    else { setSortField(field); setSortOrder('desc') }
    clearSelection()
  }

  // ---- 批量勾选 ----
  const toggleSelectAll = () => {
    if (selectedIds.size === data.length && data.length > 0) setSelectedIds(new Set())
    else setSelectedIds(new Set(data.map(record => record.id)))
  }
  const toggleSelectOne = (id: string) => {
    const next = new Set(selectedIds)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelectedIds(next)
  }
  const isAllSelected = data.length > 0 && selectedIds.size === data.length
  const isIndeterminate = selectedIds.size > 0 && selectedIds.size < data.length

  const materialBlockedReason = referenceBlockedReason(materialsState, '物料选项', config.noun)
  const locationBlockedReason = config.needsLocations
    ? referenceBlockedReason(locationsState, '库位选项', config.noun)
    : null
  const createBlockedReason = materialBlockedReason || locationBlockedReason
  const canCreate = canWrite && createBlockedReason === null
  const canMutateList = canWrite && listState.status === 'ready'

  // ---- 弹窗 ----
  const openCreate = () => {
    if (!canCreate) {
      if (createBlockedReason) toast.error(createBlockedReason)
      return
    }
    setForm(emptyForm); setSelectedRecord(null); setModalType('create')
  }
  const openDetail = (record: LaneCRecord) => { setSelectedRecord(record); setModalType('detail') }
  const closeModal = () => { setModalType(null); setSelectedRecord(null) }
  const closeConfirmModal = () => setConfirmModal({ open: false, title: '', message: '' })

  // ---- 登记 ----
  const handleCreate = async () => {
    if (!canCreate) {
      if (createBlockedReason) toast.error(createBlockedReason)
      return
    }
    const error = config.validateCreate(form)
    if (error) { toast.error(error); return }
    setSubmitting(true)
    try {
      await config.api.create(form)
      toast.success(`${config.noun}登记成功`)
      closeModal()
      setForm(emptyForm)
      refresh(); void retryStats()
    } catch {
      /* 全局响应拦截器统一处理；本页不展示内部错误文本。 */
    } finally { setSubmitting(false) }
  }

  // ---- 撤销（单条，走危险二次确认） ----
  const handleDelete = (row: LaneCRecord) => {
    if (!canMutateList) {
      toast.error(`当前${config.noun}记录不是最新的已验证结果，暂不能撤销`)
      return
    }
    const no = row.returnNo || row.scrapNo || row.inboundNo || row.id
    setConfirmModal({
      open: true,
      title: `确认撤销${config.noun}`,
      message: `确定撤销 ${no} 吗？撤销后库存将按相反方向回滚。`,
      onConfirm: async () => {
        try {
          await config.api.remove(row.id)
          toast.success(`${config.noun}记录已撤销`)
          refresh(); void retryStats(); clearSelection()
        } catch { /* 全局拦截器统一处理。 */ }
      },
    })
  }

  // ---- 批量撤销（逐条执行，汇总成功/失败） ----
  const handleBatchDelete = () => {
    if (!canMutateList) {
      toast.error(`当前${config.noun}记录不是最新的已验证结果，暂不能撤销`)
      return
    }
    const ids = data.filter(record => selectedIds.has(record.id)).map(record => record.id)
    if (!ids.length) return
    setConfirmModal({
      open: true,
      title: `批量撤销${config.noun}`,
      message: `将撤销选中的 ${ids.length} 条记录。逐条执行，完成后汇总结果。`,
      onConfirm: async () => {
        let ok = 0, fail = 0
        for (const id of ids) {
          try { await config.api.remove(id); ok++ } catch { fail++ }
        }
        if (fail === 0) toast.success(`已撤销 ${ok} 条`)
        else toast.warning(`${ok} 条撤销成功，${fail} 条失败（多为库存不足）`)
        refresh(); void retryStats(); clearSelection()
      },
    })
  }

  // ---- 导出 Excel（有勾选导出勾选，否则导出当前页） ----
  const handleBatchExport = async () => {
    const rows = selectedIds.size > 0 ? data.filter(record => selectedIds.has(record.id)) : data
    if (rows.length === 0) { toast.error('没有可导出的数据'); return }
    try {
      const XLSX = await import('xlsx')
      const sheet = rows.map(record => config.exportRow(record, { materials }))
      const ws = XLSX.utils.json_to_sheet(sheet)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, config.exportSheet)
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      XLSX.writeFile(wb, `${config.exportFileName}_${dateStr}.xlsx`)
      toast.success('导出成功', { description: `已导出 ${rows.length} 条记录` })
    } catch { toast.error('导出失败') }
  }

  const isFilterActive = !!(searchKeyword || filterReason || filterLocation || filterStartDate || filterEndDate || activeQuickFilter !== 'all')

  return {
    config, canView, canWrite, canCreate, canMutateList, createBlockedReason,
    materials, locations, materialsState, locationsState, statsState, listState,
    data, page, pageSize, total, setPage, setPageSize, refresh,
    retryStats, retryMaterials, retryLocations,
    searchKeyword, setSearchKeyword,
    filterReason, setFilterReason,
    filterLocation, setFilterLocation,
    filterStartDate, setFilterStartDate,
    filterEndDate, setFilterEndDate,
    activeQuickFilter, setActiveQuickFilter,
    sortField, sortOrder, toggleSort,
    handleResetFilters, isFilterActive,
    selectedIds, toggleSelectAll, toggleSelectOne, isAllSelected, isIndeterminate, clearSelection,
    modalType, selectedRecord, form, setForm, submitting,
    openCreate, openDetail, closeModal,
    handleCreate, handleDelete, handleBatchDelete, handleBatchExport,
    confirmModal, closeConfirmModal,
  }
}

export type LaneCPageState = ReturnType<typeof useLaneCPage>
