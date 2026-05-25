import { ArrowDownToLine, ArrowUpFromLine, AlertTriangle } from 'lucide-react'
import type { ActivityItem as ActivityItemType } from '../hooks/useDashboardPage'

interface Props {
  item: ActivityItemType
}

const config = {
  inbound: {
    icon: ArrowDownToLine,
    bg: 'bg-green-50',
    color: 'text-green-500',
    label: '入库',
  },
  outbound: {
    icon: ArrowUpFromLine,
    bg: 'bg-blue-50',
    color: 'text-blue-500',
    label: '出库',
  },
  alert: {
    icon: AlertTriangle,
    bg: 'bg-red-50',
    color: 'text-red-500',
    label: '预警',
  },
}

export function ActivityItem({ item }: Props) {
  const c = config[item.type]
  const Icon = c.icon

  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0">
      <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 ${c.bg}`}>
        <Icon className={`w-4 h-4 ${c.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{item.title}</p>
        <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
      </div>
      <span className="text-xs text-gray-400 flex-shrink-0 whitespace-nowrap">{item.time}</span>
    </div>
  )
}
