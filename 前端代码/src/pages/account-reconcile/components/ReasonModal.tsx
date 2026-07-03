import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { btnCls, btnPri } from '../ui'

interface Props {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  onConfirm: (reason: string) => void
  onClose: () => void
}

/** 反向/敏感操作统一收「理由（必填·记经手人）」的正式弹窗，替代浏览器 prompt。 */
export function ReasonModal({ open, title, description, confirmLabel = '确认', onConfirm, onClose }: Props) {
  const [reason, setReason] = useState('')
  if (!open) return null
  const close = () => { setReason(''); onClose() }
  const submit = () => { const r = reason.trim(); if (!r) return; onConfirm(r); setReason('') }
  return (
    <Modal title={title} size="sm" onClose={close}>
      {description && <p className="mb-3 text-[13px] leading-relaxed text-gray-500">{description}</p>}
      <label className="mb-1.5 block text-xs font-medium text-gray-600">理由（必填 · 记经手人）</label>
      <textarea
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder="写清楚为什么这么做，便于日后追溯"
        className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 outline-none transition-colors focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
      />
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnCls} onClick={close}>取消</button>
        <button className={btnPri} disabled={!reason.trim()} onClick={submit}>{confirmLabel}</button>
      </div>
    </Modal>
  )
}
