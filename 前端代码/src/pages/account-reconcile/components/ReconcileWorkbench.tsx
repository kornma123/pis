import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { accountReconcileApi } from '@/api/account-reconcile'
import { VERDICT_REASONS, type ReconcileBinding, type ReconcileDiff, type ReconcileSnapshot, type HmStatus, type VerdictReason, type CaseHint } from '@/types/account-reconcile'
import { HmPill, matchStatusMeta, wan, yuan, cnMonth, btnPri, btnGhost, cardCls, selectCls } from '../ui'

interface Props {
  partnerId: string
  partnerName: string
  month: string
  canWrite: boolean
  onBack: () => void
}

/** generation 状态 → 院·月展示状态。 */
const GEN_TO_HM_STATUS: Record<ReconcileSnapshot['status'], HmStatus> = {
  pending: '待复核',
  complete: '复核完成',
  closed: '已关账',
}

export function ReconcileWorkbench({ partnerId, partnerName, month, canWrite, onBack }: Props) {
  const [binding, setBinding] = useState<ReconcileBinding | null>(null)
  const [snap, setSnap] = useState<ReconcileSnapshot | null>(null)
  const [diffs, setDiffs] = useState<ReconcileDiff[]>([])
  const [caseHints, setCaseHints] = useState<Record<string, CaseHint[]>>({})
  const [loading, setLoading] = useState(true)
  const [showUnmatched, setShowUnmatched] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 代次发现：从 board 解析该院本月的权威四元组 binding（LOC-005 合同；
      // 页面壳不在本任务 lease 内，故工作台自行解析，保证拿到的是当前代）。
      const b = await accountReconcileApi.board(month)
      const item = (b.items || []).find((i) => i.partnerId === partnerId)
      if (!item?.statementGenerationId || !item.reconcileGenerationId) {
        setBinding(null)
        setSnap(null)
        setDiffs([])
        setCaseHints({})
        return
      }
      const nb: ReconcileBinding = {
        partnerId,
        settlementMonth: month,
        statementGenerationId: item.statementGenerationId,
        reconcileGenerationId: item.reconcileGenerationId,
      }
      setBinding(nb)
      const res = await accountReconcileApi.workbench(nb)
      setSnap(res.snapshot || null)
      setDiffs(res.diffs || [])
      setCaseHints(res.caseHints || {})
    } catch {
      /* toast handled */
    } finally {
      setLoading(false)
    }
  }, [partnerId, month])

  useEffect(() => { load() }, [load])

  // 由 snapshot 组装展示用院·月视图（状态/匹配率/差异数/未匹配/实收）。
  const hm = snap
    ? {
        id: snap.hospitalMonthId,
        status: GEN_TO_HM_STATUS[snap.status],
        matchRate: snap.result?.matchRate ?? 0,
        matchStatus: snap.result?.matchStatus ?? null,
        diffCount: diffs.length,
        unmatchedCount: snap.result?.unmatched?.length ?? 0,
        confirmedLabRevenue: snap.confirmedLabRevenue,
      }
    : null
  const unmatched = snap?.result?.unmatched ?? []

  const pending = diffs.filter((d) => !d.verdict).length
  // 只有「待复核」（当前代 pending）可认定/改认定；复核完成与已关账只读。
  const readOnly = !canWrite || !hm || hm.status !== '待复核'

  const setVerdict = useCallback(async (diff: ReconcileDiff, reason: VerdictReason) => {
    if (!binding) return
    setSavingId(diff.id)
    try {
      const r = await accountReconcileApi.verdict(diff.id, binding, reason)
      setDiffs((prev) => prev.map((d) => (d.id === diff.id ? { ...d, verdict: reason, followUp: r.followUp as ReconcileDiff['followUp'], verdictBy: '我' } : d)))
      if (reason === '漏收，需补收') toast.success('已认定漏收，已生成补收单（去「补收追踪」催收）')
      else toast.success(`已认定：${reason}`)
    } catch {
      /* toast handled */
    } finally {
      setSavingId(null)
    }
  }, [binding])

  const complete = useCallback(async () => {
    if (!hm || !binding) return
    try {
      const r = await accountReconcileApi.complete(hm.id, binding)
      toast.success(`复核完成 · 已确认实收 ${wan(r.confirmedLabRevenue)}`)
      onBack()
    } catch {
      /* toast handled */
    }
  }, [hm, binding, onBack])

  const mm = matchStatusMeta(hm?.matchStatus ?? null)

  return (
    <div>
      <button className={`${btnGhost} mb-3`} onClick={onBack}>← 返回复核总览</button>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900">{partnerName} · {cnMonth(month)}</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">逐条看差异（账单片数 对 LIS 实际片数），认定原因、留痕经手人；全部认定后「复核完成」。</p>
        </div>
        {hm && <HmPill status={hm.status} />}
      </div>

      {loading ? (
        <div className="mt-8 text-center text-sm text-gray-400">加载中…</div>
      ) : !hm ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">该院该月还没有核对记录，请先在总览计算。</div>
      ) : (
        <>
          {/* source header */}
          <div className={`mt-4 flex flex-wrap gap-x-8 gap-y-3 ${cardCls} px-4 py-3.5`}>
            <Meta label="病理号匹配率" value={<span className={mm.color}>{Math.round((hm.matchRate || 0) * 100)}%（{mm.tag}）</span>} />
            <Meta label="可核差异 / 未匹配" value={`${hm.diffCount} 条 / ${hm.unmatchedCount} 例（算不了·单列）`} />
            <Meta label="本院实验室实收" value={<>{hm.confirmedLabRevenue != null ? wan(hm.confirmedLabRevenue) : '待复核完成'} <span className="font-normal text-gray-500">（收费×扣率）</span></>} />
          </div>

          <div className="mt-5 mb-2 flex items-baseline justify-between">
            <h3 className="text-[13px] font-bold text-gray-900">差异明细</h3>
            <span className="text-xs text-gray-400">{diffs.length} 条 · 已认定 {diffs.length - pending} · 待认定 {pending}</span>
          </div>
          <p className="mb-3 text-xs text-gray-500">系统初判是线索、不是定论；财务逐条终判。认定后仍可「改认定」——如「超期，免费做的」日后医院同意补，改成「漏收，需补收」即自动生成补收单。</p>

          {!diffs.length ? (
            <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
              {hm.matchStatus === '先查' ? '匹配率偏低（先查），本月先不出差异结论；请先核对未匹配名单/院名对齐。' : '账单与 LIS 逐例一致，无差异。'}
            </div>
          ) : (
            diffs.map((d) => <DiffCard key={d.id} d={d} readOnly={readOnly} saving={savingId === d.id} onVerdict={setVerdict} />)
          )}

          {/* ③ 逐抗体线索（返工/多病灶）—— 独立展示，不依赖差异卡（账实数量对得上、抗体明细仍可有线索） */}
          {Object.keys(caseHints).length > 0 && (
            <div className="mt-6">
              <h3 className="text-[13px] font-bold text-gray-900">逐抗体线索</h3>
              <p className="mb-3 mt-1 text-xs text-gray-500">从 LIS 逐抗体明细看出的线索（同蜡块重复=返工、同抗体跨蜡块=多病灶），提示财务终判——不改差异计数与认定。</p>
              <div className={`${cardCls} divide-y divide-gray-100`}>
                {Object.entries(caseHints).map(([caseNo, hs]) => (
                  <div key={caseNo} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                    <span className="text-sm font-semibold text-gray-900">病理号 {caseNo}</span>
                    {hs.map((h, i) =>
                      h.hintType === '疑似返工' ? (
                        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          同蜡块 {h.markerName}{h.waxNo ? `（${h.waxNo}）` : ''} 做了 {h.occurrences} 次 · 疑似返工（可能不该多收）
                        </span>
                      ) : (
                        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
                          {h.markerName} 跨 {h.occurrences} 个蜡块{h.waxNo ? `（${h.waxNo}）` : ''} · 多病灶各收各钱
                        </span>
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* footer */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <button className={btnGhost} onClick={() => setShowUnmatched((v) => !v)}>
              未匹配 {hm.unmatchedCount} 例（一边有、一边没有）单列「算不了」{showUnmatched ? '▲' : '▾'}
            </button>
            <div className="flex items-center gap-2">
              {hm.status === '待复核' && (
                <button className={btnPri} disabled={readOnly || pending > 0} onClick={complete}>
                  {pending > 0 ? `复核完成（还有 ${pending} 条待认定）` : '复核完成'}
                </button>
              )}
            </div>
          </div>

          {showUnmatched && (
            <div className={`mt-3 ${cardCls} overflow-hidden`}>
              {!unmatched.length ? (
                <div className="px-4 py-6 text-center text-sm text-gray-400">无未匹配病例。</div>
              ) : (
                <table className="w-full text-[13px]">
                  <thead className="bg-gray-50"><tr>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">病理号</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">情况</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {unmatched.map((u) => (
                      <tr key={u.caseNo + u.side}><td className="px-4 py-2.5 font-medium text-gray-900">{u.caseNo}</td><td className="px-4 py-2.5 text-gray-600">{u.note}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="text-xs text-gray-500">{label}<div className="mt-1 text-sm font-semibold text-gray-900">{value}</div></div>
  )
}

function DiffCard({ d, readOnly, saving, onVerdict }: { d: ReconcileDiff; readOnly: boolean; saving: boolean; onVerdict: (d: ReconcileDiff, r: VerdictReason) => void }) {
  const [editing, setEditing] = useState(false)
  const reviewed = !!d.verdict
  const showSelect = !reviewed || editing
  const deltaCls = d.delta < 0 ? 'text-red-600' : d.delta > 0 ? 'text-amber-600' : 'text-gray-500'
  return (
    <div className={`mb-2.5 grid grid-cols-1 items-center gap-x-5 gap-y-3 rounded-lg border px-4 py-3.5 md:grid-cols-[1fr_auto] ${reviewed ? 'border-green-200 bg-green-50/50' : 'border-gray-200 bg-white'}`}>
      <div>
        <div className="text-sm font-bold text-gray-900">病理号 {d.caseNo} <span className="ml-1.5 text-xs font-normal text-gray-500">{d.lineType}</span>
          {d.lowConfidence && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-600">仅供参考，请核对</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500">
          <span>账单<b className="ml-1 text-sm font-bold tabular-nums text-gray-900">{d.billCount}</b> 片</span>
          <span>LIS 实际<b className="ml-1 text-sm font-bold tabular-nums text-gray-900">{d.lisCount}</b> 片</span>
          <span className={`font-bold tabular-nums ${deltaCls}`}>差 {d.delta > 0 ? '+' : ''}{d.delta} 片</span>
          {d.amountImpact > 0 && <span>¥影响<b className="ml-1 font-bold tabular-nums text-gray-900">{yuan(d.amountImpact)}</b></span>}
          {d.systemHint && <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">◔ 系统初判：{d.systemHint}</span>}
        </div>
      </div>
      <div className="flex items-center justify-start gap-2 md:justify-end">
        {showSelect ? (
          <>
            <select className={`${selectCls} min-w-[190px]`} disabled={readOnly || saving} defaultValue={d.verdict ?? ''}
              onChange={(e) => { const v = e.target.value as VerdictReason; if (v) { onVerdict(d, v); setEditing(false) } }}>
              <option value="">{saving ? '认定中…' : reviewed ? '改为…' : '选择认定原因…'}</option>
              {VERDICT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {editing && <button className={btnGhost} onClick={() => setEditing(false)}>取消</button>}
          </>
        ) : (
          <div className="text-right">
            <div className="text-xs font-semibold text-green-700">✓ 已认定：{d.verdict}{d.verdictBy && <span className="font-normal text-gray-500"> · {d.verdictBy}</span>}</div>
            {!readOnly && <button className={`${btnGhost} mt-0.5`} onClick={() => setEditing(true)}>改认定</button>}
          </div>
        )}
      </div>
    </div>
  )
}
