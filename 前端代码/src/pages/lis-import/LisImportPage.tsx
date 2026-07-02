import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Upload, FileSpreadsheet, Database, Loader2, ShieldCheck, AlertTriangle, CheckCircle2, Building2 } from 'lucide-react'
import { lisCasesApi, type LisCaseRow, type LisPreview } from '@/api/lis-cases'
import { readGrid, btnCls, btnPri } from '@/pages/import-shared/ImportShared'
import type { Grid } from '@/api/statement-import'

// —— 隐私最小化（codex HIGH-2 教训）：LIS 导出含大量患者 PII（姓名/证件/诊断/病史…），
//    但拆分口径只需工作量+医院路由。**只白名单下列列**，其余（姓名/性别/年龄/MRN/临床诊断/病史/大体…）
//    在浏览器解析时即丢弃，绝不进请求体、绝不落库。——
const LIS_KEEP_COLS = [
  '病理号', '送检医院', '缴费方式', '病例状态', '登记时间', '接收时间',
  'HE切片数', '蜡块数', '免疫组化数', '特染数', 'EBER数', 'PD-L1数',
  '送检部位', '亚专科', // 供后端自动判样本类型（组织/细胞）
]
const DROPPED_HINT = '姓名 / 性别 / 年龄 / 证件 / 住院号(MRN) / 病史 / 临床诊断 / 病理诊断 / 大体描述'
const CHUNK = 1000 // 后端单批上限，超过分批

/** grid → 最小化 case 对象数组（只保留白名单列 + 有病理号的行）。 */
function toMinimalCases(grid: Grid): LisCaseRow[] {
  if (!grid.length) return []
  const header = grid[0].map((h) => String(h ?? '').trim())
  const idx: Record<string, number> = {}
  for (const name of LIS_KEEP_COLS) { const i = header.indexOf(name); if (i >= 0) idx[name] = i }
  const caseCol = idx['病理号']
  if (caseCol == null) return [] // 无病理号列 = 不是 LIS 导出
  const out: LisCaseRow[] = []
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r]
    if (!String(row[caseCol] ?? '').trim()) continue // 跳过无病理号行（空行/汇总）
    const o: LisCaseRow = {}
    for (const [name, i] of Object.entries(idx)) o[name] = row[i] as string | number | null
    out.push(o)
  }
  return out
}

function chunk<T>(arr: T[], size: number): T[][] {
  const cs: T[][] = []
  for (let i = 0; i < arr.length; i += size) cs.push(arr.slice(i, i + size))
  return cs
}

export default function LisImportPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  const [cases, setCases] = useState<LisCaseRow[] | null>(null)
  const [preview, setPreview] = useState<LisPreview | null>(null)
  const [done, setDone] = useState<{ imported: number; partnersCreated: number; partnersMatched: number } | null>(null)
  const [err, setErr] = useState('')

  const blockCoverage = cases ? cases.filter((c) => Number(c['蜡块数']) > 0).length : 0

  async function onFile(f: File) {
    setBusy(true); setErr(''); setPreview(null); setDone(null); setCases(null); setFileName(f.name)
    try {
      const grid = await readGrid(f)
      const mc = toMinimalCases(grid)
      if (!mc.length) { setErr('未识别到「病理号」列——请确认是 LIS「病例导出文档」原样表。'); return }
      setCases(mc)
      // 分批预览，聚合
      const parts = chunk(mc, CHUNK)
      const agg: LisPreview = { valid: 0, skipped: 0, hospitalCount: 0, newHospitals: [], specimenDistribution: { tissue: 0, tissue_complex: 0, cytology: 0 }, warnings: [] }
      const hosp = new Set<string>(); const newHosp = new Set<string>()
      for (const p of parts) {
        const r = await lisCasesApi.preview(p)
        agg.valid += r.valid; agg.skipped += r.skipped
        r.newHospitals.forEach((n) => newHosp.add(n))
        ;(['tissue', 'tissue_complex', 'cytology'] as const).forEach((k) => { agg.specimenDistribution[k] += r.specimenDistribution[k] })
      }
      mc.forEach((c) => { const n = String(c['送检医院'] ?? '').trim(); if (n) hosp.add(n) })
      agg.hospitalCount = hosp.size; agg.newHospitals = [...newHosp]
      setPreview(agg)
    } catch (e: any) { setErr(e?.response?.data?.error?.message || e?.message || '解析失败') } finally { setBusy(false) }
  }

  async function doImport() {
    if (!cases) return
    setBusy(true); setErr('')
    try {
      const parts = chunk(cases, CHUNK)
      let imported = 0, partnersCreated = 0; const matched = new Set<string>()
      for (const p of parts) {
        const r = await lisCasesApi.import(p)
        imported += r.imported; partnersCreated += r.partnersCreated
      }
      cases.forEach((c) => { const n = String(c['送检医院'] ?? '').trim(); if (n) matched.add(n) })
      setDone({ imported, partnersCreated, partnersMatched: matched.size })
      setPreview(null)
      toast.success(`已导入 ${imported} 例 LIS 病例`)
    } catch (e: any) { setErr(e?.response?.data?.error?.message || e?.message || '导入失败') } finally { setBusy(false) }
  }

  function reset() { setCases(null); setPreview(null); setDone(null); setFileName(''); setErr('') }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-blue-500" />
          <h1 className="text-[18px] font-semibold text-gray-900">LIS 病例导入</h1>
          <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11.5px] text-gray-500"><ShieldCheck className="h-3 w-3" />管理员 / 财务</span>
        </div>
        <p className="mt-1 text-[12.5px] text-gray-500">上传 LIS「病例导出文档」，系统按病理号记录每例的<b className="text-gray-700">蜡块数</b>等工作量——月度对账单拆分「制片/诊断」时按真蜡块精算（否则只能按账单数量估、偏下限）。</p>
      </div>

      {/* 隐私说明：白名单最小化 */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12px] text-blue-800">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>只读取<b>病理号 + 送检医院 + 工作量数量列</b>（蜡块/HE/免疫组化/特染等）。<b>{DROPPED_HINT}</b> 等患者信息在本机解析时即丢弃，不上传、不入库。</span>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnPri} disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{busy ? '处理中…' : '上传 LIS 导出文档'}
          </button>
          <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv" className="hidden" tabIndex={-1} aria-hidden="true" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
          {fileName && <span className="inline-flex items-center gap-1 text-[12px] text-gray-500"><FileSpreadsheet className="h-3.5 w-3.5" />{fileName}</span>}
          {cases && !done && <button className={btnCls} onClick={reset} disabled={busy}>重选</button>}
        </div>

        {err && <div className="mt-3 flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700"><AlertTriangle className="h-4 w-4" />{err}</div>}

        {/* 预览体检卡 */}
        {preview && cases && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="有效病例" value={`${preview.valid}`} sub={preview.skipped ? `跳过 ${preview.skipped}` : '无跳过'} />
              <Stat label="有蜡块数" value={`${blockCoverage}`} sub={`占 ${preview.valid ? Math.round((blockCoverage / preview.valid) * 100) : 0}%（拆分能精算的）`} tone={blockCoverage < preview.valid ? 'warn' : 'ok'} />
              <Stat label="涉及医院" value={`${preview.hospitalCount}`} sub={preview.newHospitals.length ? `新建 ${preview.newHospitals.length} 家` : '均已存在'} tone={preview.newHospitals.length ? 'warn' : 'ok'} />
              <Stat label="样本类型" value={`${preview.specimenDistribution.tissue + preview.specimenDistribution.tissue_complex}/${preview.specimenDistribution.cytology}`} sub="组织 / 细胞" />
            </div>
            {preview.newHospitals.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>将新建医院：{preview.newHospitals.slice(0, 6).join('、')}{preview.newHospitals.length > 6 ? ` 等 ${preview.newHospitals.length} 家` : ''}（默认仅技术口径，可在「合作医院配置」调整）</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-gray-400">{cases.length > CHUNK ? `共 ${cases.length} 行，将分 ${Math.ceil(cases.length / CHUNK)} 批导入` : `共 ${cases.length} 行`}</span>
              <button className={btnPri} onClick={doImport} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}确认导入</button>
            </div>
          </div>
        )}

        {/* 完成 */}
        {done && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-center">
            <CheckCircle2 className="mx-auto mb-2 h-9 w-9 text-emerald-500" />
            <div className="text-[15px] font-semibold text-gray-900">已导入 {done.imported} 例</div>
            <div className="mt-1 text-[12.5px] text-gray-600">{done.partnersMatched} 家医院{done.partnersCreated > 0 ? `（新建 ${done.partnersCreated} 家）` : ''} · 之后在「财务月度导入」按真蜡块精算拆分</div>
            <button className={btnCls + ' mt-3'} onClick={reset}>再导一份</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, sub, tone = 'plain' }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'plain' }) {
  const v = tone === 'warn' ? 'text-amber-700' : tone === 'ok' ? 'text-emerald-700' : 'text-gray-900'
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2">
      <div className="text-[12px] text-gray-500">{label}</div>
      <div className={`text-[16px] font-semibold tabular-nums ${v}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </div>
  )
}
