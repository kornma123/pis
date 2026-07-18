import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { ProjectCostReport } from '@/types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  open: boolean
  project: ProjectCostReport['projects'][number] | null
  onClose: () => void
}

type ProjectWithSource = ProjectCostReport['projects'][number] & {
  sampleCountSource?: 'lis' | 'manual' | 'unavailable'
}

const SOURCE_LABELS: Record<NonNullable<ProjectWithSource['sampleCountSource']>, string> = {
  lis: 'LIS 已映射病例',
  manual: '手工样本数',
  unavailable: '样本数来源不可用',
}

export function CostDetailModal({ open, project, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, onClose])

  if (!open || !project) return null
  const source = (project as ProjectWithSource).sampleCountSource || 'unavailable'
  const sampleAvailable = source !== 'unavailable'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <section role="dialog" aria-modal="true" aria-labelledby="project-cost-summary-title" className="relative mx-4 w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h3 id="project-cost-summary-title" className="text-lg font-semibold text-gray-900">项目成本摘要 · {project.name}</h3>
          <button type="button" aria-label="关闭项目成本摘要" onClick={onClose} className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"><X className="h-5 w-5" aria-hidden="true" /></button>
        </div>
        <dl className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
          <div className="rounded-lg bg-gray-50 p-4">
            <dt className="text-xs text-gray-500">总成本</dt>
            <dd className="mt-1 text-xl font-semibold text-gray-900">{formatCurrency(project.totalCost)}</dd>
          </div>
          <div className="rounded-lg bg-gray-50 p-4">
            <dt className="text-xs text-gray-500">样本数实际口径</dt>
            <dd className="mt-1 text-sm font-semibold text-gray-900">{SOURCE_LABELS[source]}</dd>
          </div>
          <div className="rounded-lg bg-gray-50 p-4">
            <dt className="text-xs text-gray-500">样本数</dt>
            <dd className="mt-1 text-xl font-semibold text-gray-900">{sampleAvailable ? project.sampleCount.toLocaleString() : '不可计算'}</dd>
          </div>
          <div className="rounded-lg bg-gray-50 p-4">
            <dt className="text-xs text-gray-500">单样本成本</dt>
            <dd className="mt-1 text-xl font-semibold text-gray-900">{sampleAvailable ? formatCurrency(project.unitCost) : '不可计算'}</dd>
          </div>
        </dl>
        <div className="flex justify-end border-t border-gray-200 bg-gray-50 px-6 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">关闭</button>
        </div>
      </section>
    </div>
  )
}
