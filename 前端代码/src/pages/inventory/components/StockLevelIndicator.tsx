
interface StockLevelIndicatorProps {
  stock: number
  minStock: number
}

export function StockLevelIndicator({ stock, minStock }: StockLevelIndicatorProps) {
  if (stock === 0) return <span className="ml-2 text-[11px] text-red-500">缺货</span>
  if (stock <= minStock) return <span className="ml-2 text-[11px] text-orange-500">偏低</span>
  if (stock < minStock * 2) return <span className="ml-2 text-[11px] text-green-500">正常</span>
  return <span className="ml-2 text-[11px] text-green-500">充足</span>
}
