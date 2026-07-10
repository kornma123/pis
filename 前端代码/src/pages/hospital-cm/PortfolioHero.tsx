/**
 * 第 1 层 · 整盘体检 hero（校准态·影子）——只看整盘、不点名任何一家医院；结论只回答「在变好还是变坏」。
 * 承载：∑贡献毛利（真值）+ 覆盖倍数（元素⑤「只看趋势」一等公民标注 / 元素⑥「未配置」不渲染 0）+ 产能「未测量」+ 复活哨兵。
 */
import { TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortfolioHealth } from '@/types/hospital-cm'

const yuan = (n: number) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

function Metric({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg bg-gray-50 px-4 py-3">{children}</div>
}

export default function PortfolioHero({ health }: { health: PortfolioHealth }) {
  const poolConfigured = health.fixedPoolProvided === true && health.fixedPool > 0

  return (
    <div data-testid="portfolio-hero" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-0.5 flex items-baseline gap-2">
        <h2 className="text-[16px] font-semibold text-[#0a2540]">整盘生意体检</h2>
        <span className="text-[12px] text-gray-500">只看整盘、不点名任何一家医院</span>
      </div>

      {/* hero = ∑贡献毛利（真值） */}
      <div className="mt-3 flex flex-wrap items-baseline gap-3">
        <span className="text-[32px] font-semibold leading-none text-[#0a2540] tabular-nums">{yuan(health.totalCm)}</span>
        <span className="inline-flex items-center gap-1 text-[13px] text-gray-500">
          本月贡献毛利合计 <TrendingUp className="h-3.5 w-3.5 text-blue-500" />
        </span>
      </div>
      <div className="mt-1.5 text-[12px] text-gray-500">
        真算出来的数（各院实收 − 白名单可避免材料）。趋势方向才是本期结论。
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* 覆盖倍数：元素⑤「只看趋势」一等公民 + 元素⑥「未配置」不渲染 0 */}
        <Metric>
          <div className="flex items-center gap-1.5 text-[12px] text-gray-500">
            够盖几倍固定开销
            <span
              data-testid="coverage-trend-only-badge"
              className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10.5px] font-medium text-blue-600"
            >
              只看趋势·校准前
            </span>
          </div>
          {poolConfigured ? (
            <>
              <div className="mt-1.5 text-[20px] font-semibold text-[#0a2540] tabular-nums">{health.coverageMultiple.toFixed(2)}×</div>
              <div className="mt-1 text-[11px] leading-relaxed text-gray-500">
                = 贡献毛利合计 ÷ 固定开销池。绝对值待校准，当前只看方向。
              </div>
            </>
          ) : (
            <>
              <div data-testid="coverage-not-configured" className="mt-1.5 text-[16px] font-medium text-gray-400">未配置</div>
              <div className="mt-1 text-[11px] leading-relaxed text-gray-500">
                固定成本池未配置且未认账（业务方签）→ 不渲染 0，先去配置并认账固定开销池。
              </div>
            </>
          )}
        </Metric>

        {/* 产能：未测量 */}
        <Metric>
          <div className="text-[12px] text-gray-500">产能忙不忙</div>
          {health.capacityUtilization == null ? (
            <>
              <div className="mt-1.5 text-[17px] font-medium text-gray-400">未测量</div>
              <div className="mt-1 text-[11px] leading-relaxed text-gray-500">
                瓶颈是哪类产能、忙到几成还没实测。测了才打开「每单位产能贡献」这层（第 3 层·暂不建）。
              </div>
            </>
          ) : (
            <div className="mt-1.5 text-[20px] font-semibold text-[#0a2540] tabular-nums">{(health.capacityUtilization * 100).toFixed(0)}%</div>
          )}
        </Metric>

        {/* 复活哨兵：可测账户数 / 上限 + UNMEASURED 占比 */}
        <Metric>
          <div className="text-[12px] text-gray-500">复活哨兵（要不要自动排队）</div>
          <div className="mt-1.5 text-[16px] font-medium text-[#0a2540]">
            可测 {health.measurableAccountCount}
            <span className="text-[12px] font-normal text-gray-400"> / 上限 ~{health.revivalCap} 家</span>
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-gray-500">
            看不清的钱占{' '}
            <b className={cn(health.unmeasuredRevenueShare > health.revivalUnmeasuredShareLine ? 'text-amber-700' : 'text-gray-600')}>
              {(health.unmeasuredRevenueShare * 100).toFixed(0)}%
            </b>
            。两个数任一越线才重新考虑要不要自动排队。
          </div>
        </Metric>
      </div>
    </div>
  )
}
