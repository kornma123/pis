import { Search } from 'lucide-react'
import type { Material } from '@/types'

interface InboundFilterBarProps {
  searchKeyword: string
  onSearchChange: (v: string) => void
  filterMaterial: string
  onMaterialChange: (v: string) => void
  filterStatus: string
  onStatusChange: (v: string) => void
  filterType: string
  onTypeChange: (v: string) => void
  filterStartDate: string
  onStartDateChange: (v: string) => void
  filterEndDate: string
  onEndDateChange: (v: string) => void
  onQuery: () => void
  onReset: () => void
  materials: Material[]
}

export default function InboundFilterBar({
  searchKeyword,
  onSearchChange,
  filterMaterial,
  onMaterialChange,
  filterStatus,
  onStatusChange,
  filterType,
  onTypeChange,
  filterStartDate,
  onStartDateChange,
  filterEndDate,
  onEndDateChange,
  onQuery,
  onReset,
  materials,
}: InboundFilterBarProps) {
  return (
    <div className="px-5 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
      <span className="text-sm font-medium text-gray-900">入库记录</span>
      <div className="flex-1" />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="搜索入库单号/耗材名称/批号..."
            value={searchKeyword}
            onChange={e => onSearchChange(e.target.value)}
            aria-label="搜索入库记录"
            className="pl-9 pr-3 py-2 h-10 text-sm border border-gray-300 rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <select
          value={filterMaterial}
          onChange={e => onMaterialChange(e.target.value)}
          aria-label="按耗材筛选入库记录"
          className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">全部耗材</option>
          {materials.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={e => onStatusChange(e.target.value)}
          aria-label="按状态筛选入库记录"
          className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">全部状态</option>
          <option value="completed">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
        <select
          value={filterType}
          onChange={e => onTypeChange(e.target.value)}
          aria-label="按来源筛选入库记录"
          className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">全部来源</option>
          <option value="purchase">采购入库</option>
          <option value="return">退库入库</option>
          <option value="direct">直接入库</option>
          <option value="transfer">库位调拨</option>
        </select>
        <input
          type="date"
          value={filterStartDate}
          onChange={e => onStartDateChange(e.target.value)}
          aria-label="入库开始日期"
          className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-gray-400 text-sm">至</span>
        <input
          type="date"
          value={filterEndDate}
          onChange={e => onEndDateChange(e.target.value)}
          aria-label="入库结束日期"
          className="px-3 py-2 h-10 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={onQuery}
          className="px-4 py-2 h-10 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
        >
          查询
        </button>
        <button
          onClick={onReset}
          className="px-4 py-2 h-10 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          重置
        </button>
      </div>
    </div>
  )
}
