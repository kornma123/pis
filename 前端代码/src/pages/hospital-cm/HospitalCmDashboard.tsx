/**
 * 院级贡献毛利看板（P0 内圈·标准成本口径·两层框架真前端）——替换从未上线的旧「医院盈利看板」。
 *
 * 消费新口径影子后端 `/api/v1/hospital-pnl`（P0 贡献毛利），与旧 `partner-pnl`（ABC 全成本）无关。
 * 页面两个渲染态由**就绪谓词**（服务端判定·前端只接收结果）运行时切换：
 *   · 校准态（ready=false·当前现实）：第 1 层趋势-only 体检 hero + 校准就绪清单 + 第 2 层对照表；
 *   · 完整体检态（ready=true）：第 1 层完整体检（覆盖倍数绝对判断）+ 第 2 层对照表。
 * 🔒 URL 后门焊死（§六.6）：完整态组件**只在 readiness.ready===true 时挂载**（谓词假 ⇒ 不在 DOM），
 *    且其 `/full-health` 数据端点在未就绪时后端 403——无任何 URL 参数/前端 flag 能强制唤出完整态。
 * 🚫 不产自动点名/谈价清单（DEC-2）；不做「最差在顶」缺省（缺省=绝对贡献降序·顶梁柱在顶）。
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'
import { canAccess } from '@/lib/permissions'
import { EmptyState } from '@/components/ui/EmptyState'
import { hospitalCmApi } from '@/api/hospital-cm'
import type { CaliberRatification } from '@/types/hospital-cm'
import ComparisonTable from './ComparisonTable'
import CalibrationView from './CalibrationView'
import PortfolioHero from './PortfolioHero'
import FullPhysicalExam from './FullPhysicalExam'

export default function HospitalCmDashboard() {
  const [serviceMonth, setServiceMonth] = useState('')
  const monthParam = serviceMonth ? { serviceMonth } : undefined

  const readinessQuery = useQuery({
    queryKey: ['hospital-cm', 'readiness'],
    queryFn: () => hospitalCmApi.readiness(),
    retry: false,
  })
  const comparisonQuery = useQuery({
    queryKey: ['hospital-cm', 'comparison', serviceMonth],
    queryFn: () => hospitalCmApi.comparison(monthParam),
    retry: false,
  })
  const healthQuery = useQuery({
    queryKey: ['hospital-cm', 'health', serviceMonth],
    queryFn: () => hospitalCmApi.health(monthParam),
    retry: false,
  })

  if (!canAccess('cost_analysis', 'R')) {
    return <EmptyState icon={Wallet} title="无权限访问" description="院级贡献毛利看板需要成本分析(查看)权限" />
  }

  const readiness = readinessQuery.data
  const comparison = comparisonQuery.data
  const health = healthQuery.data
  const rows = comparison?.list ?? []
  // 元素④ 水印（LEG-2·fail-closed）：仅后端明确 ratified===true 才免水印；缺席/未认账一律显示。
  const caliber: CaliberRatification | null =
    comparison?.caliberRatification ?? readiness?.caliberRatification ?? health?.caliberRatification ?? null
  const showWatermark = caliber?.ratified !== true

  const loading = readinessQuery.isLoading || comparisonQuery.isLoading || healthQuery.isLoading
  const errored = readinessQuery.isError || comparisonQuery.isError
  const refetchAll = () => {
    readinessQuery.refetch(); comparisonQuery.refetch(); healthQuery.refetch()
  }

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-[#0a2540]">院级贡献毛利看板</h1>
          <p className="mt-1 text-sm text-slate-500">
            这个月挣的钱，扣掉「多做一片就多花、我们自己做才会花」的材料钱之后剩多少——人工/设备/房租这类固定开销不摊进去。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={serviceMonth}
            onChange={(e) => setServiceMonth(e.target.value)}
            className="h-10 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 tabular-nums"
          />
          <button
            onClick={refetchAll}
            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-gray-200 px-3 text-sm text-gray-600 transition-colors hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
        </div>
      </div>

      {/* 影子模式横幅 */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-900">
        <b>影子模式 · 现在只用来校数据、看趋势方向，暂不作任何砍院/谈价决策。</b>{' '}
        三道数据地基门（库存对得上账 / 月份不串 / 分钱常量冻结）和标准成本校准还没完成前，这里的绝对值先别信。
      </div>

      {/* 元素④ 拆分口径未认账水印（与数字同视线·fail-closed·不可折叠隐藏） */}
      {showWatermark && (
        <div
          data-testid="split-caliber-watermark"
          className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 shadow-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-[13px] leading-relaxed text-amber-900">
            <span className="font-semibold">口径未经业务认账。</span>
            本页的<span className="font-medium">实验室收入</span>与<span className="font-medium">院级贡献毛利</span>由一个尚未经业务方认账的拆分口径推算
            （对外<span className="font-medium">可能显著高估约 2 倍</span>）——仅供内部参考，
            <span className="font-medium">不得作为对外披露、结算或谈判的单独依据</span>，导出前请保留本口径声明。
            {caliber?.basisVersion && <span className="text-amber-700">（口径版本 {caliber.basisVersion}）</span>}
          </p>
        </div>
      )}

      {loading ? (
        <div className="grid animate-pulse grid-cols-1 gap-3">
          <div className="h-28 rounded-xl bg-gray-100" />
          <div className="h-40 rounded-xl bg-gray-100" />
        </div>
      ) : errored ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <EmptyState icon={AlertTriangle} title="加载失败" description="加载院级贡献毛利失败，请重试" />
          <button
            onClick={refetchAll}
            className="mt-4 inline-flex h-10 items-center gap-1.5 rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600"
          >
            <RefreshCw className="h-4 w-4" /> 重试
          </button>
        </div>
      ) : (
        <>
          {/* 第 1 层：完整体检态（就绪时·DOM 红线·仅 ready 才挂载）/ 校准态（现实·趋势-only + 就绪清单） */}
          {readiness?.ready ? (
            <FullPhysicalExam serviceMonth={serviceMonth} />
          ) : (
            <>
              {health && <PortfolioHero health={health} />}
              {readiness && <CalibrationView readiness={readiness} />}
            </>
          )}

          {/* 第 2 层：对照表（始终可用·影子/校准） */}
          <ComparisonTable rows={rows} caliber={caliber} periodRange={serviceMonth || '全部账期'} />
        </>
      )}
    </div>
  )
}
