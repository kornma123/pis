import { X } from 'lucide-react'
import { getStocktakingStatusDisplay, type StocktakingRecord } from '../hooks/useStocktakingPage'

interface Props {
  open: boolean
  row: StocktakingRecord | null
  onClose: () => void
  onAdjust: (row: StocktakingRecord) => void
}

export function StocktakingDetailModal({ open, row, onClose, onAdjust }: Props) {
  if (!open || !row) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">盘点详情 - {row.stocktakingNo}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-500" /></button>
        </div>
        <div className="p-6 overflow-y-auto space-y-6">
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3">基本信息</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: '盘点编号', value: row.stocktakingNo },
                { label: '盘点名称', value: row.materialName ? `${row.materialName}盘点` : row.stocktakingNo },
                { label: '盘点范围', value: '全部物料' },
                { label: '盘点方式', value: '全盘' },
                { label: '负责人', value: row.operator || '-' },
                { label: '创建时间', value: row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-') : '-' },
                { label: '盘点进度', value: '100%' },
                { label: '状态', value: (() => { const s = getStocktakingStatusDisplay(row.status); return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${s.cls}`}>{s.label}</span> })() },
              ].map(item => (
                <div key={item.label}>
                  <div className="text-xs text-gray-500 mb-1">{item.label}</div>
                  <div className="text-sm font-medium text-gray-900">{item.value}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3">盘点明细</h4>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料编码</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">账面数量</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">实盘数量</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">差异数量</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-gray-600 text-xs">{row.materialId}</td>
                    <td className="px-3 py-2">{row.materialName}</td>
                    <td className="px-3 py-2">{row.systemStock}</td>
                    <td className="px-3 py-2">{row.actualStock}</td>
                    <td className="px-3 py-2">
                      <span className={`font-semibold ${row.difference > 0 ? 'text-green-600' : row.difference < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {row.difference > 0 ? '+' : ''}{row.difference}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        row.difference === 0 ? 'bg-green-50 text-green-600' :
                        row.difference > 0 ? 'bg-green-50 text-green-600' :
                        'bg-red-50 text-red-600'
                      }`}>
                        {row.difference === 0 ? '相符' : row.difference > 0 ? '盘盈' : '盘亏'}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">关闭</button>
          {row.status === 'pending' && row.difference !== 0 && (
            <button onClick={() => onAdjust(row)} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600">处理差异</button>
          )}
        </div>
      </div>
    </div>
  )
}
