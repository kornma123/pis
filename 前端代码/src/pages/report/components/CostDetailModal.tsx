import { X, Search } from 'lucide-react'
import type { ProjectCostReport } from '@/types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  open: boolean
  project: ProjectCostReport['projects'][number] | null
  onClose: () => void
}

export function CostDetailModal({ open, project, onClose }: Props) {
  if (!open || !project) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">检测项目成本明细 - {project.name}</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-center">
            <div>
              <div className="text-xl font-semibold text-gray-900">{formatCurrency(project.totalCost)}</div>
              <div className="text-xs text-gray-500 mt-0.5">总成本</div>
            </div>
            <div>
              <div className="text-xl font-semibold text-gray-900">{project.sampleCount.toLocaleString()}</div>
              <div className="text-xs text-gray-500 mt-0.5">病例数</div>
            </div>
            <div>
              <div className="text-xl font-semibold text-gray-900">{formatCurrency(project.unitCost)}</div>
              <div className="text-xs text-gray-500 mt-0.5">单病例均成本</div>
            </div>
            <div>
              <div className="text-xl font-semibold text-gray-900">-</div>
              <div className="text-xs text-gray-500 mt-0.5">平均检测周期</div>
            </div>
            <div>
              <div className="text-xl font-semibold text-green-600">-</div>
              <div className="text-xs text-gray-500 mt-0.5">数据完整度</div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">数据来源：</span>
              <span className="text-green-600 font-medium">LIS系统同步</span>
              <span className="text-gray-400">| 最后同步：2024-01-15 08:00</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="搜索病理号、患者姓名..."
                  className="h-9 pl-9 pr-4 text-sm border border-gray-300 rounded-md bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 w-56"
                />
              </div>
              <button className="h-9 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
                导出明细
              </button>
            </div>
          </div>

          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">病理号</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">患者信息</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">检测项目</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗物料</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">成本</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">检测日期</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    病例明细功能开发中，当前仅展示项目汇总数据
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
