import { formatCurrency } from '@/lib/utils'

interface SupplierItem {
  id: string
  name: string
  amount: number
  orderCount: number
  status: string
}

interface Props {
  data: SupplierItem[]
  totalAmount: number
}

export function SupplierCostTable({ data, totalAmount }: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">当前期间供应商采购金额、次数和占比</caption>
          <thead>
            <tr className="bg-gray-50">
              <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
              <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">采购金额</th>
              <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">采购次数</th>
              <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-gray-400">暂无供应商数据</td>
              </tr>
            ) : (
              data.map(item => {
                const ratio = totalAmount > 0 ? ((item.amount / totalAmount) * 100).toFixed(1) : '0.0'
                return (
                  <tr key={item.id} className="hover:bg-gray-50 transition-colors" style={{ contentVisibility: 'auto' }}>
                    <th scope="row" className="px-4 py-3 text-left font-semibold text-gray-900">{item.name}</th>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(item.amount)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{item.orderCount} 次</td>
                    <td className="px-4 py-3 text-right text-gray-600">{ratio}%</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
