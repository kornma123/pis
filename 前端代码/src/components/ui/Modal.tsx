import React, { useEffect, useId, useRef } from 'react'
import { cn } from '@/lib/utils'

interface ModalProps {
  children: React.ReactNode
  description?: string
  onClose: () => void
  title: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const openDialogs: HTMLElement[] = []
let bodyScrollLockCount = 0
let bodyOverflowBeforeLock = ''

function isVisible(element: HTMLElement) {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false

  let current: HTMLElement | null = element
  while (current) {
    const style = window.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    current = current.parentElement
  }
  return true
}

function getFocusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => (
    element.tabIndex >= 0 &&
    !element.matches(':disabled') &&
    element.getAttribute('aria-disabled') !== 'true' &&
    isVisible(element)
  ))
}

function lockBodyScroll() {
  if (bodyScrollLockCount === 0) bodyOverflowBeforeLock = document.body.style.overflow
  bodyScrollLockCount += 1
  document.body.style.overflow = 'hidden'
}

function unlockBodyScroll() {
  bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1)
  if (bodyScrollLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock
}

const sizeClass: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

export function Modal({ children, description, onClose, title, size = 'md' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  )
  const onCloseRef = useRef(onClose)
  const id = useId().replace(/:/g, '')
  const titleId = `modal-title-${id}`
  const descriptionId = `modal-description-${id}`

  onCloseRef.current = onClose

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    openDialogs.push(dialog)
    lockBodyScroll()

    if (!dialog.contains(document.activeElement)) {
      const [firstFocusable] = getFocusableElements(dialog)
      ;(firstFocusable ?? dialog).focus()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== dialog) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') return

      const focusableElements = getFocusableElements(dialog)
      if (focusableElements.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]
      const active = document.activeElement
      const activeIndex = active instanceof HTMLElement
        ? focusableElements.indexOf(active)
        : -1

      if (event.shiftKey && (active === first || activeIndex === -1)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || activeIndex === -1)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      const dialogIndex = openDialogs.lastIndexOf(dialog)
      if (dialogIndex >= 0) openDialogs.splice(dialogIndex, 1)
      unlockBodyScroll()

      const returnTarget = returnFocusRef.current
      const remainingDialog = openDialogs[openDialogs.length - 1]
      if (remainingDialog) {
        if (returnTarget?.isConnected && remainingDialog.contains(returnTarget)) {
          returnTarget.focus()
        } else if (!remainingDialog.contains(document.activeElement)) {
          const [firstFocusable] = getFocusableElements(remainingDialog)
          ;(firstFocusable ?? remainingDialog).focus()
        }
      } else if (returnTarget?.isConnected) {
        returnTarget.focus()
      }
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'a11y-focus-ring relative bg-white rounded-xl shadow-lg w-[calc(100%-2rem)] min-w-0 flex flex-col max-h-[90vh]',
          sizeClass[size]
        )}
      >
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-gray-900 break-words">{title}</h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-gray-600 break-words">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`关闭${title}`}
            className="a11y-focus-ring flex-shrink-0 p-1 hover:bg-gray-50 rounded-md transition-colors"
          >
            <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="min-w-0 p-6 overflow-x-auto overflow-y-auto break-words">{children}</div>
      </div>
    </div>
  )
}
