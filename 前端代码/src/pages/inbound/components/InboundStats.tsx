import { formatCurrency } from '@/lib/utils'

interface InboundStatsProps {
  total: number
  amount: number
  pendingOrders: number
  supplierCount: number
  onFilterStatus: (status: string) => void
}

export default function InboundStats({ total, amount, pendingOrders, supplierCount, onFilterStatus }: InboundStatsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <div
        onClick={() => onFilterStatus('')}
        className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-blue-500 cursor-pointer hover:shadow-md transition-shadow"
      >
        <div className="text-2xl font-semibold text-gray-900">{total}</div>
        <div className="text-sm text-gray-500 mt-1">本月入库</div>
      </div>
      <div
        onClick={() => onFilterStatus('completed')}
        className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-green-500 cursor-pointer hover:shadow-md transition-shadow"
      >
        <div className="text-2xl font-semibold text-gray-900">{formatCurrency(amount)}</div>
        <div className="text-sm text-gray-500 mt-1">入库金额</div>
      </div>
      <div
        onClick={() => onFilterStatus('pending')}
        className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-amber-500 cursor-pointer hover:shadow-md transition-shadow"
      >
        <div className="text-2xl font-semibold text-gray-900">{pendingOrders}</div>
        <div className="text-sm text-gray-500 mt-1">待入库</div>
      </div>
      <div
        onClick={() => { }}
        className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 border-l-4 border-l-gray-500 cursor-pointer hover:shadow-md transition-shadow"
      >
        <div className="text-2xl font-semibold text-gray-900">{supplierCount}</div>
        <div className="text-sm text-gray-500 mt-1">供应商数</div>
      </div>
    </div>
  )
}
