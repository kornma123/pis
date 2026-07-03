import { useState, useEffect, useMemo, useRef } from 'react'
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

export type AlertTypeFilter = 'all' | 'low-stock' | 'expiry' | 'stagnant'
export type AlertStatusFilter = 'all' | 'pending' | 'processed' | 'ignored'

export interface FilterState {
  keyword: string
  type: AlertTypeFilter
  status: AlertStatusFilter
  dateRange: [string, string]
}

export interface ModalState {
  type: 'handle' | 'consumption-handle' | 'consumption-detail' | 'detail' | null
  alert: AlertItem | null
}

export const ALERT_TYPE_MAP: Record<string, { label: string; bg: string; text: string }> = {
  'low-stock': { label: '库存不足', bg: 'bg-red-50', text: 'text-red-600' },
  'expiry': { label: '即将过期', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  'stagnant': { label: '消耗异常', bg: 'bg-green-50', text: 'text-green-600' },
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
  const url = useUrlParams()

  const initialPage = Math.max(1, url.getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(url.getNumber('pageSize', 10))
    ? url.getNumber('pageSize', 10)
    : 10

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [modal, setModal] = useState<ModalState>({ type: null, alert: null })
  const [filter, setFilter] = useState<FilterState>({
    keyword: url.get('keyword', ''),
    type: (url.get('type', 'all') as AlertTypeFilter) || 'all',
    status: (url.get('status', 'all') as AlertStatusFilter) || 'all',
    dateRange: [url.get('startDate', ''), url.get('endDate', '')] as [string, string],
  })
  const [quickFilter, setQuickFilter] = useState<AlertStatusFilter>(
    (url.get('quickFilter', 'all') as AlertStatusFilter) || 'all'
  )
  const [handleForm, setHandleForm] = useState({
    opinion: '',
    result: 'purchased',
  })

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
    url.setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 10 ? pageSize : null,
      keyword: filter.keyword || null,
      type: filter.type !== 'all' ? filter.type : null,
      status: filter.status !== 'all' ? filter.status : null,
      quickFilter: quickFilter !== 'all' ? quickFilter : null,
      startDate: filter.dateRange[0] || null,
      endDate: filter.dateRange[1] || null,
    })
  }, [page, pageSize, filter.keyword, filter.type, filter.status, filter.dateRange, quickFilter])

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
  }, [page, pageSize, filter.keyword, filter.type, filter.status, filter.dateRange, quickFilter])

  const handleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
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
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  // 处理弹窗「确认处理」入口：校验处理意见必填，把「处理结果」+「处理意见」组装成 remark 后透传。
  const submitHandle = async () => {
    const alert = modal.alert
    if (!alert) return
    if (!handleForm.opinion.trim()) {
      toast.error('请填写处理意见')
      return
    }
    const action = handleForm.result === 'ignored' ? 'ignored' : 'processed'
    const resultLabel = RESULT_LABEL_MAP[handleForm.result] || handleForm.result
    const remark = `${resultLabel}：${handleForm.opinion.trim()}`
    await handleProcess(alert.id, { action, remark })
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
    try {
      const res = (await request.post('/alerts/generate', {})) as { generatedCount?: number } | null
      const n = res?.generatedCount ?? 0
      toast.success(n > 0 ? `本次生成 ${n} 条预警` : '暂无新预警')
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因 */
    }
  }

  const getAlertTypeInfo = (type: string) => {
    return (
      ALERT_TYPE_MAP[type] || {
        label: type,
        bg: 'bg-gray-50',
        text: 'text-gray-600',
      }
    )
  }

  const getStatusInfo = (status: string) => {
    return (
      STATUS_MAP[status] || {
        label: status,
        bg: 'bg-gray-50',
        text: 'text-gray-600',
      }
    )
  }

  const openModal = (type: ModalState['type'], alert: AlertItem) => {
    setModal({ type, alert })
    setHandleForm({ opinion: '', result: 'purchased' })
  }

  const closeModal = () => setModal({ type: null, alert: null })

  const isConsumption = (type: string) => type === 'stagnant'

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
    for (const id of ids) {
      await handleProcess(id, { action: 'processed', remark: '批量处理' })
    }
    clearSelection()
  }

  // 空态自动生成：首次拉取**成功**完成后，若无筛选且列表为空，自动跑一次 /generate（仅一次，防循环）。
  // 有筛选返回空 = 正常「无匹配」，不触发生成。
  // !error 守卫：拉取失败(500/断网)时 usePagination 也会把 total 置 0，不能误当空态去生成（否则在报错页多发一次请求 + 矛盾提示）。
  const hasActiveFilters = !!(
    filter.keyword ||
    filter.type !== 'all' ||
    filter.status !== 'all' ||
    quickFilter !== 'all' ||
    filter.dateRange[0] ||
    filter.dateRange[1]
  )
  const autoGenTriedRef = useRef(false)
  const prevLoadingRef = useRef(loading)
  useEffect(() => {
    const justFinished = prevLoadingRef.current && !loading
    prevLoadingRef.current = loading
    if (justFinished && !autoGenTriedRef.current && !hasActiveFilters && total === 0 && !error) {
      autoGenTriedRef.current = true
      handleGenerate()
    }
    // handleGenerate 每次渲染重建但由 ref 保证只触发一次，故不入依赖数组（与本文件其它 effect 一致风格）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, total, hasActiveFilters, error])

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
    data,
    loading,
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
    isConsumption,
    formatDate,
    handleBatchProcess,
  }
}
