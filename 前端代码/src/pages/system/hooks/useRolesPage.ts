import { useState, useEffect, useMemo } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import request from '@/api/request'
import type { Role } from '@/types'
import { toast } from 'sonner'

export interface FormData {
  code: string
  name: string
  description: string
  permissions: string[]
  status: 'active' | 'inactive'
  dataScope?: 'all' | 'dept' | 'self'
}

export interface PermissionModule {
  key: string
  label: string
  actions: ('view' | 'add' | 'edit' | 'delete')[]
}

export const PERMISSION_MODULES: PermissionModule[] = [
  { key: 'inventory', label: '库存管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'inbound', label: '入库管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'outbound', label: '出库管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'stocktaking', label: '盘点管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'scrap', label: '报废管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'project', label: '检测服务', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'bom', label: 'BOM管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'cost', label: '成本分析', actions: ['view'] },
  { key: 'alert', label: '预警管理', actions: ['view'] },
  { key: 'category', label: '物料分类', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'consumable', label: '耗材配置', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'rule', label: '规则配置', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'supplier', label: '供应商管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'location', label: '库位管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'user', label: '用户管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'role', label: '角色管理', actions: ['view', 'add', 'edit', 'delete'] },
  { key: 'log', label: '操作日志', actions: ['view'] },
]

export const DATA_SCOPE_OPTIONS = [
  { value: 'all' as const, label: '全部数据', desc: '可查看所有部门数据' },
  { value: 'dept' as const, label: '本部门数据', desc: '仅查看所属部门数据' },
  { value: 'self' as const, label: '仅本人数据', desc: '仅查看自己操作的数据' },
]

export function useRolesPage() {
  const { get, getNumber, setMultiple } = useUrlParams()

  const [keyword, setKeyword] = useState('')
  const [tabType, setTabType] = useState<'all' | 'system' | 'custom'>('all')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<Role>({
    fetchFn: async ({ page, pageSize }) => {
      const res: any = await request.get('/roles', { params: { page, pageSize } })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [],
  })

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
      tab: tabType !== 'all' ? tabType : null,
    })
  }, [page, pageSize, keyword, tabType, setMultiple])

  const [modalType, setModalType] = useState<'create' | 'edit' | 'detail' | 'delete' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailRole, setDetailRole] = useState<Role | null>(null)
  const [deleteRole, setDeleteRole] = useState<Role | null>(null)

  const [form, setForm] = useState<FormData>({
    code: '', name: '', description: '', permissions: [], status: 'active', dataScope: 'dept'
  })

  const stats = useMemo(() => {
    const totalRoles = data.length
    const systemRoles = data.filter(r => r.code === 'admin').length
    const customRoles = totalRoles - systemRoles
    const assignedUsers = data.reduce((sum, r) => sum + (r as any).userCount || 0, 0)
    return { totalRoles, systemRoles, customRoles, assignedUsers }
  }, [data])

  const filteredData = useMemo(() => {
    let list = [...data]
    if (tabType === 'system') list = list.filter(r => r.code === 'admin')
    if (tabType === 'custom') list = list.filter(r => r.code !== 'admin')
    if (keyword.trim()) {
      const kw = keyword.toLowerCase()
      list = list.filter(r => r.name.toLowerCase().includes(kw) || r.code.toLowerCase().includes(kw))
    }
    return list
  }, [data, tabType, keyword])

  const openCreate = () => {
    setEditingId(null)
    setForm({ code: `ROLE-${Date.now()}`, name: '', description: '', permissions: [], status: 'active', dataScope: 'dept' })
    setModalType('create')
  }

  const openEdit = (row: Role) => {
    setEditingId(row.id)
    setForm({
      code: row.code,
      name: row.name,
      description: row.description || '',
      permissions: row.permissions || [],
      status: row.status,
      dataScope: 'dept'
    })
    setModalType('edit')
  }

  const openDetail = (row: Role) => {
    setDetailRole(row)
    setModalType('detail')
  }

  const openDelete = (row: Role) => {
    setDeleteRole(row)
    setModalType('delete')
  }

  const togglePermission = (moduleKey: string, action: string) => {
    const permKey = `${moduleKey}:${action}`
    setForm(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permKey)
        ? prev.permissions.filter(p => p !== permKey)
        : [...prev.permissions, permKey]
    }))
  }

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('请填写必填字段')
      return
    }
    try {
      if (editingId) {
        await request.put(`/roles/${editingId}`, form)
      } else {
        await request.post('/roles', form)
      }
      toast.success(editingId ? '保存成功' : '创建成功')
      setModalType(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleDelete = async () => {
    if (!deleteRole) return
    try {
      await request.delete(`/roles/${deleteRole.id}`)
      toast.success('删除成功')
      setModalType(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const getDataScopeLabel = (role: Role) => {
    if (role.code === 'admin') return '全部数据'
    return '本部门数据'
  }

  return {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
    keyword,
    setKeyword,
    tabType,
    setTabType,
    modalType,
    setModalType,
    editingId,
    setEditingId,
    detailRole,
    setDetailRole,
    deleteRole,
    setDeleteRole,
    form,
    setForm,
    stats,
    filteredData,
    openCreate,
    openEdit,
    openDetail,
    openDelete,
    togglePermission,
    handleSubmit,
    handleDelete,
    getDataScopeLabel,
  }
}
