import React, { useState, useEffect } from 'react'
import { Search, TrendingUp, AlertTriangle, Download } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { downloadTextFile, formatCurrency } from '@/lib/utils'

interface VarianceSummary {
  totalActual: number
  // 标准/差异/差异率后端恒返回 null（未校准），本页不渲染，故不纳入类型（避免死字段）。
  standardCalibrated?: boolean
  recordCount?: number
}

interface VarianceItem {
  id?: string
  projectId: string
  projectName: string
  groupType?: 'project' | 'month' | 'bom'
  bomId?: string
  bomName?: string
  unit?: string
  materialActual: number
  activityCost?: number
  totalActual: number
  sampleCount: number
  month?: string
  standardCalibrated?: boolean
}

const COMPARE_TYPES = [
  { value: 'project', label: '按项目' },
  { value: 'month', label: '按月份' },
  { value: 'bom', label: '按BOM' },
]

const csvCell = (value: string | number | undefined | null) => {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// HON-3（P-7）：标准成本未接入 → 停止导出「标准/差异/差异率」假列，只导出真实实际成本。
export function buildCostVarianceExportCsv(
  rows: VarianceItem[],
  dimensionLabel: string,
  getDimensionName: (item: VarianceItem) => string,
) {
  const header = [
    dimensionLabel,
    '月份',
    '样本数',
    '实际成本',
    '材料实际',
    '作业成本',
  ]
  const body = rows.map(item => [
    getDimensionName(item),
    item.month || '',
    item.sampleCount ?? 0,
    item.totalActual ?? 0,
    item.materialActual ?? 0,
    item.activityCost ?? 0,
  ])
  return [header, ...body].map(row => row.map(csvCell).join(',')).join('\n')
}

function validateMonthRange(startMonth: string, endMonth: string) {
  if (startMonth && endMonth && startMonth > endMonth) {
    return { valid: false, message: '开始月份不能晚于结束月份' }
  }
  return { valid: true, message: '' }
}

export default function CostVarianceAnalysis() {
  const [summary, setSummary] = useState<VarianceSummary | null>(null)
  const [items, setItems] = useState<VarianceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 5)
    return d.toISOString().slice(0, 7)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 7))
  const [compareType, setCompareType] = useState('project')
  const [searchKeyword, setSearchKeyword] = useState('')
  const monthRangeValidation = React.useMemo(() => validateMonthRange(startDate, endDate), [startDate, endDate])

  // 标准成本是否已校准（后端目前恒为 false → 差异分析降级为「仅展示实际成本」）
  const standardCalibrated = summary?.standardCalibrated === true

  useEffect(() => {
    if (!monthRangeValidation.valid) {
      setSummary(null)
      setItems([])
      setLoading(false)
      return
    }
    loadData()
  }, [startDate, endDate, compareType, monthRangeValidation.valid])

  const loadData = async () => {
    try {
      setLoading(true)
      const data = await abcApi.getVarianceAnalysis({
        startDate: startDate + '-01',
        endDate: endDate + '-28',
        compareType,
      })
      setSummary(data?.summary || null)
      setItems(data?.list || data?.items || [])
    } catch {
      setSummary(null)
      setItems([])
      toast.error('加载实际成本数据失败')
    } finally {
      setLoading(false)
    }
  }

  const filteredItems = items.filter(v => {
    if (!searchKeyword) return true
    const displayName = compareType === 'month'
      ? v.month || v.projectName || ''
      : compareType === 'bom'
        ? v.bomName || v.projectName || ''
        : v.projectName || ''
    return displayName.includes(searchKeyword)
  })

  const groupColumnLabel = compareType === 'month' ? '月份' : compareType === 'bom' ? 'BOM名称' : '项目名称'
  const searchPlaceholder = compareType === 'month' ? '搜索月份...' : compareType === 'bom' ? '搜索BOM名称...' : '搜索项目名称...'

  const getDisplayName = (item: VarianceItem) => {
    if (compareType === 'month') return item.month || item.projectName || '未分月'
    if (compareType === 'bom') return item.bomName || '未关联BOM'
    return item.projectName || '未关联项目'
  }

  const getRowId = (item: VarianceItem) => {
    if (compareType === 'month') return item.id || item.month || `${item.projectId || 'project'}-${item.bomId || 'bom'}`
    if (compareType === 'bom') return item.id || item.bomId || `${item.bomName || 'bom'}-${item.month || 'month'}`
    return item.id || item.projectId || `${item.projectName || 'project'}-${item.month || 'month'}`
  }

  const handleExport = () => {
    if (filteredItems.length === 0) {
      toast.error('暂无可导出的成本数据')
      return
    }
    const csv = buildCostVarianceExportCsv(filteredItems, groupColumnLabel, getDisplayName)
    downloadTextFile(
      `abc-cost-actual-${compareType}-${startDate}-${endDate}.csv`,
      csv,
      'text/csv;charset=utf-8',
    )
    toast.success('导出完成')
  }

  const uncalibratedCard = { label: '', value: '待校准' as const }
  const summaryCards = [
    {
      label: '实际成本',
      value: formatCurrency(summary?.totalActual || 0),
      icon: TrendingUp,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      muted: false,
    },
    { ...uncalibratedCard, label: '标准成本', muted: true },
    { ...uncalibratedCard, label: '成本差异', muted: true },
    { ...uncalibratedCard, label: '差异率', muted: true },
  ]

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">成本差异分析</h1>
          {/* HON-3：不再以「计划值 vs 核算值」的对比口吻引导（标准成本未校准、本页不做该对比）；
              诚实说明本页当前只展示实际成本。 */}
          <p className="text-sm text-gray-500 mt-1">
            展示各维度的<span className="font-medium text-gray-600">实际成本</span>（月度 ABC 按真实动因核算）。
            标准成本尚未校准，本页暂不做「标准 vs 实际」差异对比。
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 lg:items-end">
          <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleExport}
            disabled={filteredItems.length === 0}
            className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <Download className="h-4 w-4" /> 导出
          </button>
          <select
            value={compareType}
            onChange={e => setCompareType(e.target.value)}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {COMPARE_TYPES.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <input
            type="month"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            aria-invalid={!monthRangeValidation.valid}
            aria-describedby={!monthRangeValidation.valid ? 'cost-variance-month-error' : undefined}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 aria-[invalid=true]:border-red-500"
          />
          <span className="text-gray-400">至</span>
          <input
            type="month"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            aria-invalid={!monthRangeValidation.valid}
            aria-describedby={!monthRangeValidation.valid ? 'cost-variance-month-error' : undefined}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 aria-[invalid=true]:border-red-500"
          />
          </div>
          {!monthRangeValidation.valid && (
            <p id="cost-variance-month-error" role="alert" className="text-sm text-red-600">
              {monthRangeValidation.message}
            </p>
          )}
        </div>
      </div>

      {/* 降级提示：标准成本待校准，差异分析暂不可用 */}
      {!standardCalibrated && (
        <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <div className="font-medium text-amber-900">标准成本待校准 · 差异分析暂不可用</div>
            <p className="mt-0.5">
              标准成本需按 BOM 标准工时/用量校准后才能计算「标准 vs 实际」差异。系统尚未接入标准成本，
              因此本页不再显示差异数字，仅展示各维度的<span className="font-medium">真实实际成本</span>。
              需要真实单片成本，请前往「消耗对账」页查看。
            </p>
          </div>
        </div>
      )}

      {/* 汇总卡片：实际成本真实；标准/差异/差异率待校准 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map(card => {
          const Icon = 'icon' in card ? card.icon : null
          return (
            <div key={card.label} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                {Icon && (
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${(card as any).bgColor}`}>
                    <Icon className={`h-4 w-4 ${(card as any).color}`} />
                  </div>
                )}
                <span className="text-sm text-gray-500">{card.label}</span>
              </div>
              <div className={`text-2xl font-bold ${card.muted ? 'text-gray-300' : (card as any).color}`}>
                {card.value}
              </div>
            </div>
          )
        })}
      </div>

      {/* 搜索栏 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
          <input
            type="text"
            placeholder={searchPlaceholder}
            value={searchKeyword}
            onChange={e => setSearchKeyword(e.target.value)}
            className="w-full h-10 pl-10 pr-4 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
        </div>
      </div>

      {/* 实际成本明细表格（不再渲染标准/差异假数字） */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 text-xs text-gray-500">
          仅展示各维度的真实实际成本；标准成本与差异待校准后再显示。
        </div>
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{groupColumnLabel}</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">样本数</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">材料实际</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">作业成本</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">实际成本</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : filteredItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-400">暂无实际成本数据</td>
              </tr>
            ) : (
              filteredItems.map(item => {
                const rowId = getRowId(item)
                return (
                  <tr key={rowId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {getDisplayName(item)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right font-mono">
                      {item.sampleCount}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right font-mono">
                      {formatCurrency(item.materialActual)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right font-mono">
                      {formatCurrency(item.activityCost ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono font-medium">
                      {formatCurrency(item.totalActual)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
