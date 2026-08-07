import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { inventoryApi } from '@/api/inventory'
import {
  apiErrorCode,
  stocktakingApi,
  type StocktakingDetail,
  type StocktakingRecord,
} from '@/api/stocktaking'
import { canAccess } from '@/lib/permissions'
import { useUrlParams } from '@/hooks/useUrlParams'

export type StocktakingModal = 'create' | 'detail' | 'adjust' | 'reverse' | 'flow' | null

export interface StocktakingPositionOption {
  id: string
  version: number
  materialId: string
  materialCode: string
  materialName: string
  unit: string
  batchId: string | null
  batchNo: string | null
  locationId: string
  locationName: string
  quantity: number
}

export interface StockConflict {
  record: StocktakingDetail
  currentStock: number | null
  currentPosition: StocktakingPositionOption | null
  refreshed: boolean
}

export const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待处理' },
  { value: 'adjusted', label: '已调整' },
  { value: 'compensated', label: '已撤销调整' },
  { value: 'completed', label: '账实相符' },
  { value: 'unresolved', label: '批次或库位待核实' },
]

export const stocktakingStatusDisplay: Record<string, { label: string; cls: string }> = {
  pending: { label: '待处理', cls: 'bg-amber-50 text-amber-700' },
  adjusted: { label: '已调整', cls: 'bg-blue-50 text-blue-700' },
  compensated: { label: '已撤销调整', cls: 'bg-gray-100 text-gray-700' },
  completed: { label: '账实相符', cls: 'bg-emerald-50 text-emerald-700' },
  unresolved: { label: '待核实', cls: 'bg-orange-50 text-orange-700' },
  cancelled: { label: '已取消', cls: 'bg-gray-100 text-gray-500' },
}

export function getStocktakingStatusDisplay(status: string) {
  return stocktakingStatusDisplay[status] ?? { label: status || '-', cls: 'bg-gray-100 text-gray-600' }
}

export function quantityUnits(value: number): number {
  return Math.round(value * 10000)
}

export function formatQuantity(value: number): string {
  const fixed = (quantityUnits(value) / 10000).toFixed(4)
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

export function parseQuantityInput(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function flattenPositions(items: Awaited<ReturnType<typeof inventoryApi.getList>>['list']) {
  return items.flatMap<StocktakingPositionOption>(item => (item.positions ?? []).map(position => ({
    id: position.id,
    version: position.version,
    materialId: item.materialId,
    materialCode: item.code,
    materialName: item.name,
    unit: item.unit,
    batchId: position.batchId,
    batchNo: position.batchNo,
    locationId: position.locationId,
    locationName: position.locationName,
    quantity: Number(position.quantity),
  })))
}

export function useStocktakingPage() {
  const { get, getNumber, setMultiple } = useUrlParams()
  const queryClient = useQueryClient()
  const initialPage = Math.max(1, getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20
  const [page, setPage] = useState(initialPage)
  const [pageSize, setPageSizeState] = useState(initialPageSize)
  const [keyword, setKeyword] = useState(get('keyword', ''))
  const [appliedKeyword, setAppliedKeyword] = useState(keyword)
  const [statusFilter, setStatusFilter] = useState(get('status', ''))
  const [modal, setModal] = useState<StocktakingModal>(null)
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [createStep, setCreateStep] = useState<1 | 2 | 3>(1)
  const [positionKeyword, setPositionKeyword] = useState('')
  const deferredPositionKeyword = useDeferredValue(positionKeyword)
  const [selectedPositionId, setSelectedPositionId] = useState('')
  const [actualStock, setActualStock] = useState('')
  const [remark, setRemark] = useState('')
  const [adjustReason, setAdjustReason] = useState('pending')
  const [explanation, setExplanation] = useState('')
  const [reverseReason, setReverseReason] = useState('')
  const [conflict, setConflict] = useState<StockConflict | null>(null)

  const canRecord = canAccess('stocktaking', 'W')
  const canAdjust = canAccess('stocktaking_adjust', 'W')
  const canReverse = canAccess('stocktaking_reverse', 'W')

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: appliedKeyword || null,
      status: statusFilter || null,
    })
  }, [page, pageSize, appliedKeyword, statusFilter, setMultiple])

  const listQuery = useQuery({
    queryKey: ['stocktaking', 'list', page, pageSize, appliedKeyword, statusFilter],
    queryFn: () => stocktakingApi.getList({
      page,
      pageSize,
      keyword: appliedKeyword || undefined,
      status: statusFilter || undefined,
    }),
  })
  const statsQuery = useQuery({
    queryKey: ['stocktaking', 'stats'],
    queryFn: stocktakingApi.getStats,
  })
  const positionsQuery = useQuery({
    queryKey: ['inventory', 'stocktaking-positions', deferredPositionKeyword],
    queryFn: () => inventoryApi.getList({
      page: 1,
      pageSize: 200,
      keyword: deferredPositionKeyword || undefined,
    }),
    enabled: modal === 'create',
  })
  const detailQuery = useQuery({
    queryKey: ['stocktaking', 'detail', detailId],
    queryFn: () => stocktakingApi.getDetail(detailId!),
    enabled: Boolean(detailId && ['detail', 'adjust', 'reverse'].includes(modal ?? '')),
  })

  const positions = useMemo(
    () => flattenPositions(positionsQuery.data?.list ?? []),
    [positionsQuery.data],
  )
  const selectedPosition = positions.find(position => position.id === selectedPositionId) ?? null

  async function refreshAll(recordId?: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['stocktaking', 'list'] }),
      queryClient.invalidateQueries({ queryKey: ['stocktaking', 'stats'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory'] }),
      recordId
        ? queryClient.invalidateQueries({ queryKey: ['stocktaking', 'detail', recordId] })
        : Promise.resolve(),
    ])
  }

  const createMutation = useMutation({
    mutationFn: stocktakingApi.create,
    onSuccess: async result => {
      await refreshAll(result.id)
      toast.success(result.status === 'completed'
        ? '盘点已保存，账实相符'
        : '盘点已保存，当前库存未调整')
      setDetailId(result.id)
      setModal('detail')
    },
    onError: async error => {
      if (apiErrorCode(error) !== 'STOCK_CHANGED') return
      setSelectedPositionId('')
      setCreateStep(1)
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'stocktaking-positions'] })
      toast.error('该库存位置刚刚发生了变化，请重新选择并确认后再保存')
    },
  })
  const adjustMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => stocktakingApi.adjust(id, reason),
    onSuccess: async result => {
      await refreshAll(result.id)
      toast.success('库存已按盘点结果调整')
      setModal('detail')
    },
    onError: async error => {
      if (apiErrorCode(error) !== 'STOCK_CHANGED' || !detailQuery.data) return
      setConflict({ record: detailQuery.data, currentStock: null, currentPosition: null, refreshed: false })
      setModal(null)
      await refreshAll(detailQuery.data.id)
    },
  })
  const explanationMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => stocktakingApi.appendExplanation(id, text),
    onSuccess: async (_, input) => {
      setExplanation('')
      await refreshAll(input.id)
      toast.success('说明已补充，原操作记录未更改')
    },
  })
  const reverseMutation = useMutation({
    mutationFn: ({ id, eventId, reason }: { id: string; eventId: string; reason: string }) =>
      stocktakingApi.reverse(id, eventId, reason),
    onSuccess: async result => {
      setReverseReason('')
      await refreshAll(result.id)
      toast.success(result.status === 'adjusted' ? '原调整已恢复' : '库存调整已撤销')
      setModal('detail')
    },
  })

  function openCreate(position?: StocktakingPositionOption, desiredActual?: number) {
    if (modal === null && document.activeElement instanceof HTMLElement) setReturnFocus(document.activeElement)
    setCreateStep(1)
    setPositionKeyword(position?.materialCode ?? '')
    setSelectedPositionId(position?.id ?? '')
    setActualStock(desiredActual === undefined ? '' : formatQuantity(desiredActual))
    setRemark('')
    setModal('create')
  }

  function openDetail(record: StocktakingRecord) {
    if (modal === null && document.activeElement instanceof HTMLElement) setReturnFocus(document.activeElement)
    setDetailId(record.id)
    setModal('detail')
  }

  function openAdjust(record: StocktakingRecord | StocktakingDetail) {
    if (modal === null && document.activeElement instanceof HTMLElement) setReturnFocus(document.activeElement)
    setDetailId(record.id)
    setAdjustReason('pending')
    setModal('adjust')
  }

  function openReverse(record: StocktakingDetail) {
    setDetailId(record.id)
    setReverseReason('')
    setModal('reverse')
  }

  function openFlow() {
    if (modal === null && document.activeElement instanceof HTMLElement) setReturnFocus(document.activeElement)
    setModal('flow')
  }

  function submitCreate() {
    const actual = parseQuantityInput(actualStock)
    if (!selectedPosition) return toast.error('请选择库存位置')
    if (actual === null) return toast.error('实盘数量不能小于 0，且最多保留 4 位小数')
    createMutation.mutate({
      materialId: selectedPosition.materialId,
      positionId: selectedPosition.id,
      batchId: selectedPosition.batchId,
      locationId: selectedPosition.locationId,
      expectedPositionVersion: selectedPosition.version,
      expectedSystemStock: selectedPosition.quantity,
      actualStock: actual,
      remark: remark.trim() || undefined,
    })
  }

  function submitAdjust() {
    if (!detailQuery.data) return
    adjustMutation.mutate({ id: detailQuery.data.id, reason: adjustReason })
  }

  function submitExplanation() {
    if (!detailQuery.data || !explanation.trim()) return
    explanationMutation.mutate({ id: detailQuery.data.id, text: explanation.trim() })
  }

  function submitReverse() {
    const detail = detailQuery.data
    if (!detail?.latestEventId || !reverseReason.trim()) return
    reverseMutation.mutate({ id: detail.id, eventId: detail.latestEventId, reason: reverseReason.trim() })
  }

  async function refreshConflict() {
    if (!conflict) return
    const [record, inventory] = await Promise.all([
      stocktakingApi.getDetail(conflict.record.id),
      inventoryApi.getList({ page: 1, pageSize: 200, keyword: conflict.record.materialCode }),
    ])
    const currentPosition = flattenPositions(inventory.list)
      .find(position => position.id === conflict.record.positionId) ?? null
    setConflict({
      record,
      currentStock: record.currentStock,
      currentPosition,
      refreshed: true,
    })
  }

  function recountConflict() {
    if (!conflict?.currentPosition) {
      toast.error('该库存位置已不存在，请联系管理员核实批次和库位')
      return
    }
    const { currentPosition, record } = conflict
    setConflict(null)
    openCreate(currentPosition, record.actualStock)
  }

  return {
    data: listQuery.data?.list ?? [],
    total: listQuery.data?.pagination.total ?? 0,
    loading: listQuery.isLoading,
    error: listQuery.isError,
    retryList: listQuery.refetch,
    stats: statsQuery.data ?? { todayCount: 0, pendingCount: 0, adjustedCount: 0, unresolvedCount: 0 },
    page,
    setPage,
    pageSize,
    setPageSize: (size: number) => { setPageSizeState(size); setPage(1) },
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter: (status: string) => { setStatusFilter(status); setPage(1) },
    applyFilters: () => { setAppliedKeyword(keyword.trim()); setPage(1) },
    resetFilters: () => { setKeyword(''); setAppliedKeyword(''); setStatusFilter(''); setPage(1) },
    modal,
    setModal,
    returnFocus,
    canRecord,
    canAdjust,
    canReverse,
    detail: detailQuery.data ?? null,
    detailLoading: detailQuery.isLoading,
    createStep,
    setCreateStep,
    positions,
    positionsLoading: positionsQuery.isLoading,
    positionKeyword,
    setPositionKeyword,
    selectedPositionId,
    setSelectedPositionId,
    selectedPosition,
    actualStock,
    setActualStock,
    remark,
    setRemark,
    adjustReason,
    setAdjustReason,
    explanation,
    setExplanation,
    reverseReason,
    setReverseReason,
    conflict,
    setConflict,
    openCreate,
    openDetail,
    openAdjust,
    openReverse,
    openFlow,
    submitCreate,
    submitAdjust,
    submitExplanation,
    submitReverse,
    refreshConflict,
    recountConflict,
    createSubmitting: createMutation.isPending,
    adjustSubmitting: adjustMutation.isPending,
    explanationSubmitting: explanationMutation.isPending,
    reverseSubmitting: reverseMutation.isPending,
  }
}

export type { StocktakingDetail, StocktakingRecord }
