import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CornerUpLeft,
  X,
  Search,
  Package,
  Truck,
  RotateCcw,
  FileText,
  Eye,
  Trash2,
  ChevronRight,
  Clock,
  CheckCircle2,
  CircleDollarSign,
} from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { Pagination } from '@/components/ui/Pagination'
import { supplierReturnApi, purchaseOrderApi, inboundApi } from '@/api/inventory'
import { materialApi, supplierApi } from '@/api/master'
import type { SupplierReturnRecord, Material, Supplier, PurchaseOrder, InboundRecord } from '@/types'
import { formatDate } from '@/lib/utils'
import { toast } from 'sonner'

const statusMap: Record<string, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  pending: { label: '待发货', color: 'text-amber-700', bg: 'bg-amber-50', icon: Clock },
  shipped: { label: '已发货', color: 'text-blue-700', bg: 'bg-blue-50', icon: Truck },
  received: { label: '已收货', color: 'text-purple-700', bg: 'bg-purple-50', icon: CheckCircle2 },
  refunded: { label: '已退款', color: 'text-green-700', bg: 'bg-green-50', icon: CircleDollarSign },
  cancelled: { label: '已取消', color: 'text-gray-600', bg: 'bg-gray-100', icon: RotateCcw },
}

const reasonOptions = [
  { value: 'quality_issue', label: '质量问题' },
  { value: 'wrong_item', label: '发错货' },
  { value: 'quantity_mismatch', label: '数量不符' },
  { value: 'damaged', label: '破损' },
  { value: 'other', label: '其他' },
]

export default function SupplierReturns() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [materials, setMaterials] = useState<Material[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [inboundRecords, setInboundRecords] = useState<InboundRecord[]>([])

  const [keyword, setKeyword] = useState(searchParams.get('keyword') || '')
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '')
  const [supplierFilter, setSupplierFilter] = useState(searchParams.get('supplierId') || '')

  const [modalOpen, setModalOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRecord, setDetailRecord] = useState<SupplierReturnRecord | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [recordToDelete, setRecordToDelete] = useState<SupplierReturnRecord | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [form, setForm] = useState({
    materialId: '',
    quantity: 1,
    supplierId: '',
    purchaseOrderId: '',
    inboundRecordId: '',
    reason: '',
    refundAmount: '',
    trackingNo: '',
    remark: '',
  })

  const fetchRefs = async () => {
    try {
      const [mRes, sRes, poRes, inRes] = await Promise.all([
        materialApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        supplierApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        purchaseOrderApi.getList({ page: 1, pageSize: 999 }),
        inboundApi.getList({ page: 1, pageSize: 999 }),
      ])
      setMaterials((mRes as any)?.list || [])
      setSuppliers((sRes as any)?.list || [])
      setPurchaseOrders((poRes as any)?.list || [])
      setInboundRecords((inRes as any)?.list || [])
    } catch (e) {
      console.error(e)
    }
  }

  useEffect(() => {
    fetchRefs()
  }, [])

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<SupplierReturnRecord>({
    fetchFn: async ({ page, pageSize }) => {
      const res: any = await supplierReturnApi.getList({
        page,
        pageSize,
        keyword: keyword || undefined,
        status: statusFilter || undefined,
        supplierId: supplierFilter || undefined,
      })
      return { list: res.list || [], pagination: res.pagination }
    },
    deps: [keyword, statusFilter, supplierFilter],
  })

  const handleSearch = () => {
    const params: Record<string, string> = {}
    if (keyword) params.keyword = keyword
    if (statusFilter) params.status = statusFilter
    if (supplierFilter) params.supplierId = supplierFilter
    setSearchParams(params)
    setPage(1)
  }

  const handleReset = () => {
    setKeyword('')
    setStatusFilter('')
    setSupplierFilter('')
    setSearchParams({})
    setPage(1)
  }

  const handleCreate = async () => {
    if (!form.materialId || form.quantity <= 0 || !form.reason) {
      toast.error('请填写物料、退货数量和退货原因')
      return
    }
    setIsSubmitting(true)
    try {
      await supplierReturnApi.create({
        materialId: form.materialId,
        quantity: form.quantity,
        supplierId: form.supplierId || undefined,
        purchaseOrderId: form.purchaseOrderId || undefined,
        inboundRecordId: form.inboundRecordId || undefined,
        reason: form.reason,
        refundAmount: form.refundAmount ? Number(form.refundAmount) : undefined,
        trackingNo: form.trackingNo || undefined,
        remark: form.remark || undefined,
      })
      toast.success('退货记录创建成功')
      setModalOpen(false)
      setForm({
        materialId: '', quantity: 1, supplierId: '', purchaseOrderId: '',
        inboundRecordId: '', reason: '', refundAmount: '', trackingNo: '', remark: '',
      })
      refresh()
    } catch (e: any) {
      toast.error(e?.response?.data?.message || '创建失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleStatusChange = async (id: string, status: string) => {
    try {
      await supplierReturnApi.updateStatus(id, status)
      toast.success('状态更新成功')
      refresh()
      if (detailRecord?.id === id) {
        setDetailRecord({ ...detailRecord, status: status as any })
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message || '状态更新失败')
    }
  }

  const openDelete = (row: SupplierReturnRecord) => {
    setRecordToDelete(row)
    setDeleteConfirmOpen(true)
  }

  const handleDelete = async () => {
    if (!recordToDelete) return
    try {
      await supplierReturnApi.delete(recordToDelete.id)
      toast.success('退货记录已删除')
      setDeleteConfirmOpen(false)
      setRecordToDelete(null)
      refresh()
    } catch (e: any) {
      toast.error(e?.response?.data?.message || '删除失败')
    }
  }

  const openDetail = (row: SupplierReturnRecord) => {
    setDetailRecord(row)
    setDetailOpen(true)
  }

  const selectedMaterial = materials.find((m) => m.id === form.materialId)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">退货给供应商</h1>
          <p className="text-sm text-gray-500 mt-1">管理物料退回供应商的完整流程</p>
        </div>
        <button
          onClick={() => { fetchRefs(); setModalOpen(true) }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium transition-colors shadow-sm"
        >
          <CornerUpLeft className="w-4 h-4" />
          新建退货
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col lg:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索退货单号/物料/原因..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="w-full h-10 pl-10 pr-4 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            <option value="">全部状态</option>
            <option value="pending">待发货</option>
            <option value="shipped">已发货</option>
            <option value="received">已收货</option>
            <option value="refunded">已退款</option>
            <option value="cancelled">已取消</option>
          </select>
          <select
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            <option value="">全部供应商</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            onClick={handleSearch}
            className="h-10 px-4 bg-white text-gray-700 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            查询
          </button>
          <button
            onClick={handleReset}
            className="h-10 px-4 text-gray-500 text-sm font-medium hover:text-gray-700 transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">退货单号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">数量</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">退货原因</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">退款金额</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <Clock className="w-5 h-5 animate-spin" />
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex flex-col items-center gap-2">
                      <Package className="w-12 h-12 text-gray-300" />
                      <p className="text-sm">暂无退货记录</p>
                      <p className="text-xs text-gray-400">点击"新建退货"开始</p>
                    </div>
                  </td>
                </tr>
              ) : (
                data.map((row) => {
                  const statusInfo = statusMap[row.status] || statusMap.pending
                  const StatusIcon = statusInfo.icon
                  const reasonLabel = reasonOptions.find((r) => r.value === row.reason)?.label || row.reason
                  return (
                    <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{row.returnNo}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 text-sm">{row.materialName || '-'}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{row.supplierName || '-'}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{row.quantity}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-xs bg-orange-50 text-orange-700">{reasonLabel}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {row.refundAmount ? `¥${row.refundAmount}` : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${statusInfo.bg} ${statusInfo.color}`}>
                          <StatusIcon className="w-3 h-3" />
                          {statusInfo.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(row.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openDetail(row)}
                            className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5 inline mr-0.5" />
                            详情
                          </button>
                          {row.status === 'pending' && (
                            <button
                              onClick={() => openDelete(row)}
                              className="px-2 py-1 text-gray-500 hover:text-red-600 text-xs font-medium transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5 inline mr-0.5" />
                              删除
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

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
          <span className="text-sm text-gray-500">共 {total} 条记录</span>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      </div>

      {/* Create Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">新建退货给供应商</h3>
              <button
                onClick={() => setModalOpen(false)}
                className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  物料 <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.materialId}
                  onChange={(e) => setForm({ ...form, materialId: e.target.value })}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                >
                  <option value="">请选择物料</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.code}) - 库存 {m.stock} {m.unit}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    退货数量 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={selectedMaterial?.stock || undefined}
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                  />
                  {selectedMaterial && (
                    <p className="text-xs text-gray-400 mt-1">最大可退: {selectedMaterial.stock}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">供应商</label>
                  <select
                    value={form.supplierId}
                    onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                  >
                    <option value="">请选择</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">关联采购订单</label>
                  <select
                    value={form.purchaseOrderId}
                    onChange={(e) => setForm({ ...form, purchaseOrderId: e.target.value })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                  >
                    <option value="">请选择</option>
                    {purchaseOrders
                      .filter((po) => !form.supplierId || po.supplierId === form.supplierId)
                      .map((po) => (
                        <option key={po.id} value={po.id}>
                          {po.orderNo} ({po.materialName}) — {po.status === 'partial' ? '部分收货' : po.status === 'completed' ? '已完成' : po.status === 'pending' ? '待收货' : '已取消'}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">关联入库记录</label>
                  <select
                    value={form.inboundRecordId}
                    onChange={(e) => setForm({ ...form, inboundRecordId: e.target.value })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                  >
                    <option value="">请选择</option>
                    {inboundRecords
                      .filter((ir) => !form.materialId || ir.materialId === form.materialId)
                      .map((ir) => (
                        <option key={ir.id} value={ir.id}>
                          {ir.inboundNo} ({ir.materialName} × {ir.quantity}{ir.unit})
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  退货原因 <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                >
                  <option value="">请选择</option>
                  {reasonOptions.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">退款金额</label>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={form.refundAmount}
                    onChange={(e) => setForm({ ...form, refundAmount: e.target.value })}
                    placeholder="0.00"
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">物流单号</label>
                  <input
                    type="text"
                    value={form.trackingNo}
                    onChange={(e) => setForm({ ...form, trackingNo: e.target.value })}
                    placeholder="可选"
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">备注</label>
                <textarea
                  value={form.remark}
                  onChange={(e) => setForm({ ...form, remark: e.target.value })}
                  rows={2}
                  placeholder="可选"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 transition-colors resize-none"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
              <button
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={isSubmitting}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? '提交中...' : '确认创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detailOpen && detailRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">退货详情</h3>
              <button
                onClick={() => setDetailOpen(false)}
                className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">退货单号</span>
                <span className="text-sm font-mono text-gray-900">{detailRecord.returnNo}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">物料</span>
                <span className="text-sm text-gray-900">{detailRecord.materialName || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">退货数量</span>
                <span className="text-sm text-gray-900">{detailRecord.quantity}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">供应商</span>
                <span className="text-sm text-gray-900">{detailRecord.supplierName || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">关联采购订单</span>
                <span className="text-sm text-gray-900">{detailRecord.purchaseOrderNo || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">关联入库记录</span>
                <span className="text-sm text-gray-900">{detailRecord.inboundNo || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">退货原因</span>
                <span className="text-sm text-gray-900">
                  {reasonOptions.find((r) => r.value === detailRecord.reason)?.label || detailRecord.reason}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">退款金额</span>
                <span className="text-sm text-gray-900">{detailRecord.refundAmount ? `¥${detailRecord.refundAmount}` : '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">物流单号</span>
                <span className="text-sm text-gray-900">{detailRecord.trackingNo || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">操作人</span>
                <span className="text-sm text-gray-900">{detailRecord.operator}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">备注</span>
                <span className="text-sm text-gray-900">{detailRecord.remark || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">当前状态</span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${statusMap[detailRecord.status].bg} ${statusMap[detailRecord.status].color}`}>
                  {(() => {
                    const Icon = statusMap[detailRecord.status].icon
                    return <Icon className="w-3 h-3" />
                  })()}
                  {statusMap[detailRecord.status].label}
                </span>
              </div>

              {/* Status Flow */}
              {detailRecord.status !== 'refunded' && detailRecord.status !== 'cancelled' && (
                <div className="border-t border-gray-200 pt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">状态流转</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {detailRecord.status === 'pending' && (
                      <button
                        onClick={() => handleStatusChange(detailRecord.id, 'shipped')}
                        className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 transition-colors"
                      >
                        标记为已发货
                      </button>
                    )}
                    {detailRecord.status === 'shipped' && (
                      <button
                        onClick={() => handleStatusChange(detailRecord.id, 'received')}
                        className="px-3 py-1.5 bg-purple-600 text-white text-xs rounded-md hover:bg-purple-700 transition-colors"
                      >
                        供应商已收货
                      </button>
                    )}
                    {detailRecord.status === 'received' && (
                      <button
                        onClick={() => handleStatusChange(detailRecord.id, 'refunded')}
                        className="px-3 py-1.5 bg-green-600 text-white text-xs rounded-md hover:bg-green-700 transition-colors"
                      >
                        标记退款完成
                      </button>
                    )}
                    {detailRecord.status !== 'cancelled' && (
                      <button
                        onClick={() => handleStatusChange(detailRecord.id, 'cancelled')}
                        className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs rounded-md hover:bg-gray-200 transition-colors"
                      >
                        取消退货
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Timeline */}
              <div className="border-t border-gray-200 pt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">时间线</label>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-gray-900">创建退货记录</p>
                      <p className="text-xs text-gray-400">{formatDate(detailRecord.createdAt)}</p>
                    </div>
                  </div>
                  {detailRecord.status !== 'pending' && detailRecord.status !== 'cancelled' && (
                    <div className="flex items-start gap-3">
                      <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-sm text-gray-900">状态变更为 {statusMap[detailRecord.status]?.label || detailRecord.status}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
              <button
                onClick={() => setDetailOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirmOpen && recordToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-600">
                确定要删除退货记录 <span className="font-mono font-medium">{recordToDelete.returnNo}</span> 吗？
              </p>
              <p className="text-sm text-gray-500 mt-2">仅待发货状态可删除，删除后库存将自动恢复。</p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 transition-colors shadow-sm"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
