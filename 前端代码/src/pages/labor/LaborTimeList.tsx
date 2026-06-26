import { Plus, Search } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { useLaborTimePage } from './hooks/useLaborTimePage'
import { LaborTimeFormModal } from './components/LaborTimeFormModal'
import { LaborTimeDetailModal } from './components/LaborTimeDetailModal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export default function LaborTimeList() {
  const page = useLaborTimePage()

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">
            标准工时库
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            定义各环节标准工时与费率，用于人工成本核算
          </p>
        </div>
        {page.canManageLaborTimes && (
          <button
            onClick={page.openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium transition-colors h-10"
          >
            <Plus className="w-4 h-4" />
            新增工时定义
          </button>
        )}
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { value: page.stats.total, label: '工时可定义数' },
          { value: page.stats.totalMinutes, label: '总标准工时（分钟）', color: 'text-blue-600' },
          { value: `¥${page.stats.avgRate.toFixed(2)}`, label: '平均费率/分钟', color: 'text-green-600' },
          { value: page.stats.equipmentSteps, label: '设备步骤数', color: 'text-purple-600' },
        ].map((stat, i) => (
          <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
            <div className={`text-2xl font-semibold ${stat.color || 'text-gray-900'}`}>
              {stat.value}
            </div>
            <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* 表格区域 */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {/* 筛选栏 */}
        <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="搜索工时步骤"
              value={page.searchInput}
              onChange={(e) => page.setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && page.handleSearch()}
              className="w-48 h-10 pl-9 pr-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <SearchableSelect
            value={page.filterProjectType}
            onChange={page.handleProjectTypeChange}
            options={page.PROJECT_TYPE_OPTIONS}
            placeholder="全部项目类型"
            className="w-36"
          />
          <SearchableSelect
            value={page.filterReferenceSource}
            onChange={page.handleReferenceSourceChange}
            options={[
              { value: '', label: '全部来源' },
              { value: 'system', label: '系统预设' },
              { value: 'supplier', label: '供应商提供' },
              { value: 'industry', label: '行业标准' },
            ]}
            placeholder="全部来源"
            className="w-32"
          />
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

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">步骤编号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">步骤名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">项目类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">标准时长</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">费率/分钟</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">参考值来源</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {page.loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">加载中...</td>
                </tr>
              ) : page.data.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">暂无工时定义</td>
                </tr>
              ) : (
                page.data.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-gray-900">{row.stepCode}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{row.stepName}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {row.projectType === 'all' ? '全部' : row.projectType.toUpperCase()}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{row.standardMinutes} 分钟</td>
                    <td className="px-4 py-3 text-gray-700">¥{row.laborRatePerMinute?.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                        row.isEquipmentStep
                          ? 'bg-purple-50 text-purple-600 border-purple-200'
                          : 'bg-blue-50 text-blue-600 border-blue-200'
                      }`}>
                        {row.isEquipmentStep ? '设备' : '人工'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                        row.referenceSource === 'supplier'
                          ? 'bg-orange-50 text-orange-600 border-orange-200'
                          : row.referenceSource === 'industry'
                          ? 'bg-teal-50 text-teal-600 border-teal-200'
                          : 'bg-gray-50 text-gray-600 border-gray-200'
                      }`}>
                        {row.referenceSourceLabel || '系统预设'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => page.openDetail(row)}
                          className="px-2 py-1 text-sm text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        >
                          详情
                        </button>
                        {page.canManageLaborTimes && (
                          <>
                            <button
                              onClick={() => page.openEdit(row)}
                              className="px-2 py-1 text-sm text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                            >
                              编辑
                            </button>
                            <button
                              onClick={() => page.openDelete(row)}
                              className="px-2 py-1 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                            >
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        {page.total > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200">
            <div className="text-sm text-gray-500">共 {page.total} 条</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => page.setPage(Math.max(1, page.page - 1))}
                disabled={page.page <= 1}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                上一页
              </button>
              <span className="text-sm text-gray-600 px-2">
                {page.page} / {Math.ceil(page.total / page.pageSize) || 1}
              </span>
              <button
                onClick={() => page.setPage(page.page + 1)}
                disabled={page.page * page.pageSize >= page.total}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 表单弹窗 */}
      <LaborTimeFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      {/* 详情弹窗 */}
      <LaborTimeDetailModal
        open={page.modalType === 'detail'}
        row={page.detailRow}
        onClose={() => page.setModalType(null)}
        onEdit={page.openEdit}
        canEdit={page.canManageLaborTimes}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={page.modalType === 'delete'}
        title="归档工时定义"
        description={`确定要归档工时定义「${page.detailRow?.stepName || ''}」吗？归档后不再参与成本计算和列表展示，历史记录仍可审计。`}
        confirmText="确认归档"
        confirmVariant="danger"
        onConfirm={page.handleDelete}
        onCancel={() => page.setModalType(null)}
      />
    </div>
  )
}
