import { Search, X, Plus, Check, List, FolderOpen, Package } from 'lucide-react'

interface Material {
  id: string
  code: string
  name: string
  spec: string
  categoryName: string
  unit: string
  stock: number
}

interface BomMaterial {
  id: string
  code: string
  name: string
  spec: string
  unit: string
  stock: number
  usagePerSample: number
}

interface Props {
  open: boolean
  tab: 'list' | 'bom'
  materialList: Material[]
  materialLoading: boolean
  materialKeyword: string
  checkedMaterialIds: Set<string>
  selectedMaterials: Array<{ id: string; code: string; name: string; spec: string; unit: string; stock: number }>
  bomList: Array<{ id: string; code: string; name: string; type: string }>
  selectedBomId: string
  bomMaterials: BomMaterial[]
  bomLoading: boolean
  onClose: () => void
  onSwitchTab: (tab: 'list' | 'bom') => void
  onChangeKeyword: (v: string) => void
  onToggleCheck: (id: string) => void
  onToggleCheckAll: () => void
  onRemoveSelected: (id: string) => void
  onAddChecked: () => void
  onConfirm: () => void
  onSelectBom: (id: string) => void
  filteredMaterialList: Material[]
}

export function MaterialSelectorModal({
  open,
  tab,
  materialLoading,
  materialKeyword,
  checkedMaterialIds,
  selectedMaterials,
  bomList,
  selectedBomId,
  bomMaterials,
  bomLoading,
  onClose,
  onSwitchTab,
  onChangeKeyword,
  onToggleCheck,
  onToggleCheckAll,
  onRemoveSelected,
  onAddChecked,
  onConfirm,
  onSelectBom,
  filteredMaterialList,
}: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-16">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">添加物料</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-auto p-0">
          <div className="flex h-full" style={{ minHeight: '500px' }}>
            <div className="flex-1 p-6 border-r border-gray-200">
              <div className="flex items-center gap-0 border-b border-gray-200 mb-4">
                <button
                  onClick={() => onSwitchTab('list')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-150 ease relative ${
                    tab === 'list' ? 'text-blue-500' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <List className="w-4 h-4" />
                  物料列表
                </button>
                <button
                  onClick={() => onSwitchTab('bom')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-150 ease relative ${
                    tab === 'bom' ? 'text-blue-500' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <FolderOpen className="w-4 h-4" />
                  按检测项目添加
                </button>
              </div>

              {tab === 'list' && (
                <>
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      placeholder="搜索物料名称或编号..."
                      value={materialKeyword}
                      onChange={e => onChangeKeyword(e.target.value)}
                      className="w-full pl-10 pr-4 h-9 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 transition-all duration-150 ease"
                    />
                  </div>
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="w-10 px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={filteredMaterialList.length > 0 && checkedMaterialIds.size === filteredMaterialList.length}
                              onChange={onToggleCheckAll}
                              className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                            />
                          </th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">规格</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库存</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {materialLoading ? (
                          <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400 text-sm">加载中...</td></tr>
                        ) : filteredMaterialList.length === 0 ? (
                          <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400 text-sm">暂无数据</td></tr>
                        ) : (
                          filteredMaterialList.map(m => (
                            <tr key={m.id} className={`hover:bg-gray-50 transition-colors cursor-pointer ${checkedMaterialIds.has(m.id) ? 'bg-blue-50' : ''}`} onClick={() => onToggleCheck(m.id)}>
                              <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                                <input type="checkbox" checked={checkedMaterialIds.has(m.id)} onChange={() => onToggleCheck(m.id)} className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500" />
                              </td>
                              <td className="px-3 py-2 font-medium text-gray-900">{m.name}</td>
                              <td className="px-3 py-2 text-gray-600">{m.spec}</td>
                              <td className="px-3 py-2 text-gray-900">{m.stock} {m.unit}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <div className="text-sm text-gray-500">已勾选 <strong className="text-blue-500">{checkedMaterialIds.size}</strong> 项</div>
                    <button
                      onClick={onAddChecked}
                      disabled={checkedMaterialIds.size === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      添加到已选
                    </button>
                  </div>
                </>
              )}

              {tab === 'bom' && (
                <>
                  <div className="mb-4">
                    <select
                      value={selectedBomId}
                      onChange={e => onSelectBom(e.target.value)}
                      className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:border-blue-500"
                    >
                      <option value="">请选择检测项目/BOM</option>
                      {bomList.map(b => (
                        <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                      ))}
                    </select>
                  </div>
                  {bomLoading ? (
                    <div className="text-center py-12 text-gray-400 text-sm">加载中...</div>
                  ) : selectedBomId && bomMaterials.length === 0 ? (
                    <div className="text-center py-12 text-gray-400 text-sm">该BOM暂无物料</div>
                  ) : selectedBomId ? (
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full text-[13px]">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">规格</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单样本用量</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库存</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {bomMaterials.map(m => (
                            <tr
                              key={m.id}
                              className={`hover:bg-gray-50 transition-colors cursor-pointer ${checkedMaterialIds.has(m.id) ? 'bg-blue-50' : ''}`}
                              onClick={() => onToggleCheck(m.id)}
                            >
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={checkedMaterialIds.has(m.id)}
                                    onChange={() => onToggleCheck(m.id)}
                                    className="w-4 h-4 rounded border-gray-300 text-blue-500"
                                  />
                                  <span className="font-medium text-gray-900">{m.name}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-gray-500">{m.spec}</td>
                              <td className="px-3 py-2 text-gray-500">{m.usagePerSample}{m.unit}</td>
                              <td className="px-3 py-2 text-gray-500">{m.stock}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-center py-12 text-gray-400">
                      <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-50" strokeWidth={1.5} />
                      <div className="text-sm">请先选择检测项目</div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="w-[300px] p-6 bg-gray-50 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-semibold text-gray-900">已选物料</span>
                <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded-full">{selectedMaterials.length} 项</span>
              </div>
              <div className="flex-1 overflow-auto space-y-2 min-h-0">
                {selectedMaterials.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">
                    <Package className="w-10 h-10 mx-auto mb-2 opacity-50" strokeWidth={1.5} />
                    <p className="text-xs">从左侧勾选物料添加</p>
                    <p className="text-[11px] text-gray-400 mt-1">支持同时使用"物料列表"和"BOM"两种方式</p>
                  </div>
                ) : (
                  selectedMaterials.map(m => (
                    <div key={m.id} className="bg-white rounded-lg p-3 border border-gray-200 shadow-sm">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">{m.name}</div>
                          <div className="text-xs text-gray-500 mt-0.5">{m.spec}</div>
                        </div>
                        <button onClick={() => onRemoveSelected(m.id)} className="text-gray-400 hover:text-red-500 transition-colors ml-2 flex-shrink-0">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {selectedMaterials.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200 space-y-1">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>物料种类</span>
                    <span className="font-medium text-gray-900">{selectedMaterials.length}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 transition-all duration-150 ease"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={selectedMaterials.length === 0 && checkedMaterialIds.size === 0}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease shadow-sm"
          >
            <Check className="w-3.5 h-3.5" />
            确认添加
          </button>
        </div>
      </div>
    </div>
  )
}
