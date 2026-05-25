interface OutboundStatsProps {
  stats: {
    monthTotal: number
    completed: number
    pending: number
    cancelled: number
  }
  statusFilter: string
  onStatusChange: (status: '' | 'completed' | 'pending' | 'cancelled') => void
}

export default function OutboundStats({ stats, statusFilter, onStatusChange }: OutboundStatsProps) {
  const cards = [
    { key: '', label: '本月出库', value: stats.monthTotal, color: 'blue' as const },
    { key: 'completed', label: '已完成', value: stats.completed, color: 'green' as const },
    { key: 'pending', label: '待出库', value: stats.pending, color: 'yellow' as const },
    { key: 'cancelled', label: '已取消', value: stats.cancelled, color: 'red' as const },
  ] as const

  const colorMap = {
    blue: { activeBorder: 'border-blue-500', activeRing: 'ring-blue-500', text: 'text-gray-900' },
    green: { activeBorder: 'border-green-500', activeRing: 'ring-green-500', text: 'text-green-600' },
    yellow: { activeBorder: 'border-yellow-500', activeRing: 'ring-yellow-500', text: 'text-yellow-600' },
    red: { activeBorder: 'border-red-500', activeRing: 'ring-red-500', text: 'text-red-600' },
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(c => {
        const colors = colorMap[c.color]
        const active = statusFilter === c.key
        return (
          <div
            key={c.key}
            onClick={() => onStatusChange(c.key as any)}
            className={`cursor-pointer bg-white rounded-lg border p-5 shadow-sm transition-all duration-150 hover:shadow-md ${
              active ? `${colors.activeBorder} ring-1 ${colors.activeRing}` : 'border-gray-200'
            }`}
          >
            <div className={`text-2xl font-semibold ${colors.text}`}>{c.value}</div>
            <div className="text-sm text-gray-500 mt-1">{c.label}</div>
          </div>
        )
      })}
    </div>
  )
}
