import { useState, useEffect, useMemo } from 'react'
import request from '@/api/request'
import { materialApi } from '@/api/master'
import type { Material } from '@/types'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

export interface StocktakingRecord {
  id: string
  stocktakingNo: string
  materialId: string
  materialName: string
  systemStock: number
  actualStock: number
  difference: number
  operator: string
  status: string
  createdAt: string
  remark?: string
}

export interface FormData {
  materialId: string
  systemStock: number
  actualStock: number
  remark: string
  name: string
  type: 'full' | 'sample'
  scope: string
  manager: string
}

export const scopeOptions = [
  { value: '', label: '全部范围' },
  { value: 'all', label: '全部物料' },
  { value: 'category', label: '指定分类' },
  { value: 'location', label: '指定库位' },
]

export const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
]

export function useStocktakingPage() {
  const url = useUrlParams()

  const initialPage = Math.max(1, url.getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(url.getNumber('pageSize', 20))
    ? url.getNumber('pageSize', 20)
    : 20

  const [keyword, setKeyword] = useState(url.get('keyword', ''))
  const [statusFilter, setStatusFilter] = useState('')
  const [scopeFilter, setScopeFilter] = useState('')

  const [modalType, setModalType] = useState<'create' | 'detail' | 'adjust' | null>(null)
  const [detailRow, setDetailRow] = useState<StocktakingRecord | null>(null)
  const [createStep, setCreateStep] = useState(1)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [recordToDelete, setRecordToDelete] = useState<StocktakingRecord | null>(null)

  const [materials, setMaterials] = useState<Material[]>([])
  const [form, setForm] = useState<FormData>({
    materialId: '', systemStock: 0, actualStock: 0, remark: '',
    name: '', type: 'full', scope: 'all', manager: ''
  })

  const {
    data, loading, page, pageSize, total,
    setPage, setPageSize, refresh,
  } = usePagination<StocktakingRecord>({
    fetchFn: async (params) => {
      const res: any = await request.get('/stocktaking', {
        params: { ...params, keyword: keyword || undefined },
      })
      return {
        list: res?.list || [],
        pagination: res?.pagination,
      }
    },
    initialPage,
    initialPageSize,
    deps: [keyword],
  })

  useEffect(() => {
    url.setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
    })
  }, [page, pageSize, keyword])

  const stats = useMemo(() => {
    const inProgress = data.filter(d => d.status === 'in_progress').length
    const completed = data.filter(d => d.status === 'completed').length
    const diffCount = data.filter(d => d.difference !== 0).length
    const accuracy = data.length > 0
      ? ((data.filter(d => d.difference === 0).length / data.length) * 100).toFixed(1)
      : '100.0'
    return { inProgress, completed, diffCount, accuracy }
  }, [data])

  const openCreate = async () => {
    const res: any = await materialApi.getList({ page: 1, pageSize: 999, status: 'active' })
    setMaterials(res?.list || [])
    setForm({
      materialId: '', systemStock: 0, actualStock: 0, remark: '',
      name: '', type: 'full', scope: 'all', manager: ''
    })
    setCreateStep(1)
    setModalType('create')
  }

  const handleSubmit = async () => {
    if (!form.materialId) { toast.error('请选择物料'); return }
    if (form.actualStock === undefined || form.actualStock === null) {
      toast.error('请输入实盘数量')
      return
    }
    setIsSubmitting(true)
    try {
      await request.post('/stocktaking', {
        materialId: form.materialId,
        systemStock: form.systemStock,
        actualStock: form.actualStock,
        remark: form.remark
      })
      toast.success('盘点记录已创建')
      setModalType(null)
      refresh()
    } catch (e) { toast.error('操作失败') } finally { setIsSubmitting(false) }
  }

  const openDetail = (row: StocktakingRecord) => {
    setDetailRow(row)
    setModalType('detail')
  }

  const openAdjust = (row: StocktakingRecord) => {
    setDetailRow(row)
    setModalType('adjust')
  }

  const openDelete = (row: StocktakingRecord) => {
    setRecordToDelete(row)
    setDeleteConfirmOpen(true)
  }

  const handleDelete = async () => {
    if (!recordToDelete) return
    try {
      await request.delete(`/stocktaking/${recordToDelete.id}`)
      toast.success('盘点记录已撤销')
      setDeleteConfirmOpen(false)
      setRecordToDelete(null)
      refresh()
    } catch (e) {
      toast.error('撤销失败')
    }
  }

  const handleQuery = () => { setPage(1) }
  const handleReset = () => { setKeyword(''); setStatusFilter(''); setScopeFilter(''); setPage(1) }

  const selectedMaterial = materials.find(m => m.id === form.materialId)

  return {
    data, loading, page, pageSize, total, setPage, setPageSize, refresh,
    keyword, setKeyword, statusFilter, setStatusFilter, scopeFilter, setScopeFilter,
    modalType, setModalType,
    detailRow, setDetailRow,
    createStep, setCreateStep,
    isSubmitting, setIsSubmitting,
    deleteConfirmOpen, setDeleteConfirmOpen,
    recordToDelete, setRecordToDelete,
    materials, setMaterials,
    form, setForm,
    stats,
    handleQuery, handleReset,
    openCreate, openDetail, openAdjust, openDelete,
    handleSubmit, handleDelete,
    selectedMaterial,
  }
}
