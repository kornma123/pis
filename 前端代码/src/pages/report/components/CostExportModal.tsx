import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  onExport: () => void
}

export function CostExportModal({ open, onClose, onExport }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">导出成本分析报告</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">报告格式</label>
            <select className="w-full h-10 px-3 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10">
              <option>PDF 格式</option>
              <option>Excel 格式</option>
              <option>Word 格式</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">报告内容</label>
            <div className="space-y-2">
              {[
                { label: '检测项目成本分析', checked: true },
                { label: '物料消耗明细', checked: true },
                { label: '供应商分析', checked: false },
                { label: '公共成本统计', checked: false },
              ].map((item, idx) => (
                <label key={idx} className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-md cursor-pointer hover:bg-gray-100 transition-colors">
                  <input type="checkbox" defaultChecked={item.checked} className="w-4 h-4 text-blue-500 rounded border-gray-300 focus:ring-blue-500" />
                  <span className="text-sm text-gray-700">{item.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onExport}
            className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors"
          >
            导出报告
          </button>
        </div>
      </div>
    </div>
  )
}
