import { useState, useEffect, useMemo } from 'react'
import { inventoryApi, inboundApi, outboundApi } from '@/api/inventory'
import type { InventoryStats, InboundRecord, OutboundRecord } from '@/types'

export interface DashboardStats extends InventoryStats {
  monthlyInbound: number
  monthlyOutbound: number
  alertCount: number
}

export interface ActivityItem {
  id: string
  type: 'inbound' | 'outbound' | 'alert'
  title: string
  desc: string
  time: string
}

export function useDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [recentInbound, setRecentInbound] = useState<InboundRecord[]>([])
  const [recentOutbound, setRecentOutbound] = useState<OutboundRecord[]>([])
  const [loading, setLoading] = useState(true)

  const today = useMemo(() => {
    const d = new Date()
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`
  }, [])

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      try {
        const [statsData, inboundRes, outboundRes] = await Promise.all([
          inventoryApi.getStats(),
          inboundApi.getList({ page: 1, pageSize: 5 }),
          outboundApi.getList({ page: 1, pageSize: 5 }),
        ])

        const baseStats = statsData as unknown as InventoryStats
        setStats({
          ...baseStats,
          monthlyInbound: 0,
          monthlyOutbound: 0,
          alertCount: (baseStats.lowStockCount || 0) + (baseStats.expiringCount || 0) + (baseStats.expiredCount || 0),
        })

        setRecentInbound((inboundRes as unknown as { list: InboundRecord[] }).list || [])
        setRecentOutbound((outboundRes as unknown as { list: OutboundRecord[] }).list || [])
      } catch {
        // silent fail
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const activities: ActivityItem[] = useMemo(() => {
    const list: ActivityItem[] = []
    recentInbound.slice(0, 3).forEach(item => {
      list.push({
        id: `in-${item.id}`,
        type: 'inbound',
        title: `入库：${item.materialName || '未知物料'}`,
        desc: `数量 ${item.quantity}${item.unit || ''} · ${item.operator || '系统'}`,
        time: formatTime(item.createdAt),
      })
    })
    recentOutbound.slice(0, 3).forEach(item => {
      list.push({
        id: `out-${item.id}`,
        type: 'outbound',
        title: `出库：${item.outboundNo || '出库单'}`,
        desc: `${item.projectName || '项目消耗'} · ${item.operator || '系统'}`,
        time: formatTime(item.createdAt),
      })
    })
    return list.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 6)
  }, [recentInbound, recentOutbound])

  const stockTrend = useMemo(
    () => [
      { label: '1月', value: 420 },
      { label: '2月', value: 380 },
      { label: '3月', value: 510 },
      { label: '4月', value: 460 },
      { label: '5月', value: 580 },
      { label: '6月', value: 520 },
    ],
    []
  )

  const consumeTrend = useMemo(
    () => [
      { label: '1月', value: 120 },
      { label: '2月', value: 98 },
      { label: '3月', value: 156 },
      { label: '4月', value: 134 },
      { label: '5月', value: 178 },
      { label: '6月', value: 145 },
    ],
    []
  )

  return { stats, recentInbound, recentOutbound, loading, today, activities, stockTrend, consumeTrend }
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
