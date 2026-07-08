import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { accountReconcileApi } from '@/api/account-reconcile'
import type { SupplementOrder, SupplementBoard } from '@/types/account-reconcile'
import { SupPill, wan, yuan, pct, cnMonth, btnGhost, cardCls, selectCls } from '../ui'
import { ReasonModal } from './ReasonModal'

const TH = 'px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap'

/** 当前登录用户名（仅用于「不能签发自己提交的单」的前端提示；SoD 由后端强制）。 */
function currentUsername(): string {
  try {
    return JSON.parse(localStorage.getItem('user') || '{}')?.username || ''
  } catch {
    return ''
  }
}

type PendingKind = 'giveup' | 'reopen' | 'approve'

export function SupplementTracking({ month, canWrite }: { month: string; canWrite: boolean }) {
  const [list, setList] = useState<SupplementOrder[]>([])
  const [board, setBoard] = useState<SupplementBoard | null>(null)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const me = currentUsername()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await accountReconcileApi.supplements(month, status)
      setList(res.list || [])
      setBoard(res.board || null)
    } catch {
      /* toast handled */
    } finally {
      setLoading(false)
    }
  }, [month, status])

  useEffect(() => { load() }, [load])

  const collect = useCallback(async (so: SupplementOrder) => {
    try {
      await accountReconcileApi.collect(so.id)
      toast.success('已标记补收，计入本月实收')
      await load()
    } catch { /* toast handled */ }
  }, [load])

  const [pending, setPending] = useState<{ so: SupplementOrder; kind: PendingKind } | null>(null)
  const doPending = useCallback(async (reason: string) => {
    if (!pending) return
    try {
      if (pending.kind === 'giveup') { await accountReconcileApi.giveup(pending.so.id, reason); toast.success('已放弃补收') }
      else if (pending.kind === 'approve') { await accountReconcileApi.approve(pending.so.id, reason); toast.success('已签发，本单可收款') }
      else { await accountReconcileApi.reopenSupplement(pending.so.id, reason); toast.success('已恢复待补收') }
      setPending(null)
      await load()
    } catch { /* toast handled */ }
  }, [pending, load])

  // 操作确认弹窗文案（按操作类型）。approve 说明两人分签规则 + 本单认定人。
  const modalMeta = (() => {
    if (!pending) return { title: '', description: '', confirmLabel: '确认' }
    if (pending.kind === 'giveup') {
      return {
        title: '放弃补收',
        description: '这笔漏收放弃追收（收不回 / 不再追）。放弃后退出实收统计，可日后再恢复。请填理由并记录经手人。',
        confirmLabel: '确认放弃',
      }
    }
    if (pending.kind === 'approve') {
      const by = pending.so.submittedBy ? `本单由「${pending.so.submittedBy}」认定提交——` : ''
      return {
        title: '签发补收单',
        description: `确认这笔追加收费经你独立复核无误，同意放行收款；签发后本单方可「标记已补收」。${by}认定人不能签发自己提交的单，须由他人签发（系统强制）。请填理由并记录经手人。`,
        confirmLabel: '确认签发',
      }
    }
    return {
      title: '恢复待补收',
      description: '把已补收 / 已放弃的补收单退回「待补收」，重新催收。恢复后须重新签发才可再收款。请填理由并记录经手人。',
      confirmLabel: '确认恢复',
    }
  })()

  return (
    <div>
      <p className="text-[13px] text-gray-500">把认定为「漏收，需补收」的差异汇总成补收单；每单需由他人独立「签发」后方可收款，标记已补收后自动计入本月实收。</p>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className={`${cardCls} border-red-100 bg-red-50/60 p-4`}>
          <div className="text-xs text-gray-500">待补收</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums text-red-600">{wan(board?.待补收金额)}</div>
          <div className="mt-0.5 text-xs text-gray-400">
            {board?.待补收数 ?? 0} 单待催收
            {(board?.待签发数 ?? 0) > 0 && <span className="ml-1 text-amber-600">· {board?.待签发数} 单待签发</span>}
          </div>
        </div>
        <div className={`${cardCls} border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-4`}>
          <div className="text-xs text-gray-500">已补收 · 计入本月实收</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums text-blue-600">{wan(board?.已补收实收)}</div>
          <div className="mt-0.5 text-xs text-gray-400">账单口径 {wan(board?.已补收金额)}（收费×扣率折实收）</div>
        </div>
        <div className={`${cardCls} p-4`}>
          <div className="text-xs text-gray-500">补收率</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums text-gray-900">{pct(board?.补收率)}</div>
          <div className="mt-0.5 text-xs text-gray-400">已补收 ÷（已补收+待补收）</div>
        </div>
        <div className={`${cardCls} p-4`}>
          <div className="text-xs text-gray-500">已放弃</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums text-gray-900">{wan(board?.已放弃金额)}</div>
        </div>
      </div>

      <div className="mt-5 mb-3 flex items-center gap-3">
        <h3 className="text-[13px] font-bold text-gray-900">补收单 · {cnMonth(month)}</h3>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="待补收">待补收</option>
          <option value="已补收">已补收</option>
          <option value="已放弃">已放弃</option>
        </select>
      </div>

      {loading ? (
        <div className="mt-8 text-center text-sm text-gray-400">加载中…</div>
      ) : !list.length ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
          本月暂无补收单。工作台里认定为「漏收，需补收」的差异会自动汇总到这里。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className={`w-full text-[13px] ${cardCls} overflow-hidden`}>
            <thead className="bg-gray-50">
              <tr>
                <th className={TH}>医院 · 月份</th><th className={TH}>来源</th>
                <th className={`${TH} text-right`}>例数</th><th className={`${TH} text-right`}>金额</th><th className={TH}>状态</th><th className={`${TH} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((so) => {
                const pendingReview = so.status === '待补收' && so.reviewStatus !== 'approved'
                const isSelf = !!so.submittedBy && so.submittedBy === me
                // 缺认定人（迁移遗留的空 submitted_by）→ 后端 fail-closed 必拒签发，按钮禁用不空点。
                const noSubmitter = !so.submittedBy
                return (
                <tr key={so.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{so.partnerId} · {cnMonth(so.serviceMonth)}</td>
                  <td className="px-4 py-3 text-gray-600">{so.caseNo ? `病理号 ${so.caseNo} 漏收` : '漏收'}{so.collectedMonth && <span className="ml-2 text-xs text-blue-600">计入 {cnMonth(so.collectedMonth)}</span>}{so.collectedRevenue != null && <span className="ml-2 text-xs text-gray-500">折实收 {yuan(so.collectedRevenue)}</span>}{so.giveUpReason && <span className="ml-2 text-xs text-gray-400">{so.giveUpReason}</span>}{pendingReview && so.submittedBy && <span className="ml-2 text-xs text-gray-400">由 {so.submittedBy} 认定提交</span>}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{so.caseCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">{yuan(so.amount)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <SupPill status={so.status} />
                      {so.status === '待补收' && (pendingReview
                        ? <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">待签发</span>
                        : <span className="text-xs text-green-600">已签发{so.reviewedBy ? ` · ${so.reviewedBy}` : ''}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canWrite && pendingReview && (
                      <span className="inline-flex gap-1">
                        <button
                          className={btnGhost}
                          disabled={isSelf || noSubmitter}
                          title={noSubmitter ? '该单缺少认定人信息（数据迁移遗留），无法签发；请放弃或联系管理员' : isSelf ? '不能签发自己认定/提交的补收单，请由他人签发' : '独立复核后放行收款'}
                          onClick={() => setPending({ so, kind: 'approve' })}
                        >签发</button>
                        <button className={`${btnGhost} text-gray-500 hover:bg-gray-100`} onClick={() => setPending({ so, kind: 'giveup' })}>放弃</button>
                      </span>
                    )}
                    {canWrite && so.status === '待补收' && !pendingReview && (
                      <span className="inline-flex gap-1">
                        <button className={btnGhost} onClick={() => collect(so)}>标记已补收</button>
                        <button className={`${btnGhost} text-gray-500 hover:bg-gray-100`} onClick={() => setPending({ so, kind: 'giveup' })}>放弃</button>
                      </span>
                    )}
                    {canWrite && so.status !== '待补收' && (
                      <button className={`${btnGhost} text-gray-500 hover:bg-gray-100`} onClick={() => setPending({ so, kind: 'reopen' })}>恢复待补收</button>
                    )}
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500">补收单须先由他人「签发」（独立复核）才能收款——认定人不能签发自己提交的单。已关账月份的补收单只读回看；反向操作（恢复待补收 / 放弃）需填理由、记经手人。</p>

      <ReasonModal
        open={!!pending}
        title={modalMeta.title}
        description={modalMeta.description}
        confirmLabel={modalMeta.confirmLabel}
        onConfirm={doPending}
        onClose={() => setPending(null)}
      />
    </div>
  )
}
