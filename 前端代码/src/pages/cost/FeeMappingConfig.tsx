import React, { type ReactNode, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Calculator, CheckCircle2, Plus, RefreshCw, Search, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { Pagination } from '@/components/ui/Pagination'
import { cn, formatCurrency, formatNumber } from '@/lib/utils'

interface AuditRow {
  bomId: string
  bomCode: string
  bomName: string
  bomType?: string
  status: 'mapped' | 'legacy' | 'missing'
  mappingCount: number
  mappedFeeNames: string[]
  legacyFeeStandardName?: string
  exceptionNo?: string
}

interface FeeStandard {
  id: string
  code?: string
  name: string
  category?: string
  feePerSlide?: number
}

interface DraftMapping {
  feeStandardId: string
  quantityMultiplier: number
  aggregationScope: 'outbound' | 'case'
}

interface RowQueryOverrides {
  keyword?: string
  status?: string
  page?: number
  pageSize?: number
}

const statusLabels: Record<AuditRow['status'], string> = {
  mapped: '已配置',
  legacy: '旧字段',
  missing: '未映射',
}

const statusStyles: Record<AuditRow['status'], string> = {
  mapped: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  legacy: 'border-amber-200 bg-amber-50 text-amber-700',
  missing: 'border-red-200 bg-red-50 text-red-700',
}

function unwrapList(payload: any): AuditRow[] {
  return payload?.list || payload?.items || (Array.isArray(payload) ? payload : [])
}

function unwrapFeeStandards(payload: any): FeeStandard[] {
  return payload?.list || payload?.items || (Array.isArray(payload) ? payload : [])
}

function getInitialStatus(search: string) {
  const status = new URLSearchParams(search).get('status') || ''
  return status === 'mapped' || status === 'legacy' || status === 'missing' ? status : ''
}

export default function FeeMappingConfig() {
  const searchParams = new URLSearchParams(window.location.search)
  const initialKeyword = searchParams.get('keyword') || ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const [status, setStatus] = useState(getInitialStatus(window.location.search))
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState({ total: 0, mapped: 0, legacy: 0, missing: 0 })
  const [rows, setRows] = useState<AuditRow[]>([])
  const [feeStandards, setFeeStandards] = useState<FeeStandard[]>([])
  const [loading, setLoading] = useState(false)
  const [auditing, setAuditing] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRow, setEditingRow] = useState<AuditRow | null>(null)
  const [draftMappings, setDraftMappings] = useState<DraftMapping[]>([])
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [sampleCount, setSampleCount] = useState(1)
  const [caseNo, setCaseNo] = useState('')
  const [preview, setPreview] = useState<any>(null)

  const loadRows = async (overrides: RowQueryOverrides = {}) => {
    const nextKeyword = overrides.keyword ?? keyword
    const nextStatus = overrides.status ?? status
    const nextPage = overrides.page ?? page
    const nextPageSize = overrides.pageSize ?? pageSize
    setLoading(true)
    try {
      const payload = await abcApi.getBomFeeMappingAudit({
        keyword: nextKeyword.trim() || undefined,
        status: nextStatus || undefined,
        page: nextPage,
        pageSize: nextPageSize,
      })
      const list = unwrapList(payload)
      setRows(list)
      setTotal(payload?.pagination?.total ?? payload?.total ?? list.length)
      setSummary(payload?.summary || { total: list.length, mapped: 0, legacy: 0, missing: 0 })
    } finally {
      setLoading(false)
    }
  }

  const loadFeeStandards = async () => {
    const payload = await abcApi.getFeeStandards({ page: 1, pageSize: 500, status: 'active' })
    setFeeStandards(unwrapFeeStandards(payload))
  }

  useEffect(() => {
    loadFeeStandards().catch(() => toast.error('收费标准加载失败'))
  }, [])

  useEffect(() => {
    loadRows().catch(() => toast.error('收费映射审计加载失败'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, status, page, pageSize])

  const feeStandardOptions = useMemo(() => {
    return feeStandards.map(item => ({
      value: item.id,
      label: `${item.name}${item.code ? ` (${item.code})` : ''}`,
    }))
  }, [feeStandards])
  const mappingPreviewItems = useMemo(() => {
    return draftMappings.map(mapping => {
      const feeStandard = feeStandards.find(item => item.id === mapping.feeStandardId)
      return {
        feeStandardName: feeStandard
          ? `${feeStandard.name}${feeStandard.code ? ` (${feeStandard.code})` : ''}`
          : '待选择收费标准',
        quantityMultiplier: Number(mapping.quantityMultiplier) || 1,
        aggregationScopeLabel: mapping.aggregationScope === 'case' ? '按病例' : '按出库单',
      }
    })
  }, [draftMappings, feeStandards])
  const mappingValidationMessage = draftMappings.some(mapping => !mapping.feeStandardId)
    ? '请选择收费标准，系统才能把 BOM 接到病例收费和成本对比。'
    : draftMappings.some(mapping => !Number.isFinite(Number(mapping.quantityMultiplier)) || Number(mapping.quantityMultiplier) <= 0)
      ? '请填写大于 0 的数量系数，系统才能正确计算病例收费、成本对比和预警。'
      : ''
  const canSaveMappings = mappingValidationMessage === '' && !saving

  const runAudit = async () => {
    setAuditing(true)
    try {
      const result = await abcApi.runBomFeeMappingAudit()
      toast.success(`检查完成：${result?.missing || 0} 个 BOM 缺少收费映射`)
      await loadRows()
    } finally {
      setAuditing(false)
    }
  }

  const openEditor = async (row: AuditRow) => {
    setEditingRow(row)
    setEditorOpen(true)
    setPreview(null)
    setSampleCount(1)
    setCaseNo('')
    try {
      const mappings = await abcApi.getBomFeeMappings(row.bomId)
      const list = Array.isArray(mappings) ? mappings : []
      setDraftMappings(list.length > 0
        ? list.map((item: any) => ({
            feeStandardId: item.feeStandardId || '',
            quantityMultiplier: Number(item.quantityMultiplier) || 1,
            aggregationScope: item.aggregationScope === 'case' ? 'case' : 'outbound',
          }))
        : [{ feeStandardId: '', quantityMultiplier: 1, aggregationScope: 'outbound' }]
      )
    } catch {
      toast.error('收费映射加载失败')
    }
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditingRow(null)
    setDraftMappings([])
    setPreview(null)
  }

  const updateDraft = (index: number, patch: Partial<DraftMapping>) => {
    setDraftMappings(current => current.map((item, i) => i === index ? { ...item, ...patch } : item))
    setPreview(null)
  }

  const addDraft = () => {
    setDraftMappings(current => [...current, { feeStandardId: '', quantityMultiplier: 1, aggregationScope: 'outbound' }])
    setPreview(null)
  }

  const removeDraft = (index: number) => {
    setDraftMappings(current => current.filter((_item, i) => i !== index))
    setPreview(null)
  }

  const saveMappings = async () => {
    if (!editingRow) return
    if (mappingValidationMessage) {
      toast.warning(mappingValidationMessage)
      return
    }
    const validMappings = draftMappings.filter(item => item.feeStandardId)
    setSaving(true)
    try {
      await abcApi.updateBomFeeMappings(editingRow.bomId, validMappings)
      const focusKeyword = String(editingRow.bomCode || editingRow.bomName || '').trim()
      toast.success('收费映射已保存')
      setKeyword(focusKeyword)
      setStatus('mapped')
      setPage(1)
      closeEditor()
      await loadRows({ keyword: focusKeyword, status: 'mapped', page: 1 })
    } finally {
      setSaving(false)
    }
  }

  const runPreview = async () => {
    if (!editingRow) return
    const validMappings = draftMappings.filter(item => item.feeStandardId)
    if (validMappings.length === 0) {
      toast.warning('至少选择一个收费标准后再预览')
      return
    }
    setPreviewing(true)
    try {
      const result = await abcApi.previewBomFeeMapping(editingRow.bomId, {
        sampleCount,
        caseNo: caseNo.trim() || undefined,
        mappings: validMappings,
      })
      setPreview(result)
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 border-b border-gray-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">收费映射配置</h1>
          <p className="mt-1 text-sm text-gray-500">
            将 BOM 绑定到一个或多个收费标准，支持按出库单或按病例聚合计费。
          </p>
        </div>
        <button
          type="button"
          onClick={runAudit}
          disabled={auditing}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={cn('h-4 w-4', auditing && 'animate-spin')} />
          完整性检查
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SummaryItem label="BOM总数" value={summary.total} />
        <SummaryItem label="已配置" value={summary.mapped} tone="green" />
        <SummaryItem label="旧字段待迁移" value={summary.legacy} tone="amber" />
        <SummaryItem label="未映射" value={summary.missing} tone="red" />
      </div>

      <div className="border border-gray-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-gray-200 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-[260px] flex-col gap-1 text-xs font-medium text-gray-500">
              搜索
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  value={keyword}
                  onChange={event => {
                    setKeyword(event.target.value)
                    setPage(1)
                  }}
                  placeholder="BOM名称 / 编号"
                  className="h-10 w-full rounded-md border border-gray-300 pl-9 pr-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                />
              </div>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
              配置状态
              <select
                value={status}
                onChange={event => {
                  setStatus(event.target.value)
                  setPage(1)
                }}
                className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
              >
                <option value="">全部状态</option>
                <option value="missing">未映射</option>
                <option value="legacy">旧字段待迁移</option>
                <option value="mapped">已配置</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={loadRows}
            disabled={loading}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <Th>BOM</Th>
                <Th>状态</Th>
                <Th>收费标准</Th>
                <Th>异常</Th>
                <Th align="right">操作</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">加载中...</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">暂无 BOM 收费映射记录</td>
                </tr>
              ) : rows.map(row => (
                <tr key={row.bomId} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3">
                    <div className="text-sm font-medium text-gray-900">{row.bomName}</div>
                    <div className="text-xs text-gray-500">{row.bomCode} · {row.bomType || '-'}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="min-w-[260px] px-4 py-3 text-sm text-gray-700">
                    {row.status === 'mapped'
                      ? row.mappedFeeNames.join('、')
                      : row.status === 'legacy'
                        ? row.legacyFeeStandardName || '旧收费字段'
                        : <span className="text-red-600">未配置收费标准</span>}
                    {row.mappingCount > 0 && (
                      <div className="mt-1 text-xs text-gray-400">{row.mappingCount} 项映射</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                    {row.exceptionNo ? (
                      <span className="inline-flex items-center gap-1 text-red-600">
                        <AlertTriangle className="h-4 w-4" />
                        {row.exceptionNo}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => openEditor(row)}
                      className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <Settings2 className="h-4 w-4" />
                      配置
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-gray-200 p-4">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChangePage={setPage}
            onChangePageSize={next => {
              setPageSize(next)
              setPage(1)
            }}
          />
        </div>
      </div>

      {editorOpen && editingRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg bg-white shadow-xl">
            <div className="flex items-start justify-between border-b border-gray-200 p-5">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">配置收费映射</h2>
                <div className="mt-1 text-sm text-gray-500">{editingRow.bomName} · {editingRow.bomCode}</div>
              </div>
              <button type="button" onClick={closeEditor} className="text-sm text-gray-500 hover:text-gray-900">关闭</button>
            </div>

            <div className="space-y-5 p-5">
              <div className="space-y-3">
                {draftMappings.map((mapping, index) => (
                  <div key={index} className="grid gap-3 border border-gray-200 p-3 md:grid-cols-[minmax(220px,1fr)_140px_150px_40px]">
                    <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                      收费标准
                      <select
                        value={mapping.feeStandardId}
                        onChange={event => updateDraft(index, { feeStandardId: event.target.value })}
                        className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                      >
                        <option value="">选择收费标准</option>
                        {feeStandardOptions.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                      数量系数
                      <input
                        type="number"
                        min={0.01}
                        step={0.01}
                        value={mapping.quantityMultiplier}
                        onChange={event => updateDraft(index, { quantityMultiplier: Number(event.target.value) || 1 })}
                        className="h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                      聚合方式
                      <select
                        value={mapping.aggregationScope}
                        onChange={event => updateDraft(index, { aggregationScope: event.target.value === 'case' ? 'case' : 'outbound' })}
                        className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                      >
                        <option value="outbound">按出库单</option>
                        <option value="case">按病例</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => removeDraft(index)}
                      disabled={draftMappings.length === 1}
                      className="mt-5 inline-flex h-10 w-10 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="删除映射"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addDraft}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Plus className="h-4 w-4" />
                  增加收费项
                </button>
              </div>

              <div className="border border-gray-200 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <Calculator className="h-4 w-4" />
                  映射预览
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
                    样本数
                    <input
                      type="number"
                      min={1}
                      value={sampleCount}
                      onChange={event => setSampleCount(Math.max(1, Number(event.target.value) || 1))}
                      className="h-10 w-28 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                    />
                  </label>
                  <label className="flex min-w-[220px] flex-col gap-1 text-xs font-medium text-gray-500">
                    病例号
                    <input
                      value={caseNo}
                      onChange={event => setCaseNo(event.target.value)}
                      placeholder="病例聚合预览可填写"
                      className="h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={runPreview}
                    disabled={previewing}
                    className="inline-flex h-10 items-center gap-2 rounded-md bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Calculator className="h-4 w-4" />
                    {previewing ? '预览中...' : '计算预览'}
                  </button>
                </div>
                {preview && (
                  <div className="mt-4 grid gap-3 md:grid-cols-4">
                    <PreviewItem label="收费金额" value={formatCurrency(preview.feeAmount)} />
                    <PreviewItem label="总成本" value={formatCurrency(preview.totalCost)} />
                    <PreviewItem label="利润" value={formatCurrency(preview.profit)} />
                    <PreviewItem label="利润率" value={`${formatNumber((preview.profitRate || 0) * 100, 2)}%`} />
                  </div>
                )}
                {preview?.feeBreakdown?.length > 0 && (
                  <div className="mt-3 divide-y divide-gray-100 border border-gray-200">
                    {preview.feeBreakdown.map((item: any, index: number) => (
                      <div key={index} className="grid gap-2 px-3 py-2 text-sm md:grid-cols-[1fr_120px_120px_120px]">
                        <span className="font-medium text-gray-900">{item.feeStandardName || item.feeStandardId}</span>
                        <span className="text-gray-500">{item.aggregationScope === 'case' ? '按病例' : '按出库单'}</span>
                        <span className="text-gray-500">数量 {formatNumber(item.quantity, 2)}</span>
                        <span className="font-semibold text-gray-900">{formatCurrency(item.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-md border border-emerald-100 bg-emerald-50 px-4 py-3">
                <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <div className="text-sm font-semibold text-emerald-900">收费映射结果确认</div>
                  <div className="text-xs text-emerald-700">确认后将接住：BOM、收费标准、病例收费、成本对比、异常预警、审计记录</div>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-emerald-900 md:grid-cols-2">
                  <div>BOM {editingRow.bomName}</div>
                  <div>编号 {editingRow.bomCode}</div>
                  {mappingPreviewItems.map((item, index) => (
                    <div key={index} className="md:col-span-2">
                      映射 {item.feeStandardName} × {formatNumber(item.quantityMultiplier, 2).replace(/\.00$/, '')} · {item.aggregationScopeLabel}
                    </div>
                  ))}
                </div>
              </div>
              {mappingValidationMessage ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  {mappingValidationMessage}
                </div>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-200 p-5">
              <button
                type="button"
                onClick={closeEditor}
                className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={saveMappings}
                disabled={!canSaveMappings}
                className="h-10 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? '保存中...' : '保存映射'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryItem({ label, value, tone = 'gray' }: { label: string; value: number; tone?: 'gray' | 'green' | 'amber' | 'red' }) {
  const toneClass = {
    gray: 'text-gray-900',
    green: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
  }[tone]
  return (
    <div className="border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={cn('mt-2 text-xl font-semibold', toneClass)}>{formatNumber(value, 0)}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: AuditRow['status'] }) {
  const Icon = status === 'mapped' ? CheckCircle2 : AlertTriangle
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', statusStyles[status])}>
      <Icon className="h-3.5 w-3.5" />
      {statusLabels[status]}
    </span>
  )
}

function PreviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 bg-gray-50 p-3">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-1 text-base font-semibold text-gray-900">{value}</div>
    </div>
  )
}

function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={cn(
      'whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-normal text-gray-500',
      align === 'right' ? 'text-right' : 'text-left'
    )}>
      {children}
    </th>
  )
}
