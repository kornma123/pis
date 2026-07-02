import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Upload, FileSpreadsheet, Loader2, ArrowLeft, ShieldCheck, AlertTriangle, CheckCircle2, Building2, Trash2, FlaskConical, Layers } from 'lucide-react'
import { lisCasesApi, type LisRow, type LisBatch } from '@/api/lis-cases'
import { readGrid, btnCls, btnPri } from '@/pages/import-shared/ImportShared'
import type { Grid } from '@/api/statement-import'

// 隐私最小化：只白名单这些列，其余（姓名/证件/诊断/病史…）在本机解析时即丢弃，绝不上传/落库。
const CASE_COLS = ['病理号', '送检医院', '缴费方式', '病例状态', '登记时间', '接收时间', 'HE切片数', '蜡块数', '免疫组化数', '特染数', 'EBER数', 'PD-L1数', '送检部位', '亚专科']
const MARKER_COLS = ['病理号', 'caseNo', 'markerName', '抗体名', 'adviceType', 'waxNo', 'sectionNo']
const CHUNK = 150 // 单批 ≤ 后端 100kb body 限（1000 行≈207KB 会 413）

type Kind = 'case' | 'marker' | 'unknown'
interface ParsedFile { name: string; kind: Kind; rows: LisRow[] }

function extract(grid: Grid, cols: string[], keyCol: string): LisRow[] {
  if (!grid.length) return []
  const header = grid[0].map((h) => String(h ?? '').trim())
  const idx: Record<string, number> = {}
  for (const name of cols) { const i = header.indexOf(name); if (i >= 0) idx[name] = i }
  const kc = idx[keyCol]
  if (kc == null) return []
  const out: LisRow[] = []
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r]
    if (!String(row[kc] ?? '').trim()) continue
    const o: LisRow = {}
    for (const [name, i] of Object.entries(idx)) o[name] = row[i] as string | number | null
    out.push(o)
  }
  return out
}

/** 按列识别文件类型：有抗体名列=抗体清单；有病理号+数量列=工作量表；都不是=认不出。 */
function detect(grid: Grid): ParsedFile['kind'] {
  const header = new Set((grid[0] || []).map((h) => String(h ?? '').trim()))
  if (header.has('markerName') || header.has('抗体名')) return 'marker'
  if (header.has('病理号') && (header.has('蜡块数') || header.has('免疫组化数') || header.has('HE切片数'))) return 'case'
  return 'unknown'
}

function chunk<T>(a: T[], s: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += s) o.push(a.slice(i, i + s)); return o }

interface ImportSummary {
  caseInserted: number; caseUpdated: number; caseSkipped: number; hospitals: number; newHospitals: string[]
  markerImported: number; markerCases: number; markerUnmatched: number
}

export default function LisImportView({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<ParsedFile[]>([])
  const [err, setErr] = useState('')
  const [done, setDone] = useState<ImportSummary | null>(null)
  const [batches, setBatches] = useState<LisBatch[]>([])

  useEffect(() => { lisCasesApi.batches(3).then(setBatches).catch(() => { /* 历史批次拿不到不阻断 */ }) }, [done])

  async function addFiles(list: FileList) {
    setBusy(true); setErr(''); setDone(null)
    try {
      const next: ParsedFile[] = []
      for (const f of Array.from(list)) {
        const grid = await readGrid(f)
        const kind = detect(grid)
        const rows = kind === 'case' ? extract(grid, CASE_COLS, '病理号')
          : kind === 'marker' ? extract(grid, MARKER_COLS, header0(grid).has('病理号') ? '病理号' : 'caseNo')
          : []
        next.push({ name: f.name, kind, rows })
      }
      setFiles((prev) => [...prev, ...next])
    } catch (e: any) { setErr(e?.message || '解析失败') } finally { setBusy(false) }
  }

  const caseRows = files.filter((f) => f.kind === 'case').flatMap((f) => f.rows)
  const markerRows = files.filter((f) => f.kind === 'marker').flatMap((f) => f.rows)
  const unknownFiles = files.filter((f) => f.kind === 'unknown')
  const canImport = files.length > 0 && (caseRows.length > 0 || markerRows.length > 0)

  async function doImport() {
    setBusy(true); setErr('')
    const sum: ImportSummary = { caseInserted: 0, caseUpdated: 0, caseSkipped: 0, hospitals: 0, newHospitals: [], markerImported: 0, markerCases: 0, markerUnmatched: 0 }
    try {
      // 先工作量表（建立 病理号→医院），再抗体表（靠病理号挂医院）
      const hosp = new Set<string>()
      for (const p of chunk(caseRows, CHUNK)) {
        const r = await lisCasesApi.import(p)
        sum.caseInserted += r.inserted; sum.caseUpdated += r.updated; sum.caseSkipped += r.skipped
      }
      caseRows.forEach((c) => { const n = String(c['送检医院'] ?? '').trim(); if (n) hosp.add(n) })
      sum.hospitals = hosp.size
      for (const p of chunk(markerRows, CHUNK)) {
        const r = await lisCasesApi.importMarkers(p)
        sum.markerImported += r.imported; sum.markerCases += r.casesAffected; sum.markerUnmatched += r.unmatched
      }
      setDone(sum); setFiles([])
      toast.success('导入完成')
    } catch (e: any) {
      const base = e?.response?.data?.error?.message || e?.message || '导入失败'
      setErr(`${base}。已入库的部分不会丢（幂等），重新导入整份文件可安全续导。`)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <button className={btnCls} onClick={onBack}><ArrowLeft className="h-4 w-4" />返回列表</button>
        <h1 className="text-[18px] font-semibold text-gray-900">导入 LIS 病例</h1>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12px] text-blue-800">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>可一次拖入多张表，系统自动分「工作量表」和「抗体清单」。只读病理号、送检医院、各项数量和抗体名；姓名、证件、诊断这些患者信息在你电脑上就丢掉了，不上传、不入库。漏了数据随时再传一张，导过的会自动更新、不重复。</span>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnPri} disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{busy ? '解析中…' : '选择文件（可多张）'}
          </button>
          <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv" multiple className="hidden" tabIndex={-1} aria-hidden="true" disabled={busy}
            onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
          {files.length > 0 && !done && <button className={btnCls} onClick={() => { setFiles([]); setErr('') }} disabled={busy}>清空</button>}
        </div>

        {err && <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{err}</div>}

        {/* 已选文件 + 识别结果 */}
        {files.length > 0 && (
          <div className="mt-4 space-y-2">
            {files.map((f, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-[12.5px]">
                <span className="inline-flex items-center gap-2 text-gray-700"><FileSpreadsheet className="h-4 w-4 text-gray-400" />{f.name}</span>
                <span className="inline-flex items-center gap-3">
                  {f.kind === 'case' && <span className="inline-flex items-center gap-1 text-blue-700"><Layers className="h-3.5 w-3.5" />工作量表 · {f.rows.length} 例</span>}
                  {f.kind === 'marker' && <span className="inline-flex items-center gap-1 text-violet-700"><FlaskConical className="h-3.5 w-3.5" />抗体清单 · {f.rows.length} 条</span>}
                  {f.kind === 'unknown' && <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />认不出，将忽略</span>}
                  <button className="text-gray-400 hover:text-rose-600" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} aria-label="移除"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              </div>
            ))}
            {unknownFiles.length > 0 && <div className="text-[12px] text-amber-700">· {unknownFiles.length} 个文件没认出是工作量表还是抗体清单，导入时会跳过。</div>}
            <div className="flex items-center justify-between pt-1">
              <span className="text-[12px] text-gray-400">合计 {caseRows.length} 例工作量 · {markerRows.length} 条抗体</span>
              <button className={btnPri} onClick={doImport} disabled={busy || !canImport}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}确认导入</button>
            </div>
          </div>
        )}

        {/* 完成回执 */}
        {done && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-center gap-2 text-gray-900"><CheckCircle2 className="h-6 w-6 text-emerald-500" /><span className="text-[15px] font-semibold">导入完成</span></div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="新增病例" value={done.caseInserted} />
              <Stat label="更新病例" value={done.caseUpdated} />
              <Stat label="涉及医院" value={done.hospitals} />
              <Stat label="导入抗体" value={done.markerImported} sub={`${done.markerCases} 例`} />
            </div>
            {done.markerUnmatched > 0 && <div className="mt-2 flex items-start gap-2 text-[12px] text-amber-800"><Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />{done.markerUnmatched} 例抗体的病理号在工作量表里查无，未挂医院（先把这些院的工作量表导进来，再补传抗体）。</div>}
            <div className="mt-4 flex gap-2">
              <button className={btnPri} onClick={onDone}>去看病例列表</button>
              <button className={btnCls} onClick={() => setDone(null)}>再导一份</button>
            </div>
          </div>
        )}

        {/* 最近导入 */}
        {batches.length > 0 && (
          <div className="mt-5 border-t border-gray-100 pt-4">
            <div className="mb-2 text-[12px] font-medium text-gray-500">最近导入</div>
            <div className="space-y-1.5">
              {batches.map((b) => (
                <div key={b.importBatch} className="flex items-center justify-between text-[12px] text-gray-600">
                  <span className="tabular-nums">{fmtTime(b.importedAt)}</span>
                  <span>{b.caseCount} 例 · {b.hospitalCount} 家医院{b.operatorName ? ` · ${b.operatorName}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function header0(grid: Grid): Set<string> { return new Set((grid[0] || []).map((h) => String(h ?? '').trim())) }
function fmtTime(s: string): string { if (!s) return '—'; const d = new Date(s.replace(' ', 'T') + 'Z'); return isNaN(+d) ? s : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2">
      <div className="text-[12px] text-gray-500">{label}</div>
      <div className="text-[16px] font-semibold tabular-nums text-gray-900">{value}{sub && <span className="ml-1 text-[11px] font-normal text-gray-400">{sub}</span>}</div>
    </div>
  )
}
