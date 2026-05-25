import { Boxes } from 'lucide-react'
import type { DashboardStats } from '../hooks/useDashboardPage'

interface Props {
  stats: DashboardStats | null
}

export function CategoryDistribution({ stats }: Props) {
  return (
    <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
      <h3 className="text-base font-semibold text-gray-900 mb-4">分类分布</h3>
      <div className="space-y-3">
        {stats?.categoryDistribution?.length ? (
          stats.categoryDistribution.map(cat => {
            const pct = Math.round((cat.count / (stats.totalMaterials || 1)) * 100)
            return (
              <div key={cat.categoryId} className="flex items-center gap-3">
                <span className="text-sm text-gray-700 w-20 truncate">{cat.categoryName}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-500 ease-out"
                    style={{ width: `${Math.max(4, pct)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500 w-8 text-right">{cat.count}</span>
              </div>
            )
          })
        ) : (
          <div className="py-6 text-center">
            <Boxes className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-400">暂无数据</p>
          </div>
        )}
      </div>
    </div>
  )
}
