import { Lock } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { canAccess } from '@/lib/permissions'
import { useAccountReconcile, type ReconTab } from './hooks/useAccountReconcile'
import { ReconcileOverview } from './components/ReconcileOverview'
import { ReconcileWorkbench } from './components/ReconcileWorkbench'
import { SupplementTracking } from './components/SupplementTracking'
import { btnGhost } from './ui'

const TABS: { key: ReconTab; label: string }[] = [
  { key: 'overview', label: '① 复核总览' },
  { key: 'workbench', label: '② 复核工作台' },
  { key: 'supplement', label: '③ 补收追踪' },
]

export default function AccountReconcilePage() {
  const ctx = useAccountReconcile()

  if (!canAccess('account_reconcile', 'R')) {
    return <EmptyState icon={Lock} title="无权限访问" description="账实核对需要「账实核对」模块的查看权限，请联系管理员。" />
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-gray-900">账实核对</h1>
        <p className="mt-1 text-[13px] text-gray-500">每月把「医院对账单」和 LIS 实际片数对齐，逐院核对差异、认定原因、按月关账。</p>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((t) => {
          const active = ctx.tab === t.key
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => ctx.setTab(t.key)}
              className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${
                active ? 'border-blue-500 font-semibold text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {ctx.tab === 'overview' && <ReconcileOverview ctx={ctx} />}

      {ctx.tab === 'workbench' &&
        (ctx.selected ? (
          <ReconcileWorkbench
            partnerId={ctx.selected.partnerId}
            partnerName={ctx.selected.partnerName}
            month={ctx.month}
            canWrite={ctx.canWrite}
            onBack={ctx.backToOverview}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
            从「复核总览」点某家医院的 <button className={btnGhost} onClick={() => ctx.setTab('overview')}>去核对</button> 进入工作台。
          </div>
        ))}

      {ctx.tab === 'supplement' && <SupplementTracking month={ctx.month} canWrite={ctx.canWrite} />}
    </div>
  )
}
