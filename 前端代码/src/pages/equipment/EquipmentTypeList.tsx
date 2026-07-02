import React from 'react'
import { Plus, Search, Wrench } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useEquipmentTypePage } from './hooks/useEquipmentTypePage'
import EquipmentTypeFormModal from './components/EquipmentTypeFormModal'

export default function EquipmentTypeList() {
  const page = useEquipmentTypePage()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-bold text-gray-900">设备类型管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理设备分类，用于 BOM 成本计算和折旧统计</p>
        </div>
        {page.canManageEquipmentTypes && (
          <button
            onClick={page.openCreate}
            className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 flex items-center gap-2 transition-colors"
          >
            <Plus className="w-4 h-4" />
            新增类型
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500">类型总数</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{page.stats.total}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500">启用类型</div>
          <div className="text-2xl font-bold text-green-600 mt-1">{page.stats.active}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="text-sm text-gray-500">设备总数</div>
          <div className="text-2xl font-bold text-blue-600 mt-1">{page.stats.equipmentCount}</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        {/* Filters */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={page.searchInput}
              onChange={(e) => page.setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && page.handleSearch()}
              placeholder="搜索编码或名称..."
              className="w-full h-10 pl-9 pr-3 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
            />
          </div>
          <div className="w-36">
            <SearchableSelect
              options={[
                { value: '', label: '全部状态' },
                { value: 'active', label: '启用' },
                { value: 'inactive', label: '禁用' },
              ]}
              value={page.statusFilter}
              onChange={page.handleStatusChange}
              placeholder="全部状态"
            />
          </div>
          <button onClick={page.handleSearch} className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors">
            查询
          </button>
          <button onClick={page.handleReset} className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
            重置
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">类型编码</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">类型名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">描述</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">设备数量</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">折旧方法</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">状态</th>
                {page.canManageEquipmentTypes && (
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">操作</th>
                )}
              </tr>
            </thead>
            <tbody>
              {page.loading ? (
                <tr><td colSpan={page.canManageEquipmentTypes ? 7 : 6} className="px-4 py-12 text-center text-gray-400">加载中...</td></tr>
              ) : !page.data?.length ? (
                <tr><td colSpan={page.canManageEquipmentTypes ? 7 : 6} className="px-4 py-12 text-center text-gray-400">暂无数据</td></tr>
              ) : (
                page.data.map((row: any) => (
                  <tr key={row.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{row.code}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">
                      <div className="flex items-center gap-2">
                        <Wrench className="w-4 h-4 text-gray-400" />
                        {row.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 max-w-[200px] truncate">{row.description || '-'}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-900">{row.equipmentCount || 0}</td>
                    <td className="px-4 py-3 text-sm text-center text-gray-600">
                      {row.defaultDepreciationMethod === 'straight_line' ? '直线法' : '工作量法'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        row.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {row.status === 'active' ? '启用' : '禁用'}
                      </span>
                    </td>
                    {page.canManageEquipmentTypes && (
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => page.openEdit(row)}
                            className="text-blue-600 hover:text-blue-800 text-sm transition-colors"
                          >
                            编辑
                          </button>
                          <button
                            onClick={() => page.setDeleteTarget(row)}
                            className="text-red-600 hover:text-red-800 text-sm transition-colors"
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {page.total > 0 && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between text-sm text-gray-500">
            <span>共 {page.total} 条</span>
            <div className="flex items-center gap-2">
              <button
                disabled={page.page <= 1}
                onClick={() => page.setPage(page.page - 1)}
                className="px-3 py-1 border border-gray-300 rounded-md disabled:opacity-50 hover:bg-gray-50 transition-colors"
              >
                上一页
              </button>
              <span>{page.page}</span>
              <button
                disabled={page.page * page.pageSize >= page.total}
                onClick={() => page.setPage(page.page + 1)}
                className="px-3 py-1 border border-gray-300 rounded-md disabled:opacity-50 hover:bg-gray-50 transition-colors"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      <EquipmentTypeFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        submitting={page.submitting}
        onClose={page.closeModal}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      <ConfirmDialog
        open={!!page.deleteTarget}
        title="删除设备类型"
        message={`确定要删除设备类型“${page.deleteTarget?.name}”吗？删除后不会再用于新建设备的类型选择、默认折旧口径、BOM 成本计算和折旧统计；已有设备、历史 BOM 成本、使用记录和审计记录仍保留可回看。`}
        confirmText="删除"
        confirmVariant="danger"
        onConfirm={page.handleDelete}
        onCancel={() => page.setDeleteTarget(null)}
      />
    </div>
  )
}
