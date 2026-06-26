import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { laborTimeApi } from '@/api/master'
import { usePagination } from '@/hooks/usePagination'
import { getUserPermissions, getUserRole } from '@/lib/permissions'
import type { StandardLaborTime } from '@/types'

export interface LaborTimeForm {
  stepCode: string
  stepName: string
  projectType: string
  standardMinutes: number
  laborRatePerMinute: number
  isEquipmentStep: boolean
  description: string
  sortOrder: number
  referenceSource: 'supplier' | 'industry' | 'system'
}

const defaultForm: LaborTimeForm = {
  stepCode: '',
  stepName: '',
  projectType: 'all',
  standardMinutes: 0,
  laborRatePerMinute: 0,
  isEquipmentStep: false,
  description: '',
  sortOrder: 0,
  referenceSource: 'system',
}

function buildCreatedLaborTimeRecord(
  payload: Partial<StandardLaborTime>,
  form: LaborTimeForm,
): StandardLaborTime | null {
  if (!payload.id || !payload.stepCode) return null

  return {
    id: payload.id,
    stepCode: payload.stepCode,
    stepName: payload.stepName || form.stepName,
    projectType: payload.projectType || form.projectType,
    standardMinutes: Number(payload.standardMinutes ?? form.standardMinutes),
    laborRatePerMinute: Number(payload.laborRatePerMinute ?? form.laborRatePerMinute),
    isEquipmentStep: Boolean(payload.isEquipmentStep ?? form.isEquipmentStep),
    description: payload.description ?? form.description,
    sortOrder: Number(payload.sortOrder ?? form.sortOrder),
    referenceSource: payload.referenceSource || form.referenceSource,
    referenceSourceLabel: payload.referenceSourceLabel,
    createdAt: payload.createdAt || new Date().toISOString(),
    updatedAt: payload.updatedAt || new Date().toISOString(),
  }
}

export const PROJECT_TYPE_OPTIONS = [
  { value: '', label: '全部项目类型' },
  { value: 'all', label: '通用' },
  { value: 'ihc', label: '免疫组化' },
  { value: 'he', label: 'HE染色' },
  { value: 'ss', label: '特殊染色' },
  { value: 'mp', label: '分子病理' },
  { value: 'cyto', label: '细胞病理' },
]

function canManageLaborTimeRecords() {
  const role = getUserRole()
  if (['admin', 'finance', 'technician'].includes(role || '')) {
    return true
  }
  const permissions = getUserPermissions()
  return permissions.includes('*')
    || permissions.includes('labor_times')
    || permissions.some(permission => ['labor_times:add', 'labor_times:edit', 'labor_times:delete'].includes(permission))
}

export function useLaborTimePage() {
  const canManageLaborTimes = canManageLaborTimeRecords()
  const initialKeyword = new URLSearchParams(window.location.search).get('keyword') || ''
  const [searchInput, setSearchInput] = useState(initialKeyword)
  const [keyword, setKeyword] = useState(initialKeyword)
  const [filterProjectType, setFilterProjectType] = useState('')
  const [filterReferenceSource, setFilterReferenceSource] = useState('')
  const [modalType, setModalType] = useState<'create' | 'edit' | 'detail' | 'delete' | null>(null)
  const [detailRow, setDetailRow] = useState<StandardLaborTime | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<LaborTimeForm>(defaultForm)
  const [stats, setStats] = useState({ total: 0, totalMinutes: 0, avgRate: 0, equipmentSteps: 0 })
  const [createdLaborTimeFallback, setCreatedLaborTimeFallback] = useState<StandardLaborTime | null>(null)
  const [deletedLaborTimeIds, setDeletedLaborTimeIds] = useState<Set<string>>(new Set())

  const { data, loading, page, pageSize, total, setPage, setPageSize, refresh } = usePagination<StandardLaborTime>({
    fetchFn: async (params) => {
      const res = await laborTimeApi.getList({
        ...params,
        keyword: keyword || undefined,
        projectType: filterProjectType || undefined,
        referenceSource: filterReferenceSource || undefined,
      })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    initialPage: 1,
    initialPageSize: 20,
    deps: [keyword, filterProjectType, filterReferenceSource],
  })

  const displayedPage = useMemo(() => {
    const filteredData = deletedLaborTimeIds.size
      ? data.filter(row => !deletedLaborTimeIds.has(row.id))
      : data
    let nextTotal = Math.max(0, total - (data.length - filteredData.length))

    if (
      createdLaborTimeFallback &&
      !deletedLaborTimeIds.has(createdLaborTimeFallback.id) &&
      keyword === createdLaborTimeFallback.stepCode &&
      !filterProjectType &&
      !filterReferenceSource &&
      page === 1 &&
      !filteredData.some(row => row.id === createdLaborTimeFallback.id || row.stepCode === createdLaborTimeFallback.stepCode)
    ) {
      const rows = [createdLaborTimeFallback, ...filteredData]
      return { data: rows, total: Math.max(nextTotal + 1, rows.length) }
    }

    return { data: filteredData, total: nextTotal }
  }, [createdLaborTimeFallback, data, deletedLaborTimeIds, filterProjectType, filterReferenceSource, keyword, page, total])

  useEffect(() => {
    laborTimeApi.getStats({
      keyword: keyword || undefined,
      projectType: filterProjectType || undefined,
      referenceSource: filterReferenceSource || undefined,
    })
      .then((res: any) => setStats({
        total: Number(res?.total || 0),
        totalMinutes: Number(res?.totalMinutes || 0),
        avgRate: Number(res?.avgRate || 0),
        equipmentSteps: Number(res?.equipmentSteps || 0),
      }))
      .catch(() => setStats({ total, totalMinutes: 0, avgRate: 0, equipmentSteps: 0 }))
  }, [keyword, filterProjectType, filterReferenceSource, total])

  const handleSearch = useCallback(() => {
    setKeyword(searchInput)
    setPage(1)
  }, [searchInput, setPage])

  const handleReset = useCallback(() => {
    setSearchInput('')
    setKeyword('')
    setFilterProjectType('')
    setFilterReferenceSource('')
    setPage(1)
  }, [setPage])

  const handleProjectTypeChange = useCallback((value: string) => {
    setFilterProjectType(value)
    setPage(1)
  }, [setPage])

  const handleReferenceSourceChange = useCallback((value: string) => {
    setFilterReferenceSource(value)
    setPage(1)
  }, [setPage])

  const focusLaborTimeList = useCallback((value: string) => {
    const nextKeyword = value.trim()
    setSearchInput(nextKeyword)
    setKeyword(nextKeyword)
    setFilterProjectType('')
    setFilterReferenceSource('')
    setPage(1)
  }, [setPage])

  const openCreate = () => {
    setForm(defaultForm)
    setEditingId(null)
    setDetailRow(null)
    setModalType('create')
  }

  const openEdit = (row: StandardLaborTime) => {
    setForm({
      stepCode: row.stepCode || '',
      stepName: row.stepName || '',
      projectType: row.projectType || 'all',
      standardMinutes: row.standardMinutes || 0,
      laborRatePerMinute: row.laborRatePerMinute || 0,
      isEquipmentStep: !!row.isEquipmentStep,
      description: row.description || '',
      sortOrder: row.sortOrder || 0,
      referenceSource: row.referenceSource || 'system',
    })
    setEditingId(row.id)
    setDetailRow(row)
    setModalType('edit')
  }

  const openDetail = (row: StandardLaborTime) => {
    setDetailRow(row)
    setEditingId(null)
    setModalType('detail')
  }

  const openDelete = (row: StandardLaborTime) => {
    setDetailRow(row)
    setModalType('delete')
  }

  const handleSubmit = async () => {
    if (!form.stepCode.trim() || !form.stepName.trim()) {
      toast.error('请填写步骤编号和步骤名称')
      return
    }
    if (!Number.isFinite(form.standardMinutes) || form.standardMinutes <= 0) {
      toast.error('标准时长必须大于0')
      return
    }
    if (!Number.isFinite(form.laborRatePerMinute) || form.laborRatePerMinute < 0) {
      toast.error('费率不能为负数')
      return
    }
    if (!Number.isFinite(form.sortOrder) || form.sortOrder < 0) {
      toast.error('排序必须大于等于0')
      return
    }
    try {
      if (modalType === 'edit' && editingId) {
        const current = data.find(item => item.id === editingId)
        await laborTimeApi.update(editingId, {
          ...form,
          stepCode: current?.stepCode || form.stepCode,
          projectType: current?.projectType || form.projectType,
        })
        toast.success('工时定义已更新')
      } else {
        const created = await laborTimeApi.create(form)
        const createdKeyword = created?.stepCode || form.stepCode || form.stepName
        setCreatedLaborTimeFallback(buildCreatedLaborTimeRecord(created, form))
        focusLaborTimeList(createdKeyword)
        toast.success('工时定义已创建')
      }
      setModalType(null)
      refresh()
    } catch {
      toast.error('保存工时定义失败')
    }
  }

  const handleDelete = async () => {
    if (!detailRow) return
    try {
      await laborTimeApi.delete(detailRow.id)
      setDeletedLaborTimeIds(prev => {
        const next = new Set(prev)
        next.add(detailRow.id)
        return next
      })
      toast.success('工时定义已归档')
      setModalType(null)
      refresh()
    } catch {
      toast.error('归档工时定义失败')
    }
  }

  return {
    canManageLaborTimes,
    data: displayedPage.data,
    loading,
    page,
    pageSize,
    total: displayedPage.total,
    setPage,
    setPageSize,
    stats,
    searchInput,
    setSearchInput,
    filterProjectType,
    setFilterProjectType,
    filterReferenceSource,
    setFilterReferenceSource,
    handleProjectTypeChange,
    handleReferenceSourceChange,
    modalType,
    setModalType,
    form,
    setForm,
    detailRow,
    PROJECT_TYPE_OPTIONS,
    handleSearch,
    handleReset,
    openCreate,
    openDetail,
    openEdit,
    openDelete,
    handleSubmit,
    handleDelete,
  }
}
