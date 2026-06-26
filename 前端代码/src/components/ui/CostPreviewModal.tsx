import { useState, useEffect, useMemo } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { Modal } from './Modal'
import { formatCurrency } from '@/lib/utils'
import { bomApi } from '@/api/master'
import { toast } from 'sonner'

interface CostBreakdownItem {
  amount: number
  percentage: number
  items?: { name: string; amount: number }[]
  priceSource?: string
}

interface CostPreviewData {
  bomId: string
  bomName: string
  totalCost: number
  breakdown: {
    materialCost: CostBreakdownItem
    laborCost: CostBreakdownItem
    equipmentCost: CostBreakdownItem
    indirectCost: CostBreakdownItem
  }
  costMode: string
  updatedAt: string
}

interface Props {
  open: boolean
  onClose: () => void
  bomId: string | null
  bomName?: string
}

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6']

const COST_TYPE_LABELS: Record<string, string> = {
  materialCost: '直接材料',
  laborCost: '人工成本',
  equipmentCost: '设备折旧',
  indirectCost: '间接费用',
}

export function CostPreviewModal({ open, onClose, bomId, bomName }: Props) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<CostPreviewData | null>(null)

  useEffect(() => {
    if (open && bomId) {
      loadPreview()
    }
  }, [open, bomId])

  const loadPreview = async () => {
    if (!bomId) return
    try {
      setLoading(true)
      const res = await bomApi.getCostPreview(bomId)
      setData(res)
    } catch {
      toast.error('加载成本预览失败')
    } finally {
      setLoading(false)
    }
  }

  const pieData = useMemo(() => {
    if (!data) return []
    return Object.entries(data.breakdown).map(([key, val]) => ({
      name: COST_TYPE_LABELS[key] || key,
      value: val.amount,
    }))
  }, [data])

  if (!open) return null

  return (
    <Modal onClose={onClose} title={`成本预览 — ${bomName || data?.bomName || ''}`} size="xl">
      {loading ? (
        <div className="py-12 text-center text-gray-400">加载中...</div>
      ) : !data ? (
        <div className="py-12 text-center text-gray-400">暂无数据</div>
      ) : (
        <div className="space-y-6">
          {/* 汇总 */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="text-sm text-gray-500">总标准成本</div>
              <div className="text-2xl font-bold text-gray-900">{formatCurrency(data.totalCost)}</div>
            </div>
            <div className="text-right">
              <div className="text-sm text-gray-500">成本模式</div>
              <div className="text-sm font-medium text-gray-700">
                {data.costMode === 'equipment_average' ? '设备均价' : data.costMode}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 饼图 */}
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-3">成本结构</h4>
              {pieData.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-gray-400">暂无数据</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {pieData.map((_, index) => (
                        <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value)}
                      contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb' }}
                    />
                    <Legend
                      verticalAlign="bottom"
                      height={36}
                      formatter={(value) => <span className="text-xs text-gray-600">{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* 各项明细 */}
            <div className="space-y-4">
              {Object.entries(data.breakdown).map(([key, val]) => (
                <div key={key} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-900">
                      {COST_TYPE_LABELS[key] || key}
                    </span>
                    <span className="text-sm font-mono text-gray-700">
                      {formatCurrency(val.amount)}
                      <span className="text-xs text-gray-400 ml-1">({val.percentage.toFixed(1)}%)</span>
                    </span>
                  </div>
                  {/* 进度条 */}
                  <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(val.percentage, 100)}%`,
                        backgroundColor: PIE_COLORS[Object.keys(data.breakdown).indexOf(key) % PIE_COLORS.length],
                      }}
                    />
                  </div>
                  {/* 子项明细 */}
                  {val.items && val.items.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {val.items.map((item, i) => (
                        <div key={i} className="flex items-center justify-between text-xs text-gray-500">
                          <span className="truncate">{item.name}</span>
                          <span className="font-mono flex-shrink-0 ml-2">{formatCurrency(item.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {val.priceSource && (
                    <div className="mt-1 text-xs text-gray-400">
                      价格来源: {val.priceSource === 'equipment_average' ? '设备均价' : val.priceSource}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 更新时间 */}
          {data.updatedAt && (
            <div className="text-xs text-gray-400 text-right">
              更新于 {new Date(data.updatedAt).toLocaleString('zh-CN')}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
