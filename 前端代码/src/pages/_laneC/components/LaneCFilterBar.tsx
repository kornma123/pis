import { Search, Download, RotateCcw } from 'lucide-react'
import type { LaneCConfig, Location } from '../types'
import { requestFailureMessage, type RequestTruth } from '../requestTruth'

interface Props {
  config: LaneCConfig
  locationsState: RequestTruth<Location[]>
  onRetryLocations: () => void
  searchKeyword: string
  onSearchChange: (v: string) => void
  filterReason: string
  onReasonChange: (v: string) => void
  filterLocation: string
  onLocationChange: (v: string) => void
  filterStartDate: string
  onStartDateChange: (v: string) => void
  filterEndDate: string
  onEndDateChange: (v: string) => void
  onQuery: () => void
  onReset: () => void
  onExport: () => void
}

const inputCls = 'h-10 px-3 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500'

export default function LaneCFilterBar(p: Props) {
  const locations = p.locationsState.status === 'ready' || p.locationsState.status === 'stale'
    ? p.locationsState.data
    : []
  const locationsVerified = p.locationsState.status === 'ready'

  return (
    <div className="px-5 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={p.searchKeyword}
          onChange={e => p.onSearchChange(e.target.value)}
          placeholder="搜单号 / 物料名称"
          className={`${inputCls} w-full pl-9`}
        />
      </div>

      {p.config.filterKind === 'reason' ? (
        <select value={p.filterReason} onChange={e => p.onReasonChange(e.target.value)} className={inputCls}>
          <option value="">全部原因</option>
          {(p.config.reasons || []).map(r => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      ) : (
        <div className="flex flex-col gap-1">
          <select value={p.filterLocation} onChange={e => p.onLocationChange(e.target.value)} disabled={!locationsVerified} className={`${inputCls} disabled:bg-gray-100 disabled:cursor-not-allowed`}>
            <option value="">
              {p.locationsState.status === 'loading'
                ? '库位选项加载中'
                : p.locationsState.status === 'error' ? '库位选项不可用' : '全部目标库位'}
            </option>
            {locations.map(location => (
              <option key={location.id} value={location.id}>{location.name}</option>
            ))}
          </select>
          {(p.locationsState.status === 'error' || p.locationsState.status === 'stale') && (
            <div role="alert" aria-label={`${p.config.noun}库位选项状态`} className="flex items-center gap-2 text-xs text-amber-700">
              <span>
                {p.locationsState.status === 'stale' && '当前显示上次成功选项。'}
                {requestFailureMessage(p.locationsState.failure, '库位选项')}
              </span>
              <button onClick={p.onRetryLocations} className="underline hover:no-underline">重试</button>
            </div>
          )}
        </div>
      )}

      <input type="date" value={p.filterStartDate} onChange={e => p.onStartDateChange(e.target.value)} className={inputCls} />
      <span className="text-sm text-gray-400">至</span>
      <input type="date" value={p.filterEndDate} onChange={e => p.onEndDateChange(e.target.value)} className={inputCls} />

      <button onClick={p.onQuery} className="h-10 px-4 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 transition-colors">
        查询
      </button>
      <button onClick={p.onReset} className="h-10 px-3 inline-flex items-center gap-1.5 bg-white text-gray-500 border border-gray-300 rounded-md text-sm hover:bg-gray-50 transition-colors">
        <RotateCcw className="w-3.5 h-3.5" /> 重置
      </button>
      <button onClick={p.onExport} className="h-10 px-3 ml-auto inline-flex items-center gap-1.5 bg-white text-green-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 transition-colors">
        <Download className="w-3.5 h-3.5" /> 导出
      </button>
    </div>
  )
}
