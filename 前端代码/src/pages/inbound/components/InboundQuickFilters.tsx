import { cn } from '@/lib/utils'

interface QuickFilterItem {
  key: string
  label: string
  count: number
}

interface InboundQuickFiltersProps {
  items: QuickFilterItem[]
  activeKey: string
  onChange: (key: string) => void
}

export default function InboundQuickFilters({ items, activeKey, onChange }: InboundQuickFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="快捷日期筛选；数量为当前页记录数">
      <span className="text-xs text-gray-500">快捷日期（当前页计数）</span>
      {items.map(item => (
        <button
          key={item.key}
          onClick={() => onChange(item.key)}
          aria-label={`${item.label}，当前页 ${item.count} 条`}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
            activeKey === item.key
              ? 'bg-blue-50 text-blue-600 border border-blue-200'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          )}
        >
          {item.label}
          <span className={cn(
            'px-1.5 py-0.5 rounded-full text-[10px]',
            activeKey === item.key ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'
          )}>
            {item.count}
          </span>
        </button>
      ))}
    </div>
  )
}
