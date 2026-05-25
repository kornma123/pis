import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface Props {
  value: number
}

export function ChangeBadge({ value }: Props) {
  if (value > 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-red-600">
        <TrendingUp className="w-3 h-3" />+{value}%
      </span>
    )
  }
  if (value < 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-green-600">
        <TrendingDown className="w-3 h-3" />{value}%
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium text-gray-500">
      <Minus className="w-3 h-3" />0%
    </span>
  )
}
