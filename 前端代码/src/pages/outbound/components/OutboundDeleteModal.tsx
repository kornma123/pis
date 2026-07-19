import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { OutboundRecord } from '@/types'

interface Props {
  open: boolean
  record: OutboundRecord | null
  onDelete: () => void
  onClose: () => void
}

export default function OutboundDeleteModal({ open, record, onDelete, onClose }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (!open) return undefined
    titleRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || !record) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6">
      <section role="alertdialog" aria-modal="true" aria-labelledby="outbound-delete-title" aria-describedby="outbound-delete-description" className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 sm:px-6">
          <h2 id="outbound-delete-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-gray-900 outline-none">删除并恢复库存</h2>
          <button type="button" aria-label="关闭删除确认" onClick={onClose} className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </header>
        <div id="outbound-delete-description" className="space-y-3 px-5 py-5 text-sm text-gray-700 sm:px-6">
          <p>确认删除出库单 <strong>{record.outboundNo}</strong>？</p>
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">后端会在同一事务中恢复相关批次库存并软删除出库记录。页面没有撤销入口。</p>
        </div>
        <footer className="flex justify-end gap-3 border-t border-gray-200 px-5 py-4 sm:px-6">
          <button type="button" onClick={onClose} className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">保留记录</button>
          <button type="button" onClick={onDelete} className="h-10 rounded-md bg-red-500 px-4 text-sm font-medium text-white hover:bg-red-600">确认删除并恢复</button>
        </footer>
      </section>
    </div>
  )
}
