import { useEffect, useRef } from 'react'
import { AlertCircle, Plus, Trash2, X } from 'lucide-react'
import type { Material, Project } from '@/types'

export interface OutboundItemForm {
  materialId: string
  quantity: number
}

export interface FormData {
  type: 'project' | 'transfer' | 'scrap'
  projectId: string
  items: OutboundItemForm[]
  remark: string
}

interface OutboundFormModalProps {
  open: boolean
  editRecordId: string | null
  form: FormData
  materials: Material[]
  projects: Project[]
  refsLoading?: boolean
  refsError?: string | null
  submitting?: boolean
  submitError?: string | null
  onClose: () => void
  onSubmit: () => void
  onRetryRefs?: () => void
  onFormChange: (form: FormData) => void
}

export default function OutboundFormModal({
  open,
  editRecordId,
  form,
  materials,
  projects,
  refsLoading = false,
  refsError = null,
  submitting = false,
  submitError = null,
  onClose,
  onSubmit,
  onRetryRefs,
  onFormChange,
}: OutboundFormModalProps) {
  const titleRef = useRef<HTMLHeadingElement>(null)

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

  const addItem = () => onFormChange({
    ...form,
    items: [...form.items, { materialId: '', quantity: 1 }],
  })
  const removeItem = (index: number) => onFormChange({
    ...form,
    items: form.items.filter((_, itemIndex) => itemIndex !== index),
  })
  const updateItem = (index: number, field: keyof OutboundItemForm, value: string | number) => onFormChange({
    ...form,
    items: form.items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="outbound-form-title"
        aria-describedby="outbound-form-contract"
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 sm:px-6">
          <div>
            <h2 id="outbound-form-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-gray-900 outline-none">
              {editRecordId ? '编辑出库单' : '出库登记'}
            </h2>
            <p id="outbound-form-contract" className="mt-1 text-xs text-gray-500">
              全单一次提交；未指定批次时由后端跨全部可用批次按 FEFO 分配。
            </p>
          </div>
          <button type="button" aria-label="关闭出库登记" onClick={onClose} disabled={submitting} className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            当前登记入口创建项目/常规出库。页面不钉批次；成功后的详情会列出实际 FEFO 批次分配。若库存不足，整单拒绝且不会部分出库。
          </div>

          {(refsError || submitError) && (
            <div role="alert" className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <p>{submitError || '物料或项目选项没能加载，请重试。'}</p>
                {refsError && onRetryRefs && <button type="button" onClick={onRetryRefs} className="mt-2 font-medium underline">重新加载选项</button>}
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-sm font-medium text-gray-700">出库类型</span>
              <div className="flex h-10 items-center rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700">
                {form.type === 'transfer' ? '调拨出库' : form.type === 'scrap' ? '报废出库' : '项目/常规出库'}
              </div>
            </div>
            <div>
              <label htmlFor="outbound-project" className="mb-1.5 block text-sm font-medium text-gray-700">关联项目</label>
              <select
                id="outbound-project"
                value={form.projectId}
                onChange={event => onFormChange({ ...form, projectId: event.target.value })}
                disabled={submitting || refsLoading}
                className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100"
              >
                <option value="">公共成本</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-gray-700">出库物料 *</h3>
              <button type="button" onClick={addItem} disabled={submitting || refsLoading} className="inline-flex h-9 items-center gap-1 rounded-md bg-blue-500 px-3 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50">
                <Plus className="h-4 w-4" />添加物料
              </button>
            </div>
            <div className="space-y-2">
              {form.items.map((item, index) => {
                const selectedElsewhere = new Set(form.items.filter((_, itemIndex) => itemIndex !== index).map(candidate => candidate.materialId))
                return (
                  <div key={index} className="grid gap-2 rounded-lg bg-gray-50 p-3 sm:grid-cols-[1fr_8rem_2.5rem] sm:items-end">
                    <div>
                      <label htmlFor={`outbound-material-${index}`} className="mb-1 block text-xs text-gray-600">物料 {index + 1}</label>
                      <select id={`outbound-material-${index}`} value={item.materialId} onChange={event => updateItem(index, 'materialId', event.target.value)} disabled={submitting || refsLoading} className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100">
                        <option value="">请选择物料</option>
                        {materials.map(material => <option key={material.id} value={material.id} disabled={selectedElsewhere.has(material.id)}>{material.name} ({material.code})</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`outbound-quantity-${index}`} className="mb-1 block text-xs text-gray-600">数量</label>
                      <input id={`outbound-quantity-${index}`} type="number" inputMode="decimal" min={1} value={item.quantity || ''} onChange={event => updateItem(index, 'quantity', Number(event.target.value))} disabled={submitting} className="h-10 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100" />
                    </div>
                    <button type="button" aria-label={`移除物料 ${index + 1}`} onClick={() => removeItem(index)} disabled={submitting || form.items.length === 1} className="flex h-10 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <label htmlFor="outbound-remark" className="mb-1.5 block text-sm font-medium text-gray-700">备注</label>
            <textarea id="outbound-remark" value={form.remark} onChange={event => onFormChange({ ...form, remark: event.target.value })} rows={2} disabled={submitting} placeholder="选填" className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100" />
          </div>
        </div>

        <footer className="flex shrink-0 justify-end gap-3 border-t border-gray-200 bg-gray-50 px-5 py-4 sm:px-6">
          <button type="button" onClick={onClose} disabled={submitting} className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">取消</button>
          <button type="button" onClick={onSubmit} disabled={submitting || refsLoading || Boolean(refsError)} className="h-10 rounded-md bg-blue-500 px-4 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? '正在提交整单…' : editRecordId ? '确认更新' : '确认整单出库'}
          </button>
        </footer>
      </section>
    </div>
  )
}
