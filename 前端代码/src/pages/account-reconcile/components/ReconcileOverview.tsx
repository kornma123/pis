import { useEffect, useMemo, useState } from 'react'
import type { useAccountReconcile } from '../hooks/useAccountReconcile'
import type { HospitalMonth } from '@/types/account-reconcile'
import { HmPill, matchStatusMeta, wan, cnMonth, btnCls, btnGhost, cardCls, selectCls } from '../ui'
import { CloseMonthConfirm, type CloseMonthSnapshot } from './CloseMonthConfirm'

type Ctx = ReturnType<typeof useAccountReconcile>

function DataState({ h }: { h: HospitalMonth }) {
  if (h.statementReady && h.lisReady) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-600"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" />院名已对齐</span>
  }
  const miss = !h.statementReady && !h.lisReady ? '数据待对齐' : !h.statementReady ? '等对账单' : '等 LIS'
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{miss}</span>
}

function MatchRate({ h }: { h: HospitalMonth }) {
  if (!h.matchStatus || h.matchStatus === '待对齐') return <span className="text-gray-400">—</span>
  if (typeof h.matchRate !== 'number' || !Number.isFinite(h.matchRate)) return <span className="text-gray-400">不可计算</span>
  const m = matchStatusMeta(h.matchStatus)
  return (
    <span className={`inline-flex items-baseline gap-1.5 font-semibold tabular-nums ${m.color}`}>
      {Math.round(h.matchRate * 100)}%<span className="text-[11px] font-normal text-gray-500">{m.tag}</span>
    </span>
  )
}

function DiffCell({ h }: { h: HospitalMonth }) {
  if (h.matchStatus === '先查') return <span className="text-gray-400">先查</span>
  if (!h.matchStatus || h.matchStatus === '待对齐') return <span className="text-gray-400">—</span>
  return (
    <span className="tabular-nums">
      {h.diffCount}
      {h.status === '待复核' && h.pendingCount > 0 && <span className="ml-1 text-xs text-amber-600">待认定{h.pendingCount}</span>}
    </span>
  )
}

function Row({ h, ctx }: { h: HospitalMonth; ctx: Ctx }) {
  const clickable = h.statementReady && h.lisReady
  return (
    <tr className={clickable ? 'hover:bg-blue-50/60' : ''}>
      <td className="px-4 py-3">
        <div className="font-semibold text-gray-900">{h.partnerName || h.partnerId}</div>
      </td>
      <td className="px-4 py-3"><DataState h={h} /></td>
      <td className="px-4 py-3"><MatchRate h={h} /></td>
      <td className="px-4 py-3 text-right"><DiffCell h={h} /></td>
      <td className="px-4 py-3 text-right tabular-nums text-gray-900">
        {h.confirmedLabRevenue != null ? wan(h.confirmedLabRevenue) : <span className="text-gray-400">待定</span>}
      </td>
      <td className="px-4 py-3"><HmPill status={h.status} /></td>
      <td className="px-4 py-3 text-right">
        {clickable ? (
          <button className={btnGhost} onClick={() => ctx.openWorkbench(h.partnerId, h.partnerName || h.partnerId)}>
            {h.status === '待复核' ? '去核对 →' : '看明细'}
          </button>
        ) : (
          ctx.canWrite && <button className={btnGhost} disabled={!ctx.writeReady} onClick={() => ctx.computePartner(h.partnerId)}>重算</button>
        )}
      </td>
    </tr>
  )
}

const TH = 'px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap'

export function ReconcileOverview({ ctx }: { ctx: Ctx }) {
  const [pick, setPick] = useState('')
  const [closeSnapshot, setCloseSnapshot] = useState<CloseMonthSnapshot | null>(null)
  const todo = useMemo(() => ctx.list.filter((h) => h.status === '待复核'), [ctx.list])
  const done = useMemo(() => ctx.list.filter((h) => h.status !== '待复核'), [ctx.list])
  const closable = useMemo(
    () => ctx.list.filter((h) => h.serviceMonth === ctx.loadedMonth && h.status === '复核完成'),
    [ctx.list, ctx.loadedMonth],
  )
  const closableRevenue = closable.every((hospital) => typeof hospital.confirmedLabRevenue === 'number' && Number.isFinite(hospital.confirmedLabRevenue))
    ? closable.reduce((sum, hospital) => sum + Number(hospital.confirmedLabRevenue), 0)
    : null
  const notReady = ctx.list.some((h) => !h.statementReady || !h.lisReady)

  useEffect(() => {
    if (closeSnapshot && (!ctx.writeReady
      || closeSnapshot.request.serviceMonth !== ctx.loadedMonth
      || closeSnapshot.request.serviceMonth !== ctx.month)) {
      setCloseSnapshot(null)
    }
  }, [closeSnapshot, ctx.loadedMonth, ctx.month, ctx.writeReady])

  const openCloseConfirm = () => {
    if (!ctx.writeReady || !ctx.loadedMonth || !closable.length || closableRevenue === null) return
    setCloseSnapshot({
      request: { serviceMonth: ctx.loadedMonth, partnerIds: closable.map((h) => h.partnerId) },
      hospitalNames: closable.map((h) => h.partnerName || h.partnerId),
      confirmedRevenue: closableRevenue,
    })
  }

  return (
    <div>
      {/* month + import + compute entry */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-[13px] text-gray-600">
          核对月份
          <input type="month" value={ctx.month} onChange={(e) => ctx.setMonth(e.target.value)}
            className="h-9 rounded-md border border-gray-200 bg-white px-2.5 text-[13px] font-medium text-gray-900 outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10" />
        </label>
        {ctx.canWrite && (
          <>
            <button className={btnCls} disabled={!ctx.writeReady} onClick={ctx.recomputeAll}>重算本月</button>
            <div className="inline-flex items-center gap-2">
              <select className={selectCls} value={pick} disabled={!ctx.writeReady} onFocusCapture={ctx.loadPartners} onChange={(e) => setPick(e.target.value)}>
                <option value="">＋ 计算某院核对…</option>
                {ctx.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className={btnCls} disabled={!pick || !ctx.writeReady} onClick={() => { ctx.computePartner(pick); setPick('') }}>计算</button>
            </div>
          </>
        )}
      </div>

      {ctx.loadError && (
        <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <span>数据没能加载，当前月份的计算、重算和关账均已关闭。</span>
          <button type="button" className="font-medium underline underline-offset-2 disabled:opacity-50" disabled={ctx.loading || ctx.busy} onClick={() => void ctx.loadOverview()}>重试</button>
        </div>
      )}

      {ctx.loading && <div className="mt-8 text-center text-sm text-gray-400">加载中…</div>}

      {!ctx.loading && !ctx.loadError && <>

      {notReady && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <span>⚠︎</span>
          <div>部分院数据未到齐（缺对账单或 LIS），先不出差异结论。导入补齐后点「重算本月」自动更新。</div>
        </div>
      )}

      {/* KPI board */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className={`${cardCls} border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-4`}>
          <div className="text-xs text-gray-500">实验室实收 · 已确认</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums text-blue-600">{wan(ctx.board?.确认实收)}</div>
          <div className="mt-0.5 text-xs text-gray-400">复核完成 / 已关账的院{ctx.board?.补收实收 ? ` + 补收 ${wan(ctx.board.补收实收)}` : ''}</div>
        </div>
        {([['待复核', ctx.board?.待复核], ['复核完成', ctx.board?.复核完成], ['已关账', ctx.board?.已关账]] as const).map(([k, v]) => (
          <div key={k} className={`${cardCls} p-4`}>
            <div className="text-xs text-gray-500">{k}</div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums text-gray-900">{v ?? '不可计算'}{v != null && <span className="ml-1 text-[13px] font-semibold text-gray-500">家</span>}</div>
          </div>
        ))}
      </div>

      {/* close bar */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-lg bg-gradient-to-r from-slate-900 to-slate-700 px-5 py-4 text-white">
        <div className="text-[13px] text-slate-200">
          本月 <b className="text-white">{closable.length}</b> 家复核完成、可关账；合计实验室实收 <b className="tabular-nums text-white">{wan(closableRevenue)}</b>。未就绪的院<b className="text-white">挂起</b>，不影响先关。
        </div>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md bg-white px-3.5 text-[13px] font-semibold text-slate-900 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!ctx.writeReady || !closable.length || closableRevenue === null}
          onClick={openCloseConfirm}
        >
          关账本月（{closable.length}家）
        </button>
      </div>

      {/* lists */}
      {!ctx.list.length ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
          {cnMonth(ctx.month)} 还没有核对记录。导入对账单 + LIS 后，用上方「计算某院核对」开始。
        </div>
      ) : (
        <>
          <Group title="待处理" hint="需要有人跟进（差异待认定，或数据未齐）" rows={todo} ctx={ctx} />
          <Group title="已了结" hint="复核完成 / 已关账" rows={done} ctx={ctx} />
        </>
      )}
      </>}
      <CloseMonthConfirm
        snapshot={closeSnapshot}
        disabled={!ctx.writeReady || closeSnapshot?.request.serviceMonth !== ctx.loadedMonth || closeSnapshot?.request.serviceMonth !== ctx.month}
        onClose={() => setCloseSnapshot(null)}
        onConfirm={(request) => { setCloseSnapshot(null); void ctx.closeMonth(request) }}
      />
    </div>
  )
}

function Group({ title, hint, rows, ctx }: { title: string; hint: string; rows: HospitalMonth[]; ctx: Ctx }) {
  if (!rows.length) return null
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-baseline gap-2 text-[13px] font-bold text-slate-700">{title}<span className="font-normal text-gray-400">· {rows.length} 家 · {hint}</span></div>
      <div className="overflow-x-auto">
        <table className={`w-full text-[13px] ${cardCls} overflow-hidden`}>
          <thead className="bg-gray-50">
            <tr>
              <th className={TH}>医院</th><th className={TH}>数据情况</th><th className={TH}>病理号匹配率</th>
              <th className={`${TH} text-right`}>差异（条）</th><th className={`${TH} text-right`}>实验室实收</th><th className={TH}>状态</th><th className={TH}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((h) => <Row key={h.id} h={h} ctx={ctx} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}
