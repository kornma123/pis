import { toast } from 'sonner'
import type { MaterialSummary } from '../hooks/useReconciliationPage'

interface Props {
  loading: boolean
  materials: MaterialSummary[]
  getDiffClass: (status: string) => string
}

export function MaterialSummaryTab({ loading, materials, getDiffClass }: Props) {
  if (loading) {
    return <div className="text-center py-12 text-gray-400">加载中...</div>
  }

  if (materials.length === 0) {
    return <div className="text-center py-12 text-gray-400">暂无数据</div>
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-200">
                <th className="px-4 py-3 text-left">物料名称</th>
                <th className="px-4 py-3 text-left">规格</th>
                <th className="px-4 py-3 text-center">涉及项目</th>
                <th className="px-4 py-3 text-center">BOM理论</th>
                <th className="px-4 py-3 text-center">实际出库</th>
                <th className="px-4 py-3 text-center">差异量</th>
                <th className="px-4 py-3 text-center">差异率</th>
                <th className="px-4 py-3 text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {materials.map((mat, idx) => (
                <tr key={idx} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{mat.materialName}</td>
                  <td className="px-4 py-3 text-gray-500">{mat.spec}</td>
                  <td className="px-4 py-3 text-center">{mat.projectCount}</td>
                  <td className="px-4 py-3 text-center">{mat.theoryTotal.toFixed(1)} {mat.unit}</td>
                  <td className="px-4 py-3 text-center">{mat.actualTotal.toFixed(1)} {mat.unit}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block px-2 py-1 rounded font-semibold text-xs ${getDiffClass(mat.status)}`}>
                      {mat.diff > 0 ? '+' : ''}{mat.diff.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block px-2 py-1 rounded text-xs ${getDiffClass(mat.status)}`}>
                      {parseFloat(mat.diffRate) > 0 ? '+' : ''}{mat.diffRate}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {mat.status !== 'match' ? (
                      <button
                        onClick={() => { toast.info('请到"按项目对账"页进行BOM修正') }}
                        className="px-3 py-1 text-xs font-medium text-gray-400 bg-gray-50 border border-gray-200 rounded-md cursor-not-allowed"
                      >
                        调整BOM
                      </button>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
