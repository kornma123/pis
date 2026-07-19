import {
  LineChart as ReLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RePieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts'
import type { TrendReport, PieDataItem } from '../hooks/useCostAnalysisPage'

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316']

interface Props {
  trendReport: TrendReport | null
  pieData: PieDataItem[]
}

export function CostCharts({ trendReport, pieData }: Props) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-4">成本趋势</h3>
        <div className="h-72">
          {!trendReport?.trend?.length ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">当前期间没有成本趋势事实</div>
          ) : <ResponsiveContainer width="100%" height="100%">
            <ReLineChart data={trendReport?.trend || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={{ stroke: '#e5e7eb' }} />
              <YAxis
                tick={{ fontSize: 12, fill: '#6b7280' }}
                axisLine={{ stroke: '#e5e7eb' }}
                tickFormatter={(v: number) => `¥${(v / 10000).toFixed(0)}万`}
              />
              <Tooltip
                formatter={(value: number) => [`¥${value.toLocaleString()}`, '成本']}
                contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }}
              />
              <Line
                type="monotone"
                dataKey="cost"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ r: 3, fill: '#3b82f6' }}
                activeDot={{ r: 5 }}
              />
            </ReLineChart>
          </ResponsiveContainer>}
        </div>
      </div>

      <div className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-4">成本构成</h3>
        <div className="h-72">
          {!pieData.length ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">当前期间没有可计算的项目成本构成</div>
          ) : <ResponsiveContainer width="100%" height="100%">
            <RePieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={2}
                dataKey="value"
              >
                {pieData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Tooltip formatter={(value: number) => `${value}%`} contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 }} />
            </RePieChart>
          </ResponsiveContainer>}
        </div>
      </div>
    </div>
  )
}
