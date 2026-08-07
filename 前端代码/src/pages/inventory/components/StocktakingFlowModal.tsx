import { ArrowDown, ClipboardCheck, FileCheck2, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { StocktakingDialog } from './StocktakingDialog'

interface Props { open: boolean; onClose: () => void; returnFocus?: HTMLElement | null }

const steps = [
  { icon: ClipboardCheck, title: '记录盘点结果', text: '选择系统中已有的库存位置，填写实盘数量。这一步不修改库存。' },
  { icon: FileCheck2, title: '复核差异', text: '确认物料、批次和库位是否正确。原因不确定时可以先标记“待核实”。' },
  { icon: SlidersHorizontal, title: '确认库存调整', text: '只有具备库存调整权限的人，才能把当前库存改为实盘数量。' },
  { icon: RotateCcw, title: '追加说明或撤销', text: '新的信息只会追加；撤销通过补偿记录完成，原操作始终可追溯。' },
]

export function StocktakingFlowModal(props: Props) {
  if (!props.open) return null
  return <StocktakingDialog title="盘点怎么处理" onClose={props.onClose} returnFocus={props.returnFocus} size="md" footer={<button type="button" onClick={props.onClose} className="h-10 rounded-md bg-blue-500 px-4 text-sm font-medium text-white hover:bg-blue-600">我知道了</button>}><div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900"><strong>盘点和调整库存是两个动作。</strong><br />先记录看到的数量，有差异时再由有权限的人确认是否调整。</div><ol className="mt-5 space-y-2">{steps.map((step, index) => <li key={step.title}>{index > 0 ? <ArrowDown className="mx-auto mb-2 h-4 w-4 text-gray-300" /> : null}<div className="flex gap-4 rounded-lg border border-gray-200 p-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600"><step.icon className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold text-gray-900">{index + 1}. {step.title}</h3><p className="mt-1 text-sm leading-6 text-gray-600">{step.text}</p></div></div></li>)}</ol></StocktakingDialog>
}
