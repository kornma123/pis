import { Modal } from './Modal'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  confirmVariant?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  confirmVariant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null

  return (
    <Modal onClose={onCancel} title={title} size="sm">
      <div className="py-2">
        <p className="text-sm text-gray-600">{message}</p>
      </div>
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
        <button
          onClick={onCancel}
          className="px-4 h-10 text-sm text-gray-600 bg-white border border-gray-300 rounded-[6px] hover:bg-gray-50 transition-colors"
        >
          {cancelText}
        </button>
        <button
          onClick={onConfirm}
          className={`px-4 h-10 text-sm text-white rounded-[6px] transition-colors ${
            confirmVariant === 'danger'
              ? 'bg-red-500 hover:bg-red-600'
              : 'bg-[#3b82f6] hover:bg-blue-600'
          }`}
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  )
}
