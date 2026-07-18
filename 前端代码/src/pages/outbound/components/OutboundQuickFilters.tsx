type QuickFilter = 'all' | 'today' | 'week' | 'month'

interface OutboundQuickFiltersProps {
  quickFilter: QuickFilter
  onChange: (filter: QuickFilter) => void
}

const filters: Array<{ key: QuickFilter; label: string }> = [
  { key: 'all', label: '全部日期' },
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
]

export default function OutboundQuickFilters({ quickFilter, onChange }: OutboundQuickFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="出库日期快捷筛选">
      {filters.map(filter => (
        <button
          key={filter.key}
          type="button"
          aria-pressed={quickFilter === filter.key}
          onClick={() => onChange(filter.key)}
          className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
            quickFilter === filter.key ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {filter.label}
        </button>
      ))}
    </div>
  )
}
