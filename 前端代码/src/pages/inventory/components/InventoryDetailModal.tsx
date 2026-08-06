import type { InventoryItem, InventoryPosition } from '@/types'

interface Props {
  open: boolean
  item: InventoryItem | null
  onClose: () => void
  onOutbound: () => void
}

export function InventoryDetailModal({ open, item, onClose, onOutbound }: Props) {
  if (!open || !item) return null

  // 位置明细：后端合同只返回 quantity > 0 的位置，已按批次到期先后排序；
  // 本组件只做如实展示，不推算消耗、不判断批次是否可用、不重排
  const positions: InventoryPosition[] = item.positions ?? []
  const positionTotal = positions.reduce((sum, p) => sum + p.quantity, 0)
  const hasPositions = positions.length > 0
  const hasBatchRow = positions.some(p => p.batchNo)
  // 警示由「位置合计 ≠ 库存数量」判定驱动，不是硬编码开关
  const showMismatch = hasPositions && positionTotal !== item.stock

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inventory-detail-title"
        className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 id="inventory-detail-title" className="text-lg font-semibold text-gray-900">库存详情</h3>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none rounded-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/10"
          >
            ×
          </button>
        </div>
        <div className="p-6">
          <dl className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
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
              <dd className="text-sm text-gray-900 mt-0.5">{item.spec || '-'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">单位</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{item.unit}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">库存数量</dt>
              <dd className="text-sm font-medium text-gray-900 mt-0.5 tabular-nums">{item.stock}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">安全库存</dt>
              <dd className="text-sm text-gray-900 mt-0.5 tabular-nums">{item.minStock}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">供应商</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{item.supplierName || '-'}</dd>
            </div>
          </dl>

          <div className="mt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
              <h4 className="text-base font-semibold text-gray-900">位置明细</h4>
              <span className="text-[13px] text-gray-600 tabular-nums">
                {positions.length} 个位置，共 {positionTotal} {item.unit}
              </span>
            </div>

            {showMismatch && (
              <div
                role="alert"
                className="mb-3 rounded-lg border border-amber-600 bg-orange-50 px-3 py-2.5 text-[13px] text-amber-800"
              >
                数据不一致：位置合计（{positionTotal} {item.unit}）与库存数量（{item.stock} {item.unit}）不符。两组数字均按原始记录如实显示；如差异持续存在，请联系系统管理员核查库存数据。
              </div>
            )}

            {hasPositions ? (
              <>
                <div className="max-h-[264px] overflow-auto rounded-lg border border-gray-200">
                  <table aria-label="库存位置明细" className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th scope="col" className="sticky top-0 border-b border-gray-200 bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700">批次</th>
                        <th scope="col" className="sticky top-0 border-b border-gray-200 bg-gray-50 px-4 py-3 text-left text-xs font-medium text-gray-700">库位</th>
                        <th scope="col" className="sticky top-0 border-b border-gray-200 bg-gray-50 px-4 py-3 text-right text-xs font-medium text-gray-700 tabular-nums">数量（{item.unit}）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p, idx) => {
                        const cellClass = `px-4 py-3 text-sm text-gray-900${idx < positions.length - 1 ? ' border-b border-gray-200' : ''}`
                        return (
                          <tr key={`${p.batchId ?? 'nonbatch'}:${p.locationId}:${idx}`}>
                            <td className={cellClass}>
                              {p.batchNo
                                ? <span className="font-mono text-[13px]">{p.batchNo}</span>
                                : <span className="text-gray-500">非批次管理</span>}
                            </td>
                            <td className={cellClass}>{p.locationName}</td>
                            <td className={`${cellClass} text-right tabular-nums`}>{p.quantity}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {hasBatchRow && (
                  <p className="mt-2 text-xs text-gray-500">批次位置按到期时间先后排列，最早到期的批次在最前。</p>
                )}
              </>
            ) : (
              <div role="status" className="rounded-lg bg-gray-50 px-4 py-5 text-center text-[13px] text-gray-500">
                当前没有可展示的位置明细，但库存数量仍为 {item.stock} {item.unit}。位置数据可能尚未同步，可关闭后重新打开查看；如持续出现，请联系系统管理员核查。
              </div>
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="h-10 px-4 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/10"
          >
            关闭
          </button>
          <button
            onClick={() => { onClose(); onOutbound() }}
            className="h-10 px-4 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/10"
          >
            出库
          </button>
        </div>
      </div>
    </div>
  )
}
