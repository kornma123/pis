import { cn } from '@/lib/utils'

const ITEMS = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
]

interface Props {
  activeKey: string
  onChange: (key: string) => void
}

export default function LaneCQuickFilters({ activeKey, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {ITEMS.map(item => (
        <button
          key={item.key}
          onClick={() => onChange(item.key)}
          className={cn(
            'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
            activeKey === item.key
              ? 'bg-blue-50 text-blue-600 border border-blue-200'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
