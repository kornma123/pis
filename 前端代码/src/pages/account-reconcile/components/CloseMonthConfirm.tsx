import { Modal } from '@/components/ui/Modal'
import type { CloseMonthRequest } from '../hooks/useAccountReconcile'
import { btnCls, btnPri, cnMonth, wan } from '../ui'

export interface CloseMonthSnapshot {
  request: CloseMonthRequest
  hospitalNames: string[]
  confirmedRevenue: number
}

interface Props {
  snapshot: CloseMonthSnapshot | null
  disabled: boolean
  onConfirm: (request: CloseMonthRequest) => void
  onClose: () => void
}

/** 关账前把已加载月份与医院范围显式展示并冻结，防止 mutable month/list 串月。 */
export function CloseMonthConfirm({ snapshot, disabled, onConfirm, onClose }: Props) {
  if (!snapshot) return null
  const count = snapshot.request.partnerIds.length
  return (
    <Modal title="确认本月关账范围" size="sm" onClose={onClose}>
      <p className="text-[13px] leading-relaxed text-gray-600">
        本次只会定版以下已复核完成的医院。未列出的医院继续挂起，不会随本次关账写入。
      </p>
      <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-[13px] text-gray-700">
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">关账月份</span>
          <strong className="font-semibold text-gray-900">{cnMonth(snapshot.request.serviceMonth)}</strong>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-gray-500">确认实收合计</span>
          <strong className="font-semibold tabular-nums text-gray-900">{wan(snapshot.confirmedRevenue)}</strong>
        </div>
      </div>
      <ul className="mt-3 max-h-36 space-y-1 overflow-y-auto text-[13px] text-gray-700">
        {snapshot.hospitalNames.map((name) => <li key={name} className="rounded-md bg-blue-50 px-2.5 py-1.5">{name}</li>)}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btnCls} onClick={onClose}>取消</button>
        <button type="button" className={btnPri} disabled={disabled} onClick={() => onConfirm(snapshot.request)}>
          确认关账 {count} 家
        </button>
      </div>
    </Modal>
  )
}
