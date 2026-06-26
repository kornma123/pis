import React, { useState, useEffect, useMemo } from 'react'
import { Download, TrendingUp, DollarSign, BarChart3 } from 'lucide-react'
import { toast } from 'sonner'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from 'recharts'
import { equipmentApi } from '@/api/master'
import { formatCurrency } from '@/lib/utils'
import type { DepreciationStat } from '@/types'

const BAR_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4']

export default function EquipmentDepreciationStats() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<DepreciationStat[]>([])
  const [summary, setSummary] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const res = await equipmentApi.getDepreciationStats()
      setStats(res?.stats || [])
      setSummary(res?.summary || null)
    } catch {
      toast.error('加载折旧统计数据失败')
    } finally {
      setLoading(false)
    }
  }

  const chartData = useMemo(() =>
    stats.map(s => ({
      name: s.typeName || '未分类',
      totalAnnualDepreciation: s.totalAnnualDepreciation || 0,
      equipmentCount: s.equipmentCount || 0,
      totalPurchasePrice: s.totalPurchasePrice || 0,
    })),
    [stats]
  )

  const summaryCards = [
    {
      label: '设备总数',
      value: summary?.totalEquipment ?? stats.reduce((s, d) => s + (d.equipmentCount || 0), 0),
      icon: BarChart3,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      format: (v: number) => `${v} 台`,
    },
    {
      label: '总购置价值',
      value: summary?.totalPurchasePrice ?? stats.reduce((s, d) => s + (d.totalPurchasePrice || 0), 0),
      icon: DollarSign,
      color: 'text-green-600',
      bgColor: 'bg-green-50',
      format: formatCurrency,
    },
    {
      label: '年折旧额',
      value: summary?.totalAnnualDepreciation ?? stats.reduce((s, d) => s + (d.totalAnnualDepreciation || 0), 0),
      icon: TrendingUp,
      color: 'text-amber-600',
      bgColor: 'bg-amber-50',
      format: formatCurrency,
    },
    {
      label: '月折旧额',
      value: summary?.totalMonthlyDepreciation ?? stats.reduce((s, d) => s + (d.totalMonthlyDepreciation || 0), 0),
      icon: DollarSign,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50',
      format: formatCurrency,
    },
  ]

  const handleExport = () => {
    if (stats.length === 0) {
      toast.warning('暂无数据可导出')
      return
    }
    const headers = ['设备类型', '设备数量', '总购置价值', '年折旧额', '月折旧额']
    const rows = stats.map(s => [
      s.typeName || '未分类',
      s.equipmentCount || 0,
      s.totalPurchasePrice || 0,
      s.totalAnnualDepreciation || 0,
      s.totalMonthlyDepreciation || 0,
    ])
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `设备折旧统计_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('导出成功')
  }

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">折旧统计</h1>
          <p className="text-sm text-gray-500 mt-1">按设备类型汇总折旧情况</p>
        </div>
        <button
          onClick={handleExport}
          className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors flex items-center gap-2 self-start"
        >
          <Download className="h-4 w-4" /> 导出报表
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map(card => {
          const Icon = card.icon
          return (
            <div key={card.label} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${card.bgColor}`}>
                  <Icon className={`h-4 w-4 ${card.color}`} />
                </div>
                <span className="text-sm text-gray-500">{card.label}</span>
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {card.format(card.value)}
              </div>
            </div>
          )
        })}
      </div>

      {/* 柱状图 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">按类型折旧分布</h3>
        {loading ? (
          <div className="h-80 flex items-center justify-center text-gray-400">加载中...</div>
        ) : chartData.length === 0 ? (
          <div className="h-80 flex items-center justify-center text-gray-400">暂无数据</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 12, fill: '#6b7280' }}
                tickLine={false}
                tickFormatter={(v) => `¥${(v / 10000).toFixed(0)}万`}
              />
              <Tooltip
                formatter={(value: number, name: string) => {
                  const label = name === 'totalAnnualDepreciation' ? '年折旧额' : '购置价值'
                  return [formatCurrency(value), label]
                }}
                contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-xs text-gray-600">
                    {value === 'totalAnnualDepreciation' ? '年折旧额' : '购置价值'}
                  </span>
                )}
              />
              <Bar dataKey="totalPurchasePrice" name="totalPurchasePrice" radius={[4, 4, 0, 0]}>
                {chartData.map((_, index) => (
                  <Cell key={index} fill={BAR_COLORS[index % BAR_COLORS.length]} opacity={0.4} />
                ))}
              </Bar>
              <Bar dataKey="totalAnnualDepreciation" name="totalAnnualDepreciation" radius={[4, 4, 0, 0]}>
                {chartData.map((_, index) => (
                  <Cell key={index} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 明细表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">折旧明细</h3>
        </div>
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">设备类型</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">设备数量</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">总购置价值</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">年折旧额</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">月折旧额</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">年折旧率</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : stats.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-400">暂无折旧数据</td>
              </tr>
            ) : (
              stats.map(s => {
                const depreciationRate = s.totalPurchasePrice
                  ? ((s.totalAnnualDepreciation || 0) / s.totalPurchasePrice * 100)
                  : 0
                return (
                  <tr key={s.typeId || s.typeName} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{s.typeName || '未分类'}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{s.equipmentCount || 0}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(s.totalPurchasePrice || 0)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(s.totalAnnualDepreciation || 0)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(s.totalMonthlyDepreciation || 0)}</td>
                    <td className={`px-4 py-3 text-sm text-right font-mono font-medium ${depreciationRate > 80 ? 'text-red-600' : depreciationRate > 50 ? 'text-amber-600' : 'text-green-600'}`}>
                      {depreciationRate.toFixed(1)}%
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
