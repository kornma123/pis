import React, { useState, useEffect, useCallback } from 'react'
import { Download, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { downloadTextFile, formatCurrency, formatDate } from '@/lib/utils'
import { ProfitBadge } from '@/components/ui/ProfitBadge'
import { Pagination } from '@/components/ui/Pagination'

interface FeeRecord {
  outboundId: string
  outboundNo: string
  date: string
  projectName: string
  projectType: string
  sampleCount: number
  materialCost: number
  activityCost: number
  totalCost: number
  feeAmount: number
  profit: number
  profitRate: number
  feeStandardName: string | null
  feeCategory: string | null
}

interface FeeSummary {
  totalOutbounds: number
  totalCost: number
  totalFee: number
  totalProfit: number
  lossCount: number
  noMappingCount: number
}

const PROJECT_TYPE_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'ihc', label: '免疫组化' },
  { value: 'he', label: 'HE染色' },
  { value: 'ss', label: '特殊染色' },
  { value: 'mp', label: '分子病理' },
  { value: 'cyto', label: '细胞病理' },
]

const PROFIT_FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'loss', label: '亏损' },
  { value: 'profitable', label: '盈利' },
]

const MAPPING_FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'unmapped', label: '未映射' },
  { value: 'mapped', label: '已映射' },
]

function getProjectTypeLabel(projectTypeValue: string) {
  return PROJECT_TYPE_OPTIONS.find(option => option.value === projectTypeValue)?.label || projectTypeValue
}

function escapeCsvValue(value: string | number | undefined | null) {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function normalizeFeeComparisonResponse(res: any) {
  const list = Array.isArray(res) ? res : res?.list || []
  const summary = Array.isArray(res) ? null : res?.summary || null
  const total = Array.isArray(res) ? list.length : res?.pagination?.total || list.length
  return { list, summary, total }
}

function buildFeeComparisonExportCsv(rows: FeeRecord[]) {
  const headers = [
    '出库单号',
    '日期',
    '项目',
    '项目类型',
    '样本数',
    '物料成本',
    '作业成本',
    '总成本',
    '收费',
    '利润',
    '利润率',
    '收费标准',
  ]
  const body = rows.map(item => [
    item.outboundNo,
    formatDate(item.date),
    item.projectName,
    getProjectTypeLabel(item.projectType),
    item.sampleCount,
    item.materialCost,
    item.activityCost,
    item.totalCost,
    item.feeAmount,
    item.profit,
    `${(item.profitRate * 100).toFixed(1)}%`,
    item.feeStandardName || '未映射',
  ])
  return [headers, ...body]
    .map(row => row.map(escapeCsvValue).join(','))
    .join('\n')
}

export default function FeeComparison() {
  const [loading, setLoading] = useState(true)
  const [list, setList] = useState<FeeRecord[]>([])
  const [summary, setSummary] = useState<FeeSummary | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)

  // 筛选
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [projectType, setProjectType] = useState('all')
  const [profitFilter, setProfitFilter] = useState('all')
  const [mappingFilter, setMappingFilter] = useState('all')
  const [exporting, setExporting] = useState(false)

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const params: Record<string, string | number> = { page, pageSize }
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate
      if (projectType !== 'all') params.projectType = projectType
      if (profitFilter !== 'all') params.profitFilter = profitFilter
      if (mappingFilter !== 'all') params.mappingFilter = mappingFilter

      const res = await abcApi.getFeeComparison(params)
      const normalized = normalizeFeeComparisonResponse(res)
      setList(normalized.list)
      setSummary(normalized.summary)
      setTotal(normalized.total)
    } catch {
      toast.error('加载收费对照数据失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, startDate, endDate, projectType, profitFilter, mappingFilter])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSearch = () => {
    if (page === 1) {
      loadData()
      return
    }
    setPage(1)
  }

  const handleExport = async () => {
    try {
      setExporting(true)
      const params: Record<string, string | number> = {
        page: 1,
        pageSize: Math.max(total || list.length || pageSize, pageSize),
      }
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate
      if (projectType !== 'all') params.projectType = projectType
      if (profitFilter !== 'all') params.profitFilter = profitFilter
      if (mappingFilter !== 'all') params.mappingFilter = mappingFilter
      const res = await abcApi.getFeeComparison(params)
      const rows = normalizeFeeComparisonResponse(res).list
      downloadTextFile('abc-fee-comparison.csv', buildFeeComparisonExportCsv(rows), 'text/csv;charset=utf-8')
      toast.success('导出完成')
    } catch {
      toast.error('导出收费对照数据失败')
    } finally {
      setExporting(false)
    }
  }

  const alerts: { type: string; message: string }[] = []
  if (summary) {
    if (summary.lossCount > 0) {
      alerts.push({ type: 'loss', message: `${summary.lossCount} 条记录亏损` })
    }
    if (summary.noMappingCount > 0) {
      alerts.push({ type: 'no_mapping', message: `${summary.noMappingCount} 条记录未配置收费标准` })
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">收费对照</h1>
          <p className="text-sm text-gray-500 mt-1">出库记录的成本与收费对比分析</p>
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

      {/* 汇总卡片 */}
      <div data-testid="summary-cards" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">出库记录</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{summary?.totalOutbounds || 0}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总成本</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary?.totalCost)}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总收入</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary?.totalFee)}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总利润</div>
          <div className={`text-2xl font-bold mt-1 ${(summary?.totalProfit || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(summary?.totalProfit)}
          </div>
        </div>
      </div>

      {/* 异常提醒 */}
      {alerts.length > 0 && (
        <div data-testid="alert-banner" className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            {alerts.map((alert, i) => (
              <div key={i} className="text-sm text-amber-800">{alert.message}</div>
            ))}
          </div>
        </div>
      )}

      {/* 筛选栏 */}
      <div data-testid="filter-bar" className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">开始日期</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">结束日期</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">项目类型</label>
            <select
              value={projectType}
              onChange={e => { setProjectType(e.target.value); setPage(1) }}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            >
              {PROJECT_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">盈亏筛选</label>
            <select
              value={profitFilter}
              onChange={e => { setProfitFilter(e.target.value); setPage(1) }}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            >
              {PROFIT_FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">映射状态</label>
            <select
              value={mappingFilter}
              onChange={e => { setMappingFilter(e.target.value); setPage(1) }}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            >
              {MAPPING_FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleSearch}
            className="h-10 px-4 text-sm text-white bg-[#3b82f6] rounded-md hover:bg-blue-600 transition-colors"
          >
            查询
          </button>
        </div>
      </div>

      {/* 明细表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">出库单号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">日期</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">项目</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">样本数</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">物料成本</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">作业成本</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">总成本</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">收费</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">利润</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">利润率</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">收费标准</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-gray-400">加载中...</td></tr>
              ) : list.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-gray-400">暂无数据</td></tr>
              ) : (
                list.map(item => (
                  <tr key={item.outboundId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-mono text-gray-900">{item.outboundNo}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{formatDate(item.date)}</td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">{item.projectName}</div>
                      <div className="text-xs text-gray-400">{getProjectTypeLabel(item.projectType)}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{item.sampleCount}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.materialCost)}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.activityCost)}</td>
                    <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">{formatCurrency(item.totalCost)}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.feeAmount)}</td>
                    <td className={`px-4 py-3 text-sm text-right font-medium ${item.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(item.profit)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ProfitBadge rate={item.profitRate} />
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {item.feeStandardName || <span className="text-gray-400">未映射</span>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChangePage={setPage}
          onChangePageSize={setPageSize}
        />
      </div>
    </div>
  )
}
