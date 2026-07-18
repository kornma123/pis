import { Search, Calendar } from 'lucide-react'
import type { Material } from '@/types'

type StatusFilter = '' | 'completed' | 'pending' | 'cancelled'
type TypeFilter = '' | 'project' | 'transfer' | 'scrap'

interface OutboundFilterBarProps {
  searchText: string
  materialFilter: string
  typeFilter: TypeFilter
  statusFilter: StatusFilter
  startDate: string
  endDate: string
  materials: Material[]
  onSearchChange: (value: string) => void
  onMaterialChange: (value: string) => void
  onTypeChange: (value: TypeFilter) => void
  onStatusChange: (value: StatusFilter) => void
  onStartDateChange: (value: string) => void
  onEndDateChange: (value: string) => void
  onQuery: () => void
  onReset: () => void
}

export default function OutboundFilterBar({
  searchText,
  materialFilter,
  typeFilter,
  statusFilter,
  startDate,
  endDate,
  materials,
  onSearchChange,
  onMaterialChange,
  onTypeChange,
  onStatusChange,
  onStartDateChange,
  onEndDateChange,
  onQuery,
  onReset,
}: OutboundFilterBarProps) {
  return (
    <form onSubmit={event => { event.preventDefault(); onQuery() }} className="flex flex-col gap-4 border-b border-gray-200 p-4 lg:flex-row lg:items-center">
      <h2 id="outbound-list-title" className="text-base font-medium text-gray-900">出库记录</h2>
      <div className="flex-1 flex flex-wrap items-center gap-3">
        {/* Search */}
        <label className="relative block w-full sm:w-auto">
          <span className="sr-only">搜索出库单号、物料名称或批号</span>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索出库单号/耗材名称/批号..."
            value={searchText}
            onChange={e => onSearchChange(e.target.value)}
            className="h-10 w-full rounded-md border border-gray-300 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 sm:w-64"
          />
        </label>
        {/* Material Select */}
        <label><span className="sr-only">物料筛选</span><select value={materialFilter} onChange={e => onMaterialChange(e.target.value)} className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10"><option value="">全部耗材</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        {/* Type Select */}
        <label><span className="sr-only">出库类型筛选</span><select
          value={typeFilter}
          onChange={e => onTypeChange(e.target.value as TypeFilter)}
          className="h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
        >
          <option value="">全部类型</option>
          <option value="project">项目出库</option>
          <option value="transfer">调拨出库</option>
          <option value="scrap">报废出库</option>
        </select></label>
        {/* Status Select */}
        <label><span className="sr-only">出库状态筛选</span><select
          value={statusFilter}
          onChange={e => onStatusChange(e.target.value as StatusFilter)}
          className="h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
        >
          <option value="">全部状态</option>
          <option value="completed">已完成</option>
          <option value="pending">待出库</option>
          <option value="cancelled">已取消</option>
        </select></label>
        {/* Date Range */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">开始日期</span>
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="date"
              value={startDate}
              onChange={e => onStartDateChange(e.target.value)}
              className="pl-8 pr-2 h-10 w-[130px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </label>
          <span aria-hidden="true" className="text-gray-400">-</span>
          <label className="relative">
            <span className="sr-only">结束日期</span>
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="date"
              value={endDate}
              onChange={e => onEndDateChange(e.target.value)}
              className="pl-8 pr-2 h-10 w-[130px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </label>
        </div>
        {/* Query / Reset */}
        <button
          type="submit"
          className="h-10 px-4 bg-white border border-gray-300 text-gray-700 rounded-md text-sm hover:bg-gray-50 transition-colors duration-150"
        >
          查询
        </button>
        <button
          type="button"
          onClick={onReset}
          className="h-10 px-4 text-gray-500 rounded-md text-sm hover:text-gray-700 hover:bg-gray-50 transition-colors duration-150"
        >
          重置
        </button>
      </div>
    </form>
  )
}
