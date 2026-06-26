import React, { useState, useMemo, useEffect, useRef } from 'react'
import { Download, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, BarChart, Bar,
} from 'recharts'
import { reportsApi } from '@/api/reports'
import { downloadTextFile, formatCurrency } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'

interface PersonnelRankItem {
  id: string
  name: string
  role: string
  efficiency: number
  totalCost: number
  materialCost?: number
  outputCount: number
  recordCount?: number
  standardHours?: number
  outputPerHour?: number
  costPerOutput: number
}

interface PersonnelTrendPoint {
  month: string
  avgEfficiency: number
  totalCost: number
  outputCount: number
  standardHours?: number
  outputPerHour?: number
}

interface PersonnelSummary {
  personCount: number
  totalOutput: number
  totalLaborCost: number
  totalStandardHours: number
  avgEfficiency: number
  costPerOutput: number
}

const TIME_RANGE_OPTIONS = [
  { value: '3m', label: '近 3 个月' },
  { value: '6m', label: '近 6 个月' },
  { value: '12m', label: '近 12 个月' },
]

const ROLE_OPTIONS = [
  { value: 'all', label: '全部角色' },
  { value: 'technician', label: '技术人员' },
  { value: 'pathologist', label: '病理医师' },
  { value: 'warehouse_manager', label: '仓库管理员' },
]

function getRoleLabel(roleValue: string) {
  return ROLE_OPTIONS.find(option => option.value === roleValue)?.label || roleValue
}

export default function PersonnelEfficiency() {
  const [timeRange, setTimeRange] = useState('6m')
  const [role, setRole] = useState('all')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [ranking, setRanking] = useState<PersonnelRankItem[]>([])
  const [trend, setTrend] = useState<PersonnelTrendPoint[]>([])
  const [backendSummary, setBackendSummary] = useState<PersonnelSummary | null>(null)
  const latestRequestId = useRef(0)

  useEffect(() => {
    loadData()
  }, [timeRange, role])

  const loadData = async () => {
    const requestId = latestRequestId.current + 1
    latestRequestId.current = requestId
    try {
      setLoading(true)
      const res = await reportsApi.getPersonnelEfficiency({ timeRange, role })
      if (requestId !== latestRequestId.current) return
      setRanking(res?.ranking || [])
      setTrend(res?.trend || [])
      setBackendSummary(res?.summary || null)
    } catch {
      if (requestId !== latestRequestId.current) return
      toast.error('加载人员效率数据失败')
    } finally {
      if (requestId === latestRequestId.current) {
        setLoading(false)
      }
    }
  }

  const filteredRanking = useMemo(() => {
    if (role === 'all') return ranking
    return ranking.filter(r => r.role === role)
  }, [ranking, role])

  const summary = useMemo(() => {
    if (backendSummary) {
      return {
        avgEfficiency: Number(backendSummary.avgEfficiency || 0),
        totalCost: Number(backendSummary.totalLaborCost || 0),
        totalOutput: Number(backendSummary.totalOutput || 0),
        costPerOutput: Number(backendSummary.costPerOutput || 0),
        personCount: Number(backendSummary.personCount || 0),
      }
    }

    const avgEfficiency = filteredRanking.length > 0
      ? filteredRanking.reduce((s, r) => s + r.efficiency, 0) / filteredRanking.length
      : 0
    const totalCost = filteredRanking.reduce((s, r) => s + r.totalCost, 0)
    const totalOutput = filteredRanking.reduce((s, r) => s + r.outputCount, 0)
    const costPerOutput = totalOutput > 0 ? totalCost / totalOutput : 0
    return { avgEfficiency, totalCost, totalOutput, costPerOutput, personCount: filteredRanking.length }
  }, [backendSummary, filteredRanking])

  const handleExport = () => {
    try {
      setExporting(true)
      const header = ['姓名', '角色', '效率值', '标准小时', '产出数', '总人工成本', '单位产出成本']
      const rows = filteredRanking.map(item => [
        item.name,
        getRoleLabel(item.role),
        item.efficiency.toFixed(2),
        (item.standardHours || 0).toFixed(2),
        String(item.outputCount || 0),
        (item.totalCost || 0).toFixed(2),
        (item.costPerOutput || 0).toFixed(2),
      ])
      downloadTextFile(
        `personnel-efficiency-${timeRange}-${role}.csv`,
        [header, ...rows].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n'),
        'text/csv;charset=utf-8',
      )
      toast.success('导出完成')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">人员效率分析</h1>
          <p className="text-sm text-gray-500 mt-1">分析人员工作效率、成本产出比及排名</p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || filteredRanking.length === 0}
          className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center gap-2 self-start"
        >
          <Download className="h-4 w-4" /> 导出
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">人员数量</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{summary.personCount}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">平均效率</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">
            {summary.avgEfficiency.toFixed(2)}
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">总人工成本</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary.totalCost)}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">单位产出成本</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(summary.costPerOutput)}</div>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap gap-4">
          <select
            value={timeRange}
            onChange={e => setTimeRange(e.target.value)}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {TIME_RANGE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            value={role}
            onChange={e => setRole(e.target.value)}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {ROLE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 人员效率排名 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">人员效率排名</h3>
        {loading ? (
          <div className="h-64 flex items-center justify-center text-gray-400">加载中...</div>
        ) : filteredRanking.length === 0 ? (
          <EmptyState
            icon={Users}
            title="暂无人员效率数据"
            description="当前筛选范围内没有已完成出库记录"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">排名</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">姓名</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">角色</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">效率值</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">标准小时</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">人工成本</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">产出数</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">单位成本</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredRanking.map((item, index) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-500">{index + 1}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                        {getRoleLabel(item.role)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        item.efficiency >= 1.2 ? 'bg-green-100 text-green-700'
                          : item.efficiency >= 0.8 ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-red-100 text-red-700'
                      }`}>
                        {item.efficiency.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{(item.standardHours || 0).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-900">{formatCurrency(item.totalCost)}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{item.outputCount.toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.costPerOutput)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 人员效率趋势 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">人员效率趋势</h3>
        {loading ? (
          <div className="h-80 flex items-center justify-center text-gray-400">加载中...</div>
        ) : trend.length === 0 ? (
          <EmptyState
            icon={Users}
            title="暂无趋势数据"
            description="当前筛选范围内没有可形成趋势的出库记录"
          />
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={trend} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
              />
              <Tooltip
                formatter={(value: number, name: string) => {
                  if (name === 'avgEfficiency') return [value.toFixed(2), '平均效率']
                  if (name === 'totalCost') return [formatCurrency(value), '总成本']
                  return [value.toLocaleString(), '产出数']
                }}
                contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="avgEfficiency"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="平均效率"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 人员成本与产出对比 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">人员成本与产出对比</h3>
        {loading ? (
          <div className="h-64 flex items-center justify-center text-gray-400">加载中...</div>
        ) : trend.length === 0 ? (
          <EmptyState
            icon={Users}
            title="暂无对比数据"
            description="当前筛选范围内没有可对比的人工成本与产出"
          />
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={trend} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
                tickFormatter={(v) => `¥${v}`}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
              />
              <Tooltip
                formatter={(value: number, name: string) => {
                  if (name === 'totalCost') return [formatCurrency(value), '人工成本']
                  return [value.toLocaleString(), '产出数']
                }}
                contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Legend />
              <Bar yAxisId="left" dataKey="totalCost" fill="#3b82f6" radius={[4, 4, 0, 0]} name="人工成本" />
              <Bar yAxisId="right" dataKey="outputCount" fill="#10b981" radius={[4, 4, 0, 0]} name="产出数" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
