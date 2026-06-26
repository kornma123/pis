import React from 'react'
import { Plus, Search, Eye, Edit2, Trash2, Settings, BarChart3 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { useEquipmentPage } from './hooks/useEquipmentPage'
import { EquipmentFormModal } from './components/EquipmentFormModal'
import { EquipmentDetailModal } from './components/EquipmentDetailModal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export default function EquipmentList() {
  const page = useEquipmentPage()
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">
            设备管理
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理病理设备档案，配置折旧规则
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/equipment/types')}
            className="h-10 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 flex items-center gap-2 transition-colors"
          >
            <Settings className="w-4 h-4" />
            设备类型
          </button>
          {page.canManageEquipmentAssets && (
            <button
              onClick={page.openCreate}
              className="h-10 px-4 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 flex items-center gap-2 transition-colors"
            >
              <Plus className="w-4 h-4" />
              新增设备
            </button>
          )}
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { value: page.stats.total, label: '设备总数' },
          { value: page.stats.active, label: '已启用', color: 'text-green-600' },
          { value: page.stats.inactive, label: '已停用', color: 'text-gray-600' },
          { value: `¥${page.stats.totalValue.toFixed(2)}`, label: '资产总值', color: 'text-blue-600' },
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
              placeholder="搜索设备"
              value={page.searchInput}
              onChange={(e) => page.setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && page.handleSearch()}
              className="w-48 h-10 pl-9 pr-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <SearchableSelect
            value={page.filterTypeId}
            onChange={page.handleTypeChange}
            options={[{ value: '', label: '全部类型' }, ...page.typeOptions]}
            placeholder="全部类型"
            className="w-36"
          />
          <SearchableSelect
            value={page.filterStatus}
            onChange={page.handleStatusChange}
            options={[
              { value: '', label: '全部状态' },
              { value: 'active', label: '已启用' },
              { value: 'inactive', label: '已停用' },
              { value: 'scrapped', label: '已报废' },
            ]}
            placeholder="全部状态"
            className="w-28"
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
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">设备编号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">设备名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">设备类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">型号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">购置价格</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">折旧方式</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">年折旧额</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">状态</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {page.loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    加载中...
                  </td>
                </tr>
              ) : page.data.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    暂无设备数据
                  </td>
                </tr>
              ) : (
                page.data.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-gray-900">{row.code}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                    <td className="px-4 py-3 text-gray-500">{row.typeName || '-'}</td>
                    <td className="px-4 py-3 text-gray-500">{row.model || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">¥{row.purchasePrice?.toFixed(2) || '0.00'}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {row.depreciationMethod === 'straight_line' ? '直线法' : '工作量法'}
                    </td>
                    <td className="px-4 py-3 text-gray-700">¥{row.annualDepreciation?.toFixed(2) || '0.00'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                        row.status === 'active'
                          ? 'bg-green-50 text-green-600 border-green-200'
                          : row.status === 'inactive'
                          ? 'bg-gray-100 text-gray-600 border-gray-200'
                          : 'bg-red-50 text-red-600 border-red-200'
                      }`}>
                        {row.status === 'active' ? '已启用' : row.status === 'inactive' ? '已停用' : '已报废'}
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
                        {page.canManageEquipmentAssets && (
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
            <div className="text-sm text-gray-500">
              共 {page.total} 条
            </div>
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
      <EquipmentFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        typeOptions={page.typeOptions}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      {/* 详情弹窗 */}
      <EquipmentDetailModal
        open={page.modalType === 'detail'}
        row={page.detailRow}
        onClose={() => page.setModalType(null)}
        onEdit={page.openEdit}
        canEdit={page.canManageEquipmentAssets}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={page.modalType === 'delete'}
        title="确认删除"
        description={`确定要删除设备「${page.detailRow?.name || ''}」吗？删除后不会再进入新 BOM 设备选择、设备使用登记、折旧统计和月度成本计算；历史 BOM、使用记录、成本明细和审计记录仍保留可回看。`}
        confirmText="确认删除"
        confirmVariant="danger"
        onConfirm={page.handleDelete}
        onCancel={() => page.setModalType(null)}
      />
    </div>
  )
}
