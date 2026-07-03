import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { accountReconcileApi } from '@/api/account-reconcile'
import type { SupplementOrder, SupplementBoard } from '@/types/account-reconcile'
import { SupPill, wan, yuan, pct, cnMonth, btnGhost, cardCls, selectCls } from '../ui'

const TH = 'px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap'

export function SupplementTracking({ month, canWrite }: { month: string; canWrite: boolean }) {
  const [list, setList] = useState<SupplementOrder[]>([])
  const [board, setBoard] = useState<SupplementBoard | null>(null)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)

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

  const giveup = useCallback(async (so: SupplementOrder) => {
    const reason = window.prompt('放弃补收——请填理由（记经手人）：')
    if (!reason || !reason.trim()) return
    try {
      await accountReconcileApi.giveup(so.id, reason.trim())
      toast.success('已放弃补收')
      await load()
    } catch { /* toast handled */ }
  }, [load])

  const reopen = useCallback(async (so: SupplementOrder) => {
    const reason = window.prompt('恢复待补收——请填理由（记经手人）：')
    if (!reason || !reason.trim()) return
    try {
      await accountReconcileApi.reopenSupplement(so.id, reason.trim())
      toast.success('已恢复待补收')
      await load()
    } catch { /* toast handled */ }
  }, [load])

  return (
    <div>
      <p className="text-[13px] text-gray-500">把认定为「漏收，需补收」的差异汇总成补收单，追到收回；标记已补收后自动计入本月实收。</p>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className={`${cardCls} border-red-100 bg-red-50/60 p-4`}>
          <div className="text-xs text-gray-500">待补收</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums text-red-600">{wan(board?.待补收金额)}</div>
          <div className="mt-0.5 text-xs text-gray-400">{board?.待补收数 ?? 0} 单待催收</div>
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
              {list.map((so) => (
                <tr key={so.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{so.partnerId} · {cnMonth(so.serviceMonth)}</td>
                  <td className="px-4 py-3 text-gray-600">{so.caseNo ? `病理号 ${so.caseNo} 漏收` : '漏收'}{so.collectedMonth && <span className="ml-2 text-xs text-blue-600">计入 {cnMonth(so.collectedMonth)}</span>}{so.collectedRevenue != null && <span className="ml-2 text-xs text-gray-500">折实收 {yuan(so.collectedRevenue)}</span>}{so.giveUpReason && <span className="ml-2 text-xs text-gray-400">{so.giveUpReason}</span>}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{so.caseCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">{yuan(so.amount)}</td>
                  <td className="px-4 py-3"><SupPill status={so.status} /></td>
                  <td className="px-4 py-3 text-right">
                    {canWrite && so.status === '待补收' && (
                      <span className="inline-flex gap-1">
                        <button className={btnGhost} onClick={() => collect(so)}>标记已补收</button>
                        <button className={`${btnGhost} text-gray-500 hover:bg-gray-100`} onClick={() => giveup(so)}>放弃</button>
                      </span>
                    )}
                    {canWrite && so.status !== '待补收' && (
                      <button className={`${btnGhost} text-gray-500 hover:bg-gray-100`} onClick={() => reopen(so)}>恢复待补收</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500">已关账月份的补收单只读回看；反向操作（恢复待补收 / 放弃）需填理由、记经手人。</p>
    </div>
  )
}
