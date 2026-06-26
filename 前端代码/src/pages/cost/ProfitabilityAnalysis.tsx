import React, { useState, useEffect } from 'react'
import { AlertTriangle, Download, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { downloadTextFile, formatCurrency } from '@/lib/utils'

interface ProfitabilityData {
  projectId: string
  projectName: string
  projectType: string
  caseCount: number
  sampleCount: number
  materialCost: number
  activityCost: number
  totalCost: number
  feeAmount: number
  profit: number
  profitRate: number
}

interface InsightQuality {
  yearMonth: string
  periodStatus: string
  isClosed: boolean
  isFinal: boolean
  openExceptionCount: number
  pendingCostCount: number
  abcSnapshotCount: number
  outboundCount: number
  reliability: 'final' | 'attention' | 'draft'
  message: string
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

export function aggregateProfitabilityRows(rows: any[], month: string, projectType: string): ProfitabilityData[] {
  const projectMap = new Map<string, ProfitabilityData>()

  for (const row of rows) {
    if (row.costMonth && row.costMonth !== month) continue
    if (projectType !== 'all' && row.projectType !== projectType) continue

    const projectId = row.projectId || row.outboundId || `unknown-${projectMap.size}`
    const existing = projectMap.get(projectId) || {
      projectId,
      projectName: row.projectName || '未关联项目',
      projectType: row.projectType || '',
      caseCount: 0,
      sampleCount: 0,
      materialCost: 0,
      activityCost: 0,
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
    existing.profitRate = existing.feeAmount > 0 ? existing.profit / existing.feeAmount : 0
    projectMap.set(projectId, existing)
  }

  return [...projectMap.values()]
}

export function ProfitabilityAnalysis() {
  const [data, setData] = useState<ProfitabilityData[]>([])
  const [loading, setLoading] = useState(true)
  const [projectType, setProjectType] = useState<string>('all')
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [exporting, setExporting] = useState(false)
  const [insightQuality, setInsightQuality] = useState<InsightQuality | null>(null)

  useEffect(() => {
    loadProfitabilityData()
  }, [projectType, month])

  const loadProfitabilityData = async () => {
    try {
      setLoading(true)
      const res = await abcApi.getProfitability({
        dimension: 'project',
        startDate: month,
        endDate: month,
        projectType: projectType !== 'all' ? projectType : undefined,
        pageSize: 1000,
      })
      const rows = Array.isArray(res) ? res : res?.list || res?.items || []
      setData(aggregateProfitabilityRows(rows, month, projectType))
      setInsightQuality(Array.isArray(res) ? null : res?.insightQuality || null)
    } catch {
      toast.error('加载盈利性分析数据失败')
    } finally {
      setLoading(false)
    }
  }

  const summary = {
    totalProjects: data.length,
    totalSamples: data.reduce((sum, d) => sum + (d.sampleCount || 0), 0),
    totalCost: data.reduce((sum, d) => sum + (d.totalCost || 0), 0),
    totalFee: data.reduce((sum, d) => sum + (d.feeAmount || 0), 0),
    totalProfit: data.reduce((sum, d) => sum + (d.profit || 0), 0),
  }
  const avgProfitRate = summary.totalFee > 0 ? summary.totalProfit / summary.totalFee : 0

  const sortedData = [...data].sort((a, b) => (b.profitRate || 0) - (a.profitRate || 0))

  const getProfitRateColor = (rate: number) => {
    if (rate >= 0.2) return 'bg-green-100 text-green-800'
    if (rate >= 0) return 'bg-yellow-100 text-yellow-800'
    return 'bg-red-100 text-red-800'
  }

  const getProfitIcon = (profit: number) => {
    if (profit > 0) return <TrendingUp className="h-4 w-4 text-green-500" />
    if (profit < 0) return <TrendingDown className="h-4 w-4 text-red-500" />
    return <Minus className="h-4 w-4 text-gray-400" />
  }

  const handleExport = async () => {
    try {
      setExporting(true)
      const exported = await abcApi.exportData({
        month,
        projectType: projectType !== 'all' ? projectType : undefined,
      })
      downloadTextFile(exported.filename || 'abc-profitability.csv', exported.content || '', exported.mimeType)
      toast.success('导出完成')
    } catch {
      // 统一错误提示已在请求拦截器处理
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">盈利性分析</h1>
          <p className="text-sm text-gray-500 mt-1">分析各检测项目的成本与收费对比</p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          <Download className="h-4 w-4" /> 导出报表
        </button>
      </div>

      {insightQuality && !insightQuality.isFinal && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">口径待确认</div>
              <div className="mt-1">{insightQuality.message}</div>
              <div className="mt-2 text-xs text-amber-700">
                成本期间 {insightQuality.yearMonth}，成本快照 {insightQuality.abcSnapshotCount} 条，开放异常 {insightQuality.openExceptionCount} 条，未补算 {insightQuality.pendingCostCount} 单。
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 汇总卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">项目总数</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{summary.totalProjects}</div>
          <div className="text-xs text-gray-400 mt-1">样本总数：{summary.totalSamples.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总成本</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary.totalCost)}</div>
          <div className="text-xs text-gray-400 mt-1">单样本：{summary.totalSamples > 0 ? formatCurrency(summary.totalCost / summary.totalSamples) : '-'}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总收入</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary.totalFee)}</div>
          <div className="text-xs text-gray-400 mt-1">单样本：{summary.totalSamples > 0 ? formatCurrency(summary.totalFee / summary.totalSamples) : '-'}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总利润</div>
          <div className={`text-2xl font-bold mt-1 ${summary.totalProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(summary.totalProfit)}
          </div>
          <div className="text-xs text-gray-400 mt-1">平均利润率：{(avgProfitRate * 100).toFixed(1)}%</div>
        </div>
      </div>

      {/* 筛选 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex gap-4">
          <select
            value={projectType}
            onChange={(e) => setProjectType(e.target.value)}
            className="h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {PROJECT_TYPE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
        </div>
      </div>

      {/* 表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">项目名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">项目类型</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">样本数</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">总成本</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">总收入</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">利润</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">利润率</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">单样本成本</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">单样本收入</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">加载中...</td></tr>
            ) : sortedData.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">暂无数据</td></tr>
            ) : (
              sortedData.map(item => (
                <tr key={item.projectId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.projectName}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{getProjectTypeLabel(item.projectType)}</td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">{item.sampleCount?.toLocaleString()}</td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.totalCost)}</td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.feeAmount)}</td>
                  <td className="px-4 py-3 text-sm text-right">
                    <div className="flex items-center justify-end gap-1">
                      {getProfitIcon(item.profit)}
                      <span className={`font-medium ${item.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency(item.profit)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-right">
                    <span className={`px-2 py-1 rounded-full text-xs ${getProfitRateColor(item.profitRate || 0)}`}>
                      {((item.profitRate || 0) * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">
                    {item.sampleCount > 0 ? formatCurrency(item.totalCost / item.sampleCount) : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">
                    {item.sampleCount > 0 ? formatCurrency(item.feeAmount / item.sampleCount) : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
