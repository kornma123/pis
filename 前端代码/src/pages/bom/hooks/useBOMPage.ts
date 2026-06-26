import { useState, useEffect, useMemo } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { bomApi } from '@/api/master'
import type { BOM } from '@/types'
import { toast } from 'sonner'

export type ModalType =
  | null
  | 'create'
  | 'edit'
  | 'detail'
  | 'copy'
  | 'delete'
  | 'batchDelete'
  | 'import'
  | 'export'

export interface BOMForm {
  code: string
  name: string
  version: string
  type: string
  serviceId: string
  description: string
  supportableSamples: number
  status: 'active' | 'inactive'
}

export interface CopyForm {
  name: string
  copyInfo: boolean
  copyMaterials: boolean
}

export function useBOMPage() {
  const url = useUrlParams()

  const initialPage = Math.max(1, url.getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(url.getNumber('pageSize', 20))
    ? url.getNumber('pageSize', 20)
    : 20

  /* ---------- 状态 ---------- */
  const [keyword, setKeyword] = useState(url.get('keyword', ''))
  const [searchInput, setSearchInput] = useState(url.get('keyword', ''))

  const [quickFilter, setQuickFilter] = useState<'all' | 'active' | 'inactive'>(
    (url.get('quickFilter', 'all') as 'all' | 'active' | 'inactive') || 'all'
  )
  const [filterType, setFilterType] = useState(url.get('type', ''))
  const [filterStatus, setFilterStatus] = useState(url.get('status', ''))

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [modalType, setModalType] = useState<ModalType>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailBom, setDetailBom] = useState<BOM | null>(null)
  const [detailTab, setDetailTab] = useState<'info' | 'history' | 'usage'>('info')

  const [form, setForm] = useState<BOMForm>({
    code: '',
    name: '',
    version: 'v1.0',
    type: 'he',
    serviceId: '',
    description: '',
    supportableSamples: 0,
    status: 'active',
  })

  const [copyForm, setCopyForm] = useState<CopyForm>({
    name: '',
    copyInfo: true,
    copyMaterials: true,
  })

  const effectiveStatus = filterStatus || (quickFilter !== 'all' ? quickFilter : undefined)

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<BOM>({
    fetchFn: async (params) => {
      const res: any = await bomApi.getList({
        ...params,
        keyword: keyword || undefined,
        type: filterType || undefined,
        status: effectiveStatus,
      })
      return {
        list: res?.list || [],
        pagination: res?.pagination,
      }
    },
    initialPage,
    initialPageSize,
    deps: [keyword, filterType, effectiveStatus],
  })

  /* ---------- URL 同步 ---------- */
  useEffect(() => {
    url.setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
      type: filterType || null,
      status: filterStatus || null,
      quickFilter: quickFilter !== 'all' ? quickFilter : null,
    })
  }, [page, pageSize, keyword, filterType, filterStatus, quickFilter])

  /* ---------- 计算值 ---------- */
  function getMaterialStatus(bom: BOM): 'sufficient' | 'low' | 'insufficient' | 'missing' {
    if (bom.status === 'inactive') return 'missing'
    if (bom.supportableSamples === undefined || bom.supportableSamples === null) return 'missing'
    if (bom.supportableSamples === 0) return 'insufficient'
    if (bom.supportableSamples < 30) return 'low'
    return 'sufficient'
  }

  const stats = useMemo(() => {
    const all = data
    const sufficient = all.filter((b) => getMaterialStatus(b) === 'sufficient').length
    const low = all.filter((b) => getMaterialStatus(b) === 'low').length
    const insufficient = all.filter((b) => {
      const s = getMaterialStatus(b)
      return s === 'insufficient' || s === 'missing'
    }).length
    return { total: all.length, sufficient, low, insufficient }
  }, [data])

  const isAllSelected = data.length > 0 && selectedIds.size === data.length
  const isIndeterminate = selectedIds.size > 0 && selectedIds.size < data.length

  /* ---------- 事件处理 ---------- */
  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map((d) => d.id)))
    }
  }

  const toggleSelectRow = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const cancelSelection = () => setSelectedIds(new Set())

  const handleSearch = () => {
    setKeyword(searchInput)
    setPage(1)
  }

  const handleReset = () => {
    setSearchInput('')
    setKeyword('')
    setFilterType('')
    setFilterStatus('')
    setQuickFilter('all')
    setPage(1)
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({
      code: '',
      name: '',
      version: 'v1.0',
      type: 'he',
      serviceId: '',
      description: '',
      supportableSamples: 0,
      status: 'active',
    })
    setModalType('create')
  }

  const openEdit = (row: BOM) => {
    setEditingId(row.id)
    setForm({
      code: row.code || '',
      name: row.name || '',
      version: row.version || 'v1.0',
      type: row.type || 'he',
      serviceId: row.serviceId || '',
      description: row.description || '',
      supportableSamples: row.supportableSamples || 0,
      status: row.status as 'active' | 'inactive',
    })
    setModalType('edit')
  }

  const openDetail = async (row: BOM) => {
    try {
      const res: any = await bomApi.getDetail(row.id)
      setDetailBom(res.data || row)
      setDetailTab('info')
      setModalType('detail')
    } catch {
      setDetailBom(row)
      setDetailTab('info')
      setModalType('detail')
    }
  }

  const openCopy = (row: BOM) => {
    setEditingId(row.id)
    setCopyForm({ name: `${row.name}(副本)`, copyInfo: true, copyMaterials: true })
    setModalType('copy')
  }

  const openDelete = (row: BOM) => {
    setEditingId(row.id)
    setModalType('delete')
  }

  const openBatchDelete = () => {
    if (selectedIds.size === 0) {
      toast.warning('请先选择要删除的BOM')
      return
    }
    setModalType('batchDelete')
  }

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('请填写必填项')
      return
    }
    try {
      if (editingId) {
        await bomApi.update(editingId, form)
        toast.success('BOM更新成功')
      } else {
        await bomApi.create(form)
        toast.success('BOM创建成功')
      }
      setModalType(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleDelete = async () => {
    if (!editingId) return
    try {
      await bomApi.delete(editingId)
      toast.success('BOM已删除')
      setModalType(null)
      setEditingId(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleBatchDelete = async () => {
    try {
      const ids = Array.from(selectedIds)
      await Promise.all(ids.map((id) => bomApi.delete(id)))
      toast.success(`已删除 ${ids.length} 个BOM`)
      setModalType(null)
      setSelectedIds(new Set())
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleCopy = async () => {
    if (!editingId || !copyForm.name.trim()) {
      toast.error('请输入新BOM名称')
      return
    }
    try {
      const source: any = await bomApi.getDetail(editingId)
      const payload: Partial<BOM> = {
        code: '',
        name: copyForm.name.trim(),
        version: 'v1.0',
        type: source.data?.type || 'he',
        serviceId: copyForm.copyInfo ? source.data?.serviceId : undefined,
        description: copyForm.copyInfo ? source.data?.description : undefined,
        status: 'active',
        materialCount: copyForm.copyMaterials ? source.data?.materialCount || 0 : 0,
        unitCost: copyForm.copyMaterials ? source.data?.unitCost || 0 : 0,
        materials: copyForm.copyMaterials ? source.data?.materials : undefined,
      }
      await bomApi.create(payload)
      toast.success('BOM复制成功')
      setModalType(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleImport = () => {
    toast.info('导入功能开发中')
    setModalType(null)
  }

  const handleExport = () => {
    toast.info('导出功能开发中')
    setModalType(null)
  }

  return {
    keyword,
    setKeyword,
    searchInput,
    setSearchInput,
    quickFilter,
    setQuickFilter,
    filterType,
    setFilterType,
    filterStatus,
    setFilterStatus,
    selectedIds,
    setSelectedIds,
    modalType,
    setModalType,
    editingId,
    setEditingId,
    detailBom,
    setDetailBom,
    detailTab,
    setDetailTab,
    form,
    setForm,
    copyForm,
    setCopyForm,
    effectiveStatus,
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
    stats,
    isAllSelected,
    isIndeterminate,
    getMaterialStatus,
    toggleSelectAll,
    toggleSelectRow,
    cancelSelection,
    handleSearch,
    handleReset,
    openCreate,
    openEdit,
    openDetail,
    openCopy,
    openDelete,
    openBatchDelete,
    handleSubmit,
    handleDelete,
    handleBatchDelete,
    handleCopy,
    handleImport,
    handleExport,
  }
}
