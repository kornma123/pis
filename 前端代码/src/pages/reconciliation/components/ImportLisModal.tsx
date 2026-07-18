import { useEffect } from 'react'
import { Upload } from 'lucide-react'

interface Props {
  open: boolean
  importData: string
  setImportData: (v: string) => void
  onClose: () => void
  onConfirm: () => void
}

export function ImportLisModal({ open, importData, setImportData, onClose, onConfirm }: Props) {
  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby="import-lis-title" className="relative mx-4 w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 id="import-lis-title" className="text-lg font-semibold text-gray-900">导入 LIS 病例数据</h3>
          <button type="button" aria-label="关闭导入对话框" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        <div className="p-6">
          <div className="rounded-lg border-2 border-dashed border-gray-300 p-6 text-center">
            <Upload className="w-12 h-12 mx-auto text-gray-400 mb-2" />
            <div className="font-medium text-gray-700">把 LIS 数据粘贴到下方</div>
            <div className="text-sm text-gray-500 mt-1">每行格式：病理号, 检测项目, 操作时间, 操作人</div>
          </div>
          <textarea
            value={importData}
            onChange={e => setImportData(e.target.value)}
            aria-label="待导入的 LIS 病例数据"
            placeholder={`病理号,检测项目,操作时间,操作人\n病理号,检测项目,操作时间,操作人`}
            rows={6}
            className="w-full mt-4 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">取消</button>
          <button type="button" disabled={!importData.trim()} onClick={onConfirm} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">确认导入</button>
        </div>
      </div>
    </div>
  )
}
