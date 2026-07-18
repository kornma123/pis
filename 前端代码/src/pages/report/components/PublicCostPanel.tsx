import { Unplug } from 'lucide-react'

export function PublicCostPanel() {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm" aria-labelledby="public-cost-title">
      <Unplug className="mx-auto h-9 w-9 text-gray-400" aria-hidden="true" />
      <h3 id="public-cost-title" className="mt-3 text-base font-semibold text-gray-900">公共成本未连接</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-500">
        当前报表接口尚未提供公共成本事实，因此这里不显示零值、占比、物料明细或可执行操作。
      </p>
    </section>
  )
}
