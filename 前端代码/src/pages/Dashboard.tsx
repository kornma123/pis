import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Package,
  AlertTriangle,
  Clock,
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCheck,
  BarChart3,
  Bell,
  ChevronRight,
  Boxes,
  FileWarning,
} from 'lucide-react'
import { inventoryApi, inboundApi, outboundApi } from '@/api/inventory'
import type { InventoryStats, InboundRecord, OutboundRecord } from '@/types'

/* ================================================================
   类型扩展
   ================================================================ */
interface DashboardStats extends InventoryStats {
  monthlyInbound: number
  monthlyOutbound: number
  alertCount: number
}

interface ActivityItem {
  id: string
  type: 'inbound' | 'outbound' | 'alert'
  title: string
  desc: string
  time: string
}

/* ================================================================
   子组件：统计卡片
   ================================================================ */
function StatCard({
  title,
  value,
  icon: Icon,
  colorClass,
  bgClass,
  subtitle,
  onClick,
}: {
  title: string
  value: string | number
  icon: React.ElementType
  colorClass: string
  bgClass: string
  subtitle?: string
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-lg p-5 border border-[#e5e7eb] transition-all duration-150 ease ${
        onClick ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5' : ''
      }`}
      style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)' }}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-[13px] text-[#6b7280] mb-1">{title}</p>
          <p className="text-[28px] font-bold text-[#111827] leading-tight tracking-tight">
            {value}
          </p>
          {subtitle && (
            <p className="text-xs text-[#9ca3af] mt-1">{subtitle}</p>
          )}
        </div>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${bgClass}`}>
          <Icon className={`w-5 h-5 ${colorClass}`} />
        </div>
      </div>
    </div>
  )
}

/* ================================================================
   子组件：快捷入口卡片
   ================================================================ */
function QuickAction({
  label,
  desc,
  icon: Icon,
  colorClass,
  bgClass,
  onClick,
}: {
  label: string
  desc: string
  icon: React.ElementType
  colorClass: string
  bgClass: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-4 w-full text-left p-4 rounded-lg border border-[#e5e7eb] bg-white transition-all duration-150 ease hover:shadow-md hover:-translate-y-0.5 hover:border-[#3b82f6] group"
      style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)' }}
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${bgClass}`}>
        <Icon className={`w-5 h-5 ${colorClass}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#111827] group-hover:text-[#3b82f6] transition-colors">
          {label}
        </p>
        <p className="text-xs text-[#6b7280] mt-0.5">{desc}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-[#d1d5db] group-hover:text-[#3b82f6] transition-colors flex-shrink-0" />
    </button>
  )
}

/* ================================================================
   子组件：活动项
   ================================================================ */
function ActivityItem({ item }: { item: ActivityItem }) {
  const config = {
    inbound: {
      icon: ArrowDownToLine,
      bg: 'bg-[#f0fdf4]',
      color: 'text-[#22c55e]',
      label: '入库',
    },
    outbound: {
      icon: ArrowUpFromLine,
      bg: 'bg-[#eff6ff]',
      color: 'text-[#3b82f6]',
      label: '出库',
    },
    alert: {
      icon: AlertTriangle,
      bg: 'bg-[#fef2f2]',
      color: 'text-[#ef4444]',
      label: '预警',
    },
  }
  const c = config[item.type]
  const Icon = c.icon

  return (
    <div className="flex items-start gap-3 py-3 border-b border-[#f3f4f6] last:border-0">
      <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 ${c.bg}`}>
        <Icon className={`w-4 h-4 ${c.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[#111827] truncate">{item.title}</p>
        <p className="text-xs text-[#6b7280] mt-0.5">{item.desc}</p>
      </div>
      <span className="text-xs text-[#9ca3af] flex-shrink-0 whitespace-nowrap">{item.time}</span>
    </div>
  )
}

/* ================================================================
   子组件：简单趋势图（CSS 条形图）
   ================================================================ */
function SimpleBarChart({
  title,
  data,
  color = '#3b82f6',
}: {
  title: string
  data: { label: string; value: number }[]
  color?: string
}) {
  const max = Math.max(...data.map(d => d.value), 1)

  return (
    <div className="bg-white rounded-lg p-5 border border-[#e5e7eb]" style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)' }}>
      <h3 className="text-base font-semibold text-[#111827] mb-5">{title}</h3>
      <div className="flex items-end gap-3 h-40">
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-2">
            <div className="w-full flex flex-col items-center justify-end h-28">
              <span className="text-[10px] text-[#6b7280] mb-1">{d.value}</span>
              <div
                className="w-full max-w-[28px] rounded-t-sm transition-all duration-500 ease-out"
                style={{
                  height: `${(d.value / max) * 100}%`,
                  background: color,
                  opacity: 0.7 + (i / data.length) * 0.3,
                }}
              />
            </div>
            <span className="text-[11px] text-[#9ca3af]">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ================================================================
   主组件：Dashboard
   ================================================================ */
export default function Dashboard() {
  const navigate = useNavigate()
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
        // 静默失败，保持空状态
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  // 构建最近活动列表
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

  // Mock 图表数据
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

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-gray-200 rounded w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 bg-gray-200 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ====== 页面头部：欢迎语 + 日期 ====== */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-[#111827] tracking-tight leading-tight">
            仪表盘
          </h1>
          <p className="text-sm text-[#6b7280] mt-1.5">
            {today} · 欢迎使用 COREONE 实验室耗材管理系统
          </p>
        </div>
      </div>

      {/* ====== 统计卡片 ====== */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="库存总量"
          value={stats?.totalMaterials || 0}
          icon={Package}
          colorClass="text-[#3b82f6]"
          bgClass="bg-[#eff6ff]"
          subtitle="库存物料种类"
          onClick={() => navigate('/inventory')}
        />
        <StatCard
          title="本月入库"
          value={stats?.monthlyInbound || 0}
          icon={ArrowDownToLine}
          colorClass="text-[#22c55e]"
          bgClass="bg-[#f0fdf4]"
          subtitle="本月累计入库"
          onClick={() => navigate('/inbound')}
        />
        <StatCard
          title="本月出库"
          value={stats?.monthlyOutbound || 0}
          icon={ArrowUpFromLine}
          colorClass="text-[#3b82f6]"
          bgClass="bg-[#eff6ff]"
          subtitle="本月累计出库"
          onClick={() => navigate('/outbound')}
        />
        <StatCard
          title="预警数量"
          value={stats?.alertCount || 0}
          icon={AlertTriangle}
          colorClass="text-[#f97316]"
          bgClass="bg-[#fff7ed]"
          subtitle="需关注处理"
          onClick={() => navigate('/alerts')}
        />
      </div>

      {/* ====== 快捷操作 ====== */}
      <div>
        <h2 className="text-base font-semibold text-[#111827] mb-4">快捷操作</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <QuickAction
            label="入库登记"
            desc="录入新到耗材批次"
            icon={ArrowDownToLine}
            colorClass="text-[#22c55e]"
            bgClass="bg-[#f0fdf4]"
            onClick={() => navigate('/inbound')}
          />
          <QuickAction
            label="出库领用"
            desc="记录耗材消耗"
            icon={ArrowUpFromLine}
            colorClass="text-[#3b82f6]"
            bgClass="bg-[#eff6ff]"
            onClick={() => navigate('/outbound')}
          />
          <QuickAction
            label="库存盘点"
            desc="核对实际库存"
            icon={ClipboardCheck}
            colorClass="text-[#8b5cf6]"
            bgClass="bg-[#f5f3ff]"
            onClick={() => navigate('/stocktaking')}
          />
          <QuickAction
            label="成本报表"
            desc="查看成本分析"
            icon={BarChart3}
            colorClass="text-[#f59e0b]"
            bgClass="bg-[#fffbeb]"
            onClick={() => navigate('/cost-analysis')}
          />
        </div>
      </div>

      {/* ====== 中间区域：图表 + 最近活动 ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 库存趋势 */}
        <div className="lg:col-span-2">
          <SimpleBarChart title="库存趋势（近6个月）" data={stockTrend} color="#3b82f6" />
        </div>

        {/* 最近活动 */}
        <div className="bg-white rounded-lg p-5 border border-[#e5e7eb]" style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)' }}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-[#111827]">最近活动</h3>
            <button
              onClick={() => navigate('/logs')}
              className="text-xs text-[#3b82f6] hover:text-[#2563eb] font-medium transition-colors"
            >
              查看全部
            </button>
          </div>
          {activities.length > 0 ? (
            <div className="divide-y divide-[#f3f4f6]">
              {activities.map(item => (
                <ActivityItem key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <div className="py-8 text-center">
              <Clock className="w-8 h-8 text-[#d1d5db] mx-auto mb-2" />
              <p className="text-sm text-[#9ca3af]">暂无最近活动</p>
            </div>
          )}
        </div>
      </div>

      {/* ====== 底部区域：消耗趋势 + 分类分布 + 预警列表 ====== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 消耗趋势 */}
        <div className="lg:col-span-1">
          <SimpleBarChart title="消耗趋势（近6个月）" data={consumeTrend} color="#22c55e" />
        </div>

        {/* 分类分布 */}
        <div className="bg-white rounded-lg p-5 border border-[#e5e7eb]" style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)' }}>
          <h3 className="text-base font-semibold text-[#111827] mb-4">分类分布</h3>
          <div className="space-y-3">
            {stats?.categoryDistribution?.length ? (
              stats.categoryDistribution.map(cat => {
                const pct = Math.round((cat.count / (stats.totalMaterials || 1)) * 100)
                return (
                  <div key={cat.categoryId} className="flex items-center gap-3">
                    <span className="text-sm text-[#374151] w-20 truncate">{cat.categoryName}</span>
                    <div className="flex-1 bg-[#f3f4f6] rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#3b82f6] transition-all duration-500 ease-out"
                        style={{ width: `${Math.max(4, pct)}%` }}
                      />
                    </div>
                    <span className="text-xs text-[#6b7280] w-8 text-right">{cat.count}</span>
                  </div>
                )
              })
            ) : (
              <div className="py-6 text-center">
                <Boxes className="w-8 h-8 text-[#d1d5db] mx-auto mb-2" />
                <p className="text-sm text-[#9ca3af]">暂无数据</p>
              </div>
            )}
          </div>
        </div>

        {/* 预警列表 */}
        <div className="bg-white rounded-lg p-5 border border-[#e5e7eb]" style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)' }}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-[#111827]">预警信息</h3>
            <button
              onClick={() => navigate('/alerts')}
              className="text-xs text-[#3b82f6] hover:text-[#2563eb] font-medium transition-colors"
            >
              查看全部
            </button>
          </div>
          <div className="space-y-3">
            {(stats?.lowStockCount || 0) > 0 && (
              <div className="flex items-start gap-3 p-3 rounded-md bg-[#fff7ed]">
                <FileWarning className="w-4 h-4 text-[#f97316] flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-[#111827]">库存不足</p>
                  <p className="text-xs text-[#6b7280] mt-0.5">
                    {stats?.lowStockCount} 种物料低于安全库存
                  </p>
                </div>
              </div>
            )}
            {(stats?.expiringCount || 0) > 0 && (
              <div className="flex items-start gap-3 p-3 rounded-md bg-[#fefce8]">
                <Clock className="w-4 h-4 text-[#eab308] flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-[#111827]">即将过期</p>
                  <p className="text-xs text-[#6b7280] mt-0.5">
                    {stats?.expiringCount} 种物料将在30天内过期
                  </p>
                </div>
              </div>
            )}
            {(stats?.expiredCount || 0) > 0 && (
              <div className="flex items-start gap-3 p-3 rounded-md bg-[#fef2f2]">
                <AlertTriangle className="w-4 h-4 text-[#ef4444] flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-[#111827]">已过期</p>
                  <p className="text-xs text-[#6b7280] mt-0.5">
                    {stats?.expiredCount} 种物料已过期，请尽快处理
                  </p>
                </div>
              </div>
            )}
            {((stats?.lowStockCount || 0) + (stats?.expiringCount || 0) + (stats?.expiredCount || 0)) === 0 && (
              <div className="py-6 text-center">
                <Bell className="w-8 h-8 text-[#d1d5db] mx-auto mb-2" />
                <p className="text-sm text-[#9ca3af]">暂无预警信息</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ================================================================
   辅助函数
   ================================================================ */
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
