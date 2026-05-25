import { X } from 'lucide-react'
import type { OperationLog } from '@/types'

interface Props {
  open: boolean
  log: OperationLog | null
  getLogType: (op: string) => { value: string; label: string; className: string }
  getModuleLabel: (moduleVal: string) => string
  onClose: () => void
}

export function LogDetailModal({ open, log, getLogType, getModuleLabel, onClose }: Props) {
  if (!open || !log) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">操作详情</h3>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 rounded-md transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="grid grid-cols-2 gap-5 mb-6">
            <Info label="操作时间" value={new Date(log.createdAt).toLocaleString()} mono />
            <Info label="操作类型" value={
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getLogType(log.operation).className}`}>
                {getLogType(log.operation).label}
              </span>
            } />
            <Info label="操作用户" value={log.username} />
            <Info label="操作模块" value={getModuleLabel(log.requestData?.module as string || '')} />
            <Info label="IP地址" value={log.ip} mono />
            <Info label="浏览器" value={log.userAgent || '-'} />
          </div>

          <div className="mb-6">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">操作内容</h4>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="text-sm text-gray-900 mb-1">{log.description}</div>
              {log.requestData && (
                <div className="text-[13px] text-gray-500">{JSON.stringify(log.requestData)}</div>
              )}
            </div>
          </div>

          {log.requestData && (
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-3">变更详情</h4>
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-4 py-2 text-xs text-gray-500 border-b border-gray-200">请求数据</div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-200">
                    {Object.entries(log.requestData).map(([key, value]) => (
                      <tr key={key}>
                        <td className="px-4 py-2.5 w-[140px] bg-gray-50 font-medium text-gray-700">{key}</td>
                        <td className="px-4 py-2.5 text-gray-900">{String(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm transition-all">关闭</button>
        </div>
      </div>
    </div>
  )
}

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-[15px] font-semibold text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}
