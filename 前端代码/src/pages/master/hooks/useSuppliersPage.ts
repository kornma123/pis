import { useState, useEffect } from 'react'
import { supplierApi } from '@/api/master'
import type { Supplier } from '@/types'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

export interface FormData {
  code: string
  name: string
  contact: string
  phone: string
  email: string
  address: string
  taxNo: string
  bankName: string
  bankAccount: string
  status: 'active' | 'inactive'
}

export type ModalType = 'create' | 'edit' | 'detail' | null

export function useSuppliersPage() {
  const { getNumber, setMultiple } = useUrlParams()

  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchStatus, setSearchStatus] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 100))
    ? getNumber('pageSize', 100)
    : 100

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<Supplier>({
    fetchFn: async ({ page, pageSize }) => {
      const params: any = { page, pageSize, keyword: keyword || undefined }
      if (statusFilter && statusFilter !== 'all') {
        params.status = statusFilter
      }
      const res: any = await supplierApi.getList(params)
      return { list: res.list || [], pagination: res.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [keyword, statusFilter],
  })

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 100 ? pageSize : null,
      keyword: keyword || null,
      status: statusFilter !== 'all' ? statusFilter : null,
    })
  }, [page, pageSize, keyword, statusFilter, setMultiple])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [modalType, setModalType] = useState<ModalType>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<Supplier | null>(null)

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
    code: '', name: '', contact: '', phone: '', email: '',
    address: '', taxNo: '', bankName: '', bankAccount: '', status: 'active',
  })

  const stats = {
    total,
    active: data.filter((d) => d.status === 'active').length,
    inactive: data.filter((d) => d.status === 'inactive').length,
    newThisMonth: data.filter((d) => {
      if (!d.createdAt) return false
      const created = new Date(d.createdAt)
      const now = new Date()
      return (
        created.getMonth() === now.getMonth() &&
        created.getFullYear() === now.getFullYear()
      )
    }).length,
  }

  const handleSearch = () => {
    setKeyword(searchKeyword)
    setStatusFilter(searchStatus)
    setPage(1)
  }

  const handleReset = () => {
    setSearchKeyword('')
    setSearchStatus('all')
    setKeyword('')
    setStatusFilter('all')
    setPage(1)
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({
      code: '', name: '', contact: '', phone: '', email: '',
      address: '', taxNo: '', bankName: '', bankAccount: '', status: 'active',
    })
    setModalType('create')
  }

  const openEdit = (row: Supplier) => {
    setEditingId(row.id)
    setForm({
      code: row.code, name: row.name, contact: row.contact || '',
      phone: row.phone || '', email: row.email || '', address: row.address || '',
      taxNo: row.taxNo || '', bankName: row.bankName || '',
      bankAccount: row.bankAccount || '', status: row.status,
    })
    setModalType('edit')
  }

  const openDetail = (row: Supplier) => {
    setDetailRow(row)
    setModalType('detail')
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error('请填写供应商名称')
      return
    }
    try {
      if (editingId) {
        await supplierApi.update(editingId, form)
      } else {
        await supplierApi.create(form)
      }
      toast.success('保存成功')
      setModalType(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleDelete = async (id: string) => {
    openConfirm({
      title: '确认删除',
      description: '确定删除该供应商？删除后不可恢复。',
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          await supplierApi.delete(id)
          toast.success('删除成功')
          refresh()
        } catch {
          /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
        }
      },
    })
  }

  const handleToggleStatus = async (row: Supplier) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    try {
      await supplierApi.update(row.id, { status: newStatus })
      toast.success(newStatus === 'active' ? '已启用' : '已停用')
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === data.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map((d) => d.id)))
    }
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const getAvatarColor = (name: string) => {
    const colors = [
      { bg: '#e0e7ff', text: '#4f46e5' },
      { bg: '#fef3c7', text: '#d97706' },
      { bg: '#dbeafe', text: '#2563eb' },
      { bg: '#dcfce7', text: '#16a34a' },
      { bg: '#fce7f3', text: '#db2777' },
      { bg: '#f3e8ff', text: '#9333ea' },
    ]
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  return {
    data, loading, page, pageSize, total, setPage, setPageSize,
    searchKeyword, setSearchKeyword, searchStatus, setSearchStatus,
    keyword, statusFilter,
    selectedIds,
    modalType, setModalType,
    editingId, detailRow,
    confirmOpen, setConfirmOpen, confirmProps, setConfirmProps,
    form, setForm,
    stats,
    handleSearch, handleReset,
    openCreate, openEdit, openDetail,
    handleSubmit, handleDelete, handleToggleStatus,
    toggleSelectAll, toggleSelect,
    getAvatarColor,
  }
}
