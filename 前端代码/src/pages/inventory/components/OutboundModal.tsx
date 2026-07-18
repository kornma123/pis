import { useEffect, useRef } from 'react'
import { AlertCircle, Plus, Trash2, X } from 'lucide-react'
import type { Project } from '@/types'

interface OutboundMaterial {
  rowId: number
  materialId: string
  name: string
  spec: string
  batch?: string
  stock: number
  quantity: number
  unit: string
  project: string
  user: string
  usage: 'self' | 'external'
  receiver: string
}

interface Props {
  open: boolean
  materials: OutboundMaterial[]
  remark: string
  projectList: Project[]
  submitting: boolean
  submitError: string | null
  onClose: () => void
  onAddMaterial: () => void
  onRemoveItem: (rowId: number) => void
  onUpdateQuantity: (rowId: number, value: string) => void
  onUpdateProject: (rowId: number, value: string) => void
  onUpdateUsage: (rowId: number, value: 'self' | 'external') => void
  onUpdateReceiver: (rowId: number, value: string) => void
  onChangeRemark: (value: string) => void
  onConfirm: () => void
}

export function OutboundModal({
  open,
  materials,
  remark,
  projectList,
  submitting,
  submitError,
  onClose,
  onAddMaterial,
  onRemoveItem,
  onUpdateQuantity,
  onUpdateProject,
  onUpdateUsage,
  onUpdateReceiver,
  onChangeRemark,
  onConfirm,
}: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const projectId = materials[0]?.project ?? ''

  useEffect(() => {
    if (!open) return undefined
    titleRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, submitting])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="inventory-outbound-title"
        aria-describedby="inventory-outbound-contract"
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-lg"
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 sm:px-6">
          <div>
            <h2
              id="inventory-outbound-title"
              ref={titleRef}
              tabIndex={-1}
              className="text-lg font-semibold text-gray-900 outline-none"
            >
              出库登记
            </h2>
            <p id="inventory-outbound-contract" className="mt-1 text-xs text-gray-500">
              本单一次提交、整单成功或整单拒绝；未指定批次时由后端在全部可用批次中按 FEFO 拆分。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭出库登记"
            onClick={onClose}
            disabled={submitting}
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            页面只显示当前最早 FEFO 候选批次作为取货提示，不会把它钉成指定批次。实际批次分配以成功后的出库详情为准。
          </div>

          {submitError && (
            <div role="alert" className="mb-5 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="inventory-outbound-project" className="mb-1.5 block text-sm font-medium text-gray-700">
                关联项目（整单）
              </label>
              <select
                id="inventory-outbound-project"
                value={projectId}
                onChange={event => onUpdateProject(materials[0]?.rowId ?? 0, event.target.value)}
                disabled={submitting}
                className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100"
              >
                <option value="">公共成本</option>
                {projectList.map(project => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </div>
            <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <div className="font-medium text-gray-900">操作人</div>
              <div className="mt-1">由后端按当前登录账号记录，页面不接受代填。</div>
            </div>
          </div>

          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-gray-900">出库明细</h3>
            <button
              type="button"
              onClick={onAddMaterial}
              disabled={submitting}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-500 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              添加物料
            </button>
          </div>

          {materials.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 py-12 text-center text-sm text-gray-500">
              还没有出库物料，请先添加物料。
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-[860px] w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">物料</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">FEFO 候选</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-600">正库存缓存</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">出库数量</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">用途</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-600">接收方</th>
                    <th className="w-14 px-4 py-3 text-center text-xs font-medium text-gray-600">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {materials.map(material => (
                    <tr key={material.rowId} className="[content-visibility:auto] [contain-intrinsic-size:0_56px]">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{material.name}</div>
                        <div className="mt-0.5 text-xs text-gray-500">{material.spec || '规格未提供'}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">
                        {material.batch && material.batch !== '-' ? material.batch : '未取得批次证据'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-900">{material.stock} {material.unit}</td>
                      <td className="px-4 py-3">
                        <label className="sr-only" htmlFor={`inventory-outbound-quantity-${material.rowId}`}>
                          {material.name} 出库数量
                        </label>
                        <input
                          id={`inventory-outbound-quantity-${material.rowId}`}
                          type="number"
                          inputMode="decimal"
                          min={1}
                          max={material.stock}
                          value={material.quantity}
                          onChange={event => onUpdateQuantity(material.rowId, event.target.value)}
                          disabled={submitting}
                          className="h-9 w-24 rounded-md border border-gray-300 px-3 text-sm tabular-nums focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <label className="sr-only" htmlFor={`inventory-outbound-usage-${material.rowId}`}>
                          {material.name} 用途
                        </label>
                        <select
                          id={`inventory-outbound-usage-${material.rowId}`}
                          value={material.usage}
                          onChange={event => onUpdateUsage(material.rowId, event.target.value as 'self' | 'external')}
                          disabled={submitting}
                          className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100"
                        >
                          <option value="self">内部领用</option>
                          <option value="external">外部领用</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <label className="sr-only" htmlFor={`inventory-outbound-receiver-${material.rowId}`}>
                          {material.name} 接收方
                        </label>
                        <input
                          id={`inventory-outbound-receiver-${material.rowId}`}
                          value={material.receiver}
                          onChange={event => onUpdateReceiver(material.rowId, event.target.value)}
                          placeholder={material.usage === 'external' ? '填写接收方' : '无需填写'}
                          disabled={submitting || material.usage === 'self'}
                          className="h-9 w-32 rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100 disabled:text-gray-400"
                        />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          aria-label={`移除 ${material.name}`}
                          onClick={() => onRemoveItem(material.rowId)}
                          disabled={submitting}
                          className="rounded-md p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-5">
            <label htmlFor="inventory-outbound-remark" className="mb-1.5 block text-sm font-medium text-gray-700">备注</label>
            <textarea
              id="inventory-outbound-remark"
              value={remark}
              onChange={event => onChangeRemark(event.target.value)}
              rows={2}
              disabled={submitting}
              placeholder="选填"
              className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100"
            />
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-200 bg-gray-50 px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting || materials.length === 0}
            className="h-10 rounded-md bg-blue-500 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '正在提交整单…' : '确认整单出库'}
          </button>
        </footer>
      </section>
    </div>
  )
}
