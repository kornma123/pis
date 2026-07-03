import { PackageOpen } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'

interface DepletionItem {
  id: string
  materialName: string
  spec: string
  batch: string
  status: string
  totalQty: number
  remaining: number
  unit: string
  daysUsed: number
  expectedDays: number
  progress: number
}

interface Props {
  items: DepletionItem[]
  onEditRemain: (item: DepletionItem) => void
  onConfirmDeplete: (item: DepletionItem) => void
}

export function DepletionTab({ items, onEditRemain, onConfirmDeplete }: Props) {
  if (items.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm">
        <EmptyState
          icon={PackageOpen}
          title="暂无使用中的批次"
          description="领用出库后，正在使用的批次会显示在这里，方便跟踪剩余量和用尽进度"
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {items.map(dep => (
        <div key={dep.id} className="bg-white rounded-lg shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-base font-semibold text-gray-900">{dep.materialName}</div>
              <div className="text-xs text-gray-500 mt-0.5">{dep.spec} · 批次: {dep.batch}</div>
            </div>
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              dep.status === 'warning' ? 'bg-orange-50 text-orange-600' : 'bg-green-50 text-green-600'
            }`}>
              {dep.status === 'warning' ? '即将耗尽' : '使用中'}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-4 mb-3">
            <div>
              <div className="text-xs text-gray-500">总用量</div>
              <div className="text-sm font-medium text-gray-900">{dep.totalQty} {dep.unit}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">剩余量</div>
              <div className="text-sm font-medium text-gray-900">{dep.remaining} {dep.unit}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">已用天数</div>
              <div className="text-sm font-medium text-gray-900">{dep.daysUsed} 天</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">预计剩余</div>
              <div className="text-sm font-medium text-gray-900">{dep.expectedDays - dep.daysUsed} 天</div>
            </div>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                dep.progress > 90 ? 'bg-orange-500' : 'bg-green-500'
              }`}
              style={{ width: `${dep.progress}%` }}
            />
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={() => onEditRemain(dep)}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              修改剩余量
            </button>
            <button
              onClick={() => onConfirmDeplete(dep)}
              className="px-3 py-1.5 text-sm text-blue-500 hover:text-blue-600 transition-colors"
            >
              确认耗尽
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
