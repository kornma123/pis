import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/Modal'
import { laborTimeApi } from '@/api/master'
import type { StandardLaborTime } from '@/types'

interface Props {
  open: boolean
  row: StandardLaborTime | null
  onClose: () => void
  onEdit: (row: StandardLaborTime) => void
  canEdit?: boolean
}

const projectTypeLabels: Record<string, string> = {
  all: '通用',
  ihc: '免疫组化',
  he: 'HE染色',
  ss: '特殊染色',
  mp: '分子病理',
  cyto: '细胞病理',
}

const sourceLabels: Record<string, string> = {
  system: '系统预设',
  supplier: '供应商提供',
  industry: '行业标准',
}

function formatDateTime(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatMoney(value?: number) {
  return `¥${Number(value || 0).toFixed(2)}`
}

export function LaborTimeDetailModal({ open, row, onClose, onEdit, canEdit = true }: Props) {
  const [detail, setDetail] = useState<StandardLaborTime | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !row) {
      setDetail(null)
      return
    }

    let cancelled = false
    setDetail(row)
    setLoading(true)
    laborTimeApi.getDetail(row.id)
      .then((res) => {
        if (!cancelled) setDetail(res as StandardLaborTime)
      })
      .catch(() => {
        if (!cancelled) toast.error('加载工时详情失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, row])

  if (!open || !row) return null

  const current = detail || row
  const projectType = current.projectType || 'all'
  const source = current.referenceSource || 'system'

  return (
    <Modal title={`工时详情 - ${current.stepName}`} onClose={onClose} size="lg">
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs text-gray-500">步骤编号</div>
            <div className="mt-1 font-mono text-base font-semibold text-gray-900">{current.stepCode}</div>
          </div>
          <div className="flex items-center gap-2">
            {loading && <span className="text-xs text-gray-400">同步详情...</span>}
            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
              current.isEquipmentStep
                ? 'border-purple-200 bg-purple-50 text-purple-600'
                : 'border-blue-200 bg-blue-50 text-blue-600'
            }`}>
              {current.isEquipmentStep ? '设备步骤' : '人工步骤'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Info label="项目类型" value={projectTypeLabels[projectType] || projectType.toUpperCase()} />
          <Info label="标准时长" value={`${Number(current.standardMinutes || 0)} 分钟`} />
          <Info label="费率/分钟" value={formatMoney(current.laborRatePerMinute)} />
          <Info label="参考来源" value={current.referenceSourceLabel || sourceLabels[source] || source} />
          <Info label="排序" value={String(current.sortOrder ?? 0)} />
          <Info label="人工成本/次" value={formatMoney(Number(current.standardMinutes || 0) * Number(current.laborRatePerMinute || 0))} />
          <Info label="创建时间" value={formatDateTime(current.createdAt)} />
          <Info label="更新时间" value={formatDateTime(current.updatedAt)} />
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-gray-700">说明</div>
          <div className="min-h-20 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-6 text-gray-700">
            {current.description || '暂无说明'}
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-200 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm text-gray-700 transition-colors hover:bg-gray-50"
          >
            关闭
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={() => onEdit(current)}
              className="h-10 rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600"
            >
              编辑工时
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-gray-500">{label}</div>
      <div className="text-sm font-semibold text-gray-900">{value}</div>
    </div>
  )
}
