import { Search, Plus, Settings } from 'lucide-react'
import { useLocationsPage } from './hooks/useLocationsPage'
import { LocationTree } from './components/LocationTree'
import { LocationCards } from './components/LocationCards'
import { LocationFormModal } from './components/LocationFormModal'
import { LevelConfigModal } from './components/LevelConfigModal'

export default function Locations() {
  const page = useLocationsPage()

  const selectedNodeName = page.selectedNodeId && page.flatLocations.get(page.selectedNodeId)
    ? page.flatLocations.get(page.selectedNodeId)!.name
    : ''

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">
            库位管理
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理仓库库位，支持自定义多层级库位结构
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => page.setModalType('levelConfig')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium shadow-sm transition-all h-10"
          >
            <Settings className="w-4 h-4" />
            层级配置
          </button>
          <button
            onClick={page.openCreate}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium shadow-sm transition-all h-10"
          >
            <Plus className="w-4 h-4" />
            新建库位
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { value: page.stats.total, label: '库位总数' },
          { value: page.stats.active, label: '已启用' },
          { value: page.stats.inactive, label: '已停用' },
          { value: `${page.stats.avgUtilization}%`, label: '平均使用率' },
        ].map((stat, i) => (
          <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
            <div className="text-2xl font-semibold text-gray-900">{stat.value}</div>
            <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        <LocationTree
          treeData={page.treeData}
          selectedNodeId={page.selectedNodeId}
          expandedIds={page.expandedIds}
          onToggleExpand={page.toggleExpand}
          onSelectNode={page.setSelectedNodeId}
          onExpandAll={page.expandAll}
          onCollapseAll={page.collapseAll}
        />

        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-200">
            <span className="text-sm font-medium text-gray-900">
              {page.selectedNodeId && selectedNodeName
                ? `${selectedNodeName} 及其子库位`
                : '全部库位'}
            </span>
            <div className="flex-1" />
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="搜索库位"
                  value={page.searchKeyword}
                  onChange={e => page.setSearchKeyword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && page.handleSearch()}
                  className="w-48 h-10 pl-9 pr-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
                />
              </div>
              <select
                value={page.searchStatus}
                onChange={e => page.setSearchStatus(e.target.value)}
                className="h-10 px-3 border border-gray-300 rounded-md text-sm bg-white outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 cursor-pointer"
              >
                <option value="all">全部状态</option>
                <option value="active">已启用</option>
                <option value="inactive">已停用</option>
              </select>
              <button
                onClick={page.handleSearch}
                className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                查询
              </button>
              <button
                onClick={page.handleReset}
                className="h-10 px-4 text-sm font-medium text-gray-600 bg-transparent hover:bg-gray-100 rounded-md transition-colors"
              >
                重置
              </button>
            </div>
          </div>

          <LocationCards
            loading={page.loading}
            data={page.displayLocations}
            selectedNodeName={selectedNodeName}
            onEdit={page.openEdit}
            onDelete={page.handleDelete}
            onToggleStatus={page.handleToggleStatus}
          />
        </div>
      </div>

      {/* Form Modal */}
      <LocationFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        editingId={page.editingId}
        data={page.data}
        flatLocations={page.flatLocations}
        levelConfigs={page.levelConfigs}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      {/* Level Config Modal */}
      <LevelConfigModal
        open={page.modalType === 'levelConfig'}
        levelTab={page.levelTab}
        levelConfigs={page.levelConfigs}
        onClose={() => page.setModalType(null)}
        onChangeTab={page.setLevelTab}
        onChangeConfigs={page.setLevelConfigs}
        onSave={page.saveLevelConfigs}
      />
    </div>
  )
}
