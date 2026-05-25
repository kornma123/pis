import { Pagination } from '@/components/ui/Pagination'
import type { UsePaginationReturn } from '@/hooks/usePagination'
import type { ReconcileLog } from '../hooks/useReconciliationPage'

interface Props {
  logPagination: UsePaginationReturn<ReconcileLog>
}

export function LogListTab({ logPagination }: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200">
        <h3 className="font-semibold text-gray-900">BOM修正记录</h3>
      </div>
      <div className="p-5">
        {logPagination.data.length === 0 && !logPagination.loading ? (
          <div className="text-center py-8 text-gray-400">暂无修正记录</div>
        ) : (
          <div className="space-y-4">
            {logPagination.data.map(log => (
              <div key={log.id} className="flex gap-3 pb-4 border-b border-gray-100 last:border-0">
                <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${log.type === 'bom_fix' ? 'bg-blue-500' : 'bg-green-500'}`} />
                <div className="flex-1">
                  <div className="text-sm text-gray-800">
                    <strong>{log.type === 'bom_fix' ? '修正 BOM' : '新增关联'}</strong>：
                    {log.target_name}
                    {log.field && ` · ${log.field}`}
                    {log.old_value && log.new_value && (
                      <span> 从 <span className="line-through text-gray-400">{log.old_value}</span> 调整为 <strong>{log.new_value}</strong></span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {log.created_at} · {log.operator} · 原因：{log.reason}
                  </div>
                </div>
              </div>
            ))}
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
