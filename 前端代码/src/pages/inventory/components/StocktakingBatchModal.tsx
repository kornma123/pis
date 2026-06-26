import { X, Plus, Trash2, Loader2, Layers } from 'lucide-react'
import type { Material } from '@/types'
import type { BatchRow } from '../hooks/useStocktakingPage'

interface Props {
  open: boolean
  rows: BatchRow[]
  operator: string
  materials: Material[]
  isSubmitting: boolean
  onClose: () => void
  onRowsChange: (rows: BatchRow[]) => void
  onOperatorChange: (v: string) => void
  onSubmit: () => void
}

export function StocktakingBatchModal({
  open, rows, operator, materials, isSubmitting,
  onClose, onRowsChange, onOperatorChange, onSubmit,
}: Props) {
  if (!open) return null

  const usedIds = new Set(rows.map(r => r.materialId).filter(Boolean))
  const filledCount = rows.filter(r => r.materialId).length

  const updateRow = (idx: number, patch: Partial<BatchRow>) => {
    onRowsChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  const addRow = () => onRowsChange([...rows, { materialId: '', actualStock: '', remark: '' }])
  const removeRow = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx)
    onRowsChange(next.length ? next : [{ materialId: '', actualStock: '', remark: '' }])
  }

  const systemStockOf = (materialId: string) =>
    materials.find(m => m.id === materialId)?.stock ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Layers className="w-5 h-5 text-blue-500" />批量盘点
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-500" /></button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700">
            一次提交多个物料的实盘数量。任一行非法将整单拒绝（全部成功或全部不写入）。
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">盘点负责人</label>
            <input
              value={operator}
              onChange={e => onOperatorChange(e.target.value)}
              placeholder="请输入负责人（可选）"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>

          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-24">账面数量</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-28">实盘数量 <span className="text-red-500">*</span></th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-24">差异</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">备注</th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row, idx) => {
                  const sysStock = row.materialId ? systemStockOf(row.materialId) : 0
                  const diff = row.materialId && row.actualStock !== '' ? Number(row.actualStock) - sysStock : null
                  return (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <select
                          aria-label={`物料-${idx + 1}`}
                          value={row.materialId}
                          onChange={e => updateRow(idx, { materialId: e.target.value })}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                        >
                          <option value="">请选择物料</option>
                          {materials.map(m => (
                            <option key={m.id} value={m.id} disabled={usedIds.has(m.id) && m.id !== row.materialId}>
                              {m.code} · {m.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-gray-500">{row.materialId ? sysStock : '-'}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          aria-label={`实盘数量-${idx + 1}`}
                          value={row.actualStock}
                          onChange={e => updateRow(idx, { actualStock: e.target.value === '' ? '' : Number(e.target.value) })}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                        />
                      </td>
                      <td className="px-3 py-2">
                        {diff === null ? <span className="text-gray-400">-</span> : (
                          <span className={diff === 0 ? 'text-gray-500' : diff > 0 ? 'text-green-600' : 'text-red-600'}>
                            {diff > 0 ? `+${diff}` : diff}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={row.remark}
                          onChange={e => updateRow(idx, { remark: e.target.value })}
                          placeholder="选填"
                          className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => removeRow(idx)}
                          aria-label={`删除第 ${idx + 1} 行`}
                          className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <button
            onClick={addRow}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-blue-600 border border-blue-200 rounded-md hover:bg-blue-50 transition-colors"
          >
            <Plus className="w-4 h-4" />添加一行
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <span className="text-sm text-gray-500">已填写 <strong>{filledCount}</strong> 项</span>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">取消</button>
            <button
              onClick={onSubmit}
              disabled={isSubmitting || filledCount === 0}
              className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}提交盘点
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
