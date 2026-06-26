import { QrCode } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { materialApi } from '@/api/master'
import type { Material } from '@/types'
import { toast } from 'sonner'

interface InboundScanModalProps {
  open: boolean
  onClose: () => void
  onManualInput: () => void
  onScanSuccess?: (materialId: string) => void
}

export default function InboundScanModal({ open, onClose, onManualInput, onScanSuccess }: InboundScanModalProps) {
  if (!open) return null

  return (
    <Modal onClose={onClose} title="扫码入库">
      <div className="text-center py-6">
        <QrCode className="w-16 h-16 mx-auto text-gray-400 mb-3" />
        <div className="text-sm text-gray-600 mb-1">请使用扫码枪扫描或手动输入条码</div>
        <div className="text-xs text-gray-400 mb-4">系统将自动匹配物料信息</div>
        <div className="max-w-sm mx-auto">
          <input
            type="text"
            autoFocus
            placeholder="请扫描或输入条码..."
            className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const code = (e.target as HTMLInputElement).value.trim()
                if (!code) return
                try {
                  const res: any = await materialApi.getList({ keyword: code, pageSize: 10 })
                  const matched = res?.list?.find((m: Material) =>
                    m.code?.toLowerCase() === code.toLowerCase() ||
                    m.name?.toLowerCase().includes(code.toLowerCase())
                  )
                  if (matched) {
                    toast.success('扫码成功', { description: `已识别耗材：${matched.name}` })
                    setTimeout(() => {
                      onClose()
                      onScanSuccess?.(matched.id)
                    }, 400)
                  } else {
                    toast.error('未找到匹配物料', { description: `条码 "${code}" 未匹配到任何物料` })
                  }
                } catch {
                  /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
                }
              }
            }}
          />
        </div>
        <div className="mt-4 p-3 bg-gray-50 rounded-lg">
          <div className="text-xs text-gray-500 mb-2">支持以下条码类型：</div>
          <div className="flex flex-wrap justify-center gap-2">
            {['Code 128', 'Code 39', 'EAN-13', 'QR Code'].map(code => (
              <span key={code} className="px-2 py-1 bg-white rounded text-xs text-gray-500 border border-gray-200">
                {code}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => { onClose(); onManualInput() }}
          className="px-4 py-2 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors"
        >
          手动输入
        </button>
      </div>
    </Modal>
  )
}
