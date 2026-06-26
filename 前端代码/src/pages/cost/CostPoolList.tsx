import React, { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Calculator, Database, Plus, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { Pagination } from '@/components/ui/Pagination'
import { getUserRole } from '@/lib/permissions'
import { cn, formatCurrency, formatNumber } from '@/lib/utils'

interface CostPool {
  id: string
  activityCenterId?: string
  activityCenterName: string
  activityCenterCode?: string
  yearMonth: string
  directCost: number
  indirectCost: number
  totalCost: number
  driverQuantity: number
  driverRate: number
  source?: string
  description?: string
  adjustmentReason?: string
  sourceDocumentNo?: string
  attachmentUrl?: string
  linkedAdjustmentId?: string
}

interface ActivityCenterOption {
  id: string
  name: string
  code?: string
  status?: string | number
}

interface ManualCostPoolForm {
  activityCenterId: string
  directCost: string
  indirectCost: string
  driverQuantity: string
  adjustmentReason: string
  sourceDocumentNo: string
  attachmentUrl: string
  description: string
}

interface SourceTotals {
  sampleCount?: number
  materialCost?: number
  laborCost?: number
  equipmentCost?: number
  indirectCost?: number
  outboundCount?: number
}

interface AbsorptionInfo {
  sumPools?: number
  sourceTotal?: number
  diff?: number
  ok?: boolean
  laborUnmapped?: number
  equipUnmapped?: number
  basis?: string
}

const INDIRECT_BASIS_LABELS: Record<string, string> = {
  by_direct_cost: '按各中心直接成本占比',
  by_driver_volume: '按动因量占比',
  by_slide_equivalent: '按切片当量占比',
}
function getIndirectBasisLabel(basis?: string) {
  if (!basis) return '单一披露基准'
  // 后端在基准信号为 0 时追加 '|equal_fallback'（退化为按中心等分），需拆解显示而非露原始 token
  const [base, fallback] = String(basis).split('|')
  const label = INDIRECT_BASIS_LABELS[base] || base
  return fallback === 'equal_fallback' ? `${label}（基准信号为 0，退化为按中心等分）` : label
}

interface CostPoolQueryOverrides {
  month?: string
  source?: string
  keyword?: string
  page?: number
  pageSize?: number
}

const sourceLabels: Record<string, string> = {
  auto_collect: '自动归集',
  manual: '手工录入',
  sync: '来源同步',
}

const sourceStyles: Record<string, string> = {
  auto_collect: 'bg-blue-50 text-blue-700 border-blue-200',
  manual: 'bg-amber-50 text-amber-700 border-amber-200',
  sync: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

function unwrapList(payload: any): CostPool[] {
  return payload?.list || payload?.items || (Array.isArray(payload) ? payload : [])
}

function getTotal(payload: any, list: CostPool[]) {
  return payload?.pagination?.total ?? payload?.total ?? list.length
}

export function getManualCostPoolValidationMessage(form: ManualCostPoolForm) {
  const directCost = Number(form.directCost)
  const indirectCost = Number(form.indirectCost)
  const driverQuantity = Number(form.driverQuantity)
  if (!form.activityCenterId) {
    return '请选择作业中心，系统才能把手工成本归入正确作业中心和动因费率。'
  }
  if (!Number.isFinite(directCost) || directCost < 0) {
    return '请填写大于等于 0 的直接成本，系统才能计算本期成本池总额。'
  }
  if (!Number.isFinite(indirectCost) || indirectCost < 0) {
    return '请填写大于等于 0 的间接成本，系统才能计算本期成本池总额。'
  }
  if (!Number.isFinite(driverQuantity) || driverQuantity <= 0) {
    return '请填写大于 0 的动因量，系统才能计算动因费率并分摊到项目成本。'
  }
  if (!form.adjustmentReason.trim()) {
    return '请填写调整原因，系统才能留下成本结账和审计依据。'
  }
  return ''
}

export function isManualCostPoolFormReady(form: ManualCostPoolForm) {
  return getManualCostPoolValidationMessage(form) === ''
}

const initialManualForm: ManualCostPoolForm = {
  activityCenterId: '',
  directCost: '',
  indirectCost: '',
  driverQuantity: '',
  adjustmentReason: '',
  sourceDocumentNo: '',
  attachmentUrl: '',
  description: '',
}

export function CostPoolList() {
  const [month, setMonth] = useState(currentMonth())
  const initialKeyword = new URLSearchParams(window.location.search).get('keyword') || ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const [source, setSource] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [total, setTotal] = useState(0)
  const [pools, setPools] = useState<CostPool[]>([])
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [sourceTotals, setSourceTotals] = useState<SourceTotals | null>(null)
  const [absorption, setAbsorption] = useState<AbsorptionInfo | null>(null)
  const [activityCenters, setActivityCenters] = useState<ActivityCenterOption[]>([])
  const [manualModalOpen, setManualModalOpen] = useState(false)
  const [manualForm, setManualForm] = useState<ManualCostPoolForm>(initialManualForm)
  const [manualSubmitting, setManualSubmitting] = useState(false)

  const canWrite = useMemo(() => {
    const role = getUserRole()
    return role === 'admin' || role === 'finance'
  }, [])

  const filteredPools = useMemo(() => {
    const normalized = keyword.trim().toLowerCase()
    if (!normalized) return pools
    return pools.filter(pool =>
      `${pool.id || ''} ${pool.activityCenterName} ${pool.activityCenterCode || ''} ${pool.adjustmentReason || ''} ${pool.sourceDocumentNo || ''} ${pool.attachmentUrl || ''} ${pool.description || ''}`
        .toLowerCase()
        .includes(normalized)
    )
  }, [keyword, pools])

  const totals = useMemo(() => {
    return pools.reduce(
      (acc, pool) => ({
        totalCost: acc.totalCost + Number(pool.totalCost || 0),
        driverQuantity: acc.driverQuantity + Number(pool.driverQuantity || 0),
        directCost: acc.directCost + Number(pool.directCost || 0),
        indirectCost: acc.indirectCost + Number(pool.indirectCost || 0),
      }),
      { totalCost: 0, driverQuantity: 0, directCost: 0, indirectCost: 0 }
    )
  }, [pools])
  const manualSelectedActivityCenter = activityCenters.find(center => center.id === manualForm.activityCenterId)
  const manualDirectCost = Number(manualForm.directCost || 0)
  const manualIndirectCost = Number(manualForm.indirectCost || 0)
  const manualDriverQuantity = Number(manualForm.driverQuantity || 0)
  const manualTotalCost = (
    Number.isFinite(manualDirectCost) ? manualDirectCost : 0
  ) + (
    Number.isFinite(manualIndirectCost) ? manualIndirectCost : 0
  )
  const manualDriverRate = manualDriverQuantity > 0 ? manualTotalCost / manualDriverQuantity : 0
  const manualCostPoolDownstreamFacts = '成本池、动因费率、项目成本、成本结账、审计记录'
  const manualValidationMessage = getManualCostPoolValidationMessage(manualForm)
  const canSubmitManualCostPool = manualValidationMessage === '' && !manualSubmitting

  const loadPools = async (overrides: CostPoolQueryOverrides = {}) => {
    setLoading(true)
    try {
      const payload = await abcApi.getCostPools({
        yearMonth: overrides.month ?? month,
        source: (overrides.source ?? source) || undefined,
        keyword: (overrides.keyword ?? keyword).trim() || undefined,
        page: overrides.page ?? page,
        pageSize: overrides.pageSize ?? pageSize,
      })
      const list = unwrapList(payload)
      setPools(list)
      setTotal(getTotal(payload, list))
    } catch (err) {
      console.error('load cost pools failed', err)
    } finally {
      setLoading(false)
    }
  }

  const loadActivityCenters = async () => {
    try {
      const payload: any = await abcApi.getActivityCenters()
      const list = payload?.list || payload?.items || (Array.isArray(payload) ? payload : [])
      setActivityCenters(list.filter((center: ActivityCenterOption) =>
        center.status === undefined || center.status === 'active' || center.status === 1 || center.status === '1'
      ))
    } catch (err) {
      console.error('load activity centers failed', err)
      setActivityCenters([])
    }
  }

  useEffect(() => {
    loadPools()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, source, keyword, page, pageSize])

  const runAction = async (action: 'sync' | 'auto-collect' | 'recalculate') => {
    setActing(action)
    try {
      const result =
        action === 'sync'
          ? await abcApi.syncCostPools(month)
          : action === 'auto-collect'
            ? await abcApi.autoCollectCostPools(month)
            : await abcApi.recalculateCostPools(month)

      const nextSourceTotals = result?.sourceTotals || result?.collectResult?.sourceTotals || null
      setSourceTotals(nextSourceTotals)
      // L5-2：捕获完全吸收对账与间接基准（auto-collect / recalculate 返回；sync 无）
      setAbsorption(result?.absorption || result?.collectResult?.absorption || null)
      const messages = {
        sync: '费用来源已同步',
        'auto-collect': '成本池已自动归集',
        recalculate: '成本池已重算',
      }
      toast.success(messages[action])
      await loadPools()
    } catch (err) {
      console.error('cost pool action failed', err)
    } finally {
      setActing(null)
    }
  }

  const resetFilters = () => {
    setKeyword('')
    setSource('')
    setPage(1)
  }

  const openManualModal = () => {
    setManualForm(initialManualForm)
    setManualModalOpen(true)
    loadActivityCenters()
  }

  const submitManualCostPool = async () => {
    if (manualValidationMessage) {
      toast.error(manualValidationMessage)
      return
    }
    setManualSubmitting(true)
    try {
      const created: any = await abcApi.createCostPool({
        activityCenterId: manualForm.activityCenterId,
        yearMonth: month,
        directCost: Number(manualForm.directCost),
        indirectCost: Number(manualForm.indirectCost),
        driverQuantity: Number(manualForm.driverQuantity),
        source: 'manual',
        adjustmentReason: manualForm.adjustmentReason.trim(),
        sourceDocumentNo: manualForm.sourceDocumentNo.trim() || undefined,
        attachmentUrl: manualForm.attachmentUrl.trim() || undefined,
        description: manualForm.description.trim() || undefined,
      })
      const selectedCenter = activityCenters.find(center => center.id === manualForm.activityCenterId)
      const nextKeyword = String(
        created?.sourceDocumentNo
        || manualForm.sourceDocumentNo
        || created?.id
        || selectedCenter?.code
        || selectedCenter?.name
        || ''
      ).trim()
      toast.success('手工成本池已保存')
      setManualModalOpen(false)
      setManualForm(initialManualForm)
      setSource('manual')
      setKeyword(nextKeyword)
      setPage(1)
      await loadPools({ source: 'manual', keyword: nextKeyword, page: 1 })
    } catch (err) {
      console.error('manual cost pool failed', err)
      toast.error('手工成本池保存失败')
    } finally {
      setManualSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 border-b border-gray-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">成本池</h1>
          <p className="mt-1 text-sm text-gray-500">
            按期间归集人工、设备、间接费用，形成作业中心动因费率。
          </p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={openManualModal}
              disabled={acting !== null}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              手工录入
            </button>
            <button
              type="button"
              onClick={() => runAction('sync')}
              disabled={acting !== null}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Database className="h-4 w-4" />
              同步来源
            </button>
            <button
              type="button"
              onClick={() => runAction('auto-collect')}
              disabled={acting !== null}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Calculator className="h-4 w-4" />
              自动归集
            </button>
            <button
              type="button"
              onClick={() => runAction('recalculate')}
              disabled={acting !== null}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCcw className="h-4 w-4" />
              重算快照
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium text-gray-500">成本池总额</div>
          <div className="mt-2 text-xl font-semibold text-gray-900">{formatCurrency(totals.totalCost)}</div>
        </div>
        <div className="border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium text-gray-500">直接成本</div>
          <div className="mt-2 text-xl font-semibold text-gray-900">{formatCurrency(totals.directCost)}</div>
        </div>
        <div className="border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium text-gray-500">间接成本</div>
          <div className="mt-2 text-xl font-semibold text-gray-900">{formatCurrency(totals.indirectCost)}</div>
        </div>
        <div className="border border-gray-200 bg-white p-4">
          <div className="text-xs font-medium text-gray-500">动因量</div>
          <div className="mt-2 text-xl font-semibold text-gray-900">{formatNumber(totals.driverQuantity, 0)}</div>
        </div>
      </div>

      {sourceTotals && (
        <div className="grid gap-3 border border-blue-100 bg-blue-50/50 p-4 md:grid-cols-5">
          <SourceTotal label="出库数" value={formatNumber(sourceTotals.outboundCount, 0)} />
          <SourceTotal label="样本量" value={formatNumber(sourceTotals.sampleCount, 0)} />
          <SourceTotal label="人工来源" value={formatCurrency(sourceTotals.laborCost)} />
          <SourceTotal label="设备来源" value={formatCurrency(sourceTotals.equipmentCost)} />
          <SourceTotal label="间接来源" value={formatCurrency(sourceTotals.indirectCost)} />
        </div>
      )}

      {/* L5-2 完全吸收对账 + 间接基准披露（CHAIN-06 / CHAIN-09）：归集后明示 Σ池=Σ来源 与间接分摊基准 */}
      {absorption && (
        <div className={cn(
          'flex flex-col gap-2 rounded-lg border p-4 lg:flex-row lg:items-center lg:justify-between',
          absorption.ok ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'
        )}>
          <div className="text-sm">
            <span className={cn('font-medium', absorption.ok ? 'text-emerald-800' : 'text-amber-800')}>
              {absorption.ok ? '✓ 完全吸收：Σ池 = Σ来源' : '⚠ 未完全吸收（关账将被阻断）'}
            </span>
            <span className="ml-2 text-gray-600">
              Σ池 {formatCurrency(absorption.sumPools)} / Σ来源 {formatCurrency(absorption.sourceTotal)}
              {!absorption.ok && <> · 差额 {formatCurrency(absorption.diff)}</>}
            </span>
            {!absorption.ok && (Number(absorption.laborUnmapped) > 0 || Number(absorption.equipUnmapped) > 0) && (
              <span className="ml-2 text-xs text-amber-700">
                （未映射来源：人工 {formatCurrency(absorption.laborUnmapped)} / 设备 {formatCurrency(absorption.equipUnmapped)}）
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500">
            间接费分摊基准：<span className="font-medium text-gray-700">{getIndirectBasisLabel(absorption.basis)}</span>（估算，非精确归集）
          </div>
        </div>
      )}

      <div className="border border-gray-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-gray-200 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
              成本期间
              <input
                type="month"
                value={month}
                onChange={event => {
                  setMonth(event.target.value)
                  setPage(1)
                }}
                className="h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-500">
              来源
              <select
                value={source}
                onChange={event => {
                  setSource(event.target.value)
                  setPage(1)
                }}
                className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
              >
                <option value="">全部来源</option>
                <option value="auto_collect">自动归集</option>
                <option value="manual">手工录入</option>
                <option value="sync">来源同步</option>
              </select>
            </label>
            <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-xs font-medium text-gray-500">
              搜索
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  value={keyword}
                  onChange={event => {
                    setKeyword(event.target.value)
                    setPage(1)
                  }}
                  placeholder="作业中心 / 编码 / 说明"
                  className="h-10 w-full rounded-md border border-gray-300 pl-9 pr-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                />
              </div>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadPools()}
              disabled={loading}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              刷新
            </button>
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex h-10 items-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              重置
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <Th>作业中心</Th>
                <Th>来源</Th>
                <Th align="right">直接成本</Th>
                <Th align="right">间接成本</Th>
                <Th align="right">总成本</Th>
                <Th align="right">动因量</Th>
                <Th align="right">动因费率</Th>
                <Th>计算公式</Th>
                <Th>调整依据</Th>
                <Th>说明</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-sm text-gray-500">加载中...</td>
                </tr>
              ) : filteredPools.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-sm text-gray-500">
                    暂无成本池数据，可先执行自动归集。
                  </td>
                </tr>
              ) : (
                filteredPools.map(pool => (
                  <tr key={pool.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">{pool.activityCenterName}</div>
                      <div className="text-xs text-gray-500">{pool.activityCenterCode || '-'}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={cn(
                        'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium',
                        sourceStyles[pool.source || ''] || 'border-gray-200 bg-gray-50 text-gray-600'
                      )}>
                        {sourceLabels[pool.source || ''] || pool.source || '-'}
                      </span>
                    </td>
                    <Td align="right">{formatCurrency(pool.directCost)}</Td>
                    <Td align="right">{formatCurrency(pool.indirectCost)}</Td>
                    <Td align="right" strong>{formatCurrency(pool.totalCost)}</Td>
                    <Td align="right">{formatNumber(pool.driverQuantity, 0)}</Td>
                    <Td align="right" strong>{formatCurrency(pool.driverRate)}</Td>
                    <td className="min-w-[240px] px-4 py-3 text-sm text-gray-700">
                      总成本 / 动因量 = {formatCurrency(pool.totalCost)} / {formatNumber(pool.driverQuantity, 0)}
                    </td>
                    <td className="min-w-[220px] px-4 py-3 text-sm text-gray-600">
                      {pool.adjustmentReason ? (
                        <div className="space-y-1">
                          <div>{pool.adjustmentReason}</div>
                          <div className="text-xs text-gray-400">{pool.sourceDocumentNo || pool.attachmentUrl || '-'}</div>
                        </div>
                      ) : '-'}
                    </td>
                    <td className="min-w-[220px] px-4 py-3 text-sm text-gray-500">
                      {pool.description || '按本期来源自动归集'}
                    </td>
                  </tr>
                ))
              )}
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

      {manualModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-20">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="shrink-0 border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">手工录入成本池</h2>
              <p className="mt-1 text-sm text-gray-500">手工成本会影响本期动因费率，必须说明调整原因。</p>
            </div>
            <div className="grid overflow-y-auto px-6 py-5 sm:grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 sm:col-span-2">
                作业中心
                <select
                  value={manualForm.activityCenterId}
                  onChange={event => setManualForm(form => ({ ...form, activityCenterId: event.target.value }))}
                  className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                >
                  <option value="">请选择作业中心</option>
                  {activityCenters.map(center => (
                    <option key={center.id} value={center.id}>{center.name} ({center.code || '-'})</option>
                  ))}
                </select>
              </label>
              <ManualInput label="直接成本" value={manualForm.directCost} onChange={value => setManualForm(form => ({ ...form, directCost: value }))} />
              <ManualInput label="间接成本" value={manualForm.indirectCost} onChange={value => setManualForm(form => ({ ...form, indirectCost: value }))} />
              <ManualInput label="动因量" value={manualForm.driverQuantity} onChange={value => setManualForm(form => ({ ...form, driverQuantity: value }))} />
              <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
                来源单据
                <input
                  value={manualForm.sourceDocumentNo}
                  onChange={event => setManualForm(form => ({ ...form, sourceDocumentNo: event.target.value }))}
                  placeholder="如：FIN-ADJ-202606"
                  className="h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 sm:col-span-2">
                调整原因 <span className="text-xs font-normal text-red-500">必填</span>
                <textarea
                  value={manualForm.adjustmentReason}
                  onChange={event => setManualForm(form => ({ ...form, adjustmentReason: event.target.value }))}
                  rows={3}
                  placeholder="例如：月末人工成本补录，经财务复核调整本期成本池"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 sm:col-span-2">
                附件或凭证链接
                <input
                  value={manualForm.attachmentUrl}
                  onChange={event => setManualForm(form => ({ ...form, attachmentUrl: event.target.value }))}
                  placeholder="可填写共享文件链接或凭证编号"
                  className="h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 sm:col-span-2">
                说明
                <textarea
                  value={manualForm.description}
                  onChange={event => setManualForm(form => ({ ...form, description: event.target.value }))}
                  rows={2}
                  placeholder="显示在成本池列表的补充说明"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
                />
              </label>
              <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3 sm:col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-emerald-900">成本池结果确认</div>
                  <div className="text-xs text-emerald-700">确认后将接住：{manualCostPoolDownstreamFacts}</div>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-emerald-700 sm:grid-cols-2">
                  <div>作业中心 {manualSelectedActivityCenter?.name || '待选择'}</div>
                  <div>直接成本 {formatCurrency(Number.isFinite(manualDirectCost) ? manualDirectCost : 0)}</div>
                  <div>间接成本 {formatCurrency(Number.isFinite(manualIndirectCost) ? manualIndirectCost : 0)}</div>
                  <div>总成本 {formatCurrency(manualTotalCost)}</div>
                  <div>动因量 {Number.isFinite(manualDriverQuantity) ? formatNumber(manualDriverQuantity, 2) : '0.00'}</div>
                  <div>动因费率 {formatCurrency(manualDriverRate)} / 单位动因</div>
                  <div>来源单据 {manualForm.sourceDocumentNo.trim() || '-'}</div>
                  <div>调整原因 {manualForm.adjustmentReason.trim() || '待填写'}</div>
                </div>
              </div>
              {manualValidationMessage ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 sm:col-span-2">
                  {manualValidationMessage}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end gap-3 border-t border-gray-200 px-6 py-4">
              <button
                type="button"
                onClick={() => setManualModalOpen(false)}
                className="h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitManualCostPool}
                disabled={!canSubmitManualCostPool}
                className="h-10 rounded-md bg-amber-600 px-4 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {manualSubmitting ? '保存中...' : '保存成本池'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ManualInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
      {label}
      <input
        type="number"
        min="0"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10"
      />
    </label>
  )
}

function SourceTotal({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-blue-700">{label}</div>
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

function Td({
  children,
  align = 'left',
  strong = false,
}: {
  children: ReactNode
  align?: 'left' | 'right'
  strong?: boolean
}) {
  return (
    <td className={cn(
      'whitespace-nowrap px-4 py-3 text-sm text-gray-700',
      align === 'right' && 'text-right',
      strong && 'font-semibold text-gray-900'
    )}>
      {children}
    </td>
  )
}

export default CostPoolList
