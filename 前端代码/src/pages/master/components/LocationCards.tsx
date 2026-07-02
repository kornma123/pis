import type { Location } from '@/types'
import { getTypeLabel } from '../hooks/useLocationsPage'

interface Props {
  loading: boolean
  data: Location[]
  selectedNodeName: string
  onEdit: (loc: Location) => void
  onDelete: (id: string) => void
  onToggleStatus: (loc: Location) => void
}

export function LocationCards({ loading, data, onEdit, onDelete, onToggleStatus }: Props) {
  return (
    <div className="p-5">
      {loading ? (
        <div className="text-center text-sm text-gray-400 py-12">加载中...</div>
      ) : data.length === 0 ? (
        <div className="text-center text-sm text-gray-400 py-12">暂无库位数据</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.map(loc => {
            const utilization = loc.capacity > 0 ? Math.round((loc.used / loc.capacity) * 100) : 0
            return (
              <div key={loc.id} className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-semibold text-gray-900">{loc.code}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    loc.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {loc.status === 'active' ? '已启用' : '已停用'}
                  </span>
                </div>
                <div className="space-y-2 mb-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">名称</span>
                    <span className="text-gray-900">{loc.name}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">类型</span>
                    <span className="text-gray-900">{getTypeLabel(loc.type)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">容量</span>
                    <span className="text-gray-900">{loc.capacity}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">当前库存</span>
                    <span className="text-gray-900">{loc.used}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">使用率</span>
                    <span className={`font-medium ${
                      utilization > 90 ? 'text-red-500' : utilization > 70 ? 'text-orange-500' : 'text-green-600'
                    }`}>
                      {utilization}%
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-3 border-t border-gray-200">
                  <button
                    onClick={() => onEdit(loc)}
                    className="flex-1 py-1.5 text-xs text-gray-600 hover:text-blue-500 hover:bg-blue-50 rounded transition-colors"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => onToggleStatus(loc)}
                    className="flex-1 py-1.5 text-xs text-gray-600 hover:text-orange-500 hover:bg-orange-50 rounded transition-colors"
                  >
                    {loc.status === 'active' ? '停用' : '启用'}
                  </button>
                  <button
                    onClick={() => onDelete(loc.id)}
                    className="flex-1 py-1.5 text-xs text-gray-600 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
