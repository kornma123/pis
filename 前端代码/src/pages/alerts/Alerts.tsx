import { useState, useEffect, useMemo } from 'react'
import {
  AlertTriangle,
  Clock,
  Search,
  X,
  Eye,
  CheckSquare,
  RotateCcw,
} from 'lucide-react'
import request from '@/api/request'
import type { Alert } from '@/types'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'

// 扩展类型以支持设计稿中的可选字段
interface AlertItem extends Alert {
  batchNo?: string
  ruleId?: string
  triggerCondition?: string
  projectName?: string
}

type AlertTypeFilter = 'all' | 'low-stock' | 'expiry' | 'stagnant'
type AlertStatusFilter = 'all' | 'pending' | 'processed' | 'ignored'

interface FilterState {
  keyword: string
  type: AlertTypeFilter
  status: AlertStatusFilter
  dateRange: [string, string]
}

interface ModalState {
  type: 'handle' | 'consumption-handle' | 'consumption-detail' | 'detail' | null
  alert: AlertItem | null
}

const ALERT_TYPE_MAP: Record<string, { label: string; bg: string; text: string }> = {
  'low-stock': { label: '库存不足', bg: 'bg-red-50', text: 'text-red-600' },
  'expiry': { label: '即将过期', bg: 'bg-yellow-50', text: 'text-yellow-600' },
  'stagnant': { label: '消耗异常', bg: 'bg-green-50', text: 'text-green-600' },
}

const STATUS_MAP: Record<string, { label: string; bg: string; text: string }> = {
  'pending': { label: '待处理', bg: 'bg-yellow-50', text: 'text-yellow-700' },
  'processed': { label: '已处理', bg: 'bg-green-50', text: 'text-green-700' },
  'ignored': { label: '已忽略', bg: 'bg-gray-50', text: 'text-gray-600' },
}

export default function Alerts() {
  const url = useUrlParams()

  const initialPage = Math.max(1, url.getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(url.getNumber('pageSize', 10))
    ? url.getNumber('pageSize', 10)
    : 10

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [modal, setModal] = useState<ModalState>({ type: null, alert: null })
  const [filter, setFilter] = useState<FilterState>({
    keyword: url.get('keyword', ''),
    type: (url.get('type', 'all') as AlertTypeFilter) || 'all',
    status: (url.get('status', 'all') as AlertStatusFilter) || 'all',
    dateRange: [url.get('startDate', ''), url.get('endDate', '')] as [string, string],
  })
  const [quickFilter, setQuickFilter] = useState<AlertStatusFilter>(
    (url.get('quickFilter', 'all') as AlertStatusFilter) || 'all'
  )
  const [handleForm, setHandleForm] = useState({
    opinion: '',
    result: 'purchased',
  })

  const effectiveStatus = quickFilter !== 'all'
    ? quickFilter
    : filter.status !== 'all'
      ? filter.status
      : undefined
  const effectiveType = filter.type !== 'all' ? filter.type : undefined

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<AlertItem>({
    fetchFn: async (params) => {
      const res: any = await request.get('/alerts', {
        params: {
          ...params,
          keyword: filter.keyword || undefined,
          type: effectiveType,
          status: effectiveStatus,
          startDate: filter.dateRange[0] || undefined,
          endDate: filter.dateRange[1] || undefined,
        },
      })
      return {
        list: res?.list || [],
        pagination: res?.pagination,
      }
    },
    initialPage,
    initialPageSize,
    deps: [
      filter.keyword,
      filter.type,
      filter.status,
      filter.dateRange[0],
      filter.dateRange[1],
      quickFilter,
    ],
  })

  // URL 同步
  useEffect(() => {
    url.setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 10 ? pageSize : null,
      keyword: filter.keyword || null,
      type: filter.type !== 'all' ? filter.type : null,
      status: filter.status !== 'all' ? filter.status : null,
      quickFilter: quickFilter !== 'all' ? quickFilter : null,
      startDate: filter.dateRange[0] || null,
      endDate: filter.dateRange[1] || null,
    })
  }, [page, pageSize, filter.keyword, filter.type, filter.status, filter.dateRange, quickFilter])

  // 统计数据
  const stats = useMemo(() => {
    const pending = data.filter((a) => a.status === 'pending').length
    const processed = data.filter((a) => a.status === 'processed').length
    const ignored = data.filter((a) => a.status === 'ignored').length
    const today = data.filter((a) => {
      const d = new Date(a.createdAt)
      const now = new Date()
      return d.toDateString() === now.toDateString()
    }).length
    return { pending, processed, ignored, today, total }
  }, [data, total])

  // 清空选择当筛选/分页变化时
  useEffect(() => {
    setSelectedIds(new Set())
  }, [page, pageSize, filter.keyword, filter.type, filter.status, filter.dateRange, quickFilter])

  const handleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const handleSelectAll = () => {
    if (data.length > 0 && selectedIds.size === data.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map((a) => a.id)))
    }
  }

  const clearSelection = () => setSelectedIds(new Set())

  // 保持现有处理逻辑不变
  const handleProcess = async (id: string) => {
    try {
      await request.post(`/alerts/${id}/process`, {})
      toast.success('处理成功')
      refresh()
      setModal({ type: null, alert: null })
    } catch (e) {
      toast.error('处理失败')
    }
  }

  const handleIgnore = async (id: string) => {
    try {
      await request.post(`/alerts/${id}/ignore`, {})
      toast.success('已忽略')
      refresh()
    } catch (e) {
      toast.error('操作失败')
    }
  }

  const getAlertTypeInfo = (type: string) => {
    return (
      ALERT_TYPE_MAP[type] || {
        label: type,
        bg: 'bg-gray-50',
        text: 'text-gray-600',
      }
    )
  }

  const getStatusInfo = (status: string) => {
    return (
      STATUS_MAP[status] || {
        label: status,
        bg: 'bg-gray-50',
        text: 'text-gray-600',
      }
    )
  }

  const openModal = (type: ModalState['type'], alert: AlertItem) => {
    setModal({ type, alert })
    setHandleForm({ opinion: '', result: 'purchased' })
  }

  const closeModal = () => setModal({ type: null, alert: null })

  const isConsumption = (type: string) => type === 'stagnant'

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">
            预警中心
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            查看和处理所有库存预警信息
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors duration-150 h-10">
            <Clock className="w-4 h-4" />
            查看历史
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-red-500">
          <div className="text-2xl font-bold text-red-600">{stats.pending}</div>
          <div className="mt-1 text-sm text-gray-500">待处理</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-green-500">
          <div className="text-2xl font-bold text-green-600">{stats.processed}</div>
          <div className="mt-1 text-sm text-gray-500">已处理</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-yellow-500">
          <div className="text-2xl font-bold text-yellow-600">{stats.today}</div>
          <div className="mt-1 text-sm text-gray-500">今日预警</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-blue-500">
          <div className="text-2xl font-bold text-blue-600">{stats.total}</div>
          <div className="mt-1 text-sm text-gray-500">本月预警</div>
        </div>
      </div>

      {/* 快速筛选 */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { key: 'all', label: '全部' },
            { key: 'pending', label: '待处理' },
            { key: 'processed', label: '已处理' },
            { key: 'ignored', label: '已忽略' },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            onClick={() => {
              setQuickFilter(item.key)
              setPage(1)
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all duration-150 h-10 ${
              quickFilter === item.key
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 筛选栏 */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex flex-col xl:flex-row gap-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="搜索预警编号/物料..."
              value={filter.keyword}
              onChange={(e) =>
                setFilter((prev) => ({ ...prev, keyword: e.target.value }))
              }
              className="w-full h-10 pl-9 pr-4 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
            />
          </div>
          <select
            value={filter.type}
            onChange={(e) =>
              setFilter((prev) => ({
                ...prev,
                type: e.target.value as AlertTypeFilter,
              }))
            }
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
          >
            <option value="all">全部类型</option>
            <option value="low-stock">库存不足</option>
            <option value="expiry">即将过期</option>
            <option value="stagnant">消耗异常</option>
          </select>
          <select
            value={filter.status}
            onChange={(e) =>
              setFilter((prev) => ({
                ...prev,
                status: e.target.value as AlertStatusFilter,
              }))
            }
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
          >
            <option value="all">全部状态</option>
            <option value="pending">待处理</option>
            <option value="processed">已处理</option>
            <option value="ignored">已忽略</option>
          </select>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={filter.dateRange[0]}
              onChange={(e) =>
                setFilter((prev) => ({
                  ...prev,
                  dateRange: [e.target.value, prev.dateRange[1]],
                }))
              }
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
            />
            <span className="text-gray-400">-</span>
            <input
              type="date"
              value={filter.dateRange[1]}
              onChange={(e) =>
                setFilter((prev) => ({
                  ...prev,
                  dateRange: [prev.dateRange[0], e.target.value],
                }))
              }
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 transition-all duration-150"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(1)}
              className="inline-flex items-center gap-1.5 h-10 px-4 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors duration-150 shadow-sm"
            >
              <Search className="w-4 h-4" />
              查询
            </button>
            <button
              onClick={() => {
                setFilter({
                  keyword: '',
                  type: 'all',
                  status: 'all',
                  dateRange: ['', ''],
                })
                setQuickFilter('all')
                setPage(1)
              }}
              className="inline-flex items-center gap-1.5 h-10 px-4 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
            >
              <RotateCcw className="w-4 h-4" />
              重置
            </button>
          </div>
        </div>
      </div>

      {/* 批量操作 */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <span className="text-sm text-blue-800">
            已选择 <strong>{selectedIds.size}</strong> 条预警
          </span>
          <button
            onClick={async () => {
              const ids = Array.from(selectedIds)
              for (const id of ids) {
                await handleProcess(id)
              }
              clearSelection()
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 transition-colors"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            批量处理
          </button>
          <button
            onClick={clearSelection}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
          >
            取消选择
          </button>
        </div>
      )}

      {/* 表格卡片 */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">预警列表</h2>
          <span className="text-xs text-gray-400">共 {total} 条记录</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={
                      data.length > 0 && selectedIds.size === data.length
                    }
                    onChange={handleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  预警编号
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  预警类型
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  物料信息
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  触发条件
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  来源规则
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  预警时间
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  状态
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 tracking-wide">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    暂无预警数据
                  </td>
                </tr>
              ) : (
                data.map((alert) => {
                  const typeInfo = getAlertTypeInfo(alert.type)
                  const statusInfo = getStatusInfo(alert.status)
                  return (
                    <tr
                      key={alert.id}
                      className="hover:bg-gray-50 transition-colors duration-150"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(alert.id)}
                          onChange={() => handleSelect(alert.id)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">
                        {alert.id}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${typeInfo.bg} ${typeInfo.text}`}
                        >
                          {typeInfo.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">
                          {alert.materialName || '-'}
                        </div>
                        <div className="text-xs text-gray-500">
                          {alert.batchNo || alert.materialId}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs max-w-[200px] truncate">
                        {alert.triggerCondition || alert.message || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-blue-600">
                          {alert.ruleId || 'RULE-001'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(alert.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${statusInfo.bg} ${statusInfo.text}`}
                        >
                          {statusInfo.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {alert.status === 'pending' ? (
                            <>
                              <button
                                onClick={() =>
                                  openModal(
                                    isConsumption(alert.type)
                                      ? 'consumption-handle'
                                      : 'handle',
                                    alert
                                  )
                                }
                                className="inline-flex items-center px-2.5 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 transition-colors duration-150"
                              >
                                处理
                              </button>
                              <button
                                onClick={() => handleIgnore(alert.id)}
                                className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
                              >
                                忽略
                              </button>
                              <button
                                onClick={() =>
                                  openModal(
                                    isConsumption(alert.type)
                                      ? 'consumption-detail'
                                      : 'detail',
                                    alert
                                  )
                                }
                                className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
                              >
                                详情
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() =>
                                openModal(
                                  isConsumption(alert.type)
                                    ? 'consumption-detail'
                                    : 'detail',
                                  alert
                                )
                              }
                              className="inline-flex items-center px-2.5 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors duration-150"
                            >
                              <Eye className="w-3.5 h-3.5 mr-1" />
                              查看
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* ===== 弹窗：处理预警（库存不足/即将过期） ===== */}
      {modal.type === 'handle' && modal.alert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={closeModal} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">处理预警</h3>
              <button
                onClick={closeModal}
                className="p-1 rounded-md hover:bg-gray-100 transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div className="bg-red-50 border border-red-100 rounded-lg p-4 mb-5">
                <div className="flex items-center gap-3 mb-3">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                  <span className="font-semibold text-red-600">
                    {getAlertTypeInfo(modal.alert.type).label}预警
                  </span>
                </div>
                <div className="text-sm text-gray-600 space-y-2">
                  <div>
                    <strong>物料：</strong>
                    {modal.alert.materialName || '-'}
                  </div>
                  <div>
                    <strong>当前库存：</strong>
                    {modal.alert.currentStock ?? '-'}
                  </div>
                  <div>
                    <strong>预警阈值：</strong>
                    {modal.alert.threshold ?? '-'}
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    处理意见 <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={handleForm.opinion}
                    onChange={(e) =>
                      setHandleForm((prev) => ({
                        ...prev,
                        opinion: e.target.value,
                      }))
                    }
                    placeholder="请输入处理意见..."
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    处理结果
                  </label>
                  <div className="flex flex-wrap gap-3">
                    {[
                      { key: 'purchased', label: '已采购补货' },
                      { key: 'adjusted', label: '调整阈值' },
                      { key: 'ignored', label: '忽略预警' },
                    ].map((opt) => (
                      <label
                        key={opt.key}
                        className="inline-flex items-center gap-2 cursor-pointer"
                      >
                        <input
                          type="radio"
                          name="result"
                          value={opt.key}
                          checked={handleForm.result === opt.key}
                          onChange={(e) =>
                            setHandleForm((prev) => ({
                              ...prev,
                              result: e.target.value,
                            }))
                          }
                          className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">
                          {opt.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={closeModal}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => handleProcess(modal.alert!.id)}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm"
              >
                确认处理
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 弹窗：消耗异常处理 ===== */}
      {modal.type === 'consumption-handle' && modal.alert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={closeModal} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">
                处理消耗异常预警
              </h3>
              <button
                onClick={closeModal}
                className="p-1 rounded-md hover:bg-gray-100 transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div className="bg-red-50 border border-red-100 rounded-lg p-4">
                <div className="flex items-center gap-3 mb-3">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                  <span className="font-semibold text-red-600">
                    消耗量异常偏高
                  </span>
                </div>
                <div className="text-sm text-gray-600 space-y-2">
                  <div>
                    <strong>物料：</strong>
                    {modal.alert.materialName || '-'}
                  </div>
                  <div>
                    <strong>关联项目：</strong>
                    {modal.alert.projectName || '-'}
                  </div>
                  <div>
                    <strong>来源规则：</strong>
                    <span className="text-blue-600">
                      {modal.alert.ruleId || 'RULE-003'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">本期消耗量</div>
                  <div className="text-lg font-bold text-gray-900">85瓶</div>
                  <div className="text-xs text-gray-400">2024年Q4</div>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center border border-red-100">
                  <div className="text-xs text-gray-500 mb-1">偏离程度</div>
                  <div className="text-lg font-bold text-red-600">+2.08σ</div>
                  <div className="text-xs text-gray-400">超过阈值2σ</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">历史均值(μ)</div>
                  <div className="text-lg font-bold text-gray-900">60瓶</div>
                  <div className="text-xs text-gray-400">4个季度平均</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">标准差(σ)</div>
                  <div className="text-lg font-bold text-gray-900">12瓶</div>
                  <div className="text-xs text-gray-400">波动范围</div>
                </div>
              </div>

              <div>
                <div className="text-sm font-medium text-gray-700 mb-3">
                  6个季度消耗趋势
                </div>
                <div className="flex items-end justify-between h-32 gap-3 px-4 py-3 bg-gray-50 rounded-lg">
                  {[50, 60, 55, 65, 70, 95].map((h, i) => (
                    <div
                      key={i}
                      className="flex flex-col items-center gap-1.5 flex-1"
                    >
                      <div
                        className={`w-full max-w-[32px] rounded-t ${i === 5 ? 'bg-red-400' : 'bg-blue-300'}`}
                        style={{ height: `${h}%` }}
                      />
                      <span
                        className={`text-[10px] ${i === 5 ? 'text-red-600 font-medium' : 'text-gray-500'}`}
                      >
                        {['Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3'][i]}'24
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-sm font-medium text-gray-700 mb-3">
                  可能原因分析
                </div>
                <div className="space-y-2">
                  {[
                    {
                      title: '样本量增长',
                      desc: '本季度检测样本数较上季度增加 18%',
                    },
                    {
                      title: '新增检测项目',
                      desc: '分子病理检测新增了2个子项目使用该物料',
                    },
                    {
                      title: '操作损耗增加',
                      desc: '新员工培训期间可能存在操作损耗',
                    },
                  ].map((cause, i) => (
                    <label
                      key={i}
                      className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div>
                        <div className="text-sm font-medium text-gray-800">
                          {cause.title}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {cause.desc}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    处理意见 <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={handleForm.opinion}
                    onChange={(e) =>
                      setHandleForm((prev) => ({
                        ...prev,
                        opinion: e.target.value,
                      }))
                    }
                    placeholder="请输入处理意见..."
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    处理结果
                  </label>
                  <div className="flex flex-wrap gap-3">
                    {[
                      { key: 'normal', label: '标记为正常波动' },
                      { key: 'observe', label: '关注观察，下季度再评估' },
                      { key: 'optimize', label: '已核实，需优化流程' },
                      { key: 'adjust', label: '调整预警阈值' },
                    ].map((opt) => (
                      <label
                        key={opt.key}
                        className="inline-flex items-center gap-2 cursor-pointer"
                      >
                        <input
                          type="radio"
                          name="consumption-result"
                          value={opt.key}
                          checked={handleForm.result === opt.key}
                          onChange={(e) =>
                            setHandleForm((prev) => ({
                              ...prev,
                              result: e.target.value,
                            }))
                          }
                          className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">
                          {opt.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={closeModal}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => handleProcess(modal.alert!.id)}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm"
              >
                确认处理
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 弹窗：预警详情 ===== */}
      {modal.type === 'detail' && modal.alert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={closeModal} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">
                预警详情 - {modal.alert.id}
              </h3>
              <button
                onClick={closeModal}
                className="p-1 rounded-md hover:bg-gray-100 transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">物料名称</div>
                  <div className="text-sm font-medium text-gray-900">
                    {modal.alert.materialName || '-'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">批次号</div>
                  <div className="text-sm font-medium text-gray-900">
                    {modal.alert.batchNo || '-'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">当前库存</div>
                  <div className="text-sm font-medium text-gray-900">
                    {modal.alert.currentStock ?? '-'}
                  </div>
                </div>
                <div className="bg-red-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">预警阈值</div>
                  <div className="text-sm font-bold text-red-600">
                    {modal.alert.threshold ?? '-'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">来源规则</div>
                  <div className="text-sm font-medium text-blue-600">
                    {modal.alert.ruleId || 'RULE-001'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-500 mb-1">预警时间</div>
                  <div className="text-sm font-medium text-gray-900">
                    {formatDate(modal.alert.createdAt)}
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm font-medium text-gray-700 mb-2">
                  触发条件
                </div>
                <div className="text-sm text-gray-600">
                  {modal.alert.triggerCondition ||
                    modal.alert.message ||
                    '当前库存低于预警阈值'}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={closeModal}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors"
              >
                关闭
              </button>
              {modal.alert.status === 'pending' && (
                <button
                  onClick={() =>
                    setModal({ type: 'handle', alert: modal.alert })
                  }
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm"
                >
                  处理预警
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== 弹窗：消耗异常详情 ===== */}
      {modal.type === 'consumption-detail' && modal.alert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={closeModal} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">
                消耗异常详情 - {modal.alert.id}
              </h3>
              <button
                onClick={closeModal}
                className="p-1 rounded-md hover:bg-gray-100 transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">物料名称</div>
                  <div className="text-sm font-medium text-gray-900">
                    {modal.alert.materialName || '-'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">关联项目</div>
                  <div className="text-sm font-medium text-gray-900">
                    {modal.alert.projectName || '-'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">来源规则</div>
                  <div className="text-sm font-medium text-blue-600">
                    {modal.alert.ruleId || 'RULE-003'}
                  </div>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">预警等级</div>
                  <div className="text-sm font-bold text-red-600">高风险</div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">本期消耗量</div>
                  <div className="text-lg font-bold text-gray-900">85瓶</div>
                  <div className="text-xs text-gray-400">2024年Q4</div>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center border border-red-100">
                  <div className="text-xs text-gray-500 mb-1">偏离程度</div>
                  <div className="text-lg font-bold text-red-600">+2.08σ</div>
                  <div className="text-xs text-gray-400">超过阈值2σ</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">历史均值(μ)</div>
                  <div className="text-lg font-bold text-gray-900">60瓶</div>
                  <div className="text-xs text-gray-400">4个季度平均</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">标准差(σ)</div>
                  <div className="text-lg font-bold text-gray-900">12瓶</div>
                  <div className="text-xs text-gray-400">波动范围</div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-700">
                    6个季度消耗趋势
                  </span>
                  <span className="text-xs text-gray-500">单位：瓶</span>
                </div>
                <div className="flex items-end justify-between h-32 gap-3 px-4 py-3 bg-gray-50 rounded-lg">
                  {[50, 60, 55, 65, 70, 95].map((h, i) => (
                    <div
                      key={i}
                      className="flex flex-col items-center gap-1.5 flex-1"
                    >
                      <div
                        className={`w-full max-w-[32px] rounded-t ${i === 5 ? 'bg-red-400' : 'bg-blue-300'}`}
                        style={{ height: `${h}%` }}
                      />
                      <span
                        className={`text-[10px] ${i === 5 ? 'text-red-600 font-medium' : 'text-gray-500'}`}
                      >
                        {['Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3'][i]}'24
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      季度
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">
                      消耗量
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">
                      样本量
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">
                      单样本消耗
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">
                      偏离均值
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {[
                    {
                      q: '2024 Q3',
                      v: '85瓶',
                      s: 450,
                      p: '0.19瓶',
                      d: '+42%',
                      dc: 'text-red-600',
                    },
                    {
                      q: '2024 Q2',
                      v: '70瓶',
                      s: 380,
                      p: '0.18瓶',
                      d: '+17%',
                      dc: 'text-gray-500',
                    },
                    {
                      q: '2024 Q1',
                      v: '65瓶',
                      s: 360,
                      p: '0.18瓶',
                      d: '+8%',
                      dc: 'text-gray-500',
                    },
                    {
                      q: '2023 Q4',
                      v: '55瓶',
                      s: 320,
                      p: '0.17瓶',
                      d: '-8%',
                      dc: 'text-green-600',
                    },
                  ].map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-700">{row.q}</td>
                      <td
                        className={`px-3 py-2 text-right font-semibold ${i === 0 ? 'text-red-600' : 'text-gray-700'}`}
                      >
                        {row.v}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">
                        {row.s}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">
                        {row.p}
                      </td>
                      <td className={`px-3 py-2 text-right ${row.dc}`}>
                        {row.d}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={closeModal}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors"
              >
                关闭
              </button>
              {modal.alert.status === 'pending' && (
                <button
                  onClick={() =>
                    setModal({
                      type: 'consumption-handle',
                      alert: modal.alert,
                    })
                  }
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors shadow-sm"
                >
                  处理预警
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
