import { toast } from 'sonner'

interface DepletionItem {
  id: string
  materialName: string
  batch: string
  totalQty: number
  unit: string
  startDate: string
  daysUsed: number
}

interface Props {
  open: boolean
  item: DepletionItem | null
  depleteType: 'normal' | 'expired'
  remainValue: string
  expiredReason: string
  expiredRemark: string
  onClose: () => void
  onChangeType: (v: 'normal' | 'expired') => void
  onChangeRemainValue: (v: string) => void
  onChangeExpiredReason: (v: string) => void
  onChangeExpiredRemark: (v: string) => void
}

export function ConfirmDepleteModal({
  open,
  item,
  depleteType,
  remainValue,
  expiredReason,
  expiredRemark,
  onClose,
  onChangeType,
  onChangeRemainValue,
  onChangeExpiredReason,
  onChangeExpiredRemark,
}: Props) {
  if (!open || !item) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">确认物料耗尽</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-5">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-[13px] text-gray-500 mb-1">当前物料</div>
            <div className="font-semibold text-gray-900">{item.materialName}（{item.batch}）</div>
            <div className="text-xs text-gray-500 mt-1">{item.totalQty}{item.unit} · 出库时间：{item.startDate} · 已用{item.daysUsed}天</div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">耗尽类型 <span className="text-red-500">*</span></label>
            <div className="flex gap-3">
              <label onClick={() => onChangeType('normal')} className={`flex items-center gap-2 cursor-pointer px-4 py-2 rounded-lg border-2 transition-all ${depleteType === 'normal' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="radio" checked={depleteType === 'normal'} onChange={() => onChangeType('normal')} className="accent-[#3b82f6]" />
                <span className="text-sm font-medium">正常用完</span>
              </label>
              <label onClick={() => onChangeType('expired')} className={`flex items-center gap-2 cursor-pointer px-4 py-2 rounded-lg border-2 transition-all ${depleteType === 'expired' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="radio" checked={depleteType === 'expired'} onChange={() => onChangeType('expired')} className="accent-[#3b82f6]" />
                <span className="text-sm font-medium">过期废弃</span>
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">实际剩余量 <span className="text-red-500">*</span></label>
            <div className="flex gap-2">
              <input type="number" value={remainValue} onChange={e => onChangeRemainValue(e.target.value)} className="flex-1 h-10 px-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease" />
              <select className="w-24 h-10 px-2 border border-gray-300 rounded-md text-sm bg-white">
                <option>ml</option><option>μl</option><option>g</option><option>mg</option>
              </select>
            </div>
            <div className="text-xs text-gray-500 mt-1">输入 0 表示完全耗尽，如有剩余请输入具体数量</div>
          </div>
          {depleteType === 'expired' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">过期原因 <span className="text-red-500">*</span></label>
                <select value={expiredReason} onChange={e => onChangeExpiredReason(e.target.value)} className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white mb-2 focus:outline-none focus:border-blue-500">
                  <option value="">选择原因</option>
                  <option value="expired">物料已过有效期</option>
                  <option value="quality">物料变质/污染</option>
                  <option value="excess">采购过量，无法在效期内用完</option>
                  <option value="project-cancel">关联项目取消/暂停</option>
                  <option value="other">其他</option>
                </select>
                <textarea rows={2} placeholder="请补充说明具体情况" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease resize-none" />
              </div>
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="text-[13px] text-red-600"><strong>注意：</strong>标记为"过期废弃"后，该批次剩余量（<span>{remainValue}</span>）将计入损耗成本，不影响BOM对账的正常消耗统计。</div>
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">备注（可选）</label>
            <textarea value={expiredRemark} onChange={e => onChangeExpiredRemark(e.target.value)} rows={2} placeholder="如有特殊情况请备注" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease resize-none" />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease">取消</button>
          <button onClick={() => { toast.success('物料已确认耗尽'); onClose() }} className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-all duration-150 ease shadow-sm">确认耗尽</button>
        </div>
      </div>
    </div>
  )
}
