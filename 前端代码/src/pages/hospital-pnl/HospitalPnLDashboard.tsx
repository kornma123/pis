import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Building2, TrendingUp, AlertTriangle, Info, RefreshCw, Wallet, Landmark, Receipt } from 'lucide-react'
import { cn } from '@/lib/utils'
import { canAccess } from '@/lib/permissions'
import { EmptyState } from '@/components/ui/EmptyState'
import { partnerPnlApi } from '@/api/partner-pnl'
import type { PartnerPnl, CasePnl, PnlTrendPoint } from '@/types/partner-pnl'

// —— 设计令牌（项目标准：浅色金融 + 海军蓝标题 #0a2540 + 主蓝强调 #3b82f6 + 盈利绿 #059669/亏损红 #e11d48 + 等宽数字）——
const ACCENT = '#3b82f6'
const CARD = 'bg-white rounded-xl border border-slate-200/80 shadow-[0_2px_5px_-1px_rgba(50,50,93,0.07),0_1px_3px_-1px_rgba(0,0,0,0.05)]'
const INK = 'text-[#0a2540]'
// codex F3：金额保留 2 位小数（明细/毛利需精确到分，Math.round 会把小额毛利/差额抹平）。
const yuan = (n: number) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (r: number) => (r * 100).toFixed(1) + '%'
const marginColor = (n: number) => (n < 0 ? 'text-rose-600' : 'text-emerald-600')

export default function HospitalPnLDashboard() {
  const [serviceMonth, setServiceMonth] = useState('')
  const [rows, setRows] = useState<PartnerPnl[]>([])
  const [flagged, setFlagged] = useState<CasePnl[]>([])
  const [trend, setTrend] = useState<PnlTrendPoint[]>([])
  const [selected, setSelected] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // codex F6：reqRef 防请求竞态（快速切月份时旧请求不覆盖新结果）；selectedRef 让 load 读到最新选中院而无需进依赖（否则点行就全量重载）。
  const reqRef = useRef(0)
  const selectedRef = useRef('')
  useEffect(() => { selectedRef.current = selected }, [selected])

  const load = useCallback(async () => {
    const my = ++reqRef.current
    setLoading(true); setError('')
    try {
      const [ov, cs] = await Promise.all([
        partnerPnlApi.overview(serviceMonth ? { serviceMonth } : undefined),
        partnerPnlApi.cases({ ...(serviceMonth ? { serviceMonth } : {}), onlyFlagged: true, pageSize: 50 }),
      ])
      if (my !== reqRef.current) return // 已有更新的请求在途 → 丢弃本次结果
      const list = (ov?.list || []).slice().sort((a, b) => a.grossMargin - b.grossMargin)
      setRows(list)
      setFlagged(cs?.list || [])
      const top = selectedRef.current || list.slice().sort((a, b) => b.labRevenueTotal - a.labRevenueTotal)[0]?.partnerId || ''
      setSelected(top)
      const tr = top ? await partnerPnlApi.trend(top) : []
      if (my !== reqRef.current) return
      setTrend(tr)
    } catch {
      if (my === reqRef.current) setError('加载院级盈亏失败，请重试')
    } finally {
      if (my === reqRef.current) setLoading(false)
    }
  }, [serviceMonth])

  useEffect(() => { load() }, [load])

  const pickPartner = async (id: string) => {
    setSelected(id)
    try { setTrend(await partnerPnlApi.trend(id)) } catch { /* 拦截器已 toast */ }
  }

  const kpi = useMemo(() => {
    const s = rows.reduce((a, r) => ({
      net: a.net + r.netRevenueTotal, lab: a.lab + r.labRevenueTotal, cost: a.cost + r.costTotal, gm: a.gm + r.grossMargin,
    }), { net: 0, lab: 0, cost: 0, gm: 0 })
    return { ...s, rate: s.lab > 0 ? s.gm / s.lab : 0, lossCount: rows.filter((r) => r.grossMargin < 0).length }
  }, [rows])

  if (!canAccess('cost_analysis', 'R')) {
    return <EmptyState icon={Wallet} title="无权限访问" description="医院盈利看板需要成本分析(查看)权限" />
  }

  const selectedName = rows.find((r) => r.partnerId === selected)?.partnerName || ''

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className={cn('text-[26px] font-semibold tracking-tight leading-tight', INK)}>医院盈利看板</h1>
          <p className="text-sm text-slate-500 mt-1">按合作医院的财务实收 → 实验室收入 → 核算成本 → 院级毛利</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" value={serviceMonth} onChange={(e) => setServiceMonth(e.target.value)}
            className="h-10 px-3 rounded-md border border-slate-200 text-sm text-slate-700 bg-white focus:ring-[3px] focus:ring-[#3b82f6]/10 focus:border-[#3b82f6] outline-none tabular-nums" />
          <button onClick={() => load()} className="h-10 inline-flex items-center gap-1.5 px-3 rounded-md border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors">
            <RefreshCw className="w-4 h-4" /> 刷新
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 animate-pulse">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-[88px] rounded-xl bg-slate-100" />)}
        </div>
      ) : error ? (
        <div className={cn(CARD, 'p-10 text-center')}>
          <EmptyState icon={AlertTriangle} title="加载失败" description={error} />
          <button onClick={() => load()} className="mt-4 h-10 inline-flex items-center gap-1.5 px-4 rounded-md bg-blue-500 text-sm font-medium text-white hover:bg-blue-600 transition-colors">
            <RefreshCw className="w-4 h-4" /> 重试
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className={cn(CARD, 'p-10')}>
          <EmptyState icon={Building2} title="本期暂无院级盈亏数据" description="先导入 LIS 病例与财务收费单据，回填成本后这里即可看到每家医院的毛利。" />
        </div>
      ) : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi icon={Building2} label="合作医院" value={String(rows.length)} sub={`负毛利 ${kpi.lossCount} 家`} subColor={kpi.lossCount ? 'text-rose-600' : 'text-slate-400'} />
            <Kpi icon={Receipt} label="财务实收" value={yuan(kpi.net)} sub={serviceMonth || '全部账期'} />
            <Kpi icon={Landmark} label="实验室收入" value={yuan(kpi.lab)} sub="计入实验室的结算额" />
            <Kpi icon={Wallet} label="核算成本" value={yuan(kpi.cost)} sub="按医院汇总" />
            <Kpi icon={TrendingUp} label="院级毛利" value={yuan(kpi.gm)} sub={`毛利率 ${pct(kpi.rate)}`} valueColor={marginColor(kpi.gm)} />
          </div>

          {/* 院级 P&L 表 */}
          <div className={cn(CARD, 'overflow-hidden')}>
            <div className="flex items-center px-4 py-3 border-b border-slate-100">
              <h2 className={cn('text-sm font-semibold', INK)}>院级盈亏 · 负毛利置顶</h2>
              <div className="ml-auto flex items-center gap-3 text-xs">
                {kpi.lossCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-rose-600 bg-rose-50 px-2 py-1 rounded-full">
                    <AlertTriangle className="w-3.5 h-3.5" /> {kpi.lossCount} 家负毛利
                  </span>
                )}
                {rows[0]?.costMonthAxis === 'service_month' && (
                  <span className="inline-flex items-center gap-1 text-slate-400" title="本月成本已按服务月对齐：跨月使用的耗材成本归入病例的服务当月，与收入同月，避免单月毛利错期。">
                    <Info className="w-3.5 h-3.5" /> 成本按服务月对齐
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-slate-400"><Info className="w-3.5 h-3.5" /> 参考值未按病种校正</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-xs text-slate-400">
                    <th className="text-left font-medium px-4 py-2.5">医院</th>
                    <th className="text-right font-medium px-4 py-2.5">财务实收</th>
                    <th className="text-right font-medium px-4 py-2.5">实验室收入</th>
                    <th className="text-right font-medium px-4 py-2.5" title="医生诊断/报告/现场服务——我们收但非实验室工序，不进毛利">诊断与报告</th>
                    <th className="text-right font-medium px-4 py-2.5">核算成本</th>
                    <th className="text-right font-medium px-4 py-2.5">毛利</th>
                    <th className="text-right font-medium px-4 py-2.5">毛利率</th>
                    <th className="text-left font-medium px-4 py-2.5">完整度</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const est = r.sourceCounts?.estimated ?? (r.qualityCounts.partial_quantities + r.qualityCounts.no_quantities)
                    const neg = r.grossMargin < 0
                    return (
                      <tr key={r.partnerId} onClick={() => pickPartner(r.partnerId)}
                        role="button" tabIndex={0} aria-label={`查看 ${r.partnerName || r.partnerId} 月度趋势`}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickPartner(r.partnerId) } }}
                        className={cn('border-t border-slate-50 cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3b82f6]/50',
                          neg ? 'bg-rose-50/60 hover:bg-rose-50' : 'hover:bg-slate-50',
                          selected === r.partnerId && 'ring-1 ring-inset ring-[#3b82f6]/30 bg-[#3b82f6]/[0.04]')}>
                        <td className={cn('px-4 py-3 font-medium', INK)}>{r.partnerName || r.partnerId}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{yuan(r.netRevenueTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{yuan(r.labRevenueTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-400">{r.diagnosisRevenueTotal > 0 ? yuan(r.diagnosisRevenueTotal) : '—'}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{r.costMatched ? yuan(r.costTotal) : <span className="text-amber-600">未接通</span>}</td>
                        <td className={cn('px-4 py-3 text-right font-medium', marginColor(r.grossMargin))}>{r.grossMargin < 0 ? '−' : '+'}{yuan(Math.abs(r.grossMargin)).slice(1)}</td>
                        <td className={cn('px-4 py-3 text-right font-medium', marginColor(r.grossMargin))}>{pct(r.marginRate)}</td>
                        <td className="px-4 py-3">
                          {est > 0
                            ? <span className="inline-block text-[11px] text-amber-700 border border-amber-200 bg-amber-50 px-2 py-0.5 rounded" title="部分病例无对账单，按经验占比估算">估算 {est} 例</span>
                            : <span className="inline-block text-[11px] text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded">全部已对账</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 趋势 + CM 筛查 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className={cn(CARD, 'lg:col-span-2 p-4')}>
              <div className="flex items-center justify-between mb-3">
                <h2 className={cn('text-sm font-semibold', INK)}>月度趋势 {selectedName && <span className="text-slate-400 font-normal">· {selectedName}</span>}</h2>
                <span className="text-xs text-slate-400">点上表某行切换医院</span>
              </div>
              {trend.length === 0 ? (
                <div className="h-[260px] flex items-center justify-center text-sm text-slate-400">该医院暂无月度数据</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={trend} margin={{ top: 6, right: 10, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                    <XAxis dataKey="serviceMonth" tick={{ fontSize: 12, fill: '#8792a2' }} axisLine={{ stroke: '#e6ebf1' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 12, fill: '#8792a2' }} axisLine={false} tickLine={false} width={56} />
                    <Tooltip formatter={(v: number, n) => [yuan(v), n as string]} contentStyle={{ borderRadius: 10, border: '1px solid #e6ebf1', boxShadow: '0 2px 5px -1px rgba(50,50,93,.12)' }} />
                    <Line type="monotone" dataKey="labRevenueTotal" name="实验室收入" stroke={ACCENT} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="costTotal" name="成本" stroke="#e11d48" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="grossMargin" name="毛利" stroke="#059669" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className={cn(CARD, 'p-4')}>
              <h2 className={cn('text-sm font-semibold mb-3', INK)}>负毛利病例筛查</h2>
              {flagged.length === 0 ? (
                <div className="h-[260px] flex items-center justify-center text-sm text-slate-400">本期无负毛利病例</div>
              ) : (
                <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                  {flagged.map((c) => (
                    <div key={c.caseNo + c.serviceMonth} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-rose-50/70 border border-rose-100">
                      <div className="min-w-0">
                        <div className={cn('text-[13px] font-medium truncate', INK)}>{c.caseNo}</div>
                        <div className="text-[11px] text-slate-500 truncate">{c.partnerName}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[13px] font-medium text-rose-600 tabular-nums">−{yuan(Math.abs(c.grossMargin)).slice(1)}</div>
                        <div className="text-[11px] text-slate-400 tabular-nums">{pct(c.marginRate)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <p className="text-xs text-slate-400 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" /> 实验室收入 = 对账单里计入实验室的项目结算额之和；无对账单的病例按经验占比估算（标「估算」），账单到位即校正。决策以院级毛利为准。
          </p>
        </>
      )}
    </div>
  )
}

function Kpi({ icon: Icon, label, value, sub, valueColor, subColor }: {
  icon: any; label: string; value: string; sub: string; valueColor?: string; subColor?: string
}) {
  return (
    <div className={cn(CARD, 'p-4')}>
      <div className="flex items-center gap-1.5 text-xs text-slate-400"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className={cn('text-[22px] font-semibold tracking-tight mt-2 tabular-nums', valueColor || INK)}>{value}</div>
      <div className={cn('text-[11px] mt-1.5', subColor || 'text-slate-400')}>{sub}</div>
    </div>
  )
}
