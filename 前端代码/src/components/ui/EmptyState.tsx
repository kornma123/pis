import React, { useEffect, useId, useState } from 'react'
import { Package } from 'lucide-react'

interface EmptyStateProps {
  icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
  title?: string
  description?: string
  headingLevel?: 2 | 3 | 4 | 5 | 6
  liveRegion?: 'polite' | 'assertive'
  action?: {
    label: string
    onClick: () => void
  }
}

export function EmptyState({
  icon: Icon = Package,
  title = '暂无数据',
  description,
  headingLevel = 2,
  liveRegion,
  action,
}: EmptyStateProps) {
  const [announcement, setAnnouncement] = useState('')
  const id = useId().replace(/:/g, '')
  const titleId = `empty-state-title-${id}`
  const descriptionId = `empty-state-description-${id}`
  const Heading = `h${headingLevel}` as keyof React.JSX.IntrinsicElements

  useEffect(() => {
    if (!liveRegion) {
      setAnnouncement('')
      return
    }
    setAnnouncement([title, description].filter(Boolean).join('。'))
  }, [description, liveRegion, title])

  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className="w-full max-w-full min-w-0 py-12 text-center [overflow-wrap:anywhere]"
    >
      {liveRegion && (
        <span
          role={liveRegion === 'assertive' ? 'alert' : 'status'}
          aria-live={liveRegion}
          aria-atomic="true"
          className="sr-only"
        >
          {announcement}
        </span>
      )}
      <Icon
        aria-hidden="true"
        focusable="false"
        className="w-12 h-12 text-gray-300 mx-auto mb-3"
      />
      <Heading id={titleId} className="max-w-full text-sm text-gray-500 break-words">{title}</Heading>
      {description && (
        <p id={descriptionId} className="max-w-full text-xs text-gray-500 mt-1 break-words">{description}</p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="a11y-focus-ring max-w-full mt-4 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 whitespace-normal break-words transition-colors"
        >
          {action.label}
        </button>
      )}
    </section>
  )
}
