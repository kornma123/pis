import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, Upload } from 'lucide-react'
import { inboundApi } from '@/api/inventory'
import { genIdempotencyKey } from '@/api/request'
import type { Location, Material, Supplier } from '@/types'
import { toast } from 'sonner'
import {
  executeInboundImport,
  INBOUND_IMPORT_HEADERS,
  parseInboundCsv,
  summarizeInboundImport,
  validateInboundImportRows,
} from '../importInboundModel'
import type { InboundImportRow } from '../importInboundModel'
import {
  clearImportWorkflowJournal,
  readImportWorkflowJournal,
  writeImportWorkflowJournal,
} from '../../import-shared/importWorkflowJournal'

interface ImportInboundModalProps {
  onClose: () => void
  onSuccess: () => void
  materials: Material[]
  locations: Location[]
  suppliers?: Supplier[]
}

type ImportPhase = 'idle' | 'validation' | 'confirm' | 'importing' | 'result'

const statusLabel: Record<InboundImportRow['status'], string> = {
  ready: '校验通过',
  validation_error: '校验失败',
  succeeded: '已入库',
  failed: '提交失败',
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function downloadCsvTemplate() {
  const sampleRows = [
    ['M001', 10, 'L001', 'B20260701', 0, '', '2026-07-01', '2027-07-01', '直接入库示例'],
  ]
  const content = `\uFEFF${[
    INBOUND_IMPORT_HEADERS.map(csvCell).join(','),
    ...sampleRows.map(row => row.map(csvCell).join(',')),
  ].join('\r\n')}`
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '直接入库导入模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export default function ImportInboundModal({
  onClose,
  onSuccess,
  materials,
  locations,
  suppliers = [],
}: ImportInboundModalProps) {
  const [phase, setPhase] = useState<ImportPhase>('idle')
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<InboundImportRow[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [recovery, setRecovery] = useState(() => readImportWorkflowJournal('direct-inbound'))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const selectionVersionRef = useRef(0)
  const operationLockRef = useRef(false)

  const validationErrorCount = useMemo(
    () => rows.filter(row => row.status === 'validation_error').length,
    [rows],
  )
  const readyCount = useMemo(
    () => rows.filter(row => row.status === 'ready').length,
    [rows],
  )
  const resultSummary = useMemo(() => summarizeInboundImport(rows), [rows])
  const canProceedToConfirm = rows.length > 0
    && readyCount > 0
    && !fileError
    && !parsing

  useEffect(() => {
    if (phase === 'idle') return
    const frame = window.requestAnimationFrame(() => summaryRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [phase, fileError])

  const selectFile = async (file: File) => {
    if (operationLockRef.current) return
    const selectionVersion = ++selectionVersionRef.current
    setFileName(file.name)
    setRows([])
    setFileError(null)
    setConfirmed(false)
    setPhase('validation')
    setParsing(true)

    if (!file.name.toLocaleLowerCase('en-US').endsWith('.csv')) {
      setFileError('仅支持 CSV 文件；Excel 工作簿不是此导入器的真实对象')
      setParsing(false)
      return
    }

    try {
      const parsed = parseInboundCsv(await file.text())
      if (selectionVersionRef.current !== selectionVersion) return
      if (parsed.fileError) {
        setFileError(parsed.fileError)
        return
      }
      const validation = validateInboundImportRows(
        parsed.headers,
        parsed.rows,
        { materials, locations, suppliers },
        genIdempotencyKey,
      )
      setRows(validation.rows)
      setFileError(validation.fileError)
    } catch {
      if (selectionVersionRef.current === selectionVersion) {
        setFileError('CSV 读取失败，请重新选择文件')
      }
    } finally {
      if (selectionVersionRef.current === selectionVersion) setParsing(false)
    }
  }

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (selected) void selectFile(selected)
  }

  const handleDrop = (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setDragActive(false)
    const selected = event.dataTransfer.files?.[0]
    if (selected) void selectFile(selected)
  }

  const runImport = async (retryFailedOnly = false) => {
    if (operationLockRef.current) return
    const runnable = rows.some(row => retryFailedOnly ? row.status === 'failed' : row.status === 'ready')
    if (!runnable) return

    operationLockRef.current = true
    setPhase('importing')
    const beforeSummary = summarizeInboundImport(rows)
    const submittingJournal = {
      version: 1 as const,
      kind: 'direct-inbound' as const,
      phase: 'submitting' as const,
      updatedAt: new Date().toISOString(),
      fileName,
      summary: {
        total: beforeSummary.total,
        succeeded: beforeSummary.succeeded,
        failed: beforeSummary.failed,
        validationRejected: beforeSummary.validationRejected,
      },
    }
    writeImportWorkflowJournal(submittingJournal)
    setRecovery(submittingJournal)
    try {
      const nextRows = await executeInboundImport(
        rows,
        (payload, idempotencyKey) => inboundApi.create(payload, idempotencyKey),
        { retryFailedOnly },
      )
      setRows(nextRows)
      setPhase('result')
      const summary = summarizeInboundImport(nextRows)
      const settledJournal = {
        version: 1 as const,
        kind: 'direct-inbound' as const,
        phase: 'settled' as const,
        updatedAt: new Date().toISOString(),
        fileName,
        summary: {
          total: summary.total,
          succeeded: summary.succeeded,
          failed: summary.failed,
          validationRejected: summary.validationRejected,
        },
        receiptIds: nextRows
          .filter(row => row.status === 'succeeded' && row.resultInboundNo)
          .map(row => row.resultInboundNo as string),
      }
      writeImportWorkflowJournal(settledJournal)
      setRecovery(settledJournal)
      if (summary.failed === 0 && summary.validationRejected === 0) {
        toast.success('直接入库提交完成', { description: `成功 ${summary.succeeded} 行` })
      } else if (summary.succeeded === 0) {
        toast.error(`没有行入库：服务失败 ${summary.failed} 行，校验拒绝 ${summary.validationRejected} 行`)
      } else {
        toast.warning(`部分完成：成功 ${summary.succeeded} 行，服务失败 ${summary.failed} 行，校验拒绝 ${summary.validationRejected} 行`)
      }
    } finally {
      operationLockRef.current = false
    }
  }

  const handleClose = () => {
    if (operationLockRef.current) return
    onClose()
  }

  const handleFinish = () => {
    if (operationLockRef.current) return
    onSuccess()
  }

  return (
    <div className="min-w-0" aria-busy={phase === 'importing'}>
      <div
        id="direct-inbound-import-scope"
        className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900"
      >
        <strong>导入对象：直接入库记录。</strong>
        每行会独立调用一次真实入库接口并立即影响库存；这不是采购订单收货，也不承诺整批原子成功。
        部分失败时，已成功行不会回滚，失败行会保留原幂等键供安全重试。
      </div>

      {phase === 'idle' && recovery && (
        <div role="status" className={`mb-4 rounded-lg border px-4 py-3 text-sm leading-6 ${recovery.phase === 'submitting' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
          <div className="font-medium">
            {recovery.phase === 'submitting' ? '上次直接入库提交结果未知' : '上次直接入库回执'}
          </div>
          {recovery.phase === 'submitting' ? (
            <p>文件「{recovery.fileName}」离开页面时仍在提交。原始行未保存在浏览器，也不会自动重提；请先到入库记录核对结果。</p>
          ) : (
            <p>
              文件「{recovery.fileName}」：成功 {recovery.summary.succeeded} 行，服务失败 {recovery.summary.failed} 行，校验拒绝 {recovery.summary.validationRejected} 行。
              {recovery.receiptIds?.length ? ` 入库单：${recovery.receiptIds.join('、')}` : ' 服务端未返回可显示的入库单号。'}
            </p>
          )}
          <button
            type="button"
            className="mt-1 font-medium text-blue-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/20"
            onClick={() => { clearImportWorkflowJournal('direct-inbound'); setRecovery(null) }}
          >
            清除上次记录
          </button>
        </div>
      )}

      <input
        id="direct-inbound-csv-file"
        type="file"
        ref={fileInputRef}
        accept=".csv,text/csv"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleInputChange}
        disabled={phase === 'importing'}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragEnter={event => { event.preventDefault(); setDragActive(true) }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        disabled={phase === 'importing'}
        aria-describedby="direct-inbound-import-scope direct-inbound-file-help"
        className={`w-full rounded-xl border-2 border-dashed p-5 text-center transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/20 sm:p-8 ${
          dragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50'
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <Upload className="mx-auto mb-3 h-10 w-10 text-gray-400 sm:h-12 sm:w-12" aria-hidden="true" />
        <span className="block break-all text-base font-medium text-gray-900">
          {fileName || '选择或拖放 CSV 文件'}
        </span>
        <span id="direct-inbound-file-help" className="mt-1 block text-sm text-gray-500">
          仅支持模板 CSV，最多 1000 个非空数据行
        </span>
      </button>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-gray-600">模板包含稳定的物料、库位和可选供应商编码列。</span>
        <button
          type="button"
          onClick={downloadCsvTemplate}
          disabled={phase === 'importing'}
          className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/20 disabled:opacity-50 sm:w-auto"
        >
          <Download className="h-4 w-4" aria-hidden="true" /> 下载直接入库 CSV 模板
        </button>
      </div>

      {phase !== 'idle' && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role={fileError ? 'alert' : undefined}
          aria-live="polite"
          className="mt-5 rounded-lg border border-gray-200 bg-gray-50 p-4 focus:outline-none"
        >
          {parsing ? (
            <p className="text-sm text-gray-700">正在本地解析并校验 CSV，不会在此阶段写入数据…</p>
          ) : fileError ? (
            <div className="flex items-start gap-2 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{fileError}</span>
            </div>
          ) : phase === 'validation' ? (
            <div className="flex items-start gap-2 text-sm text-gray-700">
              {validationErrorCount === 0 ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              )}
              <span>
                本地校验完成：共 {rows.length} 行，{readyCount} 行可提交，{validationErrorCount} 行需修正。
                {validationErrorCount > 0 && ' 修正 CSV 后请重新选择文件。'}
              </span>
            </div>
          ) : phase === 'confirm' ? (
            <div className="text-sm text-gray-700">
              只提交 {readyCount} 行；另有 {validationErrorCount} 行校验拒绝、不发送到服务端。提交开始后仍可能出现部分成功。
            </div>
          ) : phase === 'importing' ? (
            <div className="text-sm text-blue-700">正在逐行提交，请勿重复点击或重新选择文件…</div>
          ) : (
            <div className="text-sm text-gray-700">
              文件 {resultSummary.total} 行：成功 {resultSummary.succeeded} 行，服务失败 {resultSummary.failed} 行，校验拒绝 {resultSummary.validationRejected} 行。
              {resultSummary.failed > 0 && ' 已成功行不会再次提交；重试只处理失败行。'}
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-gray-200">
          <table className="min-w-[760px] w-full text-left text-xs">
            <caption className="sr-only">直接入库 CSV 本地校验与提交结果</caption>
            <thead className="sticky top-0 bg-gray-50 text-gray-600">
              <tr>
                <th scope="col" className="px-3 py-2">行</th>
                <th scope="col" className="px-3 py-2">物料编码</th>
                <th scope="col" className="px-3 py-2">数量</th>
                <th scope="col" className="px-3 py-2">库位编码</th>
                <th scope="col" className="px-3 py-2">单价</th>
                <th scope="col" className="px-3 py-2">状态 / 原因</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white text-gray-700">
              {rows.map(row => (
                <tr
                  key={`${row.rowNumber}-${row.idempotencyKey}`}
                  style={{ contentVisibility: 'auto', containIntrinsicSize: '0 40px' }}
                >
                  <td className="px-3 py-2 tabular-nums">{row.rowNumber}</td>
                  <td className="px-3 py-2 font-mono">{row.raw['物料编码'] || '空'}</td>
                  <td className="px-3 py-2 tabular-nums">{row.raw['入库数量'] || '空'}</td>
                  <td className="px-3 py-2 font-mono">{row.raw['库位编码'] || '空'}</td>
                  <td className="px-3 py-2 tabular-nums">{row.raw['单价'] === '' ? '空' : row.raw['单价']}</td>
                  <td className="max-w-sm px-3 py-2">
                    <span className={row.status === 'succeeded' ? 'font-medium text-green-700' : row.status === 'failed' || row.status === 'validation_error' ? 'font-medium text-red-700' : 'font-medium text-blue-700'}>
                      {statusLabel[row.status]}
                    </span>
                    {row.resultInboundNo && <span className="ml-1 font-mono">{row.resultInboundNo}</span>}
                    {row.issues.length > 0 && <span className="ml-1">— {row.issues.join('；')}</span>}
                    {row.errorMessage && <span className="ml-1">— {row.errorMessage}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {phase === 'confirm' && (
        <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={event => setConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span>我已确认这些行是“直接入库”，并理解逐行提交可能部分成功、不会整批自动回滚。</span>
        </label>
      )}

      <div className="mt-6 flex flex-col-reverse gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={phase === 'result' ? handleFinish : handleClose}
          disabled={phase === 'importing'}
          className="h-10 w-full rounded-md border border-gray-300 bg-white px-4 text-sm text-gray-600 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/20 disabled:opacity-50 sm:w-auto"
        >
          {phase === 'result' ? '完成并刷新列表' : '取消'}
        </button>
        {phase === 'validation' && (
          <button
            type="button"
            onClick={() => { setConfirmed(false); setPhase('confirm') }}
            disabled={!canProceedToConfirm}
            className="h-10 w-full rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            核对并确认
          </button>
        )}
        {phase === 'confirm' && (
          <button
            type="button"
            onClick={() => void runImport(false)}
            disabled={!confirmed}
            className="h-10 w-full rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            确认并开始逐行入库
          </button>
        )}
        {phase === 'result' && resultSummary.failed > 0 && (
          <button
            type="button"
            onClick={() => void runImport(true)}
            className="h-10 w-full rounded-md bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/20 sm:w-auto"
          >
            仅重试 {resultSummary.failed} 个失败行
          </button>
        )}
      </div>
    </div>
  )
}
