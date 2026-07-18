import type { DashboardLoadStatus } from '../hooks/useDashboardPage'

interface Props {
  title: string
  value: string | number | null
  icon: React.ElementType
  colorClass: string
  bgClass: string
  subtitle?: string
  unavailableMessage?: string
  status: DashboardLoadStatus
  onClick?: () => void
  onRetry?: () => void
}

export function StatCard({
  title, value, icon: Icon, colorClass, bgClass, subtitle, unavailableMessage,
  status, onClick, onRetry,
}: Props) {
  const retrying = status === 'retrying'
  const unavailable = status === 'error' || retrying || (status === 'success' && value === null)
  const displayValue = status === 'loading' ? '加载中' : unavailable ? '不可用' : value
  const displaySubtitle = retrying
    ? '正在重试'
    : status === 'error'
      ? '数据没能加载'
    : value === null
      ? unavailableMessage || '暂无可靠数据'
      : subtitle

  const content = (
    <>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-sm text-gray-500 mb-1">{title}</p>
          <p className={`text-[28px] font-bold leading-tight tracking-tight ${unavailable ? 'text-amber-700' : 'text-gray-900'}`}>
            {displayValue}
          </p>
          {displaySubtitle ? <p className="text-xs text-gray-500 mt-1">{displaySubtitle}</p> : null}
        </div>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${bgClass}`}>
          <Icon aria-hidden="true" className={`w-5 h-5 ${colorClass}`} />
        </div>
      </div>
    </>
  )
  const primaryAction = unavailable ? onRetry : onClick

  return (
    <section
      aria-label={title}
      aria-busy={retrying || undefined}
      className={`bg-white rounded-lg p-5 border shadow-sm transition-all ${
        unavailable ? 'border-amber-300' : 'border-gray-200'
      } ${onClick && !unavailable ? 'hover:shadow-md hover:-translate-y-0.5 motion-reduce:transform-none' : ''}`}
    >
      {primaryAction ? (
        <button
          type="button"
          onClick={retrying ? undefined : primaryAction}
          aria-disabled={retrying || undefined}
          aria-label={unavailable ? `${retrying ? '正在重试' : '重试'}${title}` : undefined}
          className="w-full text-left rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 forced-colors:outline-[Highlight]"
        >
          {content}
          {unavailable && onRetry ? (
            <span className="mt-3 inline-flex min-h-10 items-center px-3 rounded-md border border-gray-200 text-sm font-medium text-blue-600">
              {retrying ? '重试中' : '重试'}
            </span>
          ) : null}
        </button>
      ) : content}
    </section>
  )
}
