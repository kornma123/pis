import { X } from 'lucide-react'
import type { AlertItem } from '../hooks/useAlertsPage'

interface Props {
  open: boolean
  alert: AlertItem | null
  onClose: () => void
  onHandle: () => void
}

export function AlertConsumptionDetailModal({ open, alert, onClose, onHandle }: Props) {
  if (!open || !alert) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">消耗异常详情 - {alert.id}</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">物料名称</div>
              <div className="text-sm font-medium text-gray-900">{alert.materialName || '-'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">关联项目</div>
              <div className="text-sm font-medium text-gray-900">{alert.projectName || '-'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">来源规则</div>
              <div className="text-sm font-medium text-blue-600">{alert.ruleId || 'RULE-003'}</div>
            </div>
            <div className="bg-red-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">预警等级</div>
              <div className="text-sm font-bold text-red-600">高风险</div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">本期消耗量</div>
              <div className="text-lg font-bold text-gray-900">85瓶</div>
              <div className="text-xs text-gray-400">2024年Q4</div>
            </div>
            <div className="bg-red-50 rounded-lg p-3 text-center border border-red-100">
              <div className="text-xs text-gray-500 mb-1">偏离程度</div>
              <div className="text-lg font-bold text-red-600">+2.08σ</div>
              <div className="text-xs text-gray-400">超过阈值2σ</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">历史均值(μ)</div>
              <div className="text-lg font-bold text-gray-900">60瓶</div>
              <div className="text-xs text-gray-400">4个季度平均</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">标准差(σ)</div>
              <div className="text-lg font-bold text-gray-900">12瓶</div>
              <div className="text-xs text-gray-400">波动范围</div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">6个季度消耗趋势</span>
              <span className="text-xs text-gray-500">单位：瓶</span>
            </div>
            <div className="flex items-end justify-between h-32 gap-3 px-4 py-3 bg-gray-50 rounded-lg">
              {[50, 60, 55, 65, 70, 95].map((h, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5 flex-1">
                  <div className={`w-full max-w-[32px] rounded-t ${i === 5 ? 'bg-red-400' : 'bg-blue-300'}`} style={{ height: `${h}%` }} />
                  <span className={`text-[10px] ${i === 5 ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                    {['Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3'][i]}'24
                  </span>
                </div>
              ))}
            </div>
          </div>

          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">季度</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">消耗量</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">样本量</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">单样本消耗</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">偏离均值</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {[
                { q: '2024 Q3', v: '85瓶', s: 450, p: '0.19瓶', d: '+42%', dc: 'text-red-600' },
                { q: '2024 Q2', v: '70瓶', s: 380, p: '0.18瓶', d: '+17%', dc: 'text-gray-500' },
                { q: '2024 Q1', v: '65瓶', s: 360, p: '0.18瓶', d: '+8%', dc: 'text-gray-500' },
                { q: '2023 Q4', v: '55瓶', s: 320, p: '0.17瓶', d: '-8%', dc: 'text-green-600' },
              ].map((row, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-700">{row.q}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${i === 0 ? 'text-red-600' : 'text-gray-700'}`}>{row.v}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{row.s}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{row.p}</td>
                  <td className={`px-3 py-2 text-right ${row.dc}`}>{row.d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors">
            关闭
          </button>
          {alert.status === 'pending' && (
            <button onClick={onHandle} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm">
              处理预警
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
