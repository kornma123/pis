import React from 'react'
import { formatCurrency } from '@/lib/utils'

interface CostWaterfallItem {
  name: string
  cost: number
  color?: string
}

interface Props {
  items: CostWaterfallItem[]
}

export function CostWaterfall({ items }: Props) {
  const maxCost = Math.max(...items.map(item => Math.abs(Number(item.cost) || 0)), 1)
  const total = items.reduce((sum, item) => sum + (Number(item.cost) || 0), 0)

  return (
    <div className="space-y-3">
      {items.map((item, index) => {
        const cost = Number(item.cost) || 0
        const width = Math.max(6, Math.round(Math.abs(cost) / maxCost * 100))
        return (
          <div key={`${item.name}-${index}`} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-gray-600">{item.name}</span>
              <span className="font-medium text-gray-900">{formatCurrency(cost)}</span>
            </div>
            <div className="h-3 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full ${item.color || (cost >= 0 ? 'bg-blue-500' : 'bg-red-500')}`}
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        )
      })}
      <div className="flex items-center justify-between pt-2 border-t border-gray-200 text-sm">
        <span className="font-medium text-gray-700">合计</span>
        <span className="font-semibold text-gray-900">{formatCurrency(total)}</span>
      </div>
    </div>
  )
}
