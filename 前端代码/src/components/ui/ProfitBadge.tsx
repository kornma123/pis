import React from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface ProfitBadgeProps {
  rate: number
  showIcon?: boolean
  showPercent?: boolean
}

export function ProfitBadge({ rate, showIcon = false, showPercent = true }: ProfitBadgeProps) {
  const percent = (rate * 100).toFixed(1)

  let colorClass: string
  let Icon: typeof TrendingUp

  if (rate >= 0.2) {
    colorClass = 'bg-green-100 text-green-800'
    Icon = TrendingUp
  } else if (rate >= 0) {
    colorClass = 'bg-yellow-100 text-yellow-800'
    Icon = Minus
  } else {
    colorClass = 'bg-red-100 text-red-800'
    Icon = TrendingDown
  }

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${colorClass}`}>
      {showIcon && <Icon className="h-3 w-3 mr-1" />}
      {showPercent ? `${percent}%` : percent}
    </span>
  )
}
