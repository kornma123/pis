import type { MaterialSummary } from '../hooks/useReconciliationPage'

interface Props {
  loading: boolean
  materials: MaterialSummary[]
  getDiffClass: (status: string) => string
}

export function MaterialSummaryTab({ loading, materials, getDiffClass }: Props) {
  if (loading) return null

  if (materials.length === 0) {
    return <div className="py-12 text-center text-gray-400">当前期间没有物料汇总事实</div>
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">当前期间的物料理论消耗、实际出库与差异汇总</caption>
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <th scope="col" className="px-4 py-3 text-left">物料名称</th>
              <th scope="col" className="px-4 py-3 text-left">规格</th>
              <th scope="col" className="px-4 py-3 text-center">涉及项目</th>
              <th scope="col" className="px-4 py-3 text-center">BOM 理论</th>
              <th scope="col" className="px-4 py-3 text-center">实际出库</th>
              <th scope="col" className="px-4 py-3 text-center">差异量</th>
              <th scope="col" className="px-4 py-3 text-center">差异率</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {materials.map(material => (
              <tr key={material.materialId} className="hover:bg-gray-50" style={{ contentVisibility: 'auto' }}>
                <th scope="row" className="px-4 py-3 text-left font-medium text-gray-900">{material.materialName}</th>
                <td className="px-4 py-3 text-gray-500">{material.spec}</td>
                <td className="px-4 py-3 text-center">{material.projectCount}</td>
                <td className="px-4 py-3 text-center">{material.theoryTotal.toFixed(1)} {material.unit}</td>
                <td className="px-4 py-3 text-center">{material.actualTotal.toFixed(1)} {material.unit}</td>
                <td className="px-4 py-3 text-center"><span className={`inline-block rounded px-2 py-1 text-xs font-semibold ${getDiffClass(material.status)}`}>{material.diff > 0 ? '+' : ''}{material.diff.toFixed(1)}</span></td>
                <td className="px-4 py-3 text-center"><span className={`inline-block rounded px-2 py-1 text-xs ${getDiffClass(material.status)}`}>{parseFloat(material.diffRate) > 0 ? '+' : ''}{material.diffRate}%</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
