import { Archive } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'

interface DepletedRecord {
  id: string
  materialName: string
  spec: string
  batch: string
  depleteType: string
  totalQty: number
  remainQty: number
  unit: string
  startDate: string
  endDate: string
  actualDays: number
}

interface Props {
  records: DepletedRecord[]
}

export function DepletedTab({ records }: Props) {
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200">
        <span className="text-base font-semibold text-gray-900">已耗尽记录</span>
      </div>
      {records.length === 0 ? (
        <EmptyState
          icon={Archive}
          title="暂无已耗尽记录"
          description="批次确认耗尽后会归档到这里，留存实际使用周期备查"
        />
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">物料名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">批次号</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">耗尽类型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">总用量</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">实际剩余</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">使用周期</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">实际天数</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {records.map(rec => (
              <tr key={rec.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{rec.materialName}</div>
                  <div className="text-xs text-gray-500">{rec.spec}</div>
                </td>
                <td className="px-4 py-3 font-mono text-gray-600 text-xs">{rec.batch}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                    rec.depleteType === '正常用完' ? 'bg-green-50 text-green-600' : 'bg-orange-50 text-orange-600'
                  }`}>
                    {rec.depleteType}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-900">{rec.totalQty} {rec.unit}</td>
                <td className="px-4 py-3 text-gray-900">{rec.remainQty} {rec.unit}</td>
                <td className="px-4 py-3 text-gray-600">{rec.startDate} ~ {rec.endDate}</td>
                <td className="px-4 py-3 text-gray-900">{rec.actualDays} 天</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}
