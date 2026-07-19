import { useState, useEffect, useMemo } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import request from '@/api/request'
import type { Alert } from '@/types'
import { toast } from 'sonner'

export interface AlertItem extends Alert {
  batchNo?: string
  ruleId?: string
  triggerCondition?: string
  projectName?: string
}

export type AlertTypeFilter = 'all' | 'low-stock' | 'expiry'
export type AlertStatusFilter = 'all' | 'pending' | 'processed' | 'ignored'

export interface FilterState {
  keyword: string
  type: AlertTypeFilter
  status: AlertStatusFilter
  dateRange: [string, string]
}

export interface ModalState {
  type: 'handle' | 'detail' | null
  alert: AlertItem | null
}

export type GenerationEvidence =
  | { status: 'connected'; generatedCount: number; generatedAt: string }
  | { status: 'unknown'; generatedAt: string }

export const ALERT_TYPE_MAP: Record<string, { label: string; bg: string; text: string }> = {
  'low-stock': { label: '库存不足', bg: 'bg-red-50', text: 'text-red-600' },
  'expiry': { label: '即将过期', bg: 'bg-yellow-50', text: 'text-yellow-600' },
}

export const STATUS_MAP: Record<string, { label: string; bg: string; text: string }> = {
  'pending': { label: '待处理', bg: 'bg-yellow-50', text: 'text-yellow-700' },
  'processed': { label: '已处理', bg: 'bg-green-50', text: 'text-green-700' },
  'ignored': { label: '已忽略', bg: 'bg-gray-50', text: 'text-gray-600' },
}

// 处理结果选项 → 备注前缀：后端只有单一 remark 字段，故把「处理结果」+「处理意见」
// 组装成一条可读备注一起落库（覆盖低库存/过期弹窗与消耗异常弹窗两套选项）。
export const RESULT_LABEL_MAP: Record<string, string> = {
  purchased: '已采购补货',
  adjusted: '调整阈值',
  ignored: '忽略预警',
  normal: '标记为正常波动',
  observe: '关注观察',
  optimize: '需优化流程',
  adjust: '调整预警阈值',
}

export function useAlertsPage() {
  const { get, getNumber, setMultiple } = useUrlParams()

  const initialPage = Math.max(1, getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 10))
    ? getNumber('pageSize', 10)
    : 10
  const typeParam = get('type', 'all')
  const initialType: AlertTypeFilter = ['all', 'low-stock', 'expiry'].includes(typeParam)
    ? typeParam as AlertTypeFilter
    : 'all'
  const statusParam = get('status', 'all')
  const initialStatus: AlertStatusFilter = ['all', 'pending', 'processed', 'ignored'].includes(statusParam)
    ? statusParam as AlertStatusFilter
    : 'all'
  const quickFilterParam = get('quickFilter', 'all')
  const initialQuickFilter: AlertStatusFilter = ['all', 'pending', 'processed', 'ignored'].includes(quickFilterParam)
    ? quickFilterParam as AlertStatusFilter
    : 'all'

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [modal, setModal] = useState<ModalState>({ type: null, alert: null })
  const [filter, setFilter] = useState<FilterState>({
    keyword: get('keyword', ''),
    type: initialType,
    status: initialStatus,
    dateRange: [get('startDate', ''), get('endDate', '')] as [string, string],
  })
  const [quickFilter, setQuickFilter] = useState<AlertStatusFilter>(initialQuickFilter)
  const [generating, setGenerating] = useState(false)
  const [generationEvidence, setGenerationEvidence] = useState<GenerationEvidence | null>(null)
  const [handleForm, setHandleForm] = useState({
    opinion: '',
    result: 'purchased',
  })
  const [handleError, setHandleError] = useState('')

  const effectiveStatus = quickFilter !== 'all'
    ? quickFilter
    : filter.status !== 'all'
      ? filter.status
      : undefined
  const effectiveType = filter.type !== 'all' ? filter.type : undefined

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
  } = usePagination<AlertItem>({
    fetchFn: async (params) => {
      const res: any = await request.get('/alerts', {
        params: {
          ...params,
          keyword: filter.keyword || undefined,
          type: effectiveType,
          status: effectiveStatus,
          startDate: filter.dateRange[0] || undefined,
          endDate: filter.dateRange[1] || undefined,
        },
      })
      return {
        list: res?.list || [],
        pagination: res?.pagination,
      }
    },
    initialPage,
    initialPageSize,
    deps: [
      filter.keyword,
      filter.type,
      filter.status,
      filter.dateRange[0],
      filter.dateRange[1],
      quickFilter,
    ],
  })

  // URL 同步
  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 10 ? pageSize : null,
      keyword: filter.keyword || null,
      type: filter.type !== 'all' ? filter.type : null,
      status: filter.status !== 'all' ? filter.status : null,
      quickFilter: quickFilter !== 'all' ? quickFilter : null,
      startDate: filter.dateRange[0] || null,
      endDate: filter.dateRange[1] || null,
    })
  }, [page, pageSize, filter.keyword, filter.type, filter.status, filter.dateRange[0], filter.dateRange[1], quickFilter, setMultiple])

  // 统计数据
  const stats = useMemo(() => {
    const pending = data.filter((a) => a.status === 'pending').length
    const processed = data.filter((a) => a.status === 'processed').length
    const ignored = data.filter((a) => a.status === 'ignored').length
    const today = data.filter((a) => {
      const d = new Date(a.createdAt)
      const now = new Date()
      return d.toDateString() === now.toDateString()
    }).length
    return { pending, processed, ignored, today, total }
  }, [data, total])

  // 清空选择当筛选/分页变化时
  useEffect(() => {
    setSelectedIds(new Set())
  }, [page, pageSize, filter.keyword, filter.type, filter.status, filter.dateRange[0], filter.dateRange[1], quickFilter])

  const handleSelect = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSelectAll = () => {
    if (data.length > 0 && selectedIds.size === data.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map((a) => a.id)))
    }
  }

  const clearSelection = () => setSelectedIds(new Set())

  // 唯一写入端点 = POST /alerts/:id/handle（action 区分终态）。
  // 修复前前端调 /process、/ignore（后端无此路由）→ 处理/忽略全 404，本函数统一收口。
  const handleProcess = async (
    id: string,
    payload?: { action?: 'processed' | 'ignored'; remark?: string }
  ) => {
    const action = payload?.action ?? 'processed'
    try {
      await request.post(`/alerts/${id}/handle`, { action, remark: payload?.remark ?? '' })
      toast.success(action === 'ignored' ? '已忽略' : '处理成功')
      refresh()
      setModal({ type: null, alert: null })
      setHandleError('')
      return true
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
      return false
    }
  }

  // 处理弹窗「确认处理」入口：校验处理意见必填，把「处理结果」+「处理意见」组装成 remark 后透传。
  const submitHandle = async () => {
    const alert = modal.alert
    if (!alert) return
    if (!handleForm.opinion.trim()) {
      setHandleError('请填写处理意见后再确认。')
      toast.error('请填写处理意见')
      return
    }
    const action = handleForm.result === 'ignored' ? 'ignored' : 'processed'
    const resultLabel = RESULT_LABEL_MAP[handleForm.result] || handleForm.result
    const remark = `${resultLabel}：${handleForm.opinion.trim()}`
    const completed = await handleProcess(alert.id, { action, remark })
    if (!completed) setHandleError('处理未完成，请核对预警状态后重试。')
  }

  const handleIgnore = async (id: string) => {
    try {
      await request.post(`/alerts/${id}/handle`, { action: 'ignored', remark: '快速忽略' })
      toast.success('已忽略')
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  // 生成/刷新预警：调运行时 /generate（按库存与效期规则实时计算），回填生成条数并刷新列表。
  const handleGenerate = async () => {
    if (generating) return
    setGenerating(true)
    try {
      const res = (await request.post('/alerts/generate', {})) as { generatedCount?: number } | null
      const generatedAt = new Date().toISOString()
      const generatedCount = res?.generatedCount
      if (typeof generatedCount === 'number' && Number.isInteger(generatedCount) && generatedCount >= 0) {
        setGenerationEvidence({ status: 'connected', generatedCount, generatedAt })
        toast.success(`生成完成：新增 ${generatedCount} 条记录`)
      } else {
        setGenerationEvidence({ status: 'unknown', generatedAt })
        toast.error('生成请求已完成，但服务未返回生成条数')
      }
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因 */
    } finally {
      setGenerating(false)
    }
  }

  const getAlertTypeInfo = (type: string) => {
    return (
      ALERT_TYPE_MAP[type] || {
        label: '未识别类型',
        bg: 'bg-gray-50',
        text: 'text-gray-600',
      }
    )
  }

  const getStatusInfo = (status: string) => {
    return (
      STATUS_MAP[status] || {
        label: '未识别状态',
        bg: 'bg-gray-50',
        text: 'text-gray-600',
      }
    )
  }

  const openModal = (type: ModalState['type'], alert: AlertItem) => {
    setModal({ type, alert })
    setHandleForm({ opinion: '', result: 'purchased' })
    setHandleError('')
  }

  const closeModal = () => setModal({ type: null, alert: null })

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  const handleBatchProcess = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    try {
      await Promise.all(ids.map(id => request.post(`/alerts/${id}/handle`, { action: 'processed', remark: '批量处理' })))
      toast.success(`已处理 ${ids.length} 条预警`)
      clearSelection()
      refresh()
    } catch {
      /* 任一请求失败时不宣称批量成功，保留选择供用户核对后重试。 */
    }
  }

  const hasActiveFilters = !!(
    filter.keyword ||
    filter.type !== 'all' ||
    filter.status !== 'all' ||
    quickFilter !== 'all' ||
    filter.dateRange[0] ||
    filter.dateRange[1]
  )
  return {
    filter,
    setFilter,
    quickFilter,
    setQuickFilter,
    selectedIds,
    setSelectedIds,
    modal,
    setModal,
    handleForm,
    setHandleForm,
    handleError,
    setHandleError,
    data,
    loading,
    error: error ? '预警服务暂时不可用，请重新加载。' : null,
    generating,
    generationEvidence,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
    stats,
    handleSelect,
    handleSelectAll,
    clearSelection,
    handleProcess,
    submitHandle,
    handleIgnore,
    handleGenerate,
    hasActiveFilters,
    getAlertTypeInfo,
    getStatusInfo,
    openModal,
    closeModal,
    formatDate,
    handleBatchProcess,
  }
}
