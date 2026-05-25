import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ProjectReconcile, MaterialDiff } from '../hooks/useReconciliationPage'

interface Props {
  loading: boolean
  projects: ProjectReconcile[]
  expandedProject: string | null
  projectMaterials: Record<string, MaterialDiff[]>
  onToggleProject: (projectId: string) => void
  getDiffClass: (status: string) => string
  onFixBom: (mat: MaterialDiff, projectId: string) => void
}

export function ReconcileProjectTab({
  loading,
  projects,
  expandedProject,
  projectMaterials,
  onToggleProject,
  getDiffClass,
  onFixBom,
}: Props) {
  if (loading) {
    return <div className="text-center py-12 text-gray-400">加载中...</div>
  }

  if (projects.length === 0) {
    return <div className="text-center py-12 text-gray-400">暂无数据</div>
  }

  return (
    <div className="space-y-4">
      {projects.map(proj => (
        <div key={proj.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div
            className="px-5 py-4 bg-gray-50 border-b border-gray-200 flex items-center justify-between cursor-pointer"
            onClick={() => onToggleProject(proj.id)}
          >
            <div>
              <div className="font-semibold text-gray-900">{proj.name}</div>
              <div className="text-xs text-gray-500 mt-1">
                LIS病例：{proj.case_count}例 | 关联出库：{proj.outbound_count}例 | 涉及物料：{(proj.boms?.length || 0)}种BOM
              </div>
            </div>
            <div className="flex items-center gap-3">
              {proj.boms?.map(b => (
                <span key={b.id} className="px-2.5 py-1 text-xs font-medium bg-blue-50 text-blue-600 rounded-full">
                  {b.name}
                </span>
              ))}
              {!proj.hasBom && (
                <span className="px-2.5 py-1 text-xs font-medium bg-red-50 text-red-600 rounded-full">
                  未配置BOM
                </span>
              )}
              {expandedProject === proj.id
                ? <ChevronUp className="w-5 h-5 text-gray-400" />
                : <ChevronDown className="w-5 h-5 text-gray-400" />}
            </div>
          </div>

          {expandedProject === proj.id && (
            <div className="p-5">
              {!proj.hasBom ? (
                <div className="text-sm text-gray-500 py-4">
                  该检测项目尚未关联BOM，无法计算理论消耗。请到 <strong>BOM清单</strong> 页面配置。
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                        <th className="px-3 py-2 text-left">物料</th>
                        <th className="px-3 py-2 text-center">理论消耗</th>
                        <th className="px-3 py-2 text-center">实际出库</th>
                        <th className="px-3 py-2 text-center">差异</th>
                        <th className="px-3 py-2 text-center">原因分析</th>
                        <th className="px-3 py-2 text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(projectMaterials[proj.id] || []).map((mat, idx) => (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="px-3 py-3">
                            <div className="font-medium text-gray-900">{mat.materialName}</div>
                            <div className="text-xs text-gray-500">{mat.spec} · {mat.bomUsagePerSample}{mat.bomUnit}/例</div>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className="inline-block px-2 py-1 rounded text-blue-700 bg-blue-50 font-semibold text-xs">
                              {mat.theoryQty.toFixed(1)} {mat.theoryUnit}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className="inline-block px-2 py-1 rounded text-orange-700 bg-orange-50 font-semibold text-xs">
                              {mat.actualQty.toFixed(1)} {mat.actualUnit}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className={`inline-block px-2 py-1 rounded font-semibold text-xs ${getDiffClass(mat.status)}`}>
                              {mat.diff > 0 ? '+' : ''}{mat.diff.toFixed(1)}
                              <br />
                              <span className="text-[10px] opacity-75">{mat.diffRate}%</span>
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center text-xs text-gray-500">
                            {mat.status === 'match' ? '按规格出库，正常余量' : mat.diff > 0 ? '按规格出库，剩余在库' : '实际用量偏大'}
                          </td>
                          <td className="px-3 py-3 text-center">
                            {mat.status !== 'match' && (
                              <button
                                onClick={() => onFixBom(mat, proj.id)}
                                className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                              >
                                修正BOM
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
