/**
 * 校准视图（元素⑦·DEC-6 + 公理一）——渲染就绪谓词清单：还差哪几件、谁负责、死线何时。
 * 每个未满足条件 = 带 owner 的**任务**（非被动等待）；未满足且缺死线 = 红（configError·违反公理一）；
 * 死线过期 = 红（overdue·上 GOV-3 豁免面板）；预计就绪日后移 = 事件（滑动告警 finding）。
 */
import { CheckCircle2, Circle, AlertTriangle, CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Readiness, ReadinessCondition, ReadinessOwnerRole } from '@/types/hospital-cm'

const OWNER_LABEL: Record<ReadinessOwnerRole, string> = {
  tech: '技术负责人',
  business: '业务决策方（不可代签）',
  pm: 'PM（月度推进）',
}

function ConditionRow({ c }: { c: ReadinessCondition }) {
  const red = !c.met && (c.configError || c.overdue)
  return (
    <div
      data-testid={`readiness-condition-${c.key}`}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3',
        c.met ? 'border-gray-200 bg-white' : red ? 'border-red-300 bg-red-50' : 'border-amber-200 bg-amber-50/60',
      )}
    >
      {c.met ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <Circle className={cn('mt-0.5 h-4 w-4 shrink-0', red ? 'text-red-500' : 'text-amber-500')} />
      )}
      <div className="min-w-0 flex-1">
        <div className={cn('text-[13px] font-medium', c.met ? 'text-gray-700' : red ? 'text-red-800' : 'text-amber-900')}>
          {c.label}
        </div>
        {c.detail && <div className="mt-0.5 text-[12px] leading-relaxed text-gray-500">{c.detail}</div>}
        {!c.met && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            <span className="text-gray-500">负责人：{OWNER_LABEL[c.owner]}</span>
            {c.configError ? (
              <span className="inline-flex items-center gap-1 font-medium text-red-600">
                <AlertTriangle className="h-3 w-3" /> 未填死线（违反公理一·必须补 owner+死线）
              </span>
            ) : c.overdue ? (
              <span className="inline-flex items-center gap-1 font-medium text-red-600">
                <CalendarClock className="h-3 w-3" /> 死线 {c.due} 已过期·上豁免面板
              </span>
            ) : (
              <span className="text-gray-500">目标日期：{c.due}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function CalibrationView({ readiness }: { readiness: Readiness }) {
  const { checklist, findings } = readiness
  const metCount = checklist.filter((c) => c.met).length

  return (
    <div data-testid="calibration-view" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-baseline gap-2">
        <h2 className="text-[16px] font-semibold text-[#0a2540]">校准就绪清单</h2>
        <span className="text-[12px] text-gray-500">{metCount} / {checklist.length} 项已满足</span>
      </div>
      <p className="mb-4 text-[12.5px] leading-relaxed text-gray-500">
        绝对值判断（覆盖倍数够不够、逐院可留/需谈价）在下列条件<b>全部满足</b>前<b>不出门</b>——影子期只看趋势方向、校数据。
        每一条差的都挂了负责人和目标日期；缺死线或过期的会标红。
      </p>

      <div className="space-y-2.5">
        {checklist.map((c) => (
          <ConditionRow key={c.key} c={c} />
        ))}
      </div>

      {findings.length > 0 && (
        <div className="mt-4 space-y-2" data-testid="readiness-findings">
          {findings.map((f, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-relaxed text-red-800"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
              <span>{f.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
