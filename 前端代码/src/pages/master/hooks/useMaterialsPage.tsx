import { useState, useEffect, useCallback } from 'react'
import { materialApi, categoryApi, supplierApi } from '@/api/master'
import type { Material, Category, Supplier } from '@/types'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

export interface FormData {
  code: string
  name: string
  spec: string
  unit: string
  categoryId: string
  supplierId: string
  price: number
  minStock: number
  maxStock: number
  safetyStock: number
  status: 'active' | 'inactive'
  remark: string
}

export type QuickFilter = 'all' | 'active' | 'inactive' | 'low-stock'

export function useMaterialsPage() {
  const { getNumber, setMultiple } = useUrlParams()

  const [keyword, setKeyword] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

  const {
    data, loading, page, pageSize, total,
    setPage, setPageSize, refresh,
  } = usePagination<Material>({
    fetchFn: async ({ page, pageSize }) => {
      const params: any = { page, pageSize }
      if (keyword) params.keyword = keyword
      if (categoryId) params.categoryId = categoryId
      if (supplierId) params.supplierId = supplierId
      if (quickFilter === 'active' || quickFilter === 'inactive') {
        params.status = quickFilter
      }
      const res: any = await materialApi.getList(params)
      let list: Material[] = res.list || []
      if (quickFilter === 'low-stock') {
        list = list.filter((m: Material) => m.stock <= m.minStock)
      }
      return { list, pagination: res.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [keyword, categoryId, supplierId, quickFilter],
  })

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
      categoryId: categoryId || null,
      supplierId: supplierId || null,
      status: quickFilter !== 'all' ? quickFilter : null,
    })
  }, [page, pageSize, keyword, categoryId, supplierId, quickFilter, setMultiple])

  const [categories, setCategories] = useState<Category[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  const [modalOpen, setModalOpen] = useState(false)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailMaterial, setDetailMaterial] = useState<Material | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmProps, setConfirmProps] = useState<{
    title: string
    description: string
    confirmText: string
    confirmVariant: 'danger' | 'primary'
    onConfirm: () => void
  } | null>(null)

  const openConfirm = (props: {
    title: string
    description: string
    confirmText: string
    confirmVariant: 'danger' | 'primary'
    onConfirm: () => void
  }) => {
    setConfirmProps(props)
    setConfirmOpen(true)
  }

  const [form, setForm] = useState<FormData>({
    code: '', name: '', spec: '', unit: '个', categoryId: '', supplierId: '',
    price: 0, minStock: 0, maxStock: 999999, safetyStock: 0, status: 'active', remark: ''
  })

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [specPart, setSpecPart] = useState({ amount: '', unit: '' })

  const fetchRefs = async () => {
    try {
      const [catRes, supRes]: any = await Promise.all([
        categoryApi.getList({ page: 1, pageSize: 999 }),
        supplierApi.getList({ page: 1, pageSize: 999 }),
      ])
      setCategories(catRes?.list || [])
      setSuppliers(supRes?.list || [])
    } catch (e) { console.error(e) }
  }

  useEffect(() => { fetchRefs() }, [])

  useEffect(() => {
    if (modalOpen && !editingId && categories.length > 0 && !form.code) {
      const cat = form.categoryId || categories[0]?.id
      if (cat) autoFillCode(cat)
    }
  }, [categories, modalOpen])

  const stats = {
    total,
    active: data.filter(m => m.status === 'active').length,
    inactive: data.filter(m => m.status === 'inactive').length,
    lowStock: data.filter(m => m.stock <= m.minStock).length,
  }

  const autoFillCode = useCallback(async (categoryId: string) => {
    if (!categoryId) return
    try {
      const res: any = await materialApi.getNextCode(categoryId)
      if (res.data?.code) {
        setForm(prev => ({ ...prev, code: res.data.code }))
      }
    } catch (e) { /* ignore */ }
  }, [])

  const parseSpec = (spec?: string) => {
    if (!spec || !spec.includes('/')) return { amount: '', unit: spec || '' }
    const [a, b] = spec.split('/')
    return { amount: a, unit: b }
  }

  const openCreate = () => {
    setEditingId(null)
    setSpecPart({ amount: '', unit: '' })
    const defaultCat = categories[0]?.id || ''
    setForm({ code: '', name: '', spec: '', unit: '个', categoryId: defaultCat, supplierId: '', price: 0, minStock: 0, maxStock: 999999, safetyStock: 0, status: 'active', remark: '' })
    setModalOpen(true)
    if (defaultCat) autoFillCode(defaultCat)
  }

  const openEdit = (row: Material) => {
    setEditingId(row.id)
    setSpecPart(parseSpec(row.spec))
    setForm({
      code: row.code, name: row.name, spec: row.spec || '', unit: row.unit,
      categoryId: row.categoryId || '', supplierId: row.supplierId || '',
      price: row.price || 0, minStock: row.minStock || 0, maxStock: row.maxStock || 999999,
      safetyStock: row.safetyStock || 0, status: row.status, remark: row.remark || ''
    })
    setModalOpen(true)
  }

  const openDetail = (row: Material) => {
    setDetailMaterial(row)
    setDetailModalOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.unit.trim()) {
      toast.error('请填写必填字段')
      return
    }
    try {
      if (editingId) {
        await materialApi.update(editingId, form)
        toast.success('物料更新成功')
      } else {
        await materialApi.create(form)
        toast.success('物料创建成功')
      }
      setModalOpen(false)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleDelete = async (id: string) => {
    openConfirm({
      title: '确认删除',
      description: '删除后不可恢复，是否继续？',
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          await materialApi.delete(id)
          toast.success('删除成功')
          refresh()
        } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
      },
    })
  }

  const handleToggleStatus = async (row: Material) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    try {
      await materialApi.update(row.id, { status: newStatus })
      toast.success(newStatus === 'active' ? '物料已启用' : '物料已停用')
      refresh()
    } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === data.length && data.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map(d => d.id)))
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const batchDelete = async () => {
    openConfirm({
      title: '确认批量删除',
      description: `确认删除选中的 ${selectedIds.size} 个物料？删除后不可恢复。`,
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          for (const id of selectedIds) {
            await materialApi.delete(id)
          }
          toast.success('批量删除成功')
          clearSelection()
          refresh()
        } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
      },
    })
  }

  const batchToggleStatus = async (status: 'active' | 'inactive') => {
    try {
      for (const id of selectedIds) {
        await materialApi.update(id, { status })
      }
      toast.success(status === 'active' ? '批量启用成功' : '批量停用成功')
      clearSelection()
      refresh()
    } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
  }

  const getCategoryName = (id?: string) => {
    if (!id) return '-'
    return categories.find(c => c.id === id)?.name || id
  }

  const getSupplierName = (id?: string) => {
    if (!id) return '-'
    return suppliers.find(s => s.id === id)?.name || id
  }

  const statusBadge = (status: string) => (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
    }`}>
      {status === 'active' ? '已启用' : '已停用'}
    </span>
  )

  const handleSearch = () => { setPage(1) }

  const handleReset = () => {
    setKeyword('')
    setCategoryId('')
    setSupplierId('')
    setQuickFilter('all')
    setPage(1)
  }

  return {
    data, loading, page, pageSize, total, setPage, setPageSize, refresh,
    keyword, setKeyword, categoryId, setCategoryId, supplierId, setSupplierId,
    quickFilter, setQuickFilter,
    categories, suppliers,
    modalOpen, setModalOpen,
    detailModalOpen, setDetailModalOpen,
    editingId, setEditingId,
    detailMaterial, setDetailMaterial,
    confirmOpen, setConfirmOpen, confirmProps, setConfirmProps,
    form, setForm,
    selectedIds, setSelectedIds,
    specPart, setSpecPart,
    stats,
    handleSearch, handleReset,
    openCreate, openEdit, openDetail,
    handleSubmit, handleDelete, handleToggleStatus,
    toggleSelectAll, toggleSelect, clearSelection,
    batchDelete, batchToggleStatus,
    getCategoryName, getSupplierName, statusBadge,
    autoFillCode,
  }
}
