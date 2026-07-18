import { useState, useEffect, useMemo } from 'react'
import { projectApi, bomApi } from '@/api/master'
import type { Project, BOM } from '@/types'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

export type ModalType = 'create' | 'edit' | 'copy' | 'delete' | null

export interface FormData {
  code: string
  name: string
  type: string
  cycle: string
  manager: string
  description: string
  supportableSamples: number
  status: 'active' | 'inactive'
}

export function useProjectsPage() {
  const [boms, setBoms] = useState<BOM[]>([])
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [bomFilter, setBomFilter] = useState('')
  const [modalType, setModalType] = useState<ModalType>(null)
  const [editingRow, setEditingRow] = useState<Project | null>(null)
  const [form, setForm] = useState<FormData>({
    code: '', name: '', type: 'he', cycle: '', manager: '',
    description: '', supportableSamples: 0, status: 'active'
  })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editTab, setEditTab] = useState<'basic' | 'bom'>('basic')
  const [createStep, setCreateStep] = useState(1)
  const [bomOption, setBomOption] = useState<'select' | 'create' | 'skip'>('select')
  const [selectedBomId, setSelectedBomId] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { get, getNumber, setMultiple } = useUrlParams()

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<Project>({
    fetchFn: ({ page, pageSize }) =>
      projectApi.getList({
        page,
        pageSize,
        keyword: keyword || undefined,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
        bomFilter: bomFilter || undefined,
      }),
    deps: [keyword, typeFilter, statusFilter, bomFilter],
  })

  useEffect(() => {
    const k = get('keyword') || ''
    const t = get('type') || ''
    const s = get('status') || ''
    const b = get('bom') || ''
    setKeyword(k)
    setTypeFilter(t)
    setStatusFilter(s)
    setBomFilter(b)
    const p = getNumber('page', 1)
    const ps = getNumber('pageSize', 20)
    setPage(Math.max(1, p || 1))
    setPageSize(Math.max(1, Math.min(100, ps || 20)))
  }, [])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (keyword) params.keyword = keyword
    if (typeFilter) params.type = typeFilter
    if (statusFilter) params.status = statusFilter
    if (bomFilter) params.bom = bomFilter
    if (page !== 1) params.page = String(page)
    if (pageSize !== 20) params.pageSize = String(pageSize)
    setMultiple(params)
  }, [page, pageSize, keyword, typeFilter, statusFilter, bomFilter])

  const fetchBoms = async () => {
    try {
      const res: any = await bomApi.getList({ page: 1, pageSize: 999 })
      setBoms(res.list || [])
    } catch (e) { console.error(e) }
  }

  const stats = useMemo(() => {
    const active = data.filter(s => s.status === 'active').length
    const inactive = data.filter(s => s.status === 'inactive').length
    const noBom = data.filter(s => !s.bomId).length
    return { total, active, inactive, noBom }
  }, [data, total])

  const openCreate = () => {
    setEditingRow(null)
    setForm({
      code: '', name: '', type: 'he', cycle: '', manager: '',
      description: '', supportableSamples: 0, status: 'active'
    })
    setCreateStep(1)
    setBomOption('select')
    setSelectedBomId('')
    setModalType('create')
    fetchBoms()
  }

  const openEdit = (row: Project) => {
    setEditingRow(row)
    setForm({
      code: row.code,
      name: row.name,
      type: row.type || 'he',
      cycle: row.cycle || '',
      manager: row.manager || '',
      description: row.description || '',
      supportableSamples: row.supportableSamples || 0,
      status: row.status,
    })
    setEditTab('basic')
    setModalType('edit')
    fetchBoms()
  }

  const openCopy = (row: Project) => {
    setEditingRow(row)
    setForm({
      code: '',
      name: row.name + '（副本）',
      type: row.type || 'he',
      cycle: row.cycle || '',
      manager: row.manager || '',
      description: row.description || '',
      supportableSamples: row.supportableSamples || 0,
      status: 'active',
    })
    setModalType('copy')
  }

  const openDelete = (row: Project) => {
    setEditingRow(row)
    setModalType('delete')
  }

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('请填写必填字段')
      return
    }
    setIsSubmitting(true)
    try {
      if (modalType === 'edit' && editingRow) {
        await projectApi.update(editingRow.id, form)
        toast.success('检测服务已更新')
      } else if (modalType === 'create') {
        await projectApi.create(form)
        toast.success('检测服务已创建')
      } else if (modalType === 'copy' && editingRow) {
        await projectApi.create({ ...form })
        toast.success('检测服务已复制')
      }
      setModalType(null)
      refresh()
    } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ } finally { setIsSubmitting(false) }
  }

  const handleDeleteConfirm = async () => {
    if (!editingRow) return
    try {
      await projectApi.delete(editingRow.id)
      toast.success('已删除')
      setModalType(null)
      refresh()
    } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
  }

  const handleQuery = () => { setPage(1) }
  const handleReset = () => {
    setKeyword(''); setTypeFilter(''); setStatusFilter(''); setBomFilter('')
    setPage(1)
  }

  const toggleSelectAll = (checked: boolean) => {
    if (checked) setSelectedIds(new Set(data.map(r => r.id)))
    else setSelectedIds(new Set())
  }

  const toggleSelectOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds)
    if (checked) next.add(id)
    else next.delete(id)
    setSelectedIds(next)
  }

  const batchEnable = async () => {
    toast.success(`已启用 ${selectedIds.size} 个检测服务`)
    setSelectedIds(new Set())
  }

  const batchDisable = async () => {
    toast.success(`已停用 ${selectedIds.size} 个检测服务`)
    setSelectedIds(new Set())
  }

  const selectedBom = boms.find(b => b.id === selectedBomId)

  return {
    boms, setBoms,
    keyword, setKeyword,
    typeFilter, setTypeFilter,
    statusFilter, setStatusFilter,
    bomFilter, setBomFilter,
    modalType, setModalType,
    editingRow, setEditingRow,
    form, setForm,
    selectedIds, setSelectedIds,
    editTab, setEditTab,
    createStep, setCreateStep,
    bomOption, setBomOption,
    selectedBomId, setSelectedBomId,
    isSubmitting, setIsSubmitting,
    data, loading, page, pageSize, total, setPage, setPageSize, refresh,
    stats,
    openCreate, openEdit, openCopy, openDelete,
    handleSubmit, handleDeleteConfirm, handleQuery, handleReset,
    toggleSelectAll, toggleSelectOne,
    batchEnable, batchDisable,
    selectedBom,
  }
}
