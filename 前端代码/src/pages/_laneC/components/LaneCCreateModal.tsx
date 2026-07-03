import { Modal } from '@/components/ui/Modal'
import type { LaneCConfig, LaneCForm, Material, Location } from '../types'

interface Props {
  open: boolean
  config: LaneCConfig
  form: LaneCForm
  setForm: (updater: LaneCForm | ((prev: LaneCForm) => LaneCForm)) => void
  materials: Material[]
  locations: Location[]
  submitting: boolean
  onClose: () => void
  onSubmit: () => void
}

const label = 'block text-sm font-medium text-gray-700 mb-1'
const control = 'w-full h-10 px-3 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500'
const req = <span className="text-red-500">*</span>

export default function LaneCCreateModal({ open, config, form, setForm, materials, locations, submitting, onClose, onSubmit }: Props) {
  if (!open) return null
  const set = (patch: Partial<LaneCForm>) => setForm(prev => ({ ...prev, ...patch }))
  const isTransfer = config.createMode === 'transfer'

  return (
    <Modal onClose={onClose} title={config.createLabel} size="lg">
      <div className="space-y-4">
        <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${config.effect.tone === 'up' ? 'bg-green-50 text-green-700' : config.effect.tone === 'down' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
          <span>{config.note}</span>
        </div>

        <div>
          <label className={label}>物料 {req}</label>
          <select value={form.materialId} onChange={e => set({ materialId: e.target.value })} className={control}>
            <option value="">请选择</option>
            {materials.map(m => (
              <option key={m.id} value={m.id}>{m.name}（{m.code}）· 库存 {m.stock} {m.unit}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={label}>数量 {req}</label>
            <input type="number" min={1} value={form.quantity} onChange={e => set({ quantity: Number(e.target.value) })} className={control} />
          </div>
          {isTransfer ? (
            <div>
              <label className={label}>批号</label>
              <input type="text" value={form.batchNo} onChange={e => set({ batchNo: e.target.value })} className={control} />
            </div>
          ) : (
            <div>
              <label className={label}>{config.noun}原因 {req}</label>
              <select value={form.reason} onChange={e => set({ reason: e.target.value })} className={control}>
                <option value="">请选择</option>
                {(config.reasons || []).map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {isTransfer && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>来源库位 {req}</label>
              <select value={form.fromLocationId} onChange={e => set({ fromLocationId: e.target.value })} className={control}>
                <option value="">请选择</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>目标库位 {req}</label>
              <select value={form.toLocationId} onChange={e => set({ toLocationId: e.target.value })} className={control}>
                <option value="">请选择</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>
        )}

        <div>
          <label className={label}>备注</label>
          <textarea value={form.remark} onChange={e => set({ remark: e.target.value })} rows={2}
            className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
        <button onClick={onClose} className="px-4 h-10 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">取消</button>
        <button
          onClick={onSubmit}
          disabled={submitting}
          className={`px-4 h-10 text-sm text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${config.createTone === 'red' ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'}`}
        >
          {submitting ? '提交中...' : `确认${config.noun}`}
        </button>
      </div>
    </Modal>
  )
}
