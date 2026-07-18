/**
 * 第 1 层 · **完整体检态**（覆盖倍数绝对判断已启用）——同一页面由就绪谓词运行时切换出来的另一个渲染态。
 *
 * ⚠️ 本组件**只在就绪谓词为真时被挂载**（父组件 `{readiness.ready && <FullPhysicalExam/>}`）——
 *    谓词为假时它**根本不在 DOM 里**（非隐藏），且它消费的 `/full-health` 端点在未就绪时后端 403、
 *    不返回完整数据（URL 后门焊到数据层·§六.6）。两层都挡：DOM 不在 + 数据不出门。
 *    现实（三门未绿/池未认账/历史 0/首周期未校验）→ 永不到达；这是「建好的运行时切换态」、非「建好等需求」。
 */
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { hospitalCmApi } from '@/api/hospital-cm'

const yuan = (n: number) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

export default function FullPhysicalExam({ serviceMonth }: { serviceMonth?: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['hospital-cm', 'full-health', serviceMonth],
    queryFn: () => hospitalCmApi.fullHealth(serviceMonth ? { serviceMonth } : undefined),
    retry: false,
  })

  if (isLoading) return <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
  // 就绪但取数失败（含极端竞态下的 403）→ 不臆造完整判断，降级提示。
  if (isError || !data) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5 text-[13px] text-gray-500 shadow-sm">
        完整体检态数据暂不可用。
      </div>
    )
  }

  const coverageMultiple =
    typeof data.coverageMultiple === 'number' && Number.isFinite(data.coverageMultiple)
      ? data.coverageMultiple
      : null

  return (
    <div data-testid="full-physical-exam" className="rounded-xl border border-emerald-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-emerald-500" />
        <h2 className="text-[16px] font-semibold text-[#0a2540]">整盘体检 · 完整态（绝对判断已启用）</h2>
      </div>
      <p className="mb-3 text-[12.5px] text-gray-500">三门 + 认账 + 历史 + 首周期全绿——覆盖倍数绝对值可信，可回答「够不够」。</p>
      <div className="flex flex-wrap items-baseline gap-4">
        <div>
          <div className="text-[12px] text-gray-500">本月贡献毛利合计</div>
          <div className="text-[28px] font-semibold text-[#0a2540] tabular-nums">{yuan(data.totalCm)}</div>
        </div>
        <div>
          <div className="text-[12px] text-gray-500">够盖几倍固定开销（绝对值）</div>
          {coverageMultiple == null ? (
            <div data-testid="full-coverage-unknown" className="text-[18px] font-medium text-gray-400">不可计算</div>
          ) : (
            <div className="text-[28px] font-semibold text-emerald-600 tabular-nums">{coverageMultiple.toFixed(2)}×</div>
          )}
        </div>
      </div>
    </div>
  )
}
