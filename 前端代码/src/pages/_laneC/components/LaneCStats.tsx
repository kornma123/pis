import { RotateCcw } from 'lucide-react'
import type { LaneCStats as Stats } from '@/api/inventory'
import { requestFailureMessage, type RequestTruth } from '../requestTruth'

interface Props {
  noun: string
  state: RequestTruth<Stats>
  onRetry: () => void
}

const cards = [
  { key: 'monthCount', label: (noun: string) => `本月${noun}`, unit: '笔', border: 'border-l-blue-500' },
  { key: 'monthQty', label: () => '本月件数', unit: '件', border: 'border-l-green-500' },
  { key: 'materialKinds', label: () => '涉及物料', unit: '种', border: 'border-l-amber-500' },
  { key: 'todayCount', label: (noun: string) => `今日${noun}`, unit: '笔', border: 'border-l-gray-400' },
] as const

export default function LaneCStats({ noun, state, onRetry }: Props) {
  const stats = state.status === 'ready' || state.status === 'stale' ? state.data : undefined
  const failure = state.status === 'error' || state.status === 'stale' ? state.failure : undefined

  return (
    <div className="space-y-2">
      {failure && (
        <div role="alert" aria-label={`${noun}统计状态`} className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="flex-1">
            {state.status === 'stale' && '刷新失败，当前显示上次成功结果。'}
            {requestFailureMessage(failure, `${noun}统计`)}
          </span>
          <button onClick={onRetry} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 text-xs hover:bg-amber-100">
            <RotateCcw className="h-3.5 w-3.5" /> 重试
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(card => (
          <div key={card.key} className={`bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 ${card.border}`}>
            <div className="text-2xl font-semibold text-gray-900 tabular-nums">
              {stats
                ? stats[card.key].toLocaleString()
                : state.status === 'loading' ? '加载中' : '不可用'}
              {stats && <span className="text-sm font-normal text-gray-400 ml-1">{card.unit}</span>}
            </div>
            <div className="text-sm text-gray-500 mt-1">{card.label(noun)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
