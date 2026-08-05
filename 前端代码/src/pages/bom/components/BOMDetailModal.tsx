import { X, Clock } from 'lucide-react'
import type { BOM, BOMMaterial, BOMVersion } from '@/types'
import { formatDateTime } from '../constants'

interface Props {
  open: boolean
  bom: BOM | null
  tab: 'info' | 'history' | 'usage'
  onClose: () => void
  onChangeTab: (tab: 'info' | 'history' | 'usage') => void
  onEdit: () => void
}

export function BOMDetailModal({ open, bom, tab, onClose, onChangeTab, onEdit }: Props) {
  if (!open || !bom) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">BOM详情</h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <div className="px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {(
              [
                { key: 'info' as const, label: '基本信息' },
                { key: 'history' as const, label: '版本历史' },
                { key: 'usage' as const, label: '使用记录' },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => onChangeTab(t.key)}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  tab === t.key
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="p-6 overflow-y-auto flex-1">
          {tab === 'info' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs text-gray-500 mb-1">BOM编号</div>
                  <div className="font-mono text-sm text-gray-900">{bom.code}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">BOM名称</div>
                  <div className="text-sm font-medium text-gray-900">{bom.name}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">当前版本</div>
                  <div className="text-sm text-gray-900">{bom.version}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">状态</div>
                  <div>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        bom.status === 'active'
                          ? 'bg-green-50 text-green-600 border border-green-200'
                          : 'bg-gray-100 text-gray-600 border border-gray-200'
                      }`}
                    >
                      {bom.status === 'active' ? '已启用' : '已停用'}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">关联检测服务</div>
                  <div className="text-sm text-gray-900">
                    {bom.serviceName || '-'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">物料数量</div>
                  <div className="text-sm text-gray-900">
                    {typeof bom.materialCount === 'number' ? bom.materialCount : '未知'} 项
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">创建时间</div>
                  <div className="text-sm text-gray-900">
                    {formatDateTime(bom.createdAt)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">更新时间</div>
                  <div className="text-sm text-gray-900">
                    {formatDateTime(bom.updatedAt)}
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  物料清单
                </label>
                <div className="border border-gray-200 rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                          序号
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                          物料名称
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                          规格型号
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                          用量/样本
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                          单位
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                          库存状态
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {bom.materials && bom.materials.length > 0 ? (
                        bom.materials.map((m: BOMMaterial, idx: number) => {
                          let stockStatus = '充足'
                          let stockClass =
                            'bg-green-50 text-green-600 border-green-200'
                          if (typeof m.stock !== 'number') {
                            stockStatus = '未知'
                            stockClass = 'bg-gray-50 text-gray-500 border-gray-200'
                          } else if (m.stock <= 0) {
                            stockStatus = '不足'
                            stockClass =
                              'bg-red-50 text-red-600 border-red-200'
                          } else if (m.stock < 10) {
                            stockStatus = '偏低'
                            stockClass =
                              'bg-yellow-50 text-yellow-600 border-yellow-200'
                          }
                          return (
                            <tr key={m.id || idx}>
                              <td className="px-4 py-2.5 text-gray-500">
                                {idx + 1}
                              </td>
                              <td className="px-4 py-2.5 font-medium text-gray-900">
                                {m.name}
                              </td>
                              <td className="px-4 py-2.5 text-gray-500">
                                {m.spec || '-'}
                              </td>
                              <td className="px-4 py-2.5 text-gray-700">
                                {m.usagePerSample}
                              </td>
                              <td className="px-4 py-2.5 text-gray-500">
                                {m.unit}
                              </td>
                              <td className="px-4 py-2.5">
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${stockClass}`}
                                >
                                  {stockStatus}
                                </span>
                              </td>
                            </tr>
                          )
                        })
                      ) : !Array.isArray(bom.materials) ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-4 py-8 text-center text-gray-400"
                          >
                            物料数据不可用
                          </td>
                        </tr>
                      ) : (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-4 py-8 text-center text-gray-400"
                          >
                            暂无物料数据
                          </td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot className="bg-gray-50">
                      <tr>
                        <td
                          colSpan={6}
                          className="px-4 py-2.5 text-right text-sm text-gray-600"
                        >
                        共 {typeof bom.materialCount === 'number' ? bom.materialCount : '未知'} 项物料
                          {typeof bom.unitCost === 'number' && bom.unitCost > 0 &&
                            ` | 单样本成本 ¥${bom.unitCost.toFixed(2)}`}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          )}
          {tab === 'history' && (
            <div className="border border-gray-200 rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                      版本号
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                      修改说明
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">
                      修改时间
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {bom.versionHistory && bom.versionHistory.length > 0 ? (
                    bom.versionHistory.map((v: BOMVersion, idx: number) => (
                      <tr key={idx}>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600 border border-blue-200">
                            {v.version}
                          </span>
                          {idx === 0 && (
                            <span className="ml-2 text-xs text-gray-400">当前</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-700">
                          {v.changeLog || '-'}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">
                          {formatDateTime(v.updatedAt)}
                        </td>
                      </tr>
                    ))
                  ) : !Array.isArray(bom.versionHistory) ? (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-4 py-8 text-center text-gray-400"
                      >
                        版本历史数据不可用
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-4 py-8 text-center text-gray-400"
                      >
                        暂无版本历史
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'usage' && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <Clock className="w-12 h-12 mb-3 text-gray-300" />
              <p className="text-sm">使用记录功能开发中</p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
          >
            关闭
          </button>
          <button
            onClick={() => {
              onClose()
              onEdit()
            }}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm"
          >
            编辑
          </button>
        </div>
      </div>
    </div>
  )
}
