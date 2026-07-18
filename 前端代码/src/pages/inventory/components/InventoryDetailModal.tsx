import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { InventoryItem } from '@/types'

interface InventoryEvidence extends InventoryItem {
  batch?: string
  expiry?: string
}

interface Props {
  open: boolean
  item: InventoryEvidence | null
  canOutbound?: boolean
  onClose: () => void
  onOutbound: () => void
}

function locationEvidence(item: InventoryEvidence) {
  if (!item.locationId) return '未登记库位'
  if (!item.locationName || item.locationName === '-') return '库位引用失效'
  return `${item.locationName}（未按批次验证）`
}

export function InventoryDetailModal({ open, item, canOutbound = true, onClose, onOutbound }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (!open) return undefined
    titleRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || !item) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby="inventory-detail-title" className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 id="inventory-detail-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-gray-900 outline-none">库存证据详情</h2>
          <button
            type="button"
            aria-label="关闭库存详情"
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">
          <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            本页是物料级正库存缓存。批次与效期仅代表当前 FEFO 起始候选；登记库位不是按批次核实的持仓或容量承诺。
          </div>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-gray-500">物料名称</dt>
              <dd className="text-sm font-medium text-gray-900 mt-0.5">{item.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">物料编码</dt>
              <dd className="text-sm font-mono text-gray-900 mt-0.5">{item.code}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">规格</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{item.spec || '未提供'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">单位</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{item.unit}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">正库存缓存</dt>
              <dd className="text-sm font-medium text-gray-900 mt-0.5">{item.stock} {item.unit}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">安全库存</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{item.minStock} {item.unit}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">FEFO 起始批次</dt>
              <dd className="text-sm font-mono text-gray-900 mt-0.5">{item.batch && item.batch !== '-' ? item.batch : '未取得可用批次证据'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">候选批次效期</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{item.expiry && item.expiry !== '-' ? item.expiry : '未取得效期证据'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-gray-500">登记库位（未按批次验证）</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{locationEvidence(item)}</dd>
            </div>
          </dl>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
          >
            关闭
          </button>
          {canOutbound && (
            <button
              type="button"
              onClick={() => { onClose(); onOutbound() }}
              className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm"
            >
              加入出库单
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
