import { useCallback, useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, XCircle, RotateCw, MinusCircle } from 'lucide-react'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import type { Grid } from '@/api/statement-import'
import type { ImportScore, ImportStatus, PreviewRevenue } from '@/types/statement-import'

// —— 共用设计令牌（主蓝 #3b82f6；按钮 h-10=项目标准）——
export const inputCls = 'h-10 rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-900 outline-none transition-colors focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10'
export const btnCls = 'inline-flex h-10 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:ring-[3px] focus-visible:ring-blue-500/10 focus-visible:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50'
export const btnPri = 'inline-flex h-10 items-center gap-1.5 rounded-md bg-blue-500 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-blue-600 focus-visible:ring-[3px] focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50'
// codex F3：金额保留 2 位小数（导入/差额/对账闭合需精确到分，Math.round 会把 ¥0.01 差额显示成 ¥0）。
export const yuan = (n: number | null | undefined) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 读 xlsx/csv File → 2D 网格（首个工作表，header:1）。 */
export async function readGrid(file: File): Promise<Grid> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as Grid
}

/** 合作医院下拉（finance/admin）。codex F7：暴露 loading/error/reload，调用方需呈现错误可重试态。 */
export function useHospitals() {
  const [hospitals, setHospitals] = useState<PartnerListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    setLoading(true); setError('')
    partnerConfigApi.partners()
      .then((r) => setHospitals(r.list || []))
      .catch((e) => setError(e?.response?.data?.error?.message || e?.message || '加载医院失败'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])
  return { hospitals, loading, error, reload: load }
}

/** 顶部操作条：选医院 + 选月份 + 上传对账单。 */
export function UploadBar({ hospitals, partnerId, onPartner, month, onMonth, onFile, busy, fileName, hospitalsLoading, hospitalsError, onReloadHospitals }: {
  hospitals: PartnerListItem[]; partnerId: string; onPartner: (id: string) => void
  month: string; onMonth: (m: string) => void; onFile: (f: File) => void; busy?: boolean; fileName?: string
  hospitalsLoading?: boolean; hospitalsError?: string; onReloadHospitals?: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-gray-500">合作医院</span>
        <select className={inputCls + ' w-56'} value={partnerId} onChange={(e) => onPartner(e.target.value)} disabled={!!hospitalsError} aria-label="合作医院">
          <option value="">{hospitalsLoading ? '加载中…' : '选择医院…'}</option>
          {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-gray-500">账期</span>
        <input type="month" className={inputCls + ' tabular-nums'} value={month} onChange={(e) => onMonth(e.target.value)} aria-label="账期" />
      </label>
      {/* codex F4：上传入口改可聚焦按钮触发隐藏 input，键盘可达（原 label 包 display:none input 不进 Tab 顺序）。 */}
      <button type="button" className={btnPri} disabled={busy} onClick={() => fileRef.current?.click()}>
        <Upload className="h-4 w-4" />{busy ? '解析中…' : '上传对账单'}
      </button>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" tabIndex={-1} aria-hidden="true" disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
      {fileName && <span className="inline-flex items-center gap-1 text-[12px] text-gray-500"><FileSpreadsheet className="h-3.5 w-3.5" />{fileName}</span>}
      {/* codex F7：医院列表加载失败显式可重试，不再静默成空下拉 */}
      {hospitalsError && (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-rose-600">
          <AlertTriangle className="h-3.5 w-3.5" />{hospitalsError}
          {onReloadHospitals && (
            <button type="button" onClick={onReloadHospitals} className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline">
              <RotateCw className="h-3 w-3" />重试
            </button>
          )}
        </span>
      )}
    </div>
  )
}

const STATUS_META: Record<ImportStatus, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  ready: { label: '已核对·可设基线', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
  review: { label: '全部通过·待人工核对', cls: 'bg-blue-50 text-blue-700 border-blue-200', icon: CheckCircle2 },
  todo: { label: '有待处理项', cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: AlertTriangle },
}

function Check({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  // null = 未启用/无数据的中性态（灰圆点，不是警告）——可选项每月都黄会训练用户忽略状态（告警疲劳）
  const Icon = ok === true ? CheckCircle2 : ok === false ? XCircle : MinusCircle
  const color = ok === true ? 'text-emerald-600' : ok === false ? 'text-rose-600' : 'text-gray-300'
  return (
    <div className="flex items-start gap-2 rounded-md border border-gray-200 bg-white p-3">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-gray-800">{label}</div>
        <div className="text-[12px] text-gray-500">{detail}</div>
      </div>
    </div>
  )
}

/** 收入分桶小卡：实验室收入（主）/ 诊断与报告 / 外送转出 / 未识别。 */
function Bucket({ label, value, tone = 'plain', hint }: { label: string; value: number; tone?: 'primary' | 'plain' | 'warn'; hint?: string }) {
  const cls = tone === 'primary' ? 'border-blue-200 bg-blue-50' : tone === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'
  const val = tone === 'primary' ? 'text-blue-700' : tone === 'warn' ? 'text-amber-700' : 'text-gray-900'
  return (
    <div className={`rounded-md border px-3 py-2 ${cls}`} title={hint}>
      <div className="text-[12px] text-gray-500">{label}</div>
      <div className={`text-[15px] font-semibold tabular-nums ${val}`}>{yuan(value)}</div>
    </div>
  )
}

/** 体检卡：收入三分（实验室/诊断报告/外送）+ 完整度提示 + 识别率/对账闭合/病例匹配/黄金 + status + 未过项。 */
export function ScoreCard({ score, revenue }: { score: ImportScore; revenue: PreviewRevenue }) {
  const m = STATUS_META[score.status]
  const r = score.recognition, cl = score.closure, fwd = score.caseMatch.forward, bwd = score.caseMatch.backward, g = score.golden
  const unrecognized = (revenue.unmatchedSettle || 0) + (revenue.ambiguousSettle || 0)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium ${m.cls}`}><m.icon className="h-3.5 w-3.5" />{m.label}</span>
        <span className="text-[12px] text-gray-400">对账单实收合计 <b className="tabular-nums text-gray-600">{yuan(revenue.totalSettle)}</b>（= 下列各项之和，不漏不重）</span>
      </div>
      {/* 收入三分：实验室收入是我们做的技术工序；诊断报告是我们收但非实验室工序；外送转出是转出去的 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Bucket label="实验室收入" value={revenue.labRevenue} tone="primary" hint="整条计入的染色 + 拆分出的制片份额" />
        <Bucket label="诊断与报告" value={revenue.diagnosisSettle} hint="医生诊断 / 报告 / 现场服务——我们收但非实验室工序" />
        <Bucket label="外送转出" value={revenue.outSettle} hint="外送 NGS/FISH、远程、共建分成——非我们的实验室" />
        {unrecognized > 0 && <Bucket label="未识别待归类" value={unrecognized} tone="warn" hint="未匹配 + 歧义，需在测试台补识别规则" />}
      </div>
      {/* 完整度：拆分依赖 LIS 蜡块，缺则降级账单数量估算，如实标注 */}
      {revenue.splitLisMissing > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[12px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>本期 {revenue.splitLisMissing}/{revenue.splitLisExpected} 例组织制片缺 LIS 蜡块数，已按账单数量估算（口径偏下限）。补导该院 LIS 后<b>重新导入本对账单</b>即可更新。</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Check ok={r.pass} label={`识别率 ${(r.rate * 100).toFixed(0)}%`} detail={`${r.matched}/${r.total} 行；未匹配 ${r.unmatched}、歧义 ${r.ambiguous}`} />
        <Check ok={cl.pass} label="对账闭合" detail={cl.declaredTotal == null ? '对账单无独立合计行' : `逐行 ${yuan(cl.computed)} vs 声明 ${yuan(cl.declaredTotal)}${cl.diff ? `，差 ${yuan(cl.diff)}` : '·对平'}`} />
        <Check ok={fwd.pass} label="病例匹配" detail={fwd.pass == null ? '该院未导 LIS，无法核对（不阻断）' : `命中 ${fwd.matched}/${fwd.withCaseNo}（对该院全部 LIS）${bwd.missingFromStatement ? `；本期 LIS 另有 ${bwd.missingFromStatement} 例未覆盖` : ''}`} />
        <Check ok={g.pass} label="黄金值（可选）" detail={g.expected == null ? '未启用——可录入期望实收作外部核对' : `算出 ${yuan(g.computed)} vs 期望 ${yuan(g.expected)}${g.diff ? `，差 ${yuan(g.diff)}` : '·符'}`} />
      </div>
      {score.failures.length > 0 && (
        <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-800">
          {score.failures.map((f, i) => <li key={i}>· {f}</li>)}
        </ul>
      )}
    </div>
  )
}
