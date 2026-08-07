import { AlertTriangle, HelpCircle, Plus, RefreshCw } from 'lucide-react'
import { useStocktakingPage, statusOptions } from './hooks/useStocktakingPage'
import { StocktakingTable } from './components/StocktakingTable'
import { StocktakingCreateModal } from './components/StocktakingCreateModal'
import { StocktakingDetailModal } from './components/StocktakingDetailModal'
import { StocktakingAdjustModal } from './components/StocktakingAdjustModal'
import { StocktakingReverseModal } from './components/StocktakingReverseModal'
import { StocktakingFlowModal } from './components/StocktakingFlowModal'

const statCards = [
  { key: 'todayCount', label: '今日盘点记录', tone: 'border-blue-100 text-blue-700' },
  { key: 'pendingCount', label: '有差异待处理', tone: 'border-amber-100 text-amber-700' },
  { key: 'adjustedCount', label: '已调整库存', tone: 'border-emerald-100 text-emerald-700' },
  { key: 'unresolvedCount', label: '批次或库位待核实', tone: 'border-orange-100 text-orange-700' },
] as const

export default function Stocktaking() {
  const page = useStocktakingPage()
  const closeModal = () => page.setModal(null)

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-gray-900">库存盘点</h1>
          <p className="mt-1 text-sm text-gray-500">记录现场实盘数量，有差异时再独立确认是否调整库存。</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={page.openFlow} className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"><HelpCircle className="h-4 w-4" />查看盘点流程</button>
          {page.canRecord ? <button type="button" onClick={() => page.openCreate()} className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-600"><Plus className="h-4 w-4" />新建盘点</button> : null}
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="盘点概况">
        {statCards.map(card => <div key={card.key} className={`rounded-lg border bg-white p-5 shadow-sm ${card.tone}`}><div className="text-3xl font-semibold tabular-nums">{page.stats[card.key]}</div><div className="mt-1 text-sm text-gray-500">{card.label}</div></div>)}
      </section>

      {!page.canRecord ? <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">你当前只能查看盘点记录。如果需要登记实盘数量，请联系管理员配置“盘点”写权限。</div> : null}
      {page.error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"><span>盘点记录加载失败，当前数据可能不完整。</span><button type="button" onClick={() => void page.retryList()} className="inline-flex h-9 items-center gap-2 rounded-md border border-rose-200 bg-white px-3 font-medium"><RefreshCw className="h-4 w-4" />重新加载</button></div> : null}

      {page.conflict ? <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><div className="flex gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><div className="flex-1"><strong>盘点之后，该位置的库存又发生了变化。</strong><p className="mt-1">系统已拒绝直接覆盖，需要刷新当前库存后重新盘点。{page.conflict.refreshed ? ` 当前库存：${page.conflict.currentStock ?? '无法确认'}。` : ''}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void page.refreshConflict()} className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 bg-white px-3 font-medium"><RefreshCw className="h-4 w-4" />刷新当前库存</button>{page.conflict.refreshed ? <button type="button" onClick={page.recountConflict} className="h-9 rounded-md bg-amber-700 px-3 font-medium text-white">重新盘点</button> : null}<button type="button" onClick={() => page.setConflict(null)} className="h-9 px-3 font-medium text-amber-800">稍后处理</button></div></div></div></div> : null}

      <StocktakingTable
        data={page.data} loading={page.loading} total={page.total} page={page.page} pageSize={page.pageSize}
        keyword={page.keyword} statusFilter={page.statusFilter} statusOptions={statusOptions}
        canRecord={page.canRecord} canAdjust={page.canAdjust}
        onKeywordChange={page.setKeyword} onStatusFilterChange={page.setStatusFilter}
        onQuery={page.applyFilters} onReset={page.resetFilters} onPageChange={page.setPage} onPageSizeChange={page.setPageSize}
        onOpenCreate={() => page.openCreate()} onOpenDetail={page.openDetail} onOpenAdjust={page.openAdjust}
      />

      <StocktakingCreateModal open={page.modal === 'create'} step={page.createStep} positions={page.positions} confirmedPosition={page.confirmedPosition} loading={page.positionsLoading} keyword={page.positionKeyword} selectedPositionId={page.selectedPositionId} actualStock={page.actualStock} remark={page.remark} submitting={page.createSubmitting} onClose={closeModal} returnFocus={page.returnFocus} onKeywordChange={page.setPositionKeyword} onSelectPosition={page.setSelectedPositionId} onActualStockChange={page.setActualStock} onRemarkChange={page.setRemark} onStepChange={page.setCreateStep} onSubmit={page.submitCreate} />
      <StocktakingDetailModal open={page.modal === 'detail'} row={page.detail} loading={page.detailLoading} canAdjust={page.canAdjust} canReverse={page.canReverse} explanation={page.explanation} explanationSubmitting={page.explanationSubmitting} onExplanationChange={page.setExplanation} onAppendExplanation={page.submitExplanation} onAdjust={page.openAdjust} onReverse={page.openReverse} onClose={closeModal} returnFocus={page.returnFocus} />
      <StocktakingAdjustModal open={page.modal === 'adjust'} row={page.detail} loading={page.detailLoading} reason={page.adjustReason} submitting={page.adjustSubmitting} onChangeReason={page.setAdjustReason} onSubmit={page.submitAdjust} onClose={closeModal} returnFocus={page.returnFocus} />
      <StocktakingReverseModal open={page.modal === 'reverse'} row={page.detail} loading={page.detailLoading} reason={page.reverseReason} submitting={page.reverseSubmitting} onReasonChange={page.setReverseReason} onSubmit={page.submitReverse} onClose={closeModal} returnFocus={page.returnFocus} />
      <StocktakingFlowModal open={page.modal === 'flow'} onClose={closeModal} returnFocus={page.returnFocus} />
    </div>
  )
}
