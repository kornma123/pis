import { BarChart3, Activity, PieChart, Users } from 'lucide-react'
import type { CostAnalysisStats } from '../hooks/useCostAnalysisPage'

interface Props {
  stats: CostAnalysisStats
  supplierCount: number
}

export function CostStatsCards({ stats, supplierCount }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1.5 bg-blue-50 rounded-md">
            <BarChart3 className="w-4 h-4 text-blue-600" />
          </div>
          <span className="text-xs text-gray-500 font-medium">物料总成本</span>
        </div>
        <div className="text-2xl font-bold text-gray-900">
          ¥{(stats.totalCost / 10000).toFixed(1)}万
        </div>
        <div className="flex items-center gap-2 mt-2 text-xs">
          <span className="text-gray-400">统计周期内总成本</span>
        </div>
      </div>

      <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1.5 bg-emerald-50 rounded-md">
            <Activity className="w-4 h-4 text-emerald-600" />
          </div>
          <span className="text-xs text-gray-500 font-medium">检测项目成本</span>
        </div>
        <div className="text-2xl font-bold text-gray-900">
          ¥{(stats.projectCost / 10000).toFixed(1)}万
        </div>
        <div className="flex items-center gap-2 mt-2 text-xs">
          <span className="text-gray-400">
            占比 {stats.totalCost > 0 ? ((stats.projectCost / stats.totalCost) * 100).toFixed(1) : '0.0'}%
          </span>
        </div>
      </div>

      <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1.5 bg-orange-50 rounded-md">
            <PieChart className="w-4 h-4 text-orange-600" />
          </div>
          <span className="text-xs text-gray-500 font-medium">公共成本</span>
        </div>
        <div className="text-2xl font-bold text-gray-900">
          ¥{(stats.publicCost / 10000).toFixed(1)}万
        </div>
        <div className="flex items-center gap-2 mt-2 text-xs">
          <span className="text-gray-400">
            占比 {stats.totalCost > 0 ? ((stats.publicCost / stats.totalCost) * 100).toFixed(1) : '0.0'}%
          </span>
        </div>
      </div>

      <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1.5 bg-purple-50 rounded-md">
            <Users className="w-4 h-4 text-purple-600" />
          </div>
          <span className="text-xs text-gray-500 font-medium">供应商数量</span>
        </div>
        <div className="text-2xl font-bold text-gray-900">{supplierCount}</div>
        <div className="flex items-center gap-2 mt-2 text-xs">
          <span className="text-gray-400">有采购记录的供应商</span>
        </div>
      </div>
    </div>
  )
}
