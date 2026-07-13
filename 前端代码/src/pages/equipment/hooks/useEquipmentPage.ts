import { useState, useEffect, useCallback, useMemo } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { equipmentApi } from '@/api/master'
import { canAccess } from '@/lib/permissions'
import type { Equipment, EquipmentType } from '@/types'
import { toast } from 'sonner'

export interface EquipmentForm {
  code: string
  name: string
  model: string
  manufacturer: string
  purchasePrice: number
  purchaseDate: string
  depreciableLifeYears: number
  residualValue: number
  depreciationMethod: 'straight_line' | 'units_of_production'
  totalCapacity: number
  capacityUnit: string
  status: 'active' | 'inactive' | 'scrapped'
  locationId: string
  typeId: string
}

// 设备资产写操作（新增/编辑/删除/登记使用）的前端显隐判据，与后端 requirePermission('equipment','W') 对齐。
// 读能力矩阵（登录响应下发的 user.capabilities，单一来源），而非早前退化为「role∈{admin,technician}」、
// 且依赖后端从不下发的 user.permissions 数组的旧判据——那会把同样持 equipment:W 的角色（如 finance/lab_director）
// 在前端误藏，而后端却放行（前端藏了·后端放行）。capabilities 缺失时 canAccess 放行，真实边界仍由后端守卫兜底。
function canManageEquipment() {
  return canAccess('equipment', 'W')
}

function calculateAnnualDepreciation(form: EquipmentForm) {
  const depreciableAmount = Math.max(0, Number(form.purchasePrice || 0) - Number(form.residualValue || 0))
  if (form.depreciationMethod === 'units_of_production') {
    return 0
  }
  return form.depreciableLifeYears > 0 ? depreciableAmount / form.depreciableLifeYears : 0
}

function buildCreatedEquipment(payload: Partial<Equipment>, form: EquipmentForm): Equipment | null {
  const code = String(payload.code || form.code || '').trim()
  if (!payload.id || !code) return null

  const now = new Date().toISOString()
  const annualDepreciation = Number(payload.annualDepreciation ?? calculateAnnualDepreciation(form))
  const purchasePrice = Number(payload.purchasePrice ?? form.purchasePrice)
  const accumulatedDepreciation = Number(payload.accumulatedDepreciation ?? 0)

  return {
    id: String(payload.id),
    code,
    name: String(payload.name || form.name),
    model: payload.model ?? form.model,
    manufacturer: payload.manufacturer ?? form.manufacturer,
    purchasePrice,
    purchaseDate: payload.purchaseDate ?? form.purchaseDate,
    depreciableLifeYears: Number(payload.depreciableLifeYears ?? form.depreciableLifeYears),
    residualValue: Number(payload.residualValue ?? form.residualValue),
    depreciationMethod: (payload.depreciationMethod || form.depreciationMethod) as Equipment['depreciationMethod'],
    totalCapacity: Number(payload.totalCapacity ?? form.totalCapacity),
    capacityUnit: payload.capacityUnit ?? form.capacityUnit,
    status: (payload.status || form.status) as Equipment['status'],
    locationId: payload.locationId ?? form.locationId,
    typeId: payload.typeId ?? form.typeId,
    typeName: payload.typeName ?? null,
    annualDepreciation,
    accumulatedDepreciation,
    netBookValue: Number(payload.netBookValue ?? Math.max(0, purchasePrice - accumulatedDepreciation)),
    createdAt: payload.createdAt || now,
    updatedAt: payload.updatedAt || now,
  }
}

export function useEquipmentPage() {
  const canManageEquipmentAssets = canManageEquipment()
  const initialParams = new URLSearchParams(window.location.search)
  const initialKeyword = initialParams.get('keyword') || ''
  const [includeDeleted, setIncludeDeleted] = useState(initialParams.get('includeDeleted') === 'true')
  const [keyword, setKeyword] = useState(initialKeyword)
  const [searchInput, setSearchInput] = useState(initialKeyword)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterTypeId, setFilterTypeId] = useState('')
  const [typeOptions, setTypeOptions] = useState<Array<{ value: string; label: string }>>([])
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0, scrapped: 0, totalValue: 0 })

  const [modalType, setModalType] = useState<null | 'create' | 'edit' | 'detail' | 'delete'>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<Equipment | null>(null)
  const [createdEquipmentFallback, setCreatedEquipmentFallback] = useState<Equipment | null>(null)

  const [form, setForm] = useState<EquipmentForm>({
    code: '',
    name: '',
    model: '',
    manufacturer: '',
    purchasePrice: 0,
    purchaseDate: '',
    depreciableLifeYears: 5,
    residualValue: 0,
    depreciationMethod: 'straight_line',
    totalCapacity: 0,
    capacityUnit: '',
    status: 'active',
    locationId: '',
    typeId: '',
  })

  // 加载设备类型选项
  useEffect(() => {
    equipmentApi.getTypes({ page: 1, pageSize: 999, status: 'active' }).then((res: any) => {
      const options = (res?.list || []).map((t: EquipmentType) => ({ value: t.id, label: t.name }))
      setTypeOptions(options)
    }).catch(() => {})
  }, [])

  const fetchFn = useCallback(
    async (params: { page: number; pageSize: number }) => {
      const res: any = await equipmentApi.getList({
        ...params,
        keyword: keyword || undefined,
        status: filterStatus || undefined,
        typeId: filterTypeId || undefined,
        includeDeleted: includeDeleted || undefined,
      })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    [keyword, filterStatus, filterTypeId, includeDeleted]
  )

  const { data, loading, page, pageSize, total, setPage, setPageSize, refresh } =
    usePagination<Equipment>({ fetchFn, initialPage: 1, initialPageSize: 20, deps: [keyword, filterStatus, filterTypeId, includeDeleted] })

  const displayedPage = useMemo(() => {
    if (
      createdEquipmentFallback &&
      keyword === createdEquipmentFallback.code &&
      !filterStatus &&
      !filterTypeId &&
      !includeDeleted &&
      page === 1 &&
      !data.some(row => row.id === createdEquipmentFallback.id || row.code === createdEquipmentFallback.code)
    ) {
      const rows = [createdEquipmentFallback, ...data]
      return { data: rows, total: Math.max(total + 1, rows.length) }
    }

    return { data, total }
  }, [createdEquipmentFallback, data, filterStatus, filterTypeId, includeDeleted, keyword, page, total])

  useEffect(() => {
    equipmentApi.getStats({
      keyword: keyword || undefined,
      status: filterStatus || undefined,
      typeId: filterTypeId || undefined,
      includeDeleted: includeDeleted || undefined,
    })
      .then((res: any) => setStats({
        total: Number(res?.total || 0),
        active: Number(res?.active || 0),
        inactive: Number(res?.inactive || 0),
        scrapped: Number(res?.scrapped || 0),
        totalValue: Number(res?.totalValue || 0),
      }))
      .catch(() => setStats({ total, active: 0, inactive: 0, scrapped: 0, totalValue: 0 }))
  }, [keyword, filterStatus, filterTypeId, includeDeleted, total])

  const handleSearch = () => {
    setKeyword(searchInput)
    setPage(1)
  }

  const handleReset = () => {
    setSearchInput('')
    setKeyword('')
    setIncludeDeleted(false)
    setFilterStatus('')
    setFilterTypeId('')
    setPage(1)
  }

  const handleStatusChange = useCallback((value: string) => {
    setFilterStatus(value)
    setPage(1)
  }, [setPage])

  const handleTypeChange = useCallback((value: string) => {
    setFilterTypeId(value)
    setPage(1)
  }, [setPage])

  const focusEquipmentList = useCallback((value: string) => {
    const nextKeyword = value.trim()
    setSearchInput(nextKeyword)
    setKeyword(nextKeyword)
    setFilterStatus('')
    setFilterTypeId('')
    setIncludeDeleted(false)
    setPage(1)
  }, [setPage])

  const openCreate = () => {
    setEditingId(null)
    setForm({
      code: '',
      name: '',
      model: '',
      manufacturer: '',
      purchasePrice: 0,
      purchaseDate: '',
      depreciableLifeYears: 5,
      residualValue: 0,
      depreciationMethod: 'straight_line',
      totalCapacity: 0,
      capacityUnit: '',
      status: 'active',
      locationId: '',
      typeId: '',
    })
    setModalType('create')
  }

  const openEdit = (row: Equipment) => {
    setEditingId(row.id)
    setForm({
      code: row.code || '',
      name: row.name || '',
      model: row.model || '',
      manufacturer: row.manufacturer || '',
      purchasePrice: row.purchasePrice || 0,
      purchaseDate: row.purchaseDate || '',
      depreciableLifeYears: row.depreciableLifeYears || 5,
      residualValue: row.residualValue || 0,
      depreciationMethod: row.depreciationMethod || 'straight_line',
      totalCapacity: row.totalCapacity || 0,
      capacityUnit: row.capacityUnit || '',
      status: row.status || 'active',
      locationId: row.locationId || '',
      typeId: row.typeId || '',
    })
    setModalType('edit')
  }

  const openDetail = (row: Equipment) => {
    setDetailRow(row)
    setModalType('detail')
  }

  const openDelete = (row: Equipment) => {
    setEditingId(row.id)
    setDetailRow(row)
    setModalType('delete')
  }

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('请填写必填项')
      return
    }
    if (!Number.isFinite(form.purchasePrice) || form.purchasePrice < 0) {
      toast.error('购置价格必须大于等于0')
      return
    }
    if (!Number.isFinite(form.residualValue) || form.residualValue < 0) {
      toast.error('残值必须大于等于0')
      return
    }
    if (form.residualValue > form.purchasePrice) {
      toast.error('残值不能大于购置价格')
      return
    }
    if (!Number.isFinite(form.depreciableLifeYears) || form.depreciableLifeYears <= 0) {
      toast.error('折旧年限必须大于0')
      return
    }
    if (form.depreciationMethod === 'units_of_production' && (!Number.isFinite(form.totalCapacity) || form.totalCapacity <= 0)) {
      toast.error('工作量法必须填写大于0的总工作量')
      return
    }
    if (form.depreciationMethod === 'straight_line' && (!Number.isFinite(form.totalCapacity) || form.totalCapacity < 0)) {
      toast.error('总工作量必须大于等于0')
      return
    }
    try {
      const payload = { ...form }
      if (editingId) {
        const current = displayedPage.data.find(item => item.id === editingId)
        if (current) payload.code = current.code
        await equipmentApi.update(editingId, payload)
        toast.success('设备更新成功')
      } else {
        const created: any = await equipmentApi.create(payload)
        setCreatedEquipmentFallback(buildCreatedEquipment(created, form))
        focusEquipmentList(String(created?.code || form.code || form.name || ''))
        toast.success('设备创建成功')
      }
      setModalType(null)
      refresh()
    } catch {
      toast.error('操作失败')
    }
  }

  const handleDelete = async () => {
    if (!editingId) return
    try {
      await equipmentApi.delete(editingId)
      toast.success('设备已删除')
      setModalType(null)
      setEditingId(null)
      refresh()
    } catch {
      toast.error('删除失败')
    }
  }

  return {
    canManageEquipmentAssets,
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
    filterTypeId,
    setFilterTypeId,
    handleStatusChange,
    handleTypeChange,
    typeOptions,
    modalType,
    setModalType,
    editingId,
    detailRow,
    form,
    setForm,
    handleSearch,
    handleReset,
    openCreate,
    openEdit,
    openDetail,
    openDelete,
    handleSubmit,
    handleDelete,
  }
}
