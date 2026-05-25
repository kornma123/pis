import { X, AlertTriangle } from 'lucide-react'
import type { AlertItem } from '../hooks/useAlertsPage'

interface Props {
  open: boolean
  alert: AlertItem | null
  form: { opinion: string; result: string }
  onClose: () => void
  onChange: (form: { opinion: string; result: string }) => void
  onConfirm: () => void
}

export function AlertConsumptionHandleModal({ open, alert, form, onClose, onChange, onConfirm }: Props) {
  if (!open || !alert) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">处理消耗异常预警</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-5">
          <div className="bg-red-50 border border-red-100 rounded-lg p-4">
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle className="w-6 h-6 text-red-600" />
              <span className="font-semibold text-red-600">消耗量异常偏高</span>
            </div>
            <div className="text-sm text-gray-600 space-y-2">
              <div><strong>物料：</strong>{alert.materialName || '-'}</div>
              <div><strong>关联项目：</strong>{alert.projectName || '-'}</div>
              <div><strong>来源规则：</strong><span className="text-blue-600">{alert.ruleId || 'RULE-003'}</span></div>
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
            <div className="text-sm font-medium text-gray-700 mb-3">6个季度消耗趋势</div>
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

          <div>
            <div className="text-sm font-medium text-gray-700 mb-3">可能原因分析</div>
            <div className="space-y-2">
              {[
                { title: '样本量增长', desc: '本季度检测样本数较上季度增加 18%' },
                { title: '新增检测项目', desc: '分子病理检测新增了2个子项目使用该物料' },
                { title: '操作损耗增加', desc: '新员工培训期间可能存在操作损耗' },
              ].map((cause, i) => (
                <label key={i} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
                  <input type="checkbox" className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                  <div>
                    <div className="text-sm font-medium text-gray-800">{cause.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{cause.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                处理意见 <span className="text-red-500">*</span>
              </label>
              <textarea
                value={form.opinion}
                onChange={(e) => onChange({ ...form, opinion: e.target.value })}
                placeholder="请输入处理意见..."
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">处理结果</label>
              <div className="flex flex-wrap gap-3">
                {[
                  { key: 'normal', label: '标记为正常波动' },
                  { key: 'observe', label: '关注观察，下季度再评估' },
                  { key: 'optimize', label: '已核实，需优化流程' },
                  { key: 'adjust', label: '调整预警阈值' },
                ].map((opt) => (
                  <label key={opt.key} className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="consumption-result"
                      value={opt.key}
                      checked={form.result === opt.key}
                      onChange={(e) => onChange({ ...form, result: e.target.value })}
                      className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors">
            取消
          </button>
          <button onClick={onConfirm} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm">
            确认处理
          </button>
        </div>
      </div>
    </div>
  )
}
