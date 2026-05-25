type QuickFilter = 'all' | 'today' | 'week' | 'month'

interface OutboundQuickFiltersProps {
  quickFilter: QuickFilter
  counts: Record<QuickFilter, number>
  onChange: (filter: QuickFilter) => void
}

const filters: { key: QuickFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
]

export default function OutboundQuickFilters({ quickFilter, counts, onChange }: OutboundQuickFiltersProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {filters.map(f => (
        <button
          key={f.key}
          onClick={() => onChange(f.key)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-all duration-150 ${
            quickFilter === f.key
              ? 'bg-blue-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {f.label}
          <span className={`text-xs ${quickFilter === f.key ? 'text-blue-100' : 'text-gray-400'}`}>
            {counts[f.key]}
          </span>
        </button>
      ))}
    </div>
  )
}
