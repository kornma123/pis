import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi, inboundApi, outboundApi, purchaseOrderApi } from '@/api/inventory'
import { projectApi } from '@/api/master'
import { abcApi } from '@/api/abc'
import { canAccess, canSeeCost } from '@/lib/permissions'
import type { InventoryStats, InboundRecord, OutboundRecord } from '@/types'

export interface DashboardStats extends InventoryStats {
  alertCount: number
}

export interface CostSummary {
  totalCost: number | null
  totalRevenue: number | null
  totalProfit: number | null
  profitRate: number | null // 0–100；分母未知或为 0 时不可计算
  quality: 'final' | 'partial' | 'unknown'
  qualityMessage: string
}

export interface ActivityItem {
  id: string
  type: 'inbound' | 'outbound' | 'alert'
  title: string
  desc: string
  time: string
}

export type DashboardLoadStatus = 'idle' | 'loading' | 'retrying' | 'success' | 'error'

export type DashboardResource =
  | 'inventory'
  | 'recentInbound'
  | 'recentOutbound'
  | 'monthlyInbound'
  | 'monthlyOutbound'
  | 'projects'
  | 'purchaseOrders'
  | 'cost'

export type DashboardLoadState = Record<DashboardResource, DashboardLoadStatus>

export function useDashboardPage() {
  const access = {
    inventory: canAccess('inventory', 'R'),
    inbound: canAccess('inbound', 'R'),
    outbound: canAccess('outbound', 'R'),
    projects: canAccess('projects', 'R'),
    purchaseOrders: canAccess('purchase_orders', 'R'),
    cost: canSeeCost() && canAccess('abc_dashboard', 'R'),
  }
  const month = useCurrentMonthRange()

  const inventoryQuery = useQuery({
    queryKey: ['dashboard', 'inventory'],
    queryFn: async () => normalizeInventoryStats(await inventoryApi.getStats()),
    enabled: access.inventory,
    retry: false,
  })
  const recentInboundQuery = useQuery({
    queryKey: ['dashboard', 'recent-inbound'],
    queryFn: async () => extractList<InboundRecord>(await inboundApi.getList({ page: 1, pageSize: 5 })),
    enabled: access.inbound,
    retry: false,
  })
  const recentOutboundQuery = useQuery({
    queryKey: ['dashboard', 'recent-outbound'],
    queryFn: async () => extractList<OutboundRecord>(await outboundApi.getList({ page: 1, pageSize: 5 })),
    enabled: access.outbound,
    retry: false,
  })
  const monthlyInboundQuery = useQuery({
    queryKey: ['dashboard', 'monthly-inbound', month.startDate, month.endDate],
    queryFn: async () => extractPaginationTotal(await inboundApi.getList({
      page: 1,
      pageSize: 1,
      status: 'completed',
      startDate: month.startDate,
      endDate: month.endDate,
    })),
    enabled: access.inbound,
    retry: false,
  })
  const monthlyOutboundQuery = useQuery({
    queryKey: ['dashboard', 'monthly-outbound', month.startDate, month.endDate],
    queryFn: async () => extractPaginationTotal(await outboundApi.getList({
      page: 1,
      pageSize: 1,
      status: 'completed',
      startDate: month.startDate,
      endDate: month.endDate,
    })),
    enabled: access.outbound,
    retry: false,
  })
  const projectsQuery = useQuery({
    queryKey: ['dashboard', 'projects'],
    queryFn: async () => extractPaginationTotal(await projectApi.getList({ page: 1, pageSize: 1, status: 'active' })),
    enabled: access.projects,
    retry: false,
  })
  const purchaseOrdersQuery = useQuery({
    queryKey: ['dashboard', 'purchase-orders'],
    queryFn: async () => extractPaginationTotal(await purchaseOrderApi.getList({ page: 1, pageSize: 1 })),
    enabled: access.purchaseOrders,
    retry: false,
  })
  const costQuery = useQuery({
    queryKey: ['dashboard', 'cost', month.yearMonth],
    queryFn: async () => extractCostSummary(await abcApi.getDashboard(month.yearMonth)),
    enabled: access.cost,
    retry: false,
  })

  const loadState: DashboardLoadState = {
    inventory: queryStatus(inventoryQuery, access.inventory),
    recentInbound: queryStatus(recentInboundQuery, access.inbound),
    recentOutbound: queryStatus(recentOutboundQuery, access.outbound),
    monthlyInbound: queryStatus(monthlyInboundQuery, access.inbound),
    monthlyOutbound: queryStatus(monthlyOutboundQuery, access.outbound),
    projects: queryStatus(projectsQuery, access.projects),
    purchaseOrders: queryStatus(purchaseOrdersQuery, access.purchaseOrders),
    cost: queryStatus(costQuery, access.cost),
  }

  const today = useMemo(() => {
    const d = new Date()
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`
  }, [])

  const recentInbound = recentInboundQuery.data ?? []
  const recentOutbound = recentOutboundQuery.data ?? []
  const activities: ActivityItem[] = useMemo(() => {
    const list: Array<ActivityItem & { timestamp: number }> = []
    recentInbound.slice(0, 3).forEach(item => {
      list.push({
        id: `in-${item.id}`,
        type: 'inbound',
        title: `入库：${item.materialName || '未知物料'}`,
        desc: `数量 ${item.quantity}${item.unit || ''} · ${item.operator || '系统'}`,
        time: formatTime(item.createdAt),
        timestamp: timestampOf(item.createdAt),
      })
    })
    recentOutbound.slice(0, 3).forEach(item => {
      list.push({
        id: `out-${item.id}`,
        type: 'outbound',
        title: `出库：${item.outboundNo || '出库单'}`,
        desc: `${item.projectName || '项目消耗'} · ${item.operator || '系统'}`,
        time: formatTime(item.createdAt),
        timestamp: timestampOf(item.createdAt),
      })
    })
    return list
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 6)
      .map(({ timestamp: _timestamp, ...item }) => item)
  }, [recentInbound, recentOutbound])

  const retry = (resource: DashboardResource) => {
    const queries = {
      inventory: inventoryQuery,
      recentInbound: recentInboundQuery,
      recentOutbound: recentOutboundQuery,
      monthlyInbound: monthlyInboundQuery,
      monthlyOutbound: monthlyOutboundQuery,
      projects: projectsQuery,
      purchaseOrders: purchaseOrdersQuery,
      cost: costQuery,
    }
    void queries[resource].refetch()
  }

  const retryActivities = () => {
    if (access.inbound) void recentInboundQuery.refetch()
    if (access.outbound) void recentOutboundQuery.refetch()
  }

  const loading = Boolean(
    (access.inventory && initialLoading(inventoryQuery))
    || (access.inbound && (initialLoading(recentInboundQuery) || initialLoading(monthlyInboundQuery)))
    || (access.outbound && (initialLoading(recentOutboundQuery) || initialLoading(monthlyOutboundQuery)))
    || (access.projects && initialLoading(projectsQuery))
    || (access.purchaseOrders && initialLoading(purchaseOrdersQuery))
    || (access.cost && initialLoading(costQuery)),
  )

  return {
    stats: inventoryQuery.data ?? null,
    recentInbound,
    recentOutbound,
    monthlyInbound: monthlyInboundQuery.data ?? null,
    monthlyOutbound: monthlyOutboundQuery.data ?? null,
    projectCount: projectsQuery.data ?? null,
    poCount: purchaseOrdersQuery.data ?? null,
    costSummary: costQuery.data ?? null,
    loadState,
    loading,
    today,
    activities,
    // 当前 API 没有真实月度序列。null 表示来源尚未接通，不与“成功空数组”混义。
    stockTrend: null as Array<{ label: string; value: number }> | null,
    consumeTrend: null as Array<{ label: string; value: number }> | null,
    retry,
    retryActivities,
  }
}

function queryStatus(
  query: { errorUpdatedAt: number; isFetching: boolean; isError: boolean; isSuccess: boolean },
  enabled: boolean,
): DashboardLoadStatus {
  if (!enabled) return 'idle'
  if (query.isFetching && !query.isSuccess && query.errorUpdatedAt > 0) return 'retrying'
  if (query.isFetching && query.isSuccess) return 'success'
  if (query.isFetching) return 'loading'
  if (query.isError) return 'error'
  return query.isSuccess ? 'success' : 'loading'
}

function initialLoading(query: { errorUpdatedAt: number; isLoading: boolean }) {
  return query.isLoading && query.errorUpdatedAt === 0
}

// /abc/dashboard 响应字段防御性提取（兼容 summary 嵌套 / 扁平 / snake_case）。
// 后端 profitRate 是 0–1 比率；为避免字段语义漂移，UI 继续从真实利润/收入推导 0–100 百分数。
function extractCostSummary(raw: unknown): CostSummary {
  const root = isRecord(raw) ? raw : {}
  const s = isRecord(root.summary) ? root.summary : root
  const num = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = s[key] ?? root[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
      }
    }
    return null
  }
  const totalCost = num('totalCost', 'total_cost')
  const totalRevenue = num('totalRevenue', 'totalFee', 'total_fee', 'revenue')
  const totalProfit = num('totalProfit', 'total_profit', 'profit')
  const profitRate = totalRevenue !== null && totalRevenue > 0 && totalProfit !== null
    ? Math.round((totalProfit / totalRevenue) * 1000) / 10
    : null
  const insightQuality = isRecord(root.insightQuality) ? root.insightQuality : null
  const isFinal = insightQuality?.isFinal === true
  const pendingCostCount = optionalNonNegative(insightQuality?.pendingCostCount)
  const openExceptionCount = optionalNonNegative(insightQuality?.openExceptionCount)
  const quality = isFinal ? 'final' : insightQuality ? 'partial' : 'unknown'
  const qualityMessage = quality === 'final'
    ? ''
    : pendingCostCount !== null && pendingCostCount > 0
      ? `仍有 ${pendingCostCount} 单未补算或成本异常`
      : openExceptionCount !== null && openExceptionCount > 0
        ? `仍有 ${openExceptionCount} 条开放成本异常`
        : quality === 'partial'
          ? '成本期间尚未定版'
          : '成本数据完整性未知'
  return { totalCost, totalRevenue, totalProfit, profitRate, quality, qualityMessage }
}

function normalizeInventoryStats(raw: unknown): DashboardStats {
  if (!isRecord(raw) || !Array.isArray(raw.categoryDistribution)) {
    throw new Error('invalid inventory stats')
  }
  const totalMaterials = requiredFinite(raw.totalMaterials)
  const lowStockCount = requiredFinite(raw.lowStockCount)
  const expiringCount = requiredFinite(raw.expiringCount)
  const expiredCount = requiredFinite(raw.expiredCount)
  return {
    ...(raw as unknown as InventoryStats),
    totalMaterials,
    lowStockCount,
    expiringCount,
    expiredCount,
    alertCount: lowStockCount + expiringCount + expiredCount,
  }
}

function extractList<T>(raw: unknown): T[] {
  if (!isRecord(raw) || !Array.isArray(raw.list)) throw new Error('invalid list response')
  return raw.list as T[]
}

function extractPaginationTotal(raw: unknown): number {
  if (!isRecord(raw) || !isRecord(raw.pagination)) throw new Error('missing pagination')
  const total = requiredFinite(raw.pagination.total)
  if (total < 0) throw new Error('invalid pagination total')
  return total
}

function useCurrentMonthRange() {
  const [yearMonth, setYearMonth] = useState(() => localYearMonth(new Date()))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const syncAtLocalDayBoundary = () => {
      const now = new Date()
      setYearMonth(localYearMonth(now))
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      timer = setTimeout(syncAtLocalDayBoundary, Math.max(50, nextDay.getTime() - now.getTime() + 50))
    }
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') setYearMonth(localYearMonth(new Date()))
    }

    syncAtLocalDayBoundary()
    document.addEventListener('visibilitychange', syncWhenVisible)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', syncWhenVisible)
    }
  }, [])

  return useMemo(() => currentMonthRange(yearMonth), [yearMonth])
}

function localYearMonth(reference: Date) {
  return `${reference.getFullYear()}-${String(reference.getMonth() + 1).padStart(2, '0')}`
}

function currentMonthRange(yearMonth: string) {
  const [yearText, monthText] = yearMonth.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  return {
    yearMonth,
    startDate: formatDate(year, month, 1),
    endDate: formatDate(year, month, new Date(year, month, 0).getDate()),
  }
}

function formatDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function requiredFinite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid numeric field')
  return value
}

function optionalNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function timestampOf(iso: string): number {
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : 0
}

function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 7) return `${days}天前`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
