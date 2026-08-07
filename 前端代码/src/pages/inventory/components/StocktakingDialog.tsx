import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface Props {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  returnFocus?: HTMLElement | null
  size?: 'sm' | 'md' | 'lg'
}

const sizeClasses = {
  sm: 'max-w-lg',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter(element => !element.hasAttribute('hidden'))
}

export function StocktakingDialog({
  title,
  children,
  footer,
  onClose,
  returnFocus,
  size = 'md',
}: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const returnFocusRef = useRef(returnFocus)

  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => { returnFocusRef.current = returnFocus }, [returnFocus])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const first = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusableElements(dialog)[0] ?? dialog
    first.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        window.setTimeout(() => returnFocusRef.current?.focus(), 0)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const firstElement = focusable[0]
      const lastElement = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault()
        lastElement.focus()
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault()
        firstElement.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const close = () => {
    closeRef.current()
    window.setTimeout(() => returnFocusRef.current?.focus(), 0)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-gray-950/45" aria-label="关闭弹窗" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-xl bg-white shadow-lg ${sizeClasses[size]}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" aria-label="关闭" onClick={close} className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <div className="flex shrink-0 justify-end gap-3 border-t border-gray-200 px-6 py-4">{footer}</div> : null}
      </div>
    </div>
  )
}
