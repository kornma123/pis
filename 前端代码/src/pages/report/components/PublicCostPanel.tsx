import { FileText } from 'lucide-react'

export function PublicCostPanel() {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <div className="p-1 bg-blue-100 rounded-full mt-0.5">
            <FileText className="w-4 h-4 text-blue-600" />
          </div>
          <p className="text-sm text-blue-800">
            公共成本指未关联BOM清单的物料消耗，如一次性手套、口罩、防护服等耗材。
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-xs text-gray-500 mb-1">年度消耗</div>
            <div className="text-lg font-semibold text-gray-900">-</div>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-xs text-gray-500 mb-1">年度成本</div>
            <div className="text-lg font-semibold text-gray-900">-</div>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-xs text-gray-500 mb-1">占总成本</div>
            <div className="text-lg font-semibold text-gray-900">-</div>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-xs text-gray-500 mb-1">物料种类</div>
            <div className="text-lg font-semibold text-gray-900">-</div>
          </div>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-gray-900 mb-3">公共成本物料明细</h4>
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料名称</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">分类</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗数量</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">消耗金额</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">占比</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    公共成本统计功能开发中，请先完善BOM清单配置
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
