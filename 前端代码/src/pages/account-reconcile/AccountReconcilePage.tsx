import type { KeyboardEvent } from 'react'
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

function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || [])
  if (!tabs.length) return
  event.preventDefault()
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[nextIndex]?.focus()
  tabs[nextIndex]?.click()
}

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

      {!ctx.canWrite && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-[13px] text-blue-800">当前为只读模式：可以回看来源事实与处理状态，不能计算、认定、签发、补收或关账。</div>}

      <div className="flex gap-1 overflow-x-auto border-b border-gray-200" role="tablist" aria-label="账实复核工作流">
        {TABS.map((t, index) => {
          const active = ctx.tab === t.key
          return (
            <button
              key={t.key}
              id={`account-reconcile-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`account-reconcile-panel-${t.key}`}
              tabIndex={active ? 0 : -1}
              onKeyDown={event => handleTabKeyDown(event, index)}
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

      {ctx.tab === 'overview' && <div id="account-reconcile-panel-overview" role="tabpanel" aria-labelledby="account-reconcile-tab-overview"><ReconcileOverview ctx={ctx} /></div>}

      {ctx.tab === 'workbench' &&
        <div id="account-reconcile-panel-workbench" role="tabpanel" aria-labelledby="account-reconcile-tab-workbench">{ctx.selected ? (
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
        )}</div>}

      {ctx.tab === 'supplement' && <div id="account-reconcile-panel-supplement" role="tabpanel" aria-labelledby="account-reconcile-tab-supplement"><SupplementTracking month={ctx.month} canWrite={ctx.canWrite} /></div>}
    </div>
  )
}
