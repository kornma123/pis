import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Building2, TrendingUp, AlertTriangle, Info, RefreshCw, Wallet, Landmark, Receipt } from 'lucide-react'
import { cn } from '@/lib/utils'
import { canAccess } from '@/lib/permissions'
import { EmptyState } from '@/components/ui/EmptyState'
import { partnerPnlApi } from '@/api/partner-pnl'
import type { PartnerPnl, CasePnl, PnlTrendPoint, CaliberRatification } from '@/types/partner-pnl'

// —— 设计令牌（项目标准：浅色金融 + 海军蓝标题 #0a2540 + 主蓝强调 #3b82f6 + 等宽数字）——
// P-2 呈现层止血（八层门禁 · DEC 决策安全层）：本页是口径迁移期的旧视图。账户级*盈利判断*一律不再用红/绿
// 把客户框成「好/坏」，也不把负毛利客户逐个点名；金额保留正负号即可。红/绿只用于「单家医院月度趋势」多线图
// 的线条区分（一家医院自己的时间序列，非跨账户排名）与数据质量徽标（完整度/估算/未接通），均非账户优劣评判。
const ACCENT = '#3b82f6'
const CARD = 'bg-white rounded-xl border border-slate-200/80 shadow-[0_2px_5px_-1px_rgba(50,50,93,0.07),0_1px_3px_-1px_rgba(0,0,0,0.05)]'
const INK = 'text-[#0a2540]'
// codex F3：金额保留 2 位小数（明细/毛利需精确到分，Math.round 会把小额毛利/差额抹平）。
const yuan = (n: number) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (r: number) => (r * 100).toFixed(1) + '%'

// P-2 默认展示排序：按院级毛利「降序」——贡献最大的顶梁柱排在最上，绝不把最赚钱的大客户排到「最差」位置点名。
// 抽成纯函数，供回归测试锁死「默认排序不得再是最差在顶 / 按毛利升序」（见 HospitalPnLDashboard.stopgap.test.tsx）。
export function sortPartnersForDisplay(list: PartnerPnl[]): PartnerPnl[] {
  return list.slice().sort((a, b) => b.grossMargin - a.grossMargin)
}

export default function HospitalPnLDashboard() {
  const [serviceMonth, setServiceMonth] = useState('')
  const [rows, setRows] = useState<PartnerPnl[]>([])
  const [flagged, setFlagged] = useState<CasePnl[]>([])
  const [trend, setTrend] = useState<PnlTrendPoint[]>([])
  // 止损执法点（LEG-2）：拆分口径认账水印。fail-closed——null 视为未认账、照样显示水印。
  const [ratification, setRatification] = useState<CaliberRatification | null>(null)
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
      const list = sortPartnersForDisplay(ov?.list || [])
      setRows(list)
      setRatification(ov?.caliberRatification ?? null) // 缺席则 null → 下方 fail-closed 仍显水印
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
    return { ...s, rate: s.lab > 0 ? s.gm / s.lab : 0 }
  }, [rows])

  if (!canAccess('cost_analysis', 'R')) {
    return <EmptyState icon={Wallet} title="无权限访问" description="医院盈利看板需要成本分析(查看)权限" />
  }

  const selectedName = rows.find((r) => r.partnerId === selected)?.partnerName || ''
  // 止损执法点（LEG-2）：只有后端明确回 ratified===true 才免水印；null/未认账一律显示（fail-closed）。
  const showWatermark = ratification?.ratified !== true

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

      {/* P-2 口径迁移横幅：本页是旧视图，正迁移到新的院级贡献毛利看板；当前排序仅供浏览、不评判客户优劣 */}
      <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 shadow-sm">
        <Info className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
        <p className="text-[13px] leading-relaxed text-slate-600">
          本页的盈利算法正在升级到新版看板。当前表格按毛利从高到低排列，仅供浏览参考，
          <span className="font-medium text-slate-700">不代表对某家医院客户好坏的评判</span>；请勿据此单独对某家客户做去留决定。
        </p>
      </div>

      {/* 止损执法点（LEG-2）：拆分口径未认账水印——与实验室收入/毛利数字同视线、强制显示、不可折叠隐藏。 */}
      {showWatermark && (
        <div data-testid="split-caliber-watermark"
          className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 shadow-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
          <p className="text-[13px] leading-relaxed text-amber-900">
            <span className="font-semibold">口径未经业务认账。</span>
            本页的<span className="font-medium">实验室收入</span>与<span className="font-medium">院级毛利</span>，由一个尚未经业务方认账的拆分口径推算得出
            （对外<span className="font-medium">可能显著高估约 2 倍</span>）——仅供内部参考，
            <span className="font-medium">不得作为对外披露、结算或谈判的单独依据</span>，导出前请保留本口径声明。
            {ratification?.basisVersion && <span className="text-amber-700">（口径版本 {ratification.basisVersion}）</span>}
          </p>
        </div>
      )}

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
            <Kpi icon={Building2} label="合作医院" value={String(rows.length)} sub={serviceMonth || '全部账期'} />
            <Kpi icon={Receipt} label="财务实收" value={yuan(kpi.net)} sub={serviceMonth || '全部账期'} />
            <Kpi icon={Landmark} label="实验室收入" value={yuan(kpi.lab)} sub="计入实验室的结算额" />
            <Kpi icon={Wallet} label="核算成本" value={yuan(kpi.cost)} sub="按医院汇总" />
            <Kpi icon={TrendingUp} label="院级毛利" value={yuan(kpi.gm)} sub={`毛利率 ${pct(kpi.rate)}`} />
          </div>

          {/* 院级 P&L 表 */}
          <div className={cn(CARD, 'overflow-hidden')}>
            <div className="flex items-center px-4 py-3 border-b border-slate-100">
              <h2 className={cn('text-sm font-semibold', INK)}>院级盈亏 · 按毛利从高到低</h2>
              {showWatermark && (
                <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 border border-amber-300 bg-amber-50 px-2 py-0.5 rounded-full"
                  title="本表实验室收入/毛利来自未经业务认账的拆分口径，可能显著高估，不得单独作为对外依据">
                  <AlertTriangle className="w-3 h-3" /> 口径未认账
                </span>
              )}
              <div className="ml-auto flex items-center gap-3 text-xs">
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
                    return (
                      <tr key={r.partnerId} onClick={() => pickPartner(r.partnerId)}
                        role="button" tabIndex={0} aria-label={`查看 ${r.partnerName || r.partnerId} 月度趋势`}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickPartner(r.partnerId) } }}
                        className={cn('border-t border-slate-50 cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3b82f6]/50 hover:bg-slate-50',
                          selected === r.partnerId && 'ring-1 ring-inset ring-[#3b82f6]/30 bg-[#3b82f6]/[0.04]')}>
                        <td className={cn('px-4 py-3 font-medium', INK)}>{r.partnerName || r.partnerId}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{yuan(r.netRevenueTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{yuan(r.labRevenueTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-400">{r.diagnosisRevenueTotal > 0 ? yuan(r.diagnosisRevenueTotal) : '—'}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{r.costMatched ? yuan(r.costTotal) : <span className="text-amber-600">未接通</span>}</td>
                        <td className={cn('px-4 py-3 text-right font-medium', INK)}>{r.grossMargin < 0 ? '−' : '+'}{yuan(Math.abs(r.grossMargin)).slice(1)}</td>
                        <td className="px-4 py-3 text-right font-medium text-slate-600">{pct(r.marginRate)}</td>
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
              <h2 className={cn('text-sm font-semibold mb-3', INK)}>待复核病例（毛利为负）</h2>
              {flagged.length === 0 ? (
                <div className="h-[260px] flex items-center justify-center text-sm text-slate-400">本期无毛利为负的病例</div>
              ) : (
                <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                  {flagged.map((c) => (
                    <div key={c.caseNo + c.serviceMonth} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-100">
                      <div className="min-w-0">
                        <div className={cn('text-[13px] font-medium truncate', INK)}>{c.caseNo}</div>
                        <div className="text-[11px] text-slate-500 truncate">{c.partnerName}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={cn('text-[13px] font-medium tabular-nums', INK)}>−{yuan(Math.abs(c.grossMargin)).slice(1)}</div>
                        <div className="text-[11px] text-slate-400 tabular-nums">{pct(c.marginRate)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <p className="text-xs text-slate-400 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" /> 实验室收入 = 对账单里计入实验室的项目结算额之和；无对账单的病例按经验占比估算（标「估算」），账单到位即校正。本页毛利为迁移期参考值。
          </p>
        </>
      )}
    </div>
  )
}

// P-2：Kpi 原有 valueColor/subColor（曾承载「院级毛利变红 / 负毛利家数红色计数」的账户级好坏框定）已随中性化
// 全部下线；这里一并删除这两个 prop，从机制上杜绝「一行改回即复活颜色点名」的入口（值恒 INK、副标题恒中性灰）。
function Kpi({ icon: Icon, label, value, sub }: {
  icon: any; label: string; value: string; sub: string
}) {
  return (
    <div className={cn(CARD, 'p-4')}>
      <div className="flex items-center gap-1.5 text-xs text-slate-400"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className={cn('text-[22px] font-semibold tracking-tight mt-2 tabular-nums', INK)}>{value}</div>
      <div className="text-[11px] mt-1.5 text-slate-400">{sub}</div>
    </div>
  )
}
