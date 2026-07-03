import { ArrowRightLeft, ArrowUp, ArrowDown } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import type { LaneCConfig, LaneCRecord, Material } from '../types'

interface Props {
  open: boolean
  config: LaneCConfig
  record: LaneCRecord | null
  materials: Material[]
  onClose: () => void
}

const toneStyles: Record<string, string> = {
  up: 'bg-green-50 text-green-700',
  down: 'bg-red-50 text-red-700',
  neutral: 'bg-gray-100 text-gray-600',
}

export default function LaneCDetailModal({ open, config, record, materials, onClose }: Props) {
  if (!open || !record) return null
  const fields = config.detailFields(record, { materials })
  const EffectIcon = config.effect.tone === 'up' ? ArrowUp : config.effect.tone === 'down' ? ArrowDown : ArrowRightLeft

  return (
    <Modal onClose={onClose} title={`${config.noun}详情`} size="lg">
      <div className="grid grid-cols-2 gap-3">
        {fields.map((f, i) => (
          <div key={i} className="bg-gray-50 rounded-lg px-3 py-2.5">
            <div className="text-xs text-gray-400">{f.label}</div>
            <div className="text-sm text-gray-900 mt-0.5 tabular-nums break-words">{f.value ?? '—'}</div>
          </div>
        ))}
        <div className={`col-span-2 flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm ${toneStyles[config.effect.tone]}`}>
          <EffectIcon className="w-4 h-4" />
          本次操作对库存的影响：{config.effect.text}
        </div>
      </div>
      <div className="flex items-center justify-end mt-6 pt-4 border-t border-gray-200">
        <button onClick={onClose} className="px-4 h-10 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
          关闭
        </button>
      </div>
    </Modal>
  )
}
