import React from 'react'
import { AlertTriangle, Plus, RefreshCw, Search, Coins } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { useCostCenterPage } from './hooks/useCostCenterPage'
import { CostCenterFormModal } from './components/CostCenterFormModal'
import { AllocationModal } from './components/AllocationModal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export default function IndirectCostCenterList() {
  const page = useCostCenterPage()

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">
            间接成本中心
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理房租、水电、管理等间接费用，录入月度分摊数据
          </p>
        </div>
        <button
          onClick={page.openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium transition-colors h-10"
        >
          <Plus className="w-4 h-4" />
          新增成本中心
        </button>
      </div>

      <section aria-label="数据覆盖与口径" className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">数据覆盖与口径</h2>
        {page.statsStatus === 'loading' ? (
          <p className="mt-1 text-sm text-gray-500" role="status">正在加载当前筛选条件的汇总统计…</p>
        ) : page.statsStatus === 'error' ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            <span>汇总统计不可用；下方列表按自身请求状态展示，统计值不折算为 0。</span>
            <button type="button" onClick={() => void page.retryStats()} className="inline-flex h-8 items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
              <RefreshCw className="h-3.5 w-3.5" /> 重试汇总统计
            </button>
          </div>
        ) : (
          <p className="mt-1 text-sm text-gray-500">统计与列表均按当前关键词和状态筛选；缺失字段以“—”表示。</p>
        )}
      </section>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { value: page.stats?.total ?? '—', label: '成本中心数' },
          { value: page.stats?.active ?? '—', label: '已启用', color: 'text-green-600' },
          { value: page.stats?.totalMonthly == null ? '—' : `¥${page.stats.totalMonthly.toFixed(2)}`, label: '月度费用合计', color: 'text-blue-600' },
          { value: page.stats?.allocationCount ?? '—', label: '分摊记录数', color: 'text-purple-600' },
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
        {page.listError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            <span>{page.data.length > 0 ? '列表刷新失败，当前保留上次成功结果。' : '列表数据不可用，没有把请求失败解释成空列表。'}</span>
            <button type="button" onClick={page.refresh} className="ml-auto inline-flex h-8 items-center gap-1 rounded-md border border-amber-300 px-2.5 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
              <RefreshCw className="h-3.5 w-3.5" /> 重试列表
            </button>
          </div>
        )}
        {/* 筛选栏 */}
        <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              aria-label="搜索成本中心"
              placeholder="搜索成本中心"
              value={page.searchInput}
              onChange={(e) => page.setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && page.handleSearch()}
              className="w-48 h-10 pl-9 pr-3 border border-gray-300 rounded-md text-sm outline-none transition-all focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <SearchableSelect
            value={page.filterStatus}
            onChange={page.handleStatusChange}
            options={[
              { value: '', label: '全部状态' },
              { value: 'active', label: '已启用' },
              { value: 'inactive', label: '已停用' },
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
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">编号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">费用类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">月度金额</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">分摊基础</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">状态</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {page.loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">加载中...</td>
                </tr>
              ) : page.listError && page.data.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-amber-700">列表数据不可用</td>
                </tr>
              ) : page.data.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">暂无成本中心</td>
                </tr>
              ) : (
                page.data.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_48px]">
                    <td className="px-4 py-3 font-mono text-gray-900">{row.code}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                    <td className="px-4 py-3 text-gray-500">{row.costTypeLabel || row.costType}</td>
                    <td className="px-4 py-3 text-gray-700">
                      {typeof row.monthlyAmount === 'number' && Number.isFinite(row.monthlyAmount)
                        ? `¥${row.monthlyAmount.toFixed(2)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {/* HON-4：逐中心分摊口径从不被引擎读取；不再按中心展示「样本数/收入…」的空转选项，
                          统一显示真实分摊方式（按每月统一规则），避免误导。 */}
                      <span title="间接费用按每月统一规则分摊，未按成本中心单独选择的口径">统一规则</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                        row.status === 'active'
                          ? 'bg-green-50 text-green-600 border-green-200'
                          : 'bg-gray-100 text-gray-600 border-gray-200'
                      }`}>
                        {row.status === 'active' ? '已启用' : '已停用'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => page.openAllocation(row)}
                          className="px-2 py-1 text-sm text-gray-600 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors flex items-center gap-1"
                        >
                          <Coins className="w-3.5 h-3.5" />
                          分摊
                        </button>
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
      <CostCenterFormModal
        open={page.modalType === 'create' || page.modalType === 'edit'}
        type={page.modalType === 'edit' ? 'edit' : 'create'}
        form={page.form}
        onClose={() => page.setModalType(null)}
        onChange={page.setForm}
        onSubmit={page.handleSubmit}
      />

      {/* 分摊弹窗 */}
      <AllocationModal
        open={page.modalType === 'allocation'}
        row={page.detailRow}
        allocationForm={page.allocationForm}
        allocations={page.allocations}
        allocationStatus={page.allocationStatus}
        onRetryAllocations={() => void page.retryAllocations()}
        onClose={() => page.setModalType(null)}
        onChangeForm={page.setAllocationForm}
        onSubmit={page.handleAllocationSubmit}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={page.modalType === 'delete'}
        title="确认删除"
        description={`确定要删除成本中心「${page.detailRow?.name || ''}」吗？删除后不会再用于新月度分摊、项目成本归集、成本结账和审计筛选；已有分摊记录的成本中心后端会阻止删除，历史分摊、项目成本和审计记录仍保留可回看。`}
        confirmText="确认删除"
        confirmVariant="danger"
        onConfirm={page.handleDelete}
        onCancel={() => page.setModalType(null)}
      />
    </div>
  )
}
