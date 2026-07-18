/**
 * 第 2 层 · 各医院对照表（要看单家时）——绝对贡献 + 率 + 趋势**并列**·系统不排名/不打分/不自动生成清单。
 *
 * 硬规格（防「人眼自己排名」把误伤从算法搬进人脑）+ 11 条诚实元素里归本表的：
 *   ① 「排序≠评判」常显（非 tooltip）  ② 率旁并列「占固定成本覆盖份额」  ③ 趋势只用同账户历史
 *   ⑧ UNMEASURED 账户（有账单但无染色）以灰行+原因出现·缩小盲区（边界=仅覆盖有账单流水的院·脚注诚实披露）
 *   ⑨ 趋势线口径变更标（琥珀点·已实现）+ 历史失真月标（待数据信号接入·脚注诚实标注·说明常显）
 *   ⑩ 「观察中·暂不出判定」态（可测但未过数据质量门 → 徽标而非自信数字）
 *   缺省排序 = 绝对贡献降序（顶梁柱在顶）·用户可自选任意列重排（含按率·禁令针对系统提名、不针对人的分析自由）。
 */
import { useMemo, useState } from 'react'
import { ArrowUpDown, Download, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComparisonRow, CaliberRatification, TrendPoint } from '@/types/hospital-cm'
import { exportComparisonCsv } from './exportComparison'

const isKnownNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const yuan = (n: number) => isKnownNumber(n) ? `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '不可计算'
const pct = (r: number) => isKnownNumber(r) ? `${(r * 100).toFixed(1)}%` : '—'

type SortKey = 'cm' | 'cmRate' | 'fixedCoverageShare' | 'partnerName'
const MIN_TREND_POINTS = 3 // 与就绪 N=3 一致：分辨趋势方向 vs 噪声至少 3 点

/** 迷你趋势（同账户历史·③）；口径变更月画点（⑨·LEG-3）。<3 点 → 趋势积累中。 */
function Sparkline({ points }: { points?: TrendPoint[] | null }) {
  if (!points || points.length < MIN_TREND_POINTS) {
    const need = Math.max(0, MIN_TREND_POINTS - (points?.length ?? 0))
    return <span className="text-[11px] text-gray-400">趋势积累中<br />还需 {need} 个月</span>
  }
  const ys = points.map((p) => p.hospitalCm)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const span = max - min || 1
  const W = 56
  const H = 16
  const step = W / (points.length - 1)
  const coords = points.map((p, i) => [i * step, H - 2 - ((p.hospitalCm - min) / span) * (H - 4)] as const)
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  // 口径变更月：与上一月 caliber 不同 → 竖标点（⑨）。
  const changeIdx = points.map((p, i) => (i > 0 && points[i - 1].caliber !== p.caliber ? i : -1)).filter((i) => i >= 0)
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="同院月度趋势">
      <polyline points={line} fill="none" stroke="#3b82f6" strokeWidth={1.6} />
      {changeIdx.map((i) => (
        <circle key={i} cx={coords[i][0]} cy={coords[i][1]} r={2} fill="#b45309">
          <title>口径变更月（{points[i].serviceMonth}·{points[i - 1].caliber}→{points[i].caliber}）</title>
        </circle>
      ))}
    </svg>
  )
}

function Th({ label, sortKey, sort, onSort, className }: {
  label: string; sortKey?: SortKey; sort: { key: SortKey; dir: 'asc' | 'desc' }; onSort: (k: SortKey) => void; className?: string
}) {
  const active = sortKey && sort.key === sortKey
  return (
    <th
      aria-sort={sortKey ? (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
      className={cn('px-3 py-2.5 text-[11.5px] font-medium text-gray-500', className)}
    >
      {sortKey ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={cn('inline-flex items-center gap-1 hover:text-gray-700', active && 'text-gray-800 font-semibold')}
          aria-label={`按${label}排序`}
        >
          {label}
          <ArrowUpDown className="h-3 w-3" />
          {active && <span className="text-[10px]">{sort.dir === 'desc' ? '↓' : '↑'}</span>}
        </button>
      ) : (
        label
      )}
    </th>
  )
}

/** ⑩ 观察中：可测但未过数据质量门（needsData / low / 观察·需补） → 徽标而非自信数字。 */
function isObserving(r: ComparisonRow): boolean {
  const d = r.detail
  if (!d) return false
  return d.quality?.needsData === true || d.confidence === 'low' || /观察|需补/.test(d.state || '')
}

export default function ComparisonTable({
  rows,
  caliber,
  periodRange,
}: {
  rows: ComparisonRow[]
  caliber?: CaliberRatification | null
  periodRange?: string
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'cm', dir: 'desc' }) // 缺省=绝对贡献降序
  const onSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: k === 'partnerName' ? 'asc' : 'desc' }))

  const sorted = useMemo(() => {
    const arr = rows.slice()
    arr.sort((a, b) => {
      if (sort.key !== 'partnerName' && a.measurable !== b.measurable) return a.measurable ? -1 : 1
      if (sort.key === 'partnerName') {
        const d = (a.partnerName || a.partnerId).localeCompare(b.partnerName || b.partnerId, 'zh')
        return sort.dir === 'desc' ? -d : d
      }
      const av = a[sort.key] as number | null
      const bv = b[sort.key] as number | null
      if (!isKnownNumber(av)) return !isKnownNumber(bv) ? 0 : 1
      if (!isKnownNumber(bv)) return -1
      const d = av - bv
      return sort.dir === 'desc' ? -d : d
    })
    return arr
  }, [rows, sort])

  const nonRate = sort.key === 'cmRate' // 按率排序时「排序≠评判」尤其要在场

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm" data-testid="comparison-empty">
        <div className="text-[15px] font-medium text-gray-700">本月还没有可算的院级对照数据</div>
        <div className="mx-auto mt-1.5 max-w-lg text-[13px] leading-relaxed text-gray-500">
          院级贡献毛利要三件套齐了才能算：<b>对账单</b>（实收）+ <b>工作量表</b>（片数）+ <b>抗体清单</b>（每片抗体）。
          现在这三样还没导入，所以先不显示假数字。
        </div>
      </div>
    )
  }

  return (
    <section aria-label="医院贡献毛利明细" className="rounded-xl border border-gray-200 bg-white shadow-sm" data-testid="comparison-table">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[#0a2540]">各医院对照表</h2>
        <button
          onClick={() => exportComparisonCsv(sorted, caliber, { periodRange, exportedAt: new Date().toISOString() })}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-200 px-3 text-[12px] text-gray-600 transition-colors hover:bg-gray-50"
        >
          <Download className="h-3.5 w-3.5" /> 导出（带口径声明）
        </button>
      </div>

      {/* ① 「排序≠评判」常显（非 tooltip）——按率排序时格外强调 */}
      <div
        data-testid="sort-not-verdict"
        className={cn('mx-4 mt-3 rounded-lg border px-4 py-2.5 text-[12.5px] leading-relaxed', nonRate ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50/60 text-blue-900')}
      >
        默认按「贡献毛利绝对额」从大到小排——挣得最多的顶梁柱在最上。系统<b>不排名、不打分、不自动生成谈价清单</b>；
        <b>排序≠评判</b>，请结合关系、议价力自己判断。{nonRate && '（你正按「率」排序——大额薄利的顶梁柱率低，别据此当「最差」压价。）'}
      </div>

      {/* 页面级状态横幅（D10）：CM_TARGET 未拍前不出裁决词 */}
      <div className="mx-4 mt-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-[12px] leading-relaxed text-gray-600">
        <b>全部医院：经营线未定 · 仅供观察。</b> 数字照出、可排序，但「可留 / 需谈价 / 停止候选」这类裁决词暂不出——
        等经营线（CM_TARGET）由真实院月数据校准、PM 拍板后才逐行显示。
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[13px] tabular-nums">
          <caption className="sr-only">各医院贡献毛利、覆盖份额、口径与同院趋势明细</caption>
          <thead>
            <tr className="border-b border-gray-200 text-right">
              <Th label="医院" sortKey="partnerName" sort={sort} onSort={onSort} className="text-left" />
              <Th label="贡献毛利" sortKey="cm" sort={sort} onSort={onSort} className="text-right" />
              <Th label="率" sortKey="cmRate" sort={sort} onSort={onSort} className="text-right" />
              <Th label="占全组份额" sortKey="fixedCoverageShare" sort={sort} onSort={onSort} className="text-right" />
              <Th label="口径" sort={sort} onSort={onSort} className="text-right" />
              <Th label="近几月趋势（同院）" sort={sort} onSort={onSort} className="text-right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const observing = r.measurable && isObserving(r)
              if (!r.measurable) {
                // ⑧ UNMEASURED：灰行 + 原因（缺席=被读成不存在·盲区消失）
                return (
                  <tr key={r.partnerId} data-testid="unmeasured-row" className="border-b border-gray-100 bg-gray-50/60 text-right text-gray-400 [content-visibility:auto] [contain-intrinsic-size:auto_48px]">
                    <td className="px-3 py-3 text-left font-medium">{r.partnerName || r.partnerId}</td>
                    <td className="px-3 py-3" colSpan={5}>
                      <span className="inline-flex items-center gap-1 text-[12px]">
                        <Info className="h-3.5 w-3.5" /> 未测量（有对账单流水但无进率染色病例·多为代送/会诊/外送）——不参与贡献毛利判断，在此列出以缩小盲区。
                      </span>
                    </td>
                  </tr>
                )
              }
              return (
                <tr key={r.partnerId} className="border-b border-gray-100 text-right [content-visibility:auto] [contain-intrinsic-size:auto_48px]">
                  <td className="px-3 py-3 text-left font-medium text-gray-900">{r.partnerName || r.partnerId}</td>
                  <td className="px-3 py-3 font-semibold text-[#0a2540]">
                    {observing ? (
                      <span className="font-normal text-gray-400" data-testid="observing-badge">观察中·暂不出判定</span>
                    ) : r.cm == null ? (
                      <span className="font-normal text-gray-400">不可计算</span>
                    ) : yuan(r.cm)}
                  </td>
                  <td className="px-3 py-3 text-gray-700">
                    {observing || r.cmRate == null ? '—' : (
                      <>
                        {pct(r.cmRate)}
                        {/* 率覆盖技术收入占比：<全院时警示（率不代表全院） */}
                        {r.detail && r.detail.quality.lineCoverage < 0.6 ? (
                          <div className="text-[10.5px] text-amber-700">率仅覆盖 {pct(r.detail.quality.lineCoverage)} 技术收入·不代表全院</div>
                        ) : r.detail ? (
                          <div className="text-[10.5px] text-gray-400">率覆盖技术收入 {pct(r.detail.quality.lineCoverage)}</div>
                        ) : null}
                      </>
                    )}
                  </td>
                  {/* ② 占全组固定成本覆盖份额（率旁并列）。⑩ 观察中行不露份额——它由被隐藏的 cm 派生，露出=泄漏未过门数字。 */}
                  <td className="px-3 py-3 text-gray-600">
                    {observing || r.fixedCoverageShare == null ? '—' : pct(r.fixedCoverageShare)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="inline-block rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10.5px] text-gray-600">
                      {r.detail?.caliber ?? '仅染色'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end">
                      <Sparkline points={r.trendPoints} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 顶梁柱说明（说人话·不点名·防「率最低=最差」误读） */}
      <div className="m-4 rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 text-[12.5px] leading-relaxed text-blue-900">
        <b>为什么按绝对额排、不按率排？</b> 「大额薄利」的顶梁柱贡献毛利绝对额最大、率却可能最低；按率把它当「最差」去压价，
        谈崩了它扛的那份固定开销没人分摊（死亡螺旋）。所以默认按绝对额排、系统不自动点名。
        （「顶梁柱」是性质、须待产能费实测才能盖章；绝对贡献最大 ≠ 一定健康，故系统不自动贴标。）
      </div>

      {/* ③⑨ 口径 + 趋势脚注（说明常显·防口径切换/历史污染被读成业务波动·诚实标注实现边界） */}
      <p className="m-4 mt-0 text-[11px] leading-relaxed text-gray-400">
        趋势用<b>该院自己的历史</b>（同账户·非跨院对比）。趋势线上<b>口径变更月</b>已以标点提示（琥珀点）；
        <b>历史成本失真月的标注尚待数据信号接入</b>（当前仅标口径变更月）——在此之前，口径切换/历史污染仍可能被读成业务波动，请留意。
        一旦有院变「完整」口径，混口径的率不可直接比，届时会分组/警示。<br />
        <b>覆盖边界</b>：本表只含<b>有对账单流水</b>的院（上方灰行=有账单但无染色病例）；<b>从不走账单管道的纯代送/会诊院不在此列</b>——是当前数据面边界、非「已消除盲区」。<br />
        后视镜口径（导入天然滞后 1–3 月，不反映当下）；缺价暴露、约定价估值占比随行显示供判断可信度。
      </p>
    </section>
  )
}
