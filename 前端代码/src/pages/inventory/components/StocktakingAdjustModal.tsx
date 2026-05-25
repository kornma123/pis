import { X, CheckCircle, AlertTriangle } from 'lucide-react'
import type { StocktakingRecord } from '../hooks/useStocktakingPage'

interface Props {
  open: boolean
  row: StocktakingRecord | null
  onClose: () => void
}

export function StocktakingAdjustModal({ open, row, onClose }: Props) {
  if (!open || !row) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">处理盘点差异</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto space-y-4">
          <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
            <div>
              <div className="text-sm font-medium text-amber-900">发现差异需要处理</div>
              <div className="text-xs text-amber-700 mt-0.5">选择差异原因后确认调整，系统将自动更新库存并记录操作日志</div>
            </div>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3">差异明细</h4>
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
              <div className="p-4 flex items-center gap-4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${row.difference > 0 ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                  {row.difference > 0 ? '+' : '-'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{row.materialName} ({row.materialId})</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    账面: {row.systemStock} | 实盘: {row.actualStock} | 差异: <span className={row.difference > 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>{row.difference > 0 ? '+' : ''}{row.difference}</span>
                  </div>
                </div>
                <select className="px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-32">
                  <option value="">选择原因</option>
                  <option value="normal">正常损耗</option>
                  <option value="record">账务问题</option>
                  <option value="physical">实物问题</option>
                  <option value="other">其他</option>
                </select>
                <input placeholder="备注（选填）" className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-28" />
              </div>
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500">差异汇总</span>
              <span className="text-sm font-semibold">净差异: <span className={row.difference > 0 ? 'text-green-600' : 'text-red-600'}>{row.difference > 0 ? '+' : ''}{row.difference}</span></span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">处理说明</label>
            <textarea rows={2} placeholder="请输入处理说明（选填）" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">取消</button>
          <button className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 flex items-center gap-1">
            <CheckCircle className="w-4 h-4" />确认调整
          </button>
        </div>
      </div>
    </div>
  )
}
