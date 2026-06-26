import type { MaterialDiff } from '../hooks/useReconciliationPage'

interface Props {
  open: boolean
  fixTarget: MaterialDiff | null
  fixTargetProjectId: string | null
  fixNewUsage: number
  setFixNewUsage: (v: number) => void
  fixNewUnit: string
  setFixNewUnit: (v: string) => void
  fixReason: string
  setFixReason: (v: string) => void
  onClose: () => void
  onConfirm: () => void
}

export function FixBomModal({
  open,
  fixTarget,
  fixNewUsage,
  setFixNewUsage,
  fixNewUnit,
  setFixNewUnit,
  fixReason,
  setFixReason,
  onClose,
  onConfirm,
}: Props) {
  if (!open || !fixTarget) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">修正BOM用量</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-gray-50 p-3 rounded-md">
            <div className="text-xs text-gray-500">当前物料</div>
            <div className="font-semibold text-sm">{fixTarget.materialName}</div>
            <div className="text-xs text-gray-400">{fixTarget.spec}</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">原用量/例</label>
              <input type="text" value={`${fixTarget.bomUsagePerSample} ${fixTarget.bomUnit}`} disabled className="w-full px-3 py-2 text-sm border rounded-md bg-gray-100" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">建议用量/例</label>
              <input type="text" value={`${(fixTarget.bomUsagePerSample * 1.2).toFixed(2)} ${fixTarget.bomUnit}`} disabled className="w-full px-3 py-2 text-sm border rounded-md bg-gray-100 text-amber-700" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">修正为 <span className="text-red-500">*</span></label>
            <div className="flex gap-2">
              <input type="number" step="0.01" value={fixNewUsage} onChange={e => setFixNewUsage(Number(e.target.value))} className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:border-blue-500" />
              <select value={fixNewUnit} onChange={e => setFixNewUnit(e.target.value)} className="w-24 px-3 py-2 text-sm border rounded-md">
                <option>ml</option><option>μl</option><option>L</option><option>g</option><option>mg</option><option>片</option><option>支</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">修正原因 <span className="text-red-500">*</span></label>
            <textarea rows={2} placeholder="请说明修正原因" value={fixReason} onChange={e => setFixReason(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:border-blue-500" />
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800">
            <strong>提示：</strong>提交后不会立即修改 BOM，须由独立的成本负责人（财务/管理员）审核通过后才生效；是否追溯重算历史月份由审核环节决定。
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">取消</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">提交修正（待审核）</button>
        </div>
      </div>
    </div>
  )
}
