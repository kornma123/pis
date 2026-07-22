import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  FlaskConical,
  Loader2,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { lisCasesApi, type LisBatch, type LisPreview, type RejectionItem } from '@/api/lis-cases'
import { Modal } from '@/components/ui/Modal'
import { readGrid, btnCls, btnPri } from '@/pages/import-shared/ImportShared'
import { LisImportEvidence } from './LisImportEvidence'
import {
  aggregatePreview,
  CASE_COLS,
  chunks,
  detect,
  EMPTY_SUMMARY,
  extract,
  MARKER_COLS,
  publicError,
  type ImportEvidence,
  type Outcome,
  type ParsedFile,
} from './lisImportModel'

// #178：拒收项单行文案（类型化标签；只含安全识别字段）
function describeRejection(item: RejectionItem): string {
  if (item.code === 'CROSS_MONTH_CONFLICT') return `${item.caseNo} · ${item.partnerName} · 库中 ${item.existingMonth ?? '?'} ≠ 导入 ${item.incomingMonth ?? '?'}（同号跨月冲突）`
  if (item.code === 'INVALID_OPERATE_TIME') return `${item.caseNo} · ${item.partnerName} · 登记时间非法：${item.value ?? ''}`
  return `${item.caseNo || '（无病理号）'} · ${item.partnerName || '（无医院）'} · 缺病理号/医院，格式不完整`
}

const REJECTION_DISPLAY_LIMIT = 100

function assertReceiptCounters(receipt: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const value = receipt[field]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('回执格式不可验证')
  }
}

function neutralizeCsvFormula(value: string): string {
  let index = 0
  while (index < value.length && value.charCodeAt(index) <= 0x20) index += 1
  return '=+-@'.includes(value[index] ?? '') ? `'${value}` : value
}

export default function LisImportView({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const parseRequest = useRef(0)
  const submitLock = useRef(false)
  const [files, setFiles] = useState<ParsedFile[]>([])
  const [parsing, setParsing] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [preview, setPreview] = useState<LisPreview | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [evidence, setEvidence] = useState<ImportEvidence | null>(null)
  const [rejections, setRejections] = useState<RejectionItem[]>([]) // #178：跨 chunk 累计的 typed 拒收项（仅来自已验证 chunk）
  const [rejectedTotal, setRejectedTotal] = useState(0)
  const [rejectionsTruncated, setRejectionsTruncated] = useState(false)
  const [batches, setBatches] = useState<LisBatch[]>([])
  const [batchesLoading, setBatchesLoading] = useState(true)
  const [batchesError, setBatchesError] = useState('')

  const caseRows = useMemo(() => files.filter((file) => file.kind === 'case').flatMap((file) => file.rows), [files])
  const markerRows = useMemo(() => files.filter((file) => file.kind === 'marker').flatMap((file) => file.rows), [files])
  const unknownFiles = useMemo(() => files.filter((file) => file.kind === 'unknown'), [files])
  const locallyValid = files.length > 0 && unknownFiles.length === 0 && (caseRows.length > 0 || markerRows.length > 0)

  const loadBatches = useCallback(async () => {
    setBatchesLoading(true)
    setBatchesError('')
    try {
      const response = await lisCasesApi.batches(3)
      if (!Array.isArray(response)) throw new Error('历史批次响应格式异常')
      setBatches(response)
    } catch (error) {
      setBatches([])
      setBatchesError(publicError(error, '历史批次加载失败'))
    } finally {
      setBatchesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadBatches()
  }, [loadBatches])

  const addFiles = useCallback(async (selected: FileList | File[]) => {
    const request = ++parseRequest.current
    setParsing(true)
    setLocalError('')
    setPreviewError('')
    setPreview(null)
    setEvidence(null)
    setRejections([])
    setRejectedTotal(0)
    setRejectionsTruncated(false)
    try {
      const parsed: ParsedFile[] = []
      for (const file of Array.from(selected)) {
        const grid = await readGrid(file)
        const kind = detect(grid)
        const header = new Set((grid[0] || []).map((cell) => String(cell ?? '').trim()))
        const rows = kind === 'case'
          ? extract(grid, CASE_COLS, '病理号')
          : kind === 'marker'
            ? extract(grid, MARKER_COLS, header.has('病理号') ? '病理号' : 'caseNo')
            : []
        parsed.push({ name: file.name, kind, rows })
      }
      if (request === parseRequest.current) setFiles((current) => [...current, ...parsed])
    } catch (error) {
      if (request === parseRequest.current) setLocalError(publicError(error, '文件解析失败'))
    } finally {
      if (request === parseRequest.current) setParsing(false)
    }
  }, [])

  const removeFile = useCallback((index: number) => {
    parseRequest.current += 1
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))
    setPreview(null)
    setPreviewError('')
    setEvidence(null)
    setRejections([])
    setRejectedTotal(0)
    setRejectionsTruncated(false)
  }, [])

  const exportRejections = useCallback(() => {
    if (rejections.length === 0) return
    if (rejectionsTruncated || rejections.length !== rejectedTotal) return
    const escape = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
    const lines = ['code,caseNo,partnerName,existingMonth,incomingMonth,value']
    for (const item of rejections) {
      lines.push([
        escape(item.code),
        escape(neutralizeCsvFormula(item.caseNo)),
        escape(neutralizeCsvFormula(item.partnerName)),
        escape(item.existingMonth ?? ''),
        escape(item.incomingMonth ?? ''),
        escape(neutralizeCsvFormula(item.value ?? '')),
      ].join(','))
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `lis-rejections-${Date.now()}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [rejectedTotal, rejections, rejectionsTruncated])

  const runPreview = useCallback(async () => {
    if (!locallyValid || previewing) return
    setPreviewing(true)
    setPreviewError('')
    setEvidence(null)
    try {
      let aggregate: LisPreview = {
        valid: 0,
        skipped: 0,
        hospitalCount: 0,
        newHospitals: [],
        specimenDistribution: { tissue: 0, tissue_complex: 0, cytology: 0 },
        warnings: [],
      }
      for (const group of chunks(caseRows)) {
        aggregate = aggregatePreview(aggregate, await lisCasesApi.preview(group))
      }
      // 医院数用本地白名单列去重，避免分块预检重复计数。
      aggregate.hospitalCount = new Set(caseRows.map((row) => String(row['送检医院'] ?? '').trim()).filter(Boolean)).size
      setPreview(aggregate)
    } catch (error) {
      setPreview(null)
      setPreviewError(publicError(error, '服务端预检失败'))
    } finally {
      setPreviewing(false)
    }
  }, [caseRows, locallyValid, previewing])

  const submit = useCallback(async () => {
    if (!preview || submitLock.current) return
    submitLock.current = true
    setSubmitting(true)
    setPreviewError('')
    const summary = { ...EMPTY_SUMMARY }
    const collected: RejectionItem[] = [] // 跨 chunk 累计；只收已验证 chunk 的拒收项
    let collectedRejectedTotal = 0
    let collectedTruncated = false
    let markerBlocked = false
    try {
      for (const group of chunks(caseRows)) {
        const response = await lisCasesApi.import(group, 'verified')
        // 生产网络响应在 API 层已严格解析；默认值仅兼容旧测试直接替换该已验证方法的 test double。
        const {
          imported, inserted, updated, skipped,
          rejectedCrossMonth = 0, rejectedInvalidDate = 0,
          rejectedTotal = 0, rejectionsTruncated = false, rejections = [],
        } = response
        summary.caseImported += imported
        summary.caseInserted += inserted
        summary.caseUpdated += updated
        summary.caseSkipped += skipped
        summary.rejectedCrossMonth += rejectedCrossMonth
        summary.rejectedInvalidDate += rejectedInvalidDate
        summary.verifiedCaseChunks += 1
        collected.push(...rejections)
        collectedRejectedTotal += rejectedTotal
        collectedTruncated ||= rejectionsTruncated
      }

      // #178/#179 闭环前提：同次 case 导入被拒收的 caseNo 不得被 marker 导入当作已建立的新来源（整体停住待人工）。
      markerBlocked = markerRows.length > 0 && (summary.caseSkipped > 0 || summary.rejectedCrossMonth > 0 || summary.rejectedInvalidDate > 0)
      if (!markerBlocked) {
        for (const group of chunks(markerRows)) {
          const response = await lisCasesApi.importMarkers(group)
          assertReceiptCounters(response as unknown as Record<string, unknown>, ['imported', 'skipped', 'casesAffected', 'unmatched'])
          summary.markerImported += response.imported
          summary.markerSkipped += response.skipped
          summary.markerCases += response.casesAffected
          summary.markerUnmatched += response.unmatched
          summary.verifiedMarkerChunks += 1
        }
      }

      const partial = markerBlocked
        || summary.caseSkipped > 0
        || summary.rejectedCrossMonth > 0
        || summary.rejectedInvalidDate > 0
        || summary.markerSkipped > 0
        || summary.markerUnmatched > 0
      const outcome: Outcome = partial ? 'partial' : 'complete'
      setRejections(collected)
      setRejectedTotal(collectedRejectedTotal)
      setRejectionsTruncated(collectedTruncated)
      setEvidence({
        outcome,
        summary,
        markerBlocked,
        message: partial ? '已完成可验证的写入；拒收、跳过或未匹配项目需人工处理。' : '所有分块均返回成功证据。',
      })
      if (partial) toast.warning('LIS 导入部分完成，请查看拒收与未匹配证据')
      else toast.success('LIS 导入已完成并取得全部回执')
      if (!partial) setFiles([])
      await loadBatches()
    } catch (error) {
      setRejections(collected) // 已验证 chunk 的拒收项仍是事实，随 unknown 一并展示
      setRejectedTotal(collectedRejectedTotal)
      setRejectionsTruncated(collectedTruncated)
      setEvidence({
        outcome: 'unknown',
        summary,
        markerBlocked,
        message: `${publicError(error, '请求未取得可验证回执')}。已返回成功的分块计数可信；当前及后续分块状态未知，请先核对历史批次和病例列表。`,
      })
      toast.error('LIS 提交结果未知，请先核对后再决定是否重试')
      await loadBatches()
    } finally {
      submitLock.current = false
      setSubmitting(false)
      setConfirmOpen(false)
    }
  }, [caseRows, loadBatches, markerRows, preview])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnCls} onClick={onBack} disabled={submitting}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />返回列表
        </button>
        <div>
          <h1 className="text-[18px] font-semibold text-gray-900">导入 LIS 病例</h1>
          <p className="mt-1 text-xs text-gray-500">本地白名单校验 → 服务端预检 → 确认提交 → 回执核对。</p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12px] leading-relaxed text-blue-800">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>只把病理号、送检医院、必要数量和抗体列保留在内存中；原始文件不保存，患者姓名、证件、诊断、病史和额外列不会上传。错误提示也不回显原始行。</span>
      </div>

      <section aria-labelledby="local-validation-title" className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="local-validation-title" className="text-sm font-medium text-gray-900">1. 本地文件校验</h2>
            <p className="mt-1 text-xs text-gray-500">识别工作量表和抗体清单；认不出的文件会阻止提交。</p>
          </div>
          <button type="button" className={btnPri} disabled={parsing || submitting} onClick={() => fileRef.current?.click()}>
            {parsing ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Upload aria-hidden="true" className="h-4 w-4" />}
            选择文件
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".xlsx,.xls,.csv"
            aria-label="选择 LIS 文件"
            className="sr-only"
            onChange={(event) => {
              if (event.target.files?.length) addFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>

        {localError && <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{localError}</div>}
        {files.length > 0 && (
          <div className="mt-4 space-y-2">
            {files.map((file, index) => (
              <div key={`${file.name}-${index}`} className="flex min-w-0 items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-xs">
                {file.kind === 'case' ? <FileSpreadsheet aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-500" /> : file.kind === 'marker' ? <FlaskConical aria-hidden="true" className="h-4 w-4 shrink-0 text-violet-500" /> : <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-500" />}
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className={file.kind === 'unknown' ? 'text-amber-700' : 'text-gray-500'}>
                  {file.kind === 'case' ? `工作量 ${file.rows.length} 行` : file.kind === 'marker' ? `抗体 ${file.rows.length} 行` : '无法识别'}
                </span>
                <button type="button" aria-label={`移除 ${file.name}`} className="a11y-focus-ring rounded p-1 text-gray-400 hover:text-red-600" onClick={() => removeFile(index)} disabled={submitting}>
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        {locallyValid && (
          <div role="status" className="mt-3 flex items-center gap-2 text-xs font-medium text-green-700">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />本地校验通过
          </div>
        )}
        {unknownFiles.length > 0 && <div role="alert" className="mt-3 text-xs text-amber-700">请移除无法识别的文件；它们不会被当作成功或空文件跳过。</div>}
      </section>

      <section aria-labelledby="preview-title" className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="preview-title" className="text-sm font-medium text-gray-900">2. 服务端预检</h2>
            <p className="mt-1 text-xs text-gray-500">预检不落库，用真实规则核对有效行、跳过行和新医院。</p>
          </div>
          <button type="button" className={btnCls} disabled={!locallyValid || previewing || submitting} onClick={runPreview}>
            {previewing && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
            {caseRows.length > 0 ? '运行服务端预检' : '确认无病例可预检'}
          </button>
        </div>
        {previewError && <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{previewError}。未取得预检证据，禁止提交。</div>}
        {preview && (
          <div role="status" aria-label={caseRows.length > 0 ? '服务端预检通过' : '病例预检不适用'} className="mt-4 rounded-md border border-green-200 bg-green-50 p-3 text-xs text-green-800">
            <div className="flex items-center gap-2 font-medium"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />{caseRows.length > 0 ? '服务端预检通过' : '病例预检不适用'}</div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <span>有效病例：{preview.valid}</span><span>跳过：{preview.skipped}</span><span>医院：{preview.hospitalCount}</span><span>预计新建：{preview.newHospitals.length}</span>
            </div>
            {markerRows.length > 0 && caseRows.length === 0 && <p className="mt-2 text-amber-700">没有病例行可调用服务端预检；抗体清单尚未验证病理号到医院的映射，提交回执中的未匹配数必须单独核对。</p>}
          </div>
        )}
      </section>

      <section aria-labelledby="submit-title" className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="submit-title" className="text-sm font-medium text-gray-900">3. 确认提交与结果</h2>
            <p className="mt-1 text-xs text-gray-500">工作量先写入；有拒收时抗体清单会停住，避免覆盖无法确认月份的病例映射。</p>
          </div>
          <button type="button" className={btnPri} disabled={!preview || submitting} onClick={() => setConfirmOpen(true)}>确认提交导入</button>
        </div>

        {evidence && <LisImportEvidence evidence={evidence} />}
        {rejectedTotal > 0 && (
          <section role="region" aria-label="拒收清单" className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">拒收总数 {rejectedTotal} 条（当前取得 {rejections.length} 条安全明细）</h3>
              {!rejectionsTruncated && rejections.length === rejectedTotal && <button type="button" className={btnCls} onClick={exportRejections}>导出拒收清单</button>}
            </div>
            {rejectionsTruncated && <p role="alert" className="mt-2 font-medium">服务端回执已截断，当前清单不完整，不能导出或标记为完整拒收清单。</p>}
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {rejections.slice(0, REJECTION_DISPLAY_LIMIT).map((item, index) => (
                <li key={`${item.code}-${item.caseNo}-${index}`} className="break-all">{describeRejection(item)}</li>
              ))}
            </ul>
            {rejections.length > REJECTION_DISPLAY_LIMIT && <p className="mt-2">仅显示前 {REJECTION_DISPLAY_LIMIT} 条；完整清单请导出 CSV 核对。</p>}
          </section>
        )}
        {evidence?.outcome === 'complete' && <button type="button" className={`${btnCls} mt-4`} onClick={onDone}>返回病例列表</button>}
      </section>

      <section aria-labelledby="batch-title" className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 id="batch-title" className="text-sm font-medium text-gray-900">最近可核对批次</h2>
        {batchesLoading ? (
          <div role="status" className="mt-3 flex items-center gap-2 text-xs text-gray-500"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />加载中…</div>
        ) : batchesError ? (
          <div role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">历史批次未加载：{batchesError}。不能据此判断没有历史导入。 <button type="button" className="ml-2 underline" onClick={loadBatches}>重试</button></div>
        ) : batches.length === 0 ? (
          <p className="mt-3 text-xs text-gray-500">查询成功；当前没有历史批次。</p>
        ) : (
          <ul className="mt-3 space-y-2 text-xs text-gray-600">
            {batches.map((batch) => <li key={batch.importBatch} className="rounded-md bg-gray-50 px-3 py-2"><span className="font-medium tabular-nums text-gray-800">{batch.importBatch}</span> · {batch.caseCount} 例 · {batch.hospitalCount} 家医院 · {batch.importedAt}</li>)}
          </ul>
        )}
      </section>

      {confirmOpen && (
        <Modal
          title="确认提交 LIS 数据"
          onClose={() => { if (!submitting) setConfirmOpen(false) }}
          size="sm"
        >
          <div className="space-y-3 text-sm text-gray-700">
            <p>提交会写入病例工作量；只有全部请求返回成功，界面才会显示完成。</p>
            <p>病例 {caseRows.length} 行，抗体 {markerRows.length} 行。文件只保留白名单字段，原始文件不会保存。</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btnCls} disabled={submitting} onClick={() => setConfirmOpen(false)}>返回检查</button>
              <button type="button" className={btnPri} disabled={submitting} onClick={submit}>
                {submitting ? <><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />提交中…</> : '开始提交'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
