import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Plus } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { usePagination } from '@/hooks/usePagination'
import { Pagination } from '@/components/ui/Pagination'
import { purchaseOrderApi } from '@/api/inventory'
import { materialApi, supplierApi } from '@/api/master'
import type { Material, Supplier } from '@/types'
import { canAccess } from '@/lib/permissions'
import { toast } from 'sonner'
import {
  PURCHASE_INBOUND_UNAVAILABLE_REASON,
  buildPurchaseInboundContextUrl,
  getPurchaseOrderActions,
  normalizePurchaseOrder,
  type NormalizedPurchaseOrder,
} from './purchaseOrderModel'
import {
  PurchaseOrderCreateDialog,
  PurchaseOrderDetailDialog,
  displayPurchaseCurrency,
  displayPurchaseQuantity,
  purchaseStatusConfig,
  unknownPurchaseStatusConfig,
  type PurchaseOrderForm,
} from './PurchaseOrderDialogs'

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export default function PurchaseOrders() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const searchText = searchParams.get('keyword') ?? ''
  const statusFilter = searchParams.get('status') ?? ''
  const canWritePurchase = canAccess('purchase_orders', 'W')
  const canWriteInbound = canAccess('inbound', 'W')
  const canViewInbound = canAccess('inbound', 'R')
  const [materials, setMaterials] = useState<Material[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [referencesLoading, setReferencesLoading] = useState(false)
  const [referencesError, setReferencesError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<NormalizedPurchaseOrder | null>(null)

  const [form, setForm] = useState<PurchaseOrderForm>({
    materialId: '',
    supplierId: '',
    orderedQty: 1,
    unitPrice: 0,
    unit: '个',
    expectedDate: '',
    remark: '',
  })

  const fetchRefs = useCallback(async () => {
    setReferencesLoading(true)
    try {
      const [mRes, sRes]: any = await Promise.all([
        materialApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        supplierApi.getList({ page: 1, pageSize: 999, status: 'active' }),
      ])
      if (!Array.isArray(mRes?.list) || !Array.isArray(sRes?.list)) {
        throw new Error('物料或供应商响应格式异常，未按空数据处理')
      }
      setMaterials(mRes.list)
      setSuppliers(sRes.list)
      setReferencesError(null)
    } catch (error) {
      setReferencesError(errorMessage(error, '物料和供应商加载失败'))
    } finally {
      setReferencesLoading(false)
    }
  }, [])

  useEffect(() => { void fetchRefs() }, [fetchRefs])

  const updateSearchParams = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const {
    data,
    loading,
    error: listError,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<NormalizedPurchaseOrder>({
    fetchFn: async ({ page, pageSize }) => {
      const res: any = await purchaseOrderApi.getList({
        page, pageSize,
        status: statusFilter || undefined,
        keyword: searchText || undefined,
      })
      if (!Array.isArray(res?.list)) {
        throw new Error('采购订单响应格式异常，未按空列表处理')
      }
      const list = res.list.map(normalizePurchaseOrder)
      return { list, pagination: res?.pagination }
    },
    initialPage: positiveInteger(searchParams.get('page'), 1),
    initialPageSize: positiveInteger(searchParams.get('pageSize'), 20),
    deps: [statusFilter, searchText],
  })

  const supplierById = useMemo(
    () => new Map(suppliers.map(supplier => [supplier.id, supplier])),
    [suppliers],
  )
  const hasOpenOrders = data.some(order => order.status === 'pending' || order.status === 'partial')
  const currentReturnPath = `${location.pathname}${location.search}`
  const selectedActions = selectedOrder
    ? getPurchaseOrderActions(selectedOrder, { canWritePurchase, canWriteInbound })
    : null

  useEffect(() => {
    if (!modalOpen && !detailModalOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setModalOpen(false)
      setDetailModalOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [detailModalOpen, modalOpen])

  const handleFilterChange = (key: 'keyword' | 'status', value: string) => {
    setPage(1)
    updateSearchParams({ [key]: value || null, page: null })
  }

  const handlePageChange = (nextPage: number) => {
    setPage(nextPage)
    updateSearchParams({ page: nextPage > 1 ? String(nextPage) : null })
  }

  const handlePageSizeChange = (nextPageSize: number) => {
    setPageSize(nextPageSize)
    updateSearchParams({ page: null, pageSize: nextPageSize === 20 ? null : String(nextPageSize) })
  }

  const handleCreate = async () => {
    if (!canWritePurchase || referencesLoading || referencesError) return
    if (!form.materialId || form.orderedQty <= 0) {
      toast.error('请选择物料并填写采购数量')
      return
    }
    const mat = materials.find(m => m.id === form.materialId)
    try {
      await purchaseOrderApi.create({
        ...form,
        materialName: mat?.name || '',
        unitPrice: form.unitPrice,
      })
      toast.success('采购订单创建成功')
      setModalOpen(false)
      setForm({ materialId: '', supplierId: '', orderedQty: 1, unitPrice: 0, unit: '个', expectedDate: '', remark: '' })
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleCancel = async (order: NormalizedPurchaseOrder) => {
    const actions = getPurchaseOrderActions(order, { canWritePurchase, canWriteInbound })
    if (!actions.canCancel) return
    try {
      await purchaseOrderApi.cancel(order.id)
      toast.success('订单已取消')
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">采购订单</h1>
          <p className="text-sm text-gray-500 mt-1">管理采购单；实际入库以入库单、库存和批次记录为准</p>
        </div>
        {canWritePurchase ? (
          <button
            onClick={() => { void fetchRefs(); setModalOpen(true) }}
            className="inline-flex h-10 items-center gap-2 px-4 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            新建采购订单
          </button>
        ) : null}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-[0_1px_3px_rgba(0,0,0,0.1)] overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 p-4 border-b border-gray-200">
          <span className="text-base font-medium text-gray-900">采购订单</span>
          <div className="flex-1 flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索订单号/物料名称..."
                value={searchText}
                onChange={e => handleFilterChange('keyword', e.target.value)}
                aria-label="搜索采购订单"
                className="pl-9 pr-3 h-10 w-64 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <select
              value={statusFilter}
              onChange={e => handleFilterChange('status', e.target.value)}
              aria-label="按状态筛选采购订单"
              className="h-10 px-3 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部状态</option>
              <option value="pending">待收货</option>
              <option value="partial">部分收货</option>
              <option value="completed">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
            <button
              onClick={() => { setPage(1); updateSearchParams({ keyword: null, status: null, page: null }) }}
              className="h-10 px-4 text-gray-500 rounded-md text-sm hover:text-gray-700 hover:bg-gray-50 transition-all duration-150"
            >
              重置
            </button>
          </div>
        </div>

        {hasOpenOrders ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="note">
            {PURCHASE_INBOUND_UNAVAILABLE_REASON} 当前只提供“查看入库限制”，不会执行收货写入。
          </div>
        ) : null}
        {listError ? (
          <div className="flex flex-col gap-2 border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <span>{data.length > 0 ? `刷新失败，以下保留上次成功数据：${listError}` : `采购订单加载失败：${listError}`}</span>
            <button type="button" onClick={refresh} className="h-10 self-start rounded-md border border-red-200 bg-white px-3 font-medium hover:bg-red-100 sm:self-auto">
              重新加载
            </button>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">订单号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">采购数量</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">已收货</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">单价</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">总金额</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[240px]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">加载中...</td></tr>
              ) : listError && data.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-red-600">数据未加载，不能按空列表处理</td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-500">当前筛选下没有采购订单</td></tr>
              ) : (
                data.map(row => {
                  const cfg = purchaseStatusConfig[row.status] ?? unknownPurchaseStatusConfig
                  const supplier = row.supplierId ? supplierById.get(row.supplierId) : undefined
                  const actions = getPurchaseOrderActions(row, { canWritePurchase, canWriteInbound })
                  const hasInboundContext = actions.inboundUnavailableReason !== null
                  return (
                    <tr key={row.id} className="hover:bg-gray-50 transition-colors duration-150">
                      <td className="px-4 py-3 font-mono text-gray-600">{row.orderNo ?? '—'}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{row.materialName ?? row.materialId ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{supplier?.name ?? row.supplierName ?? row.supplierId ?? '未关联'}</td>
                      <td className="px-4 py-3 text-right">{displayPurchaseQuantity(row.orderedQty, row.unit)}</td>
                      <td className="px-4 py-3 text-right">{displayPurchaseQuantity(row.receivedQty, row.unit)}</td>
                      <td className="px-4 py-3 text-right">{displayPurchaseCurrency(row.unitPrice)}</td>
                      <td className="px-4 py-3 text-right font-medium">{displayPurchaseCurrency(row.totalAmount)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
                          {cfg.label}{purchaseStatusConfig[row.status] ? '' : `：${row.status}`}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => { setSelectedOrder(row); setDetailModalOpen(true) }}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors duration-150"
                          >
                            详情
                          </button>
                          {hasInboundContext ? (
                            <>
                              {canViewInbound ? (
                                <Link
                                  to={buildPurchaseInboundContextUrl(row, currentReturnPath)}
                                  title={actions.inboundUnavailableReason ?? undefined}
                                  className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded transition-colors"
                                >
                                  查看入库限制
                                </Link>
                              ) : (
                                <span className="px-2 py-1 text-xs text-gray-500">无入库查看权限</span>
                              )}
                              {actions.canCancel ? (
                                <button
                                  onClick={() => { void handleCancel(row) }}
                                  className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition-colors"
                                >
                                  取消
                                </button>
                              ) : null}
                            </>
                          ) : null}
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
          <span className="text-sm text-gray-500">
            {searchText || statusFilter ? `当前页 ${data.length} 条；后端未提供可信的筛选总数` : `共 ${total} 条记录`}
          </span>
          <Pagination page={page} pageSize={pageSize} total={total} onChangePage={handlePageChange} onChangePageSize={handlePageSizeChange} />
        </div>
      </div>

      <PurchaseOrderCreateDialog
        open={modalOpen && canWritePurchase}
        form={form}
        materials={materials}
        suppliers={suppliers}
        referencesLoading={referencesLoading}
        referencesError={referencesError}
        onChange={setForm}
        onClose={() => setModalOpen(false)}
        onRetryReferences={() => { void fetchRefs() }}
        onCreate={() => { void handleCreate() }}
      />

      <PurchaseOrderDetailDialog
        order={detailModalOpen ? selectedOrder : null}
        supplierName={selectedOrder
          ? (selectedOrder.supplierId ? supplierById.get(selectedOrder.supplierId)?.name : null)
            ?? selectedOrder.supplierName
            ?? selectedOrder.supplierId
            ?? '未关联'
          : '未关联'}
        inboundUnavailableReason={selectedActions?.inboundUnavailableReason ?? null}
        inboundContextUrl={selectedOrder && selectedActions?.inboundUnavailableReason && canViewInbound
          ? buildPurchaseInboundContextUrl(selectedOrder, currentReturnPath)
          : null}
        onClose={() => setDetailModalOpen(false)}
      />

    </div>
  )
}
