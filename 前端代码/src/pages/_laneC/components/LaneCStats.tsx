import type { LaneCStats as Stats } from '@/api/inventory'

interface Props {
  noun: string
  stats: Stats
}

const cards = [
  { key: 'monthCount', label: (n: string) => `本月${n}`, unit: '笔', border: 'border-l-blue-500' },
  { key: 'monthQty', label: () => '本月件数', unit: '件', border: 'border-l-green-500' },
  { key: 'materialKinds', label: () => '涉及物料', unit: '种', border: 'border-l-amber-500' },
  { key: 'todayCount', label: (n: string) => `今日${n}`, unit: '笔', border: 'border-l-gray-400' },
] as const

export default function LaneCStats({ noun, stats }: Props) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(c => (
        <div key={c.key} className={`bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 ${c.border}`}>
          <div className="text-2xl font-semibold text-gray-900 tabular-nums">
            {Number(stats[c.key] ?? 0).toLocaleString()}
            <span className="text-sm font-normal text-gray-400 ml-1">{c.unit}</span>
          </div>
          <div className="text-sm text-gray-500 mt-1">{c.label(noun)}</div>
        </div>
      ))}
    </div>
  )
}
