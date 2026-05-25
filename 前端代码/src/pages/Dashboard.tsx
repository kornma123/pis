import { useNavigate } from 'react-router-dom'
import {
  Package, AlertTriangle, ArrowDownToLine, ArrowUpFromLine,
  ClipboardCheck, BarChart3, Clock,
} from 'lucide-react'
import { useDashboardPage } from './dashboard/hooks/useDashboardPage'
import { StatCard } from './dashboard/components/StatCard'
import { QuickAction } from './dashboard/components/QuickAction'
import { ActivityItem } from './dashboard/components/ActivityItem'
import { SimpleBarChart } from './dashboard/components/SimpleBarChart'
import { AlertPanel } from './dashboard/components/AlertPanel'
import { CategoryDistribution } from './dashboard/components/CategoryDistribution'

export default function Dashboard() {
  const navigate = useNavigate()
  const page = useDashboardPage()

  if (page.loading) {
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
      {/* Page Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">
            仪表盘
          </h1>
          <p className="text-sm text-gray-500 mt-1.5">
            {page.today} · 欢迎使用 COREONE 实验室耗材管理系统
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="库存总量"
          value={page.stats?.totalMaterials || 0}
          icon={Package}
          colorClass="text-blue-500"
          bgClass="bg-blue-50"
          subtitle="库存物料种类"
          onClick={() => navigate('/inventory')}
        />
        <StatCard
          title="本月入库"
          value={page.stats?.monthlyInbound || 0}
          icon={ArrowDownToLine}
          colorClass="text-green-500"
          bgClass="bg-green-50"
          subtitle="本月累计入库"
          onClick={() => navigate('/inbound')}
        />
        <StatCard
          title="本月出库"
          value={page.stats?.monthlyOutbound || 0}
          icon={ArrowUpFromLine}
          colorClass="text-blue-500"
          bgClass="bg-blue-50"
          subtitle="本月累计出库"
          onClick={() => navigate('/outbound')}
        />
        <StatCard
          title="预警数量"
          value={page.stats?.alertCount || 0}
          icon={AlertTriangle}
          colorClass="text-orange-500"
          bgClass="bg-orange-50"
          subtitle="需关注处理"
          onClick={() => navigate('/alerts')}
        />
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-4">快捷操作</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <QuickAction
            label="入库登记"
            desc="录入新到耗材批次"
            icon={ArrowDownToLine}
            colorClass="text-green-500"
            bgClass="bg-green-50"
            onClick={() => navigate('/inbound')}
          />
          <QuickAction
            label="出库领用"
            desc="记录耗材消耗"
            icon={ArrowUpFromLine}
            colorClass="text-blue-500"
            bgClass="bg-blue-50"
            onClick={() => navigate('/outbound')}
          />
          <QuickAction
            label="库存盘点"
            desc="核对实际库存"
            icon={ClipboardCheck}
            colorClass="text-purple-500"
            bgClass="bg-purple-50"
            onClick={() => navigate('/stocktaking')}
          />
          <QuickAction
            label="成本报表"
            desc="查看成本分析"
            icon={BarChart3}
            colorClass="text-yellow-500"
            bgClass="bg-yellow-50"
            onClick={() => navigate('/cost-analysis')}
          />
        </div>
      </div>

      {/* Charts + Activities */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <SimpleBarChart title="库存趋势（近6个月）" data={page.stockTrend} color="#3b82f6" />
        </div>

        <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">最近活动</h3>
            <button
              onClick={() => navigate('/logs')}
              className="text-xs text-blue-500 hover:text-blue-600 font-medium transition-colors"
            >
              查看全部
            </button>
          </div>
          {page.activities.length > 0 ? (
            <div className="divide-y divide-gray-100">
              {page.activities.map(item => (
                <ActivityItem key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <div className="py-8 text-center">
              <Clock className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-400">暂无最近活动</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <SimpleBarChart title="消耗趋势（近6个月）" data={page.consumeTrend} color="#22c55e" />
        </div>

        <CategoryDistribution stats={page.stats} />

        <AlertPanel stats={page.stats} onViewAll={() => navigate('/alerts')} />
      </div>
    </div>
  )
}
