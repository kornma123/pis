interface Props {
  rank: number
}

export function RankBadge({ rank }: Props) {
  const className =
    rank === 1
      ? 'bg-yellow-100 text-yellow-700'
      : rank === 2
        ? 'bg-gray-100 text-gray-600'
        : rank === 3
          ? 'bg-orange-100 text-orange-700'
          : 'bg-gray-50 text-gray-500'
  return (
    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold ${className}`}>
      {rank}
    </span>
  )
}
