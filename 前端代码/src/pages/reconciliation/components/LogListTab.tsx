import { Pagination } from '@/components/ui/Pagination'
import type { UsePaginationReturn } from '@/hooks/usePagination'
import type { ReconcileLog } from '../hooks/useReconciliationPage'

interface Props {
  logPagination: UsePaginationReturn<ReconcileLog>
  currentUsername: string
  canApprove: boolean
  mutationBusy: boolean
  onApprove: (id: string, scope: 'future_only' | 'retroactive') => void
  onReject: (id: string) => void
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'bg-amber-50 text-amber-700' },
  applied: { label: '已生效', cls: 'bg-green-50 text-green-700' },
  rejected: { label: '已驳回', cls: 'bg-gray-100 text-gray-500' },
}

export function LogListTab({ logPagination, currentUsername, canApprove, mutationBusy, onApprove, onReject }: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200">
        <h3 className="font-semibold text-gray-900">BOM 修正提案 / 记录</h3>
        <p className="text-xs text-gray-500 mt-0.5">修正须经独立审核人通过后才生效（提交人不可审核自己的提案）</p>
      </div>
      <div className="p-5">
        {logPagination.error && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>修正日志没能加载。{logPagination.data.length ? '当前显示上次成功结果，审核操作已关闭。' : '本次失败不代表没有记录。'}</span>
            <button type="button" className="font-medium underline underline-offset-2" onClick={logPagination.refresh}>重试</button>
          </div>
        )}
        {logPagination.loading && <div role="status" className="mb-4 text-sm text-gray-500">修正日志加载中…</div>}
        {logPagination.data.length === 0 && !logPagination.loading && !logPagination.error ? (
          <div className="text-center py-8 text-gray-400">暂无修正记录</div>
        ) : (
          <div className="space-y-4">
            {logPagination.data.map(log => {
              const isProposal = log.type === 'bom_fix_proposal' || log.type === 'bom_fix'
              const status = log.status || (isProposal ? 'applied' : 'applied')
              const meta = STATUS_META[status] || STATUS_META.applied
              const isPending = status === 'pending'
              const isOwn = log.operator === currentUsername
              const newVal = log.proposed_usage ?? log.new_value
              return (
                <div key={log.id} className="flex gap-3 pb-4 border-b border-gray-100 last:border-0" style={{ contentVisibility: 'auto' }}>
                  <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${isProposal ? 'bg-blue-500' : 'bg-green-500'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-800 flex items-center gap-2 flex-wrap">
                      <strong>{isProposal ? '修正 BOM 用量' : '新增关联'}</strong>
                      <span>· {log.target_name}</span>
                      {log.old_value && newVal != null && (
                        <span>
                          从 <span className="line-through text-gray-400">{log.old_value}</span> 调整为 <strong>{newVal}</strong>
                        </span>
                      )}
                      <span className={`px-2 py-0.5 rounded-full text-xs ${meta.cls}`}>{meta.label}</span>
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      {log.created_at} · 提交人 {log.operator}
                      {log.reviewed_by && ` · 审核人 ${log.reviewed_by}`}
                      {log.reason ? ` · 原因：${log.reason}` : ''}
                    </div>
                    {isPending && (
                      <div className="mt-2 flex items-center gap-2">
                        {!canApprove || isOwn ? (
                          <span className="text-xs text-gray-400">{isOwn ? '（不可审核自己提交的提案，待他人审核）' : '（待成本负责人审核）'}</span>
                        ) : (
                          <>
                            <button
                              onClick={() => onApprove(log.id, 'future_only')}
                              disabled={mutationBusy || !!logPagination.error}
                              className="px-3 h-8 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                            >
                              通过（自下次生效）
                            </button>
                            <button
                              onClick={() => {
                                if (window.confirm('追溯重算会重算受影响的未关账月成本，确认通过？')) onApprove(log.id, 'retroactive')
                              }}
                              disabled={mutationBusy || !!logPagination.error}
                              className="px-3 h-8 text-xs border border-blue-600 text-blue-600 rounded-md hover:bg-blue-50 transition-colors"
                            >
                              通过并追溯重算
                            </button>
                            <button
                              onClick={() => onReject(log.id)}
                              disabled={mutationBusy || !!logPagination.error}
                              className="px-3 h-8 text-xs border border-gray-300 text-gray-600 rounded-md hover:bg-gray-50 transition-colors"
                            >
                              驳回
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-4">
          <Pagination
            page={logPagination.page}
            pageSize={logPagination.pageSize}
            total={logPagination.total}
            onChange={logPagination.setPage}
            onPageSizeChange={logPagination.setPageSize}
          />
        </div>
      </div>
    </div>
  )
}
