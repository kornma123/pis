import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertCircle, CornerUpLeft, Loader2, Package, Search } from 'lucide-react'
import { toast } from 'sonner'
import { supplierReturnApi, purchaseOrderApi, inboundApi } from '@/api/inventory'
import { materialApi, supplierApi } from '@/api/master'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pagination } from '@/components/ui/Pagination'
import { canAccess } from '@/lib/permissions'
import { formatDate } from '@/lib/utils'
import type { InboundRecord, Material, PurchaseOrder, Supplier, SupplierReturnRecord } from '@/types'
import { createRecoverablePost } from '../returns/recoverablePost'
import {
  MutationConfirmDialog,
  StatusBadge,
  SupplierReturnCreateDialog,
  SupplierReturnDetailDialog,
} from './SupplierReturnDialogs'
import {
  EMPTY_FORM,
  REASONS,
  STATUS,
  reasonLabel,
  refundLabel,
  validateForm,
  type SupplierReturnFormState,
  type Transition,
} from './supplierReturnModel'

const PAGE_SIZE = 20
const inputClass = 'a11y-focus-ring h-10 min-w-0 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-700 disabled:bg-gray-100 disabled:text-gray-500'
const buttonClass = 'a11y-focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50'

const createSupplierReturn = createRecoverablePost<SupplierReturnFormState, Record<string, unknown>, { id: string; returnNo: string }>(
  '/supplier-returns',
  (form) => ({
    materialId: form.materialId,
    quantity: form.quantity,
    supplierId: form.supplierId || undefined,
    purchaseOrderId: form.purchaseOrderId || undefined,
    inboundRecordId: form.inboundRecordId || undefined,
    reason: form.reason,
    refundAmount: form.refundAmount === '' ? undefined : Number(form.refundAmount),
    trackingNo: form.trackingNo || undefined,
    remark: form.remark || undefined,
  }),
  (result) => typeof result?.id === 'string' && result.id.length > 0 && typeof result.returnNo === 'string' && result.returnNo.length > 0,
)

type PendingMutation =
  | { kind: 'create'; form: SupplierReturnFormState }
  | { kind: 'transition'; transition: Transition; recordId: string }
  | { kind: 'delete'; record: SupplierReturnRecord }

function errorMessage(error: unknown, fallback: string) {
  const value = error instanceof Error ? error.message.trim() : ''
  return value && value.length <= 160 && !/[{}[\]]/.test(value) ? value : fallback
}

function hasServerResponse(error: unknown) {
  return Boolean((error as { response?: unknown } | null)?.response)
}

export default function SupplierReturns() {
  const canView = canAccess('supplier_returns', 'R')
  const canWrite = canAccess('supplier_returns', 'W')
  const [searchParams, setSearchParams] = useSearchParams()
  const listRequest = useRef(0)
  const refsRequest = useRef(0)
  const detailRequest = useRef(0)
  const mutationLock = useRef(false)

  const [keywordDraft, setKeywordDraft] = useState(searchParams.get('keyword') || '')
  const [statusDraft, setStatusDraft] = useState(searchParams.get('status') || '')
  const [supplierDraft, setSupplierDraft] = useState(searchParams.get('supplierId') || '')
  const [filters, setFilters] = useState({ keyword: keywordDraft, status: statusDraft, supplierId: supplierDraft })
  const [page, setPage] = useState(1)
  const [records, setRecords] = useState<SupplierReturnRecord[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')

  const [materials, setMaterials] = useState<Material[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [inboundRecords, setInboundRecords] = useState<InboundRecord[]>([])
  const [refsError, setRefsError] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<SupplierReturnFormState>(EMPTY_FORM)
  const [validationError, setValidationError] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailId, setDetailId] = useState('')
  const [detailRecord, setDetailRecord] = useState<SupplierReturnRecord | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [mutationUnknown, setMutationUnknown] = useState('')
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null)
  const [mutationBusy, setMutationBusy] = useState(false)
  const [mutationError, setMutationError] = useState('')

  const loadList = useCallback(async () => {
    if (!canView) return
    const request = ++listRequest.current
    setListLoading(true)
    setListError('')
    try {
      const response = await supplierReturnApi.getList({
        page,
        pageSize: PAGE_SIZE,
        keyword: filters.keyword.trim() || undefined,
        status: filters.status || undefined,
        supplierId: filters.supplierId || undefined,
      })
      if (request !== listRequest.current) return
      if (!response || !Array.isArray(response.list) || typeof response.pagination?.total !== 'number') {
        throw new Error('供应商退货响应格式异常')
      }
      setRecords(response.list)
      setTotal(response.pagination.total)
    } catch (error) {
      if (request === listRequest.current) {
        setRecords([])
        setTotal(0)
        setListError(errorMessage(error, '供应商退货列表加载失败'))
      }
    } finally {
      if (request === listRequest.current) setListLoading(false)
    }
  }, [canView, filters.keyword, filters.status, filters.supplierId, page])

  const loadRefs = useCallback(async () => {
    if (!canView) return
    const request = ++refsRequest.current
    setRefsError('')
    try {
      const [materialResponse, supplierResponse, orderResponse, inboundResponse] = await Promise.all([
        materialApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        supplierApi.getList({ page: 1, pageSize: 999, status: 'active' }),
        purchaseOrderApi.getList({ page: 1, pageSize: 999 }),
        inboundApi.getList({ page: 1, pageSize: 999 }),
      ])
      if (request !== refsRequest.current) return
      if (!Array.isArray((materialResponse as { list?: unknown[] })?.list)
        || !Array.isArray((supplierResponse as { list?: unknown[] })?.list)
        || !Array.isArray((orderResponse as { list?: unknown[] })?.list)
        || !Array.isArray((inboundResponse as { list?: unknown[] })?.list)) {
        throw new Error('引用数据响应格式异常')
      }
      setMaterials((materialResponse as { list: Material[] }).list)
      setSuppliers((supplierResponse as { list: Supplier[] }).list)
      setPurchaseOrders((orderResponse as { list: PurchaseOrder[] }).list)
      setInboundRecords((inboundResponse as { list: InboundRecord[] }).list)
    } catch (error) {
      if (request === refsRequest.current) {
        setMaterials([]); setSuppliers([]); setPurchaseOrders([]); setInboundRecords([])
        setRefsError(errorMessage(error, '物料、供应商或来源单据加载失败'))
      }
    }
  }, [canView])

  const loadDetail = useCallback(async (id: string) => {
    if (!id) return
    const request = ++detailRequest.current
    setDetailLoading(true)
    setDetailError('')
    try {
      const response = await supplierReturnApi.getById(id) as SupplierReturnRecord
      if (request !== detailRequest.current) return
      if (!response || response.id !== id || !STATUS[response.status]) throw new Error('供应商退货详情响应格式异常')
      setDetailRecord(response)
      setMutationUnknown('')
    } catch (error) {
      if (request === detailRequest.current) {
        setDetailRecord(null)
        setDetailError(errorMessage(error, '供应商退货详情加载失败'))
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    loadRefs()
    return () => {
      listRequest.current += 1
      refsRequest.current += 1
      detailRequest.current += 1
    }
  }, [loadRefs])

  const applyFilters = () => {
    const next = { keyword: keywordDraft, status: statusDraft, supplierId: supplierDraft }
    setFilters(next)
    setPage(1)
    const params: Record<string, string> = {}
    if (next.keyword) params.keyword = next.keyword
    if (next.status) params.status = next.status
    if (next.supplierId) params.supplierId = next.supplierId
    setSearchParams(params)
  }

  const resetFilters = () => {
    setKeywordDraft(''); setStatusDraft(''); setSupplierDraft('')
    setFilters({ keyword: '', status: '', supplierId: '' })
    setPage(1); setSearchParams({})
  }

  const openCreate = () => {
    setForm(EMPTY_FORM); setValidationError(''); setMutationError('')
    setCreateOpen(true)
    if (refsError) loadRefs()
  }

  const requestCreateConfirmation = () => {
    const selected = materials.find((material) => material.id === form.materialId)
    const invalid = validateForm(form, selected?.stock)
    setValidationError(invalid)
    if (!invalid) {
      setPendingMutation({ kind: 'create', form: { ...form } })
      setMutationError('')
    }
  }

  const openDetail = (record: SupplierReturnRecord) => {
    setDetailId(record.id); setDetailRecord(null); setDetailOpen(true); setMutationUnknown('')
    loadDetail(record.id)
  }

  const closeDetail = () => {
    detailRequest.current += 1
    setDetailOpen(false); setDetailId(''); setDetailRecord(null); setDetailError(''); setMutationUnknown('')
  }

  const runMutation = async () => {
    if (!pendingMutation || mutationLock.current) return
    mutationLock.current = true
    setMutationBusy(true)
    setMutationError('')
    try {
      if (pendingMutation.kind === 'create') {
        const result = await createSupplierReturn(pendingMutation.form)
        if (!result?.id || !result.returnNo) throw new Error('创建回执格式异常')
        toast.success(`供应商退货 ${result.returnNo} 已创建并扣减库存`)
        setCreateOpen(false); setForm(EMPTY_FORM); setValidationError('')
      } else if (pendingMutation.kind === 'transition') {
        const result = await supplierReturnApi.updateStatus(pendingMutation.recordId, pendingMutation.transition.next) as { id?: string; status?: string }
        if (result?.id !== pendingMutation.recordId || result.status !== pendingMutation.transition.next) throw new Error('状态回执格式异常')
        setDetailRecord((current) => current?.id === result.id ? { ...current, status: pendingMutation.transition.next } : current)
        toast.success(`状态已记录为“${STATUS[pendingMutation.transition.next].label}”`)
      } else {
        await supplierReturnApi.delete(pendingMutation.record.id)
        toast.success('待发货记录已删除，库存恢复由后端事务回执确认')
        closeDetail()
      }
      setPendingMutation(null)
      loadList()
    } catch (error) {
      const fallback = pendingMutation.kind === 'create' ? '创建请求失败' : '写操作失败'
      if (!hasServerResponse(error) && pendingMutation.kind !== 'create') {
        setMutationUnknown('请求未取得回执，服务端处理结果未知。')
        setPendingMutation(null)
      } else if (!hasServerResponse(error) && pendingMutation.kind === 'create') {
        setMutationError('创建回执丢失；相同内容再次确认会复用同一幂等键，不会另起一笔。请先核对列表，也可安全重试。')
      } else {
        setMutationError(errorMessage(error, fallback))
      }
    } finally {
      mutationLock.current = false
      setMutationBusy(false)
    }
  }

  if (!canView) {
    return <div role="alert" className="py-20 text-center text-sm text-gray-600">你没有查看供应商退货记录的 capability。</div>
  }

  const confirm = pendingMutation?.kind === 'create'
    ? { title: '确认创建供应商退货？', description: '当前物料和数量将在后端事务中扣减库存；若回执丢失，相同内容重试会复用幂等键。', label: '确认创建并扣减库存', danger: false }
    : pendingMutation?.kind === 'transition'
      ? { title: pendingMutation.transition.title, description: pendingMutation.transition.description, label: pendingMutation.transition.confirmLabel, danger: pendingMutation.transition.danger }
      : pendingMutation?.kind === 'delete'
        ? { title: '确认删除待发货记录？', description: '前置条件：记录仍为待发货且原批次可精确恢复。成功后记录删除并恢复库存；未知时必须先核对。', label: '确认删除并恢复库存', danger: true }
        : null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">供应商退货</h1>
          <p className="mt-1 text-sm text-gray-500">{canWrite ? '按真实状态前置条件登记退货、物流、收货与退款工作流。' : '只读查看；写操作由 supplier_returns:W capability 控制。'}</p>
        </div>
        {canWrite && <button type="button" className="a11y-focus-ring inline-flex min-h-10 items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700" onClick={openCreate}><CornerUpLeft aria-hidden="true" className="h-4 w-4" />新建供应商退货</button>}
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-800">“退款状态已登记”只代表本工作流字段；当前后端明确没有应付贷项/财务台账过账，页面不会把它显示为已退款、已冲销或到账。</div>

      <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 lg:flex-row">
        <div className="relative min-w-0 flex-1 lg:max-w-sm">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input type="search" aria-label="搜索供应商退货" className={`${inputClass} w-full pl-10`} placeholder="退货单号 / 物料 / 原因" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyFilters() }} />
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          <select aria-label="筛选供应商退货状态" className={`${inputClass} flex-1 sm:flex-none`} value={statusDraft} onChange={(event) => setStatusDraft(event.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(STATUS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
          </select>
          <select aria-label="筛选供应商" className={`${inputClass} flex-1 sm:flex-none`} value={supplierDraft} disabled={Boolean(refsError)} onChange={(event) => setSupplierDraft(event.target.value)}>
            <option value="">{refsError ? '供应商数据未知' : '全部供应商'}</option>
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
          <button type="button" className={buttonClass} onClick={applyFilters}>查询</button>
          <button type="button" className={buttonClass} onClick={resetFilters}>重置</button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        {listError ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-gray-600"><AlertCircle aria-hidden="true" className="h-6 w-6 text-amber-500" /><div><div className="font-medium text-gray-900">供应商退货记录未加载</div><div className="mt-1 text-xs">{listError}。数据未知，不能按空列表处理。</div></div><button type="button" className={buttonClass} onClick={loadList}>重新加载供应商退货</button></div>
        ) : listLoading ? (
          <div role="status" aria-label="正在加载供应商退货" className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />加载中…</div>
        ) : records.length === 0 ? (
          <EmptyState icon={Package} title="当前条件下没有供应商退货记录" description={canWrite ? '可调整筛选，或创建一笔经过确认的退货。' : '查询已成功；当前账号只有读取权限。'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium text-gray-500"><tr><th className="px-4 py-3">退货单号</th><th className="px-4 py-3">物料</th><th className="px-4 py-3">供应商</th><th className="px-4 py-3 text-right">数量</th><th className="px-4 py-3">原因</th><th className="px-4 py-3">拟登记退款额</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">创建时间</th><th className="px-4 py-3">操作</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {records.map((record) => <tr key={record.id} className="hover:bg-gray-50"><td className="px-4 py-3 font-mono text-xs text-gray-700">{record.returnNo}</td><td className="px-4 py-3 font-medium text-gray-900">{record.materialName || '未提供'}</td><td className="px-4 py-3 text-gray-600">{record.supplierName || '未关联'}</td><td className="px-4 py-3 text-right tabular-nums">{Number.isFinite(record.quantity) ? record.quantity : '未提供'}</td><td className="px-4 py-3 text-gray-600">{reasonLabel(record.reason)}</td><td className="px-4 py-3 text-gray-600">{refundLabel(record.refundAmount)}</td><td className="px-4 py-3"><StatusBadge status={record.status} /></td><td className="px-4 py-3 text-xs text-gray-500">{formatDate(record.createdAt)}</td><td className="px-4 py-3"><button type="button" aria-label={`查看 ${record.returnNo}`} className="a11y-focus-ring rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50" onClick={() => openDetail(record)}>查看详情</button></td></tr>)}
              </tbody>
            </table>
          </div>
        )}
        {!listError && !listLoading && records.length > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />}
      </div>

      {createOpen && <SupplierReturnCreateDialog form={form} setForm={setForm} materials={materials} suppliers={suppliers} purchaseOrders={purchaseOrders} inboundRecords={inboundRecords} refsError={refsError} validationError={validationError} onClose={() => setCreateOpen(false)} onConfirm={requestCreateConfirmation} />}
      {detailOpen && <SupplierReturnDetailDialog record={detailRecord} loading={detailLoading} error={detailError} canWrite={canWrite} mutationUnknown={mutationUnknown} onClose={closeDetail} onRetry={() => loadDetail(detailId)} onTransition={(transition) => { if (detailRecord) { setPendingMutation({ kind: 'transition', transition, recordId: detailRecord.id }); setMutationError('') } }} onDelete={() => { if (detailRecord?.status === 'pending') { setPendingMutation({ kind: 'delete', record: detailRecord }); setMutationError('') } }} />}
      {confirm && <MutationConfirmDialog title={confirm.title} description={confirm.description} confirmLabel={confirm.label} danger={confirm.danger} busy={mutationBusy} error={mutationError} onClose={() => { if (!mutationBusy) { setPendingMutation(null); setMutationError('') } }} onConfirm={runMutation} />}
    </div>
  )
}
