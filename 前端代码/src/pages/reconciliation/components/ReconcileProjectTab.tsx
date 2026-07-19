import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ProjectReconcile, MaterialDiff } from '../hooks/useReconciliationPage'

interface Props {
  loading: boolean
  projects: ProjectReconcile[]
  expandedProject: string | null
  projectMaterials: Record<string, MaterialDiff[]>
  projectMaterialLoading: Record<string, boolean>
  projectMaterialErrors: Record<string, string | null>
  onToggleProject: (projectId: string) => void
  getDiffClass: (status: string) => string
  onFixBom: (mat: MaterialDiff, projectId: string) => void
  canWrite: boolean
}

export function ReconcileProjectTab({
  loading,
  projects,
  expandedProject,
  projectMaterials,
  projectMaterialLoading,
  projectMaterialErrors,
  onToggleProject,
  getDiffClass,
  onFixBom,
  canWrite,
}: Props) {
  if (loading) return null

  if (projects.length === 0) {
    return <div className="py-12 text-center text-gray-400">当前期间没有项目对账事实</div>
  }

  return (
    <div className="space-y-4">
      {projects.map(project => {
        const expanded = expandedProject === project.id
        const details = projectMaterials[project.id]
        const detailLoading = projectMaterialLoading[project.id]
        const detailError = projectMaterialErrors[project.id]
        return (
          <section key={project.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white" style={{ contentVisibility: 'auto' }}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-4 border-b border-gray-200 bg-gray-50 px-5 py-4 text-left"
              aria-expanded={expanded}
              aria-controls={`project-materials-${project.id}`}
              onClick={() => onToggleProject(project.id)}
            >
              <span>
                <span className="block font-semibold text-gray-900">{project.name}</span>
                <span className="mt-1 block text-xs text-gray-500">
                  LIS 病例：{project.case_count} 例 · 关联出库：{project.outbound_count} 例 · BOM：{project.boms?.length || 0} 个
                </span>
              </span>
              <span className="flex flex-wrap items-center justify-end gap-2">
                {project.boms?.map(bom => (
                  <span key={bom.id} className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600">{bom.name}</span>
                ))}
                {!project.hasBom && <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600">未配置 BOM</span>}
                {expanded
                  ? <ChevronUp className="h-5 w-5 text-gray-400" aria-hidden="true" />
                  : <ChevronDown className="h-5 w-5 text-gray-400" aria-hidden="true" />}
              </span>
            </button>

            {expanded && (
              <div id={`project-materials-${project.id}`} className="p-5">
                {!project.hasBom ? (
                  <div className="py-4 text-sm text-gray-500">该项目没有 BOM 来源事实，无法计算理论消耗；请由有权限人员在 BOM 模块补齐。</div>
                ) : detailLoading ? (
                  <div role="status" className="py-6 text-center text-sm text-gray-400">物料明细加载中…</div>
                ) : detailError ? (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    <span>{detailError}</span>
                    <button type="button" className="font-medium underline underline-offset-2" onClick={() => onToggleProject(project.id)}>重试</button>
                  </div>
                ) : !details?.length ? (
                  <div className="py-6 text-center text-sm text-gray-400">当前期间没有该项目的物料差异明细</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">{project.name} 的理论消耗、实际出库与差异</caption>
                      <thead>
                        <tr className="bg-gray-50 text-xs uppercase text-gray-500">
                          <th scope="col" className="px-3 py-2 text-left">物料</th>
                          <th scope="col" className="px-3 py-2 text-center">理论消耗</th>
                          <th scope="col" className="px-3 py-2 text-center">实际出库</th>
                          <th scope="col" className="px-3 py-2 text-center">差异</th>
                          <th scope="col" className="px-3 py-2 text-center">状态说明</th>
                          {canWrite && <th scope="col" className="px-3 py-2 text-center">处理</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {details.map(material => (
                          <tr key={material.materialId} className="hover:bg-gray-50" style={{ contentVisibility: 'auto' }}>
                            <th scope="row" className="px-3 py-3 text-left font-normal">
                              <span className="block font-medium text-gray-900">{material.materialName}</span>
                              <span className="text-xs text-gray-500">{material.spec} · {material.bomUsagePerSample}{material.bomUnit}/例</span>
                            </th>
                            <td className="px-3 py-3 text-center"><span className="inline-block rounded bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">{material.theoryQty.toFixed(1)} {material.theoryUnit}</span></td>
                            <td className="px-3 py-3 text-center"><span className="inline-block rounded bg-orange-50 px-2 py-1 text-xs font-semibold text-orange-700">{material.actualQty.toFixed(1)} {material.actualUnit}</span></td>
                            <td className="px-3 py-3 text-center">
                              <span className={`inline-block rounded px-2 py-1 text-xs font-semibold ${getDiffClass(material.status)}`}>
                                {material.diff > 0 ? '+' : ''}{material.diff.toFixed(1)}<br />
                                <span className="text-[10px] opacity-75">{material.diffRate}%</span>
                              </span>
                            </td>
                            <td className="px-3 py-3 text-center text-xs text-gray-500">
                              {material.status === 'match' ? '理论与实际相符' : material.diff > 0 ? '实际出库高于理论' : '实际出库低于理论'}
                            </td>
                            {canWrite && (
                              <td className="px-3 py-3 text-center">
                                {material.status !== 'match'
                                  ? <button type="button" onClick={() => onFixBom(material, project.id)} className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100">提交 BOM 修正提案</button>
                                  : <span className="text-gray-400">—</span>}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
