import { formatCurrency } from '@/lib/utils'

interface InboundStatsProps {
  total: number | null
  amount: number | null
  pendingOrders: number | null
  supplierCount: number | null
  error: string | null
  onFilterStatus: (status: string) => void
}

function StatValue({ value, error, currency = false }: { value: number | null; error: string | null; currency?: boolean }) {
  if (error) return <span className="text-base font-medium text-red-700">未能核实</span>
  if (value === null) return <span className="text-base font-medium text-gray-500">核实中…</span>
  return <>{currency ? formatCurrency(value) : value}</>
}

export default function InboundStats({ total, amount, pendingOrders, supplierCount, error, onFilterStatus }: InboundStatsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="入库统计">
      <button
        type="button"
        onClick={() => onFilterStatus('')}
        className="min-h-24 rounded-lg border border-gray-200 border-l-4 border-l-blue-500 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <div className="text-2xl font-semibold text-gray-900"><StatValue value={total} error={error} /></div>
        <div className="mt-1 text-sm text-gray-500">全部入库记录</div>
      </button>
      <div className="min-h-24 rounded-lg border border-gray-200 border-l-4 border-l-green-500 bg-white p-5 shadow-sm"
        title={error || undefined}
      >
        <div className="text-2xl font-semibold text-gray-900"><StatValue value={amount} error={error} currency /></div>
        <div className="mt-1 text-sm text-gray-500">全部入库金额</div>
      </div>
      <button
        type="button"
        onClick={() => onFilterStatus('pending')}
        className="min-h-24 rounded-lg border border-gray-200 border-l-4 border-l-amber-500 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <div className="text-2xl font-semibold text-gray-900"><StatValue value={pendingOrders} error={error} /></div>
        <div className="mt-1 text-sm text-gray-500">待入库采购单</div>
      </button>
      <div className="min-h-24 rounded-lg border border-gray-200 border-l-4 border-l-gray-500 bg-white p-5 shadow-sm" title={error || undefined}>
        <div className="text-2xl font-semibold text-gray-900"><StatValue value={supplierCount} error={error} /></div>
        <div className="mt-1 text-sm text-gray-500">涉及供应商</div>
      </div>
    </div>
  )
}
