import { Upload } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  open: boolean
  importData: string
  setImportData: (v: string) => void
  onClose: () => void
  onConfirm: () => void
}

export function ImportLisModal({ open, importData, setImportData, onClose, onConfirm }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">导入LIS病例数据</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        <div className="p-6">
          <div
            className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 hover:bg-blue-50 transition-colors cursor-pointer"
            onClick={() => toast.info('请直接粘贴数据到下方')}
          >
            <Upload className="w-12 h-12 mx-auto text-gray-400 mb-2" />
            <div className="font-medium text-gray-700">点击粘贴LIS数据</div>
            <div className="text-sm text-gray-500 mt-1">支持 病理号,检测项目,操作时间,操作人 格式</div>
          </div>
          <textarea
            value={importData}
            onChange={e => setImportData(e.target.value)}
            placeholder={`P24050187,HE制片,2026-04-15 14:30,张三\nP24050188,免疫组化-IHC,2026-04-15 15:00,李四`}
            rows={6}
            className="w-full mt-4 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">取消</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">确认导入</button>
        </div>
      </div>
    </div>
  )
}
