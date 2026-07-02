// 账实核对三页共享：格式化（万元/中文日期，说人话）+ 状态药丸 + 设计令牌类。
import type { HmStatus, MatchStatus, SupplementStatus } from '@/types/account-reconcile'

/** 大额/看板用万元（¥82.4万元）。 */
export function wan(n: number | null | undefined): string {
  const v = Number(n) || 0
  return `${(v / 10000).toFixed(2)}万元`
}

/** 逐单/逐差异小额用元（¥1,020）。 */
export function yuan(n: number | null | undefined): string {
  const v = Number(n) || 0
  return `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

/** 匹配率百分比（96%）。 */
export function pct(n: number | null | undefined): string {
  return `${Math.round((Number(n) || 0) * 100)}%`
}

/** ISO / 'YYYY-MM-DD ...' → 中文日期「6月28日」。 */
export function cnDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return String(iso)
  return `${Number(m[2])}月${Number(m[3])}日`
}

/** 'YYYY-MM' → 中文月份「2026年6月」。 */
export function cnMonth(ym: string | null | undefined): string {
  if (!ym) return '—'
  const m = String(ym).match(/(\d{4})-(\d{2})/)
  if (!m) return String(ym)
  return `${m[1]}年${Number(m[2])}月`
}

// —— 设计令牌类（沿用 COREONE 现有系统：Inter / blue-500 / rounded-md / border-gray-200 / h-10）——
export const btnCls =
  'inline-flex h-10 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:ring-[3px] focus-visible:ring-blue-500/10 focus-visible:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50'
export const btnPri =
  'inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-blue-600 focus-visible:ring-[3px] focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50'
export const btnGhost =
  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50'
export const cardCls = 'rounded-lg border border-gray-200 bg-white'
export const selectCls =
  'h-9 rounded-md border border-gray-200 bg-white px-2.5 text-[13px] font-medium text-gray-900 outline-none transition-colors focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50'

const pillBase = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap'
const dot = 'h-1.5 w-1.5 rounded-full'

const HM_META: Record<HmStatus, { cls: string; dotCls: string }> = {
  待复核: { cls: 'bg-amber-50 text-amber-700', dotCls: 'bg-amber-500' },
  复核完成: { cls: 'bg-green-50 text-green-700', dotCls: 'bg-green-600' },
  已关账: { cls: 'bg-slate-100 text-slate-600', dotCls: 'bg-slate-500' },
}
const SUP_META: Record<SupplementStatus, { cls: string; dotCls: string }> = {
  待补收: { cls: 'bg-amber-50 text-amber-700', dotCls: 'bg-amber-500' },
  已补收: { cls: 'bg-green-50 text-green-700', dotCls: 'bg-green-600' },
  已放弃: { cls: 'bg-slate-100 text-slate-600', dotCls: 'bg-slate-500' },
}

export function HmPill({ status }: { status: HmStatus }) {
  const m = HM_META[status] ?? HM_META['待复核']
  return (
    <span className={`${pillBase} ${m.cls}`}>
      <span className={`${dot} ${m.dotCls}`} />
      {status}
    </span>
  )
}

export function SupPill({ status }: { status: SupplementStatus }) {
  const m = SUP_META[status] ?? SUP_META['待补收']
  return (
    <span className={`${pillBase} ${m.cls}`}>
      <span className={`${dot} ${m.dotCls}`} />
      {status}
    </span>
  )
}

/** 匹配率状态 → 颜色 + 括注（说人话，匹配偏低（仅参考）/ 先查（不出结论））。 */
export function matchStatusMeta(s: MatchStatus | null): { color: string; tag: string } {
  switch (s) {
    case '正常':
      return { color: 'text-green-600', tag: '正常' }
    case '匹配偏低':
      return { color: 'text-amber-600', tag: '匹配偏低（仅参考）' }
    case '先查':
      return { color: 'text-red-600', tag: '先查（不出结论）' }
    default:
      return { color: 'text-gray-400', tag: '待对齐' }
  }
}
