import { useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  onExport: () => void | Promise<void>
  exporting: boolean
  dataReady: boolean
}

export function CostExportModal({ open, onClose, onExport, exporting, dataReady }: Props) {
  useEffect(() => {
    if (!open || exporting) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [exporting, onClose, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={e => { if (!exporting && e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby="cost-export-title" className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 id="cost-export-title" className="text-lg font-semibold text-gray-900">导出成本分析报告</h3>
          <button
            onClick={onClose}
            disabled={exporting}
            aria-label="关闭导出窗口"
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-3">
          <div className="text-sm font-medium text-gray-700">CSV 文件</div>
          <p className="text-sm text-gray-500 leading-6">
            生成当前期间、样本数来源和项目分类筛选下的项目、物料及供应商数据。
          </p>
          <p className="text-xs text-gray-400">
            浏览器开始下载后才会提示成功；生成失败时窗口会保留以便重试。
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            disabled={exporting}
            className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onExport}
            disabled={exporting || !dataReady}
            className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {exporting ? '正在生成文件…' : dataReady ? '生成并下载 CSV' : '等待筛选结果…'}
          </button>
        </div>
      </div>
    </div>
  )
}
