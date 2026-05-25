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
          <thead>
            <tr className="bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">采购金额</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">采购次数</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">合作状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-400">暂无供应商数据</td>
              </tr>
            ) : (
              data.map(item => {
                const ratio = totalAmount > 0 ? ((item.amount / totalAmount) * 100).toFixed(1) : '0.0'
                return (
                  <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-semibold text-gray-900">{item.name}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(item.amount)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{item.orderCount} 次</td>
                    <td className="px-4 py-3 text-right text-gray-600">{ratio}%</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-medium ${item.status === 'long-term' ? 'text-green-600' : 'text-gray-500'}`}>
                        {item.status === 'long-term' ? '长期合作' : '普通合作'}
                      </span>
                    </td>
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
