import { Plus, ArrowRightLeft, ArrowUp, ArrowDown, Info, Lock } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useLaneCPage } from './useLaneCPage'
import LaneCStats from './components/LaneCStats'
import LaneCQuickFilters from './components/LaneCQuickFilters'
import LaneCFilterBar from './components/LaneCFilterBar'
import LaneCTable from './components/LaneCTable'
import LaneCDetailModal from './components/LaneCDetailModal'
import LaneCCreateModal from './components/LaneCCreateModal'
import type { LaneCConfig } from './types'

const badgeTone: Record<string, string> = {
  up: 'bg-green-50 text-green-700',
  down: 'bg-red-50 text-red-700',
  neutral: 'bg-gray-100 text-gray-600',
}
const noteTone: Record<string, string> = {
  up: 'bg-green-50 text-green-700',
  down: 'bg-red-50 text-red-700',
  neutral: 'bg-gray-50 text-gray-600',
}

export default function LaneCPage({ config }: { config: LaneCConfig }) {
  const s = useLaneCPage(config)
  const EffectIcon = config.effect.tone === 'up' ? ArrowUp : config.effect.tone === 'down' ? ArrowDown : ArrowRightLeft

  if (!s.canView) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock className="w-10 h-10 text-gray-300" />
        <div className="mt-3 text-base font-medium text-gray-700">你没有查看{config.noun}记录的权限</div>
        <div className="mt-1 text-sm text-gray-400">如需开通，请联系管理员</div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">{config.title}</h1>
            <span className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-xs font-medium ${badgeTone[config.effect.tone]}`}>
              <EffectIcon className="w-3.5 h-3.5" />{config.effect.text}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">{config.subtitle}</p>
        </div>
        {s.canWrite && (
          <button
            onClick={s.openCreate}
            disabled={!s.canCreate}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-white rounded-md text-sm font-medium transition-colors shadow-sm disabled:cursor-not-allowed disabled:bg-gray-400 ${config.createTone === 'red' ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'}`}
          >
            <Plus className="w-[18px] h-[18px]" /> {config.createLabel}
          </button>
        )}
      </div>

      {s.canWrite && s.createBlockedReason && (
        <div role="alert" aria-label={`${config.noun}登记状态`} className="flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <span className="flex-1">{s.createBlockedReason}</span>
          {(s.materialsState.status === 'error' || s.materialsState.status === 'stale') && (
            <button onClick={s.retryMaterials} className="rounded border border-amber-300 bg-white px-2.5 py-1 text-xs hover:bg-amber-100">重试物料选项</button>
          )}
          {config.needsLocations && (s.locationsState.status === 'error' || s.locationsState.status === 'stale') && (
            <button onClick={s.retryLocations} className="rounded border border-amber-300 bg-white px-2.5 py-1 text-xs hover:bg-amber-100">重试库位选项</button>
          )}
        </div>
      )}

      {/* 据实语义说明条 */}
      <div className={`flex items-start gap-2 rounded-lg px-4 py-2.5 text-xs leading-relaxed ${noteTone[config.effect.tone]}`}>
        <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>{config.note}</span>
      </div>

      {/* 统计卡 */}
      <LaneCStats noun={config.noun} state={s.statsState} onRetry={s.retryStats} />

      {/* 快速筛选 */}
      <LaneCQuickFilters activeKey={s.activeQuickFilter} onChange={s.setActiveQuickFilter} />

      {/* 主卡片 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <LaneCFilterBar
          config={config}
          locationsState={s.locationsState}
          onRetryLocations={s.retryLocations}
          searchKeyword={s.searchKeyword}
          onSearchChange={s.setSearchKeyword}
          filterReason={s.filterReason}
          onReasonChange={s.setFilterReason}
          filterLocation={s.filterLocation}
          onLocationChange={s.setFilterLocation}
          filterStartDate={s.filterStartDate}
          onStartDateChange={s.setFilterStartDate}
          filterEndDate={s.filterEndDate}
          onEndDateChange={s.setFilterEndDate}
          onQuery={() => s.setPage(1)}
          onReset={s.handleResetFilters}
          onExport={s.handleBatchExport}
        />
        <LaneCTable
          config={config}
          state={s.listState}
          materials={s.materials}
          canWrite={s.canMutateList}
          isFilterActive={s.isFilterActive}
          selectedIds={s.selectedIds}
          isAllSelected={s.isAllSelected}
          isIndeterminate={s.isIndeterminate}
          onToggleSelectAll={s.toggleSelectAll}
          onToggleSelectOne={s.toggleSelectOne}
          sortField={s.sortField}
          sortOrder={s.sortOrder}
          onSort={s.toggleSort}
          onDetail={s.openDetail}
          onDelete={s.handleDelete}
          onBatchExport={s.handleBatchExport}
          onBatchDelete={s.handleBatchDelete}
          onRetry={s.refresh}
          onResetFilters={s.handleResetFilters}
          page={s.page}
          pageSize={s.pageSize}
          onPageChange={s.setPage}
          onPageSizeChange={s.setPageSize}
        />
      </div>

      {/* 弹窗 */}
      <LaneCCreateModal
        open={s.modalType === 'create'}
        config={config}
        form={s.form}
        setForm={s.setForm}
        materials={s.materials}
        locations={s.locations}
        blockedReason={s.createBlockedReason}
        submitting={s.submitting}
        onClose={s.closeModal}
        onSubmit={s.handleCreate}
      />
      <LaneCDetailModal
        open={s.modalType === 'detail'}
        config={config}
        record={s.selectedRecord}
        materials={s.materials}
        onClose={s.closeModal}
      />
      <ConfirmDialog
        open={s.confirmModal.open}
        title={s.confirmModal.title}
        message={s.confirmModal.message}
        confirmText="确认撤销"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={() => { s.confirmModal.onConfirm?.(); s.closeConfirmModal() }}
        onCancel={s.closeConfirmModal}
      />
    </div>
  )
}
