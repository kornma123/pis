import { useEffect } from 'react'
import type { LisCase, ProjectReconcile } from '../hooks/useReconciliationPage'

interface Props {
  open: boolean
  editCaseTarget: LisCase | null
  editCaseProjectId: string
  setEditCaseProjectId: (v: string) => void
  editCaseStatus: string
  setEditCaseStatus: (v: string) => void
  projects: ProjectReconcile[]
  onClose: () => void
  onConfirm: () => void
}

export function EditCaseModal({
  open,
  editCaseTarget,
  editCaseProjectId,
  setEditCaseProjectId,
  editCaseStatus,
  setEditCaseStatus,
  projects,
  onClose,
  onConfirm,
}: Props) {
  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, onClose])

  if (!open || !editCaseTarget) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby="edit-case-title" className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 id="edit-case-title" className="text-lg font-semibold text-gray-900">修改病例信息 - {editCaseTarget.case_no}</h3>
          <button type="button" aria-label="关闭病例修改对话框" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">检测项目</label>
            <select
              value={editCaseProjectId}
              onChange={e => setEditCaseProjectId(e.target.value)}
              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:border-blue-500"
            >
              <option value="">请选择</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
            <select
              value={editCaseStatus}
              onChange={e => setEditCaseStatus(e.target.value)}
              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:border-blue-500"
            >
              <option value="normal">正常</option>
              <option value="modified">已修改</option>
              <option value="unmatched">未关联BOM</option>
            </select>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800">
            <strong>说明：</strong>修改仅影响本病例的成本归集，不会修改BOM标准。如需修改标准用量，请使用"修正BOM"功能。
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">取消</button>
          <button type="button" onClick={onConfirm} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">保存修改</button>
        </div>
      </div>
    </div>
  )
}
