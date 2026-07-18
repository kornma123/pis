interface StatsValue {
  total: number | null
  completed: number | null
  pending: number | null
  cancelled: number | null
  totalCost: number | null
}

interface OutboundStatsProps {
  stats: StatsValue
  error?: string | null
  statusFilter: string
  onStatusChange: (status: '' | 'completed' | 'pending' | 'cancelled') => void
  onRetry?: () => void
}

function displayCount(value: number | null) {
  return value === null ? '—' : value.toLocaleString('zh-CN')
}

export default function OutboundStats({ stats, error = null, statusFilter, onStatusChange, onRetry }: OutboundStatsProps) {
  const cards = [
    { key: '', label: '全部记录', value: stats.total, tone: 'blue' },
    { key: 'completed', label: '已完成', value: stats.completed, tone: 'green' },
    { key: 'pending', label: '待出库', value: stats.pending, tone: 'amber' },
    { key: 'cancelled', label: '已取消', value: stats.cancelled, tone: 'red' },
  ] as const

  const activeTone = {
    blue: 'border-blue-500 ring-blue-500',
    green: 'border-green-500 ring-green-500',
    amber: 'border-amber-500 ring-amber-500',
    red: 'border-red-500 ring-red-500',
  }

  return (
    <section aria-label="出库状态统计" className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(card => {
          const active = statusFilter === card.key
          return (
            <button
              key={card.key}
              type="button"
              aria-pressed={active}
              onClick={() => onStatusChange(card.key)}
              className={`rounded-lg border bg-white p-4 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 ${
                active ? `${activeTone[card.tone]} ring-1` : 'border-gray-200 focus:ring-blue-500'
              }`}
            >
              <span className="block text-2xl font-semibold tabular-nums text-gray-900">{displayCount(card.value)}</span>
              <span className="mt-1 block text-sm text-gray-500">{card.label}</span>
            </button>
          )
        })}
      </div>
      {error && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
          <span>统计数据未能刷新；破折号表示未知，已有数字可能是上次成功结果。</span>
          {onRetry && <button type="button" onClick={onRetry} className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100">重试统计</button>}
        </div>
      )}
    </section>
  )
}
