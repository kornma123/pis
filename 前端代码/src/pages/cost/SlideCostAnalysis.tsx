import React, { Fragment, useState, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, Download, Info } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { downloadTextFile, formatCurrency } from '@/lib/utils'
import { ProfitBadge } from '@/components/ui/ProfitBadge'
import { CostWaterfall } from '@/components/ui/CostWaterfall'
import { Pagination } from '@/components/ui/Pagination'

interface BomProfit {
  bomId: string
  bomName: string
  projectType: string
  caseCount: number
  sampleCount: number
  materialCost: number
  activityCost: number
  avgCostPerSlide: number
  totalCost: number
  feeAmount: number
  profit: number
  profitRate: number
}

const PROJECT_TYPE_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'ihc', label: '免疫组化' },
  { value: 'he', label: 'HE染色' },
  { value: 'ss', label: '特殊染色' },
  { value: 'mp', label: '分子病理' },
  { value: 'cyto', label: '细胞病理' },
]

function getProjectTypeLabel(projectTypeValue: string) {
  return PROJECT_TYPE_OPTIONS.find(option => option.value === projectTypeValue)?.label || projectTypeValue
}

const DRIVER_TYPE_LABELS: Record<string, string> = {
  block_count: '蜡块数',
  slide_count: '切片数',
  case_count: '病例数',
  sample_count: '样本数',
  stain_count: '染色次数',
  probe_count: '探针数',
  report_count: '报告数',
  test_count: '检测次数',
  machine_minute: '机器分钟',
}
function getDriverTypeLabel(driverType?: string | null) {
  if (!driverType) return '—'
  return DRIVER_TYPE_LABELS[driverType] || driverType
}

interface ActivityBreakdownRow {
  activityCenterId: string
  activityCenterName: string
  activityCenterCode: string
  driverType: string | null
  driverQuantity: number
  driverRate: number
  rateSource: string
  allocatedCost: number
}

function escapeCsvValue(value: string | number) {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildSlideCostExportCsv(rows: BomProfit[]) {
  const headers = [
    'BOM/项目名称',
    '项目类型',
    '病例数',
    '样本数',
    '物料成本',
    '作业成本',
    '切片均成本',
    '总成本',
    '总收入',
    '利润',
    '利润率',
  ]
  const body = rows.map(item => [
    item.bomName,
    getProjectTypeLabel(item.projectType),
    item.caseCount,
    item.sampleCount,
    item.materialCost,
    item.activityCost,
    item.avgCostPerSlide,
    item.totalCost,
    item.feeAmount,
    item.profit,
    `${(item.profitRate * 100).toFixed(1)}%`,
  ])
  return [headers, ...body]
    .map(row => row.map(escapeCsvValue).join(','))
    .join('\n')
}

export function normalizeProfitabilityRows(rows: any[], month: string, projectType: string): BomProfit[] {
  const groups = new Map<string, BomProfit>()

  for (const row of rows) {
    if (row.costMonth && row.costMonth !== month) continue
    if (projectType !== 'all' && row.projectType !== projectType) continue

    const key = row.bomId || row.projectId || row.outboundId || `unknown-${groups.size}`
    const existing = groups.get(key) || {
      bomId: key,
      bomName: row.bomName || row.projectName || row.outboundId || '未关联项目',
      projectType: row.projectType || '',
      caseCount: 0,
      sampleCount: 0,
      materialCost: 0,
      activityCost: 0,
      avgCostPerSlide: 0,
      totalCost: 0,
      feeAmount: 0,
      profit: 0,
      profitRate: 0,
    }

    existing.caseCount += Number(row.caseCount) || 1
    existing.sampleCount += Number(row.sampleCount) || 0
    existing.materialCost += Number(row.materialCost) || 0
    existing.activityCost += Number(row.activityCost) || 0
    existing.totalCost += Number(row.totalCost) || 0
    existing.feeAmount += Number(row.feeAmount) || 0
    existing.profit += Number(row.profit) || 0
    existing.avgCostPerSlide = existing.sampleCount > 0 ? existing.totalCost / existing.sampleCount : 0
    existing.profitRate = existing.feeAmount > 0 ? existing.profit / existing.feeAmount : 0
    groups.set(key, existing)
  }

  return [...groups.values()].sort((a, b) => b.totalCost - a.totalCost)
}

export default function SlideCostAnalysis() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<BomProfit[]>([])
  const [projectType, setProjectType] = useState('all')
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [breakdowns, setBreakdowns] = useState<Record<string, ActivityBreakdownRow[]>>({})
  const [breakdownLoading, setBreakdownLoading] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    loadData()
  }, [projectType, month])

  const loadData = async () => {
    try {
      setLoading(true)
      setExpandedId(null)
      setBreakdowns({})
      const params: Record<string, string | number> = { dimension: 'bom', startDate: month, endDate: month, pageSize: 1000 }
      if (projectType !== 'all') params.projectType = projectType
      const res = await abcApi.getProfitability(params)
      const rows = Array.isArray(res) ? res : res?.list || res?.items || []
      setData(normalizeProfitabilityRows(rows, month, projectType))
    } catch {
      toast.error('加载切片成本数据失败')
    } finally {
      setLoading(false)
    }
  }

  const summary = useMemo(() => {
    const totalCost = data.reduce((s, d) => s + d.totalCost, 0)
    const totalFee = data.reduce((s, d) => s + d.feeAmount, 0)
    const totalProfit = data.reduce((s, d) => s + d.profit, 0)
    const totalSamples = data.reduce((s, d) => s + d.sampleCount, 0)
    const avgCostPerSlide = totalSamples > 0 ? totalCost / totalSamples : 0
    const profitRate = totalFee > 0 ? totalProfit / totalFee : 0
    return { totalCost, totalFee, totalProfit, totalSamples, avgCostPerSlide, profitRate }
  }, [data])

  const pagedData = useMemo(() => {
    const start = (page - 1) * pageSize
    return data.slice(start, start + pageSize)
  }, [data, page, pageSize])

  const toggleExpand = async (bomId: string) => {
    const next = expandedId === bomId ? null : bomId
    setExpandedId(next)
    if (next && !breakdowns[bomId]) {
      try {
        setBreakdownLoading(bomId)
        const res: any = await abcApi.getBomActivityBreakdown({ bomId, startDate: month, endDate: month })
        const rows = (res?.breakdown || res?.data?.breakdown || []) as ActivityBreakdownRow[]
        setBreakdowns(prev => ({ ...prev, [bomId]: rows }))
      } catch {
        setBreakdowns(prev => ({ ...prev, [bomId]: [] }))
      } finally {
        setBreakdownLoading(null)
      }
    }
  }

  const handleExport = async () => {
    try {
      setExporting(true)
      downloadTextFile(`abc-slide-cost-${month}.csv`, buildSlideCostExportCsv(data), 'text/csv;charset=utf-8')
      toast.success('导出完成')
    } catch {
      toast.error('导出切片成本数据失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">切片成本明细</h1>
          <p className="text-sm text-gray-500 mt-1">按 BOM 维度分析每张切片的成本构成</p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center gap-2 self-start"
        >
          <Download className="h-4 w-4" /> 导出
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总成本</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary.totalCost)}</div>
          <div className="text-xs text-gray-400 mt-1">{summary.totalSamples} 片</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总收入</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary.totalFee)}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总利润</div>
          <div className={`text-2xl font-bold mt-1 ${summary.totalProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(summary.totalProfit)}
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">平均切片成本</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary.avgCostPerSlide)}</div>
          <div className="mt-1"><ProfitBadge rate={summary.profitRate} /></div>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap gap-4">
          <select
            value={projectType}
            onChange={e => { setProjectType(e.target.value); setPage(1) }}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {PROJECT_TYPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <input
            type="month"
            value={month}
            onChange={e => { setMonth(e.target.value); setPage(1) }}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
        </div>
      </div>

      {/* L5-4 间接费口径披露（CHAIN-09 间接诚实 / ADOPT-05 可解释）：不假装精确，明确标注为单一基准分摊估算 */}
      <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
        <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
        <p className="text-sm text-gray-600 leading-relaxed">
          <span className="font-medium text-gray-700">作业成本含间接费分摊估算。</span>
          间接费用（房租/水电/管理等）无法精确追溯到单张切片，按<span className="font-medium">单一披露基准（默认：各中心直接成本占比）</span>分摊，为估算值而非精确归集；
          材料与可追溯作业成本（人工/设备）按真实动因逐中心归集。
        </p>
      </div>

      {/* 明细表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="w-8 px-2" />
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">BOM/项目名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">项目类型</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">样本数</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">切片均成本</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">总成本</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">总收入</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">利润</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">利润率</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">加载中...</td></tr>
            ) : pagedData.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">暂无数据</td></tr>
            ) : (
              pagedData.map(item => (
                <Fragment key={item.bomId}>
                  <tr
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => toggleExpand(item.bomId)}
                  >
                    <td className="px-2 py-3 text-center">
                      {expandedId === item.bomId
                        ? <ChevronDown className="h-4 w-4 text-gray-400" />
                        : <ChevronRight className="h-4 w-4 text-gray-400" />}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.bomName}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{getProjectTypeLabel(item.projectType)}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{item.sampleCount?.toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.avgCostPerSlide)}</td>
                    <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">{formatCurrency(item.totalCost)}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.feeAmount)}</td>
                    <td className={`px-4 py-3 text-sm text-right font-medium ${item.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(item.profit)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ProfitBadge rate={item.profitRate} />
                    </td>
                  </tr>
                  {expandedId === item.bomId && (
                    <tr>
                      <td colSpan={9} className="px-8 py-4 bg-gray-50">
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                          <div className="max-w-xl">
                            <h4 className="text-sm font-medium text-gray-700 mb-3">成本构成</h4>
                            <CostWaterfall
                              items={[
                                { name: '物料成本（真实用量×批次价）', cost: item.materialCost || 0, color: 'bg-blue-500' },
                                { name: '作业成本（含单一基准间接估算）', cost: item.activityCost || 0, color: 'bg-emerald-500' },
                              ]}
                            />
                            <p className="text-xs text-gray-400 mt-2">
                              作业成本 = 人工/设备按真实动因逐中心归集 + 间接费按单一披露基准分摊估算。
                            </p>
                          </div>

                          {/* L5-3 逐中心作业动因分解（CHAIN-07 可解释）：哪个作业中心按哪个动因以哪个费率消耗多少 */}
                          <div>
                            <h4 className="text-sm font-medium text-gray-700 mb-3">作业动因分解（逐中心）</h4>
                            {breakdownLoading === item.bomId ? (
                              <div className="text-sm text-gray-400 py-4">加载动因明细...</div>
                            ) : (breakdowns[item.bomId]?.length ?? 0) === 0 ? (
                              <div className="text-sm text-gray-400 py-4">
                                {(item.activityCost || 0) > 0
                                  ? '本期该 BOM 未生成逐中心明细（历史快照，重算后可还原动因分解）。'
                                  : '纯材料 BOM，无作业成本分摊。'}
                              </div>
                            ) : (
                              <>
                                {breakdowns[item.bomId].some(c => c.rateSource === 'legacy') && (
                                  <p className="text-xs text-amber-600 mb-2">历史快照：仅有逐中心分摊额，缺动因量/费率明细（重算后可还原）。</p>
                                )}
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-xs text-gray-500 border-b border-gray-200">
                                      <th className="text-left font-medium py-2">作业中心</th>
                                      <th className="text-left font-medium py-2">动因</th>
                                      <th className="text-right font-medium py-2">动因量</th>
                                      <th className="text-right font-medium py-2">费率</th>
                                      <th className="text-right font-medium py-2">分摊成本</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {breakdowns[item.bomId].map(center => {
                                      const isLegacy = center.rateSource === 'legacy'
                                      return (
                                        <tr key={center.activityCenterId}>
                                          <td className="py-2 text-gray-700">{center.activityCenterName}</td>
                                          <td className="py-2 text-gray-500">{getDriverTypeLabel(center.driverType)}</td>
                                          <td className="py-2 text-right text-gray-500">{isLegacy ? '—' : center.driverQuantity?.toLocaleString()}</td>
                                          <td className="py-2 text-right text-gray-500">
                                            {isLegacy
                                              ? <span className="text-gray-400">历史</span>
                                              : center.driverRate > 0
                                                ? formatCurrency(center.driverRate)
                                                : <span className="text-amber-600">无费率</span>}
                                          </td>
                                          <td className="py-2 text-right font-medium text-gray-900">{formatCurrency(center.allocatedCost)}</td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>

        {data.length > pageSize && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.length}
            onChangePage={setPage}
            onChangePageSize={setPageSize}
          />
        )}
      </div>
    </div>
  )
}
