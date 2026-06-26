import { useState, useEffect, useCallback, useMemo } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { indirectCostApi } from '@/api/master'
import type { IndirectCostCenter, IndirectCostAllocation } from '@/types'
import { toast } from 'sonner'

export interface CostCenterForm {
  code: string
  name: string
  costType: string
  monthlyAmount: number
  allocationBase: string
  description: string
  status: 'active' | 'inactive'
}

export interface AllocationForm {
  yearMonth: string
  totalAmount: number
  allocationBaseValue: number
}

const COST_TYPE_OPTIONS = [
  { value: 'rent', label: '房租' },
  { value: 'utilities', label: '水电' },
  { value: 'maintenance', label: '维护' },
  { value: 'admin', label: '管理费' },
  { value: 'it', label: 'IT费用' },
  { value: 'other', label: '其他' },
]

const ALLOCATION_BASE_OPTIONS = [
  { value: 'sample_count', label: '样本数' },
  { value: 'revenue', label: '收入' },
  { value: 'labor_hours', label: '工时' },
  { value: 'area', label: '面积' },
]

function getErrorMessage(err: any, fallback: string) {
  return err?.response?.data?.error?.message || err?.message || fallback
}

function buildCreatedCostCenter(
  payload: Partial<IndirectCostCenter>,
  form: CostCenterForm,
): IndirectCostCenter | null {
  if (!payload.id || !payload.code) return null

  return {
    id: payload.id,
    code: payload.code,
    name: payload.name || form.name,
    costType: payload.costType || form.costType,
    monthlyAmount: Number(payload.monthlyAmount ?? form.monthlyAmount),
    allocationBase: payload.allocationBase || form.allocationBase,
    description: payload.description ?? form.description,
    status: (payload.status || form.status) as IndirectCostCenter['status'],
    createdAt: payload.createdAt || new Date().toISOString(),
    updatedAt: payload.updatedAt || new Date().toISOString(),
  }
}

function buildRecordedAllocation(
  res: any,
  costCenterId: string,
  form: AllocationForm
): IndirectCostAllocation {
  const allocationRate = Number(res?.allocationRate ?? res?.rate ?? 0)
  return {
    id: String(res?.id || `${costCenterId}-${form.yearMonth}`),
    costCenterId: String(res?.costCenterId || costCenterId),
    yearMonth: String(res?.yearMonth || form.yearMonth),
    totalAmount: Number(res?.totalAmount ?? form.totalAmount),
    allocationBaseValue: Number(res?.allocationBaseValue ?? form.allocationBaseValue),
    allocationRate,
    createdAt: String(res?.createdAt || new Date().toISOString()),
  }
}

export function useCostCenterPage() {
  const initialKeyword = new URLSearchParams(window.location.search).get('keyword') || ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const [searchInput, setSearchInput] = useState(initialKeyword)
  const [filterStatus, setFilterStatus] = useState('')
  const [stats, setStats] = useState({ total: 0, active: 0, totalMonthly: 0, allocationCount: 0 })

  const [modalType, setModalType] = useState<null | 'create' | 'edit' | 'delete' | 'allocation'>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<IndirectCostCenter | null>(null)
  const [createdCostCenterFallback, setCreatedCostCenterFallback] = useState<IndirectCostCenter | null>(null)
  const [deletedCostCenterIds, setDeletedCostCenterIds] = useState<Set<string>>(new Set())

  const [form, setForm] = useState<CostCenterForm>({
    code: '',
    name: '',
    costType: 'other',
    monthlyAmount: 0,
    allocationBase: 'sample_count',
    description: '',
    status: 'active',
  })

  const [allocationForm, setAllocationForm] = useState<AllocationForm>({
    yearMonth: new Date().toISOString().slice(0, 7),
    totalAmount: 0,
    allocationBaseValue: 1,
  })

  const [allocations, setAllocations] = useState<IndirectCostAllocation[]>([])

  const fetchFn = useCallback(
    async (params: { page: number; pageSize: number }) => {
      const res: any = await indirectCostApi.getList({
        ...params,
        keyword: keyword || undefined,
        status: filterStatus && filterStatus !== 'all' ? filterStatus : undefined,
      })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    [keyword, filterStatus]
  )

  const { data, loading, page, pageSize, total, setPage, setPageSize, refresh } =
    usePagination<IndirectCostCenter>({ fetchFn, initialPage: 1, initialPageSize: 20, deps: [keyword, filterStatus] })

  const displayedPage = useMemo(() => {
    const filteredData = deletedCostCenterIds.size
      ? data.filter(row => !deletedCostCenterIds.has(row.id))
      : data
    let nextTotal = Math.max(0, total - (data.length - filteredData.length))

    if (
      createdCostCenterFallback &&
      !deletedCostCenterIds.has(createdCostCenterFallback.id) &&
      keyword === createdCostCenterFallback.code &&
      !filterStatus &&
      page === 1 &&
      !filteredData.some(row => row.id === createdCostCenterFallback.id || row.code === createdCostCenterFallback.code)
    ) {
      const rows = [createdCostCenterFallback, ...filteredData]
      return { data: rows, total: Math.max(nextTotal + 1, rows.length) }
    }

    return { data: filteredData, total: nextTotal }
  }, [createdCostCenterFallback, data, deletedCostCenterIds, filterStatus, keyword, page, total])

  const loadStats = useCallback(async () => {
    try {
      const res: any = await indirectCostApi.getStats({
        keyword: keyword || undefined,
        status: filterStatus && filterStatus !== 'all' ? filterStatus : undefined,
      })
      setStats({
        total: Number(res?.total || 0),
        active: Number(res?.active || 0),
        totalMonthly: Number(res?.totalMonthly || 0),
        allocationCount: Number(res?.allocationCount || 0),
      })
    } catch {
      setStats({ total, active: 0, totalMonthly: 0, allocationCount: 0 })
    }
  }, [keyword, filterStatus, total])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const refreshPage = async () => {
    refresh()
    await loadStats()
  }

  const handleSearch = () => {
    setKeyword(searchInput)
    setPage(1)
  }

  const handleReset = () => {
    setSearchInput('')
    setKeyword('')
    setFilterStatus('')
    setPage(1)
  }

  const handleStatusChange = useCallback((value: string) => {
    setFilterStatus(value)
    setPage(1)
  }, [setPage])

  const focusCostCenterList = useCallback((value: string) => {
    const nextKeyword = value.trim()
    setSearchInput(nextKeyword)
    setKeyword(nextKeyword)
    setFilterStatus('')
    setPage(1)
  }, [setPage])

  const openCreate = () => {
    setEditingId(null)
    setForm({
      code: '',
      name: '',
      costType: 'other',
      monthlyAmount: 0,
      allocationBase: 'sample_count',
      description: '',
      status: 'active',
    })
    setModalType('create')
  }

  const openEdit = (row: IndirectCostCenter) => {
    setEditingId(row.id)
    setForm({
      code: row.code || '',
      name: row.name || '',
      costType: row.costType || 'other',
      monthlyAmount: row.monthlyAmount || 0,
      allocationBase: row.allocationBase || 'sample_count',
      description: row.description || '',
      status: row.status || 'active',
    })
    setModalType('edit')
  }

  const openDelete = (row: IndirectCostCenter) => {
    setEditingId(row.id)
    setDetailRow(row)
    setModalType('delete')
  }

  const openAllocation = async (row: IndirectCostCenter) => {
    setEditingId(row.id)
    setDetailRow(row)
    setAllocationForm({
      yearMonth: new Date().toISOString().slice(0, 7),
      totalAmount: row.monthlyAmount || 0,
      allocationBaseValue: 1,
    })
    try {
      const res: any = await indirectCostApi.getAllocations(row.id, { page: 1, pageSize: 12 })
      setAllocations(res?.list || [])
    } catch {
      setAllocations([])
    }
    setModalType('allocation')
  }

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('请填写必填项')
      return
    }
    if (!Number.isFinite(form.monthlyAmount) || form.monthlyAmount < 0) {
      toast.error('月度金额必须大于等于0')
      return
    }
    try {
      const payload = { ...form }
      if (editingId) {
        await indirectCostApi.update(editingId, payload)
        toast.success('成本中心更新成功')
      } else {
        const created: any = await indirectCostApi.create(payload)
        setCreatedCostCenterFallback(buildCreatedCostCenter(created, form))
        focusCostCenterList(String(created?.code || form.code || form.name || ''))
        toast.success('成本中心创建成功')
      }
      setModalType(null)
      await refreshPage()
    } catch {
      toast.error('操作失败')
    }
  }

  const handleDelete = async () => {
    if (!editingId) return
    try {
      await indirectCostApi.delete(editingId)
      setDeletedCostCenterIds(prev => {
        const next = new Set(prev)
        next.add(editingId)
        return next
      })
      toast.success('成本中心已删除')
      setModalType(null)
      setEditingId(null)
      await refreshPage()
    } catch (err: any) {
      toast.error(getErrorMessage(err, '删除失败'))
    }
  }

  const handleAllocationSubmit = async () => {
    if (!editingId || !allocationForm.yearMonth) {
      toast.error('请填写必填项')
      return
    }
    if (detailRow?.status !== 'active') {
      toast.error('停用成本中心不可录入分摊')
      return
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(allocationForm.yearMonth)) {
      toast.error('年月格式必须为 YYYY-MM')
      return
    }
    if (!Number.isFinite(allocationForm.totalAmount) || allocationForm.totalAmount < 0) {
      toast.error('费用总额必须大于等于0')
      return
    }
    if (!Number.isFinite(allocationForm.allocationBaseValue) || allocationForm.allocationBaseValue <= 0) {
      toast.error('分摊基础值必须大于0')
      return
    }
    try {
      const res: any = await indirectCostApi.recordAllocation(editingId, {
        yearMonth: allocationForm.yearMonth,
        totalAmount: allocationForm.totalAmount,
        allocationBaseValue: allocationForm.allocationBaseValue,
      })
      const recordedAllocation = buildRecordedAllocation(res, editingId, allocationForm)
      setAllocations(prev => [
        recordedAllocation,
        ...prev.filter(item => item.id !== recordedAllocation.id),
      ])
      toast.success(`分摊录入成功，单位分摊率：¥${recordedAllocation.allocationRate.toFixed(4)}`)
      try {
        const listRes: any = await indirectCostApi.getAllocations(editingId, { page: 1, pageSize: 12 })
        const refreshedAllocations = Array.isArray(listRes?.list) && listRes.list.length > 0
          ? listRes.list
          : [recordedAllocation]
        setAllocations(refreshedAllocations)
      } catch {
        setAllocations(prev => [
          recordedAllocation,
          ...prev.filter(item => item.id !== recordedAllocation.id),
        ])
      }
      await loadStats()
    } catch {
      toast.error('分摊录入失败')
    }
  }

  return {
    data: displayedPage.data,
    loading,
    page,
    pageSize,
    total: displayedPage.total,
    setPage,
    setPageSize,
    refresh,
    stats,
    keyword,
    searchInput,
    setSearchInput,
    filterStatus,
    setFilterStatus,
    handleStatusChange,
    modalType,
    setModalType,
    editingId,
    detailRow,
    form,
    setForm,
    allocationForm,
    setAllocationForm,
    allocations,
    handleSearch,
    handleReset,
    openCreate,
    openEdit,
    openDelete,
    openAllocation,
    handleSubmit,
    handleDelete,
    handleAllocationSubmit,
    COST_TYPE_OPTIONS,
    ALLOCATION_BASE_OPTIONS,
  }
}
