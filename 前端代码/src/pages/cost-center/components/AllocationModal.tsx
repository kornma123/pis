import React from 'react'
import { X } from 'lucide-react'
import type { IndirectCostCenter, IndirectCostAllocation } from '@/types'
import type { AllocationForm } from '../hooks/useCostCenterPage'

interface Props {
  open: boolean
  row: IndirectCostCenter | null
  allocationForm: AllocationForm
  allocations: IndirectCostAllocation[]
  allocationStatus?: 'idle' | 'loading' | 'success' | 'error' | 'stale'
  onRetryAllocations?: () => void
  onClose: () => void
  onChangeForm: (form: AllocationForm) => void
  onSubmit: () => void
}

const isKnownNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function AllocationModal({
  open,
  row,
  allocationForm,
  allocations,
  allocationStatus = 'idle',
  onRetryAllocations,
  onClose,
  onChangeForm,
  onSubmit,
}: Props) {
  if (!open || !row) return null
  // HON-4：分摊口径下拉已摘除；此处不再按已废弃的 allocationBase 字段给基础值贴「样本数/收入…」标签。
  const hasValidYearMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(allocationForm.yearMonth)
  const hasValidTotalAmount = Number.isFinite(allocationForm.totalAmount) && allocationForm.totalAmount >= 0
  const hasValidBaseValue = Number.isFinite(allocationForm.allocationBaseValue) && allocationForm.allocationBaseValue > 0
  const allocationRate = hasValidTotalAmount && hasValidBaseValue
    ? allocationForm.totalAmount / allocationForm.allocationBaseValue
    : null
  const validationMessage = row.status !== 'active'
    ? '停用成本中心不可录入分摊，请先启用后再录入月度成本。'
    : !hasValidYearMonth
      ? '请填写 YYYY-MM 格式的分摊年月，系统才能归入正确成本期间。'
      : !hasValidTotalAmount
        ? '请填写大于等于 0 的费用总额，系统才能计算月度间接成本。'
        : !hasValidBaseValue
          ? '请填写大于 0 的分摊基础值，系统才能把间接成本分摊到项目成本。'
          : ''
  const canSubmit = validationMessage === ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="allocation-dialog-title" className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h3 id="allocation-dialog-title" className="text-lg font-semibold text-gray-900">
            月度分摊录入 — {row.name}
          </h3>
          <button
            type="button"
            aria-label="关闭月度分摊录入"
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="allocation-year-month" className="block text-sm font-medium text-gray-700 mb-1.5">
                年月 <span className="text-red-500">*</span>
              </label>
              <input
                id="allocation-year-month"
                type="month"
                value={allocationForm.yearMonth}
                onChange={(e) => onChangeForm({ ...allocationForm, yearMonth: e.target.value })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label htmlFor="allocation-total-amount" className="block text-sm font-medium text-gray-700 mb-1.5">
                费用总额（元） <span className="text-red-500">*</span>
              </label>
              <input
                id="allocation-total-amount"
                type="number"
                min={0}
                step="0.01"
                value={allocationForm.totalAmount}
                onChange={(e) => onChangeForm({ ...allocationForm, totalAmount: Number(e.target.value) })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div>
            <label htmlFor="allocation-base-value" className="block text-sm font-medium text-gray-700 mb-1.5">
              分摊基础值 <span className="text-red-500">*</span>
            </label>
            <input
              id="allocation-base-value"
              type="number"
              min={1}
              value={allocationForm.allocationBaseValue}
              onChange={(e) => onChangeForm({ ...allocationForm, allocationBaseValue: Number(e.target.value) })}
              className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
            />
            <p className="text-xs text-gray-400 mt-1">
              单位分摊率 = 费用总额 / 分摊基础值
            </p>
          </div>

          {/* 历史分摊记录：真实空、失败与保留的本地成功记录明确分开。 */}
          {allocationStatus === 'loading' && <p role="status" className="text-sm text-gray-500">正在加载历史分摊记录…</p>}
          {allocationStatus === 'error' && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span>历史分摊记录不可用，没有把加载失败解释成空历史。</span>
              {onRetryAllocations && <button type="button" onClick={onRetryAllocations} className="font-medium underline">重试历史记录</button>}
            </div>
          )}
          {allocationStatus === 'stale' && (
            <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              分摊已录入；历史刷新失败或尚未返回新记录，当前保留本次成功记录。
            </p>
          )}
          {allocationStatus === 'success' && allocations.length === 0 && (
            <p className="text-sm text-gray-500">当前没有历史分摊记录。</p>
          )}
          {(allocationStatus === 'success' || allocationStatus === 'stale') && allocations.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                历史分摊记录
              </label>
              <div className="border border-gray-200 rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">年月</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">费用总额</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">基础值</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单位分摊率</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {allocations.map((a) => (
                      <tr key={a.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_40px]">
                        <td className="px-3 py-2 text-gray-700">{a.yearMonth}</td>
                        <td className="px-3 py-2 text-gray-700">{isKnownNumber(a.totalAmount) ? `¥${a.totalAmount.toFixed(2)}` : '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{isKnownNumber(a.allocationBaseValue) ? a.allocationBaseValue : '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{isKnownNumber(a.allocationRate) ? `¥${a.allocationRate.toFixed(4)}` : '不可计算'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="rounded-md border border-emerald-100 bg-emerald-50 px-4 py-3">
            <div className="text-sm font-semibold text-emerald-900">分摊结果确认</div>
            <div className="mt-1 text-xs text-emerald-800">确认后将接住：间接成本、月度分摊、项目成本、成本结账、审计记录</div>
            <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-emerald-900 sm:grid-cols-2">
              <div>年月 {allocationForm.yearMonth || '待填写'}</div>
              <div>费用总额 {hasValidTotalAmount ? `¥${allocationForm.totalAmount.toFixed(2)}` : '不可用'}</div>
              <div>分摊基础值 {hasValidBaseValue ? allocationForm.allocationBaseValue : '不可用'}</div>
              <div>单位分摊率 {allocationRate === null ? '不可计算' : `¥${allocationRate.toFixed(4)}`}</div>
            </div>
          </div>
          {validationMessage ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {validationMessage}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
          >
            关闭
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className={`px-4 h-10 text-white text-sm rounded-md transition-colors ${
              canSubmit ? 'bg-blue-500 hover:bg-blue-600' : 'cursor-not-allowed bg-gray-300'
            }`}
          >
            录入分摊
          </button>
        </div>
      </div>
    </div>
  )
}
