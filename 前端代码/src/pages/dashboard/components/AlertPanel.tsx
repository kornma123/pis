import { FileWarning, Clock, AlertTriangle, Bell } from 'lucide-react'
import type { DashboardStats } from '../hooks/useDashboardPage'

interface Props {
  stats: DashboardStats | null
  onViewAll: () => void
}

export function AlertPanel({ stats, onViewAll }: Props) {
  const totalAlerts = (stats?.lowStockCount || 0) + (stats?.expiringCount || 0) + (stats?.expiredCount || 0)

  return (
    <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-gray-900">预警信息</h3>
        <button
          onClick={onViewAll}
          className="text-xs text-blue-500 hover:text-blue-600 font-medium transition-colors"
        >
          查看全部
        </button>
      </div>
      <div className="space-y-3">
        {(stats?.lowStockCount || 0) > 0 && (
          <div className="flex items-start gap-3 p-3 rounded-md bg-orange-50">
            <FileWarning className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">库存不足</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {stats?.lowStockCount} 种物料低于安全库存
              </p>
            </div>
          </div>
        )}
        {(stats?.expiringCount || 0) > 0 && (
          <div className="flex items-start gap-3 p-3 rounded-md bg-yellow-50">
            <Clock className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">即将过期</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {stats?.expiringCount} 种物料将在30天内过期
              </p>
            </div>
          </div>
        )}
        {(stats?.expiredCount || 0) > 0 && (
          <div className="flex items-start gap-3 p-3 rounded-md bg-red-50">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">已过期</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {stats?.expiredCount} 种物料已过期，请尽快处理
              </p>
            </div>
          </div>
        )}
        {totalAlerts === 0 && (
          <div className="py-6 text-center">
            <Bell className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-400">暂无预警信息</p>
          </div>
        )}
      </div>
    </div>
  )
}
