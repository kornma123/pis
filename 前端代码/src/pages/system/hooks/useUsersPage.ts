import { useState, useEffect, useMemo } from 'react'
import request from '@/api/request'
import type { User } from '@/types'
import { toast } from 'sonner'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'

export interface FormData {
  username: string
  realName: string
  role: string // 主角色（兼容旧字段；= primaryRole）
  roles: string[] // 数据驱动 RBAC：多角色（鉴权按并集）
  primaryRole: string // 身份展示主角色
  department: string
  phone: string
  email: string
  status: 'active' | 'inactive'
}

// SoD 不相容组合（前端实时提示；后端权威校验）
export const SOD_PAIRS: Array<[string, string]> = [
  ['procurement', 'finance'],
  ['warehouse_manager', 'finance'],
  ['pathologist', 'technician'],
]
export function frontendSoDConflicts(roles: string[]): string[] {
  const set = new Set(roles)
  return SOD_PAIRS.filter(([a, b]) => set.has(a) && set.has(b)).map(([a, b]) => `${a}+${b}`)
}

export interface RoleItem {
  id: string
  name: string
  code: string
  userCount: number
  description: string
  permissions: string[]
  isSystem?: boolean
}

export function useUsersPage() {
  const { getNumber, setMultiple } = useUrlParams()

  const [keyword, setKeyword] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedRoleId, setSelectedRoleId] = useState('')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

  const {
    data, loading, page, pageSize, total,
    setPage, setPageSize, refresh,
  } = usePagination<User>({
    fetchFn: async ({ page, pageSize }) => {
      const params: any = { page, pageSize }
      if (keyword) params.keyword = keyword
      if (roleFilter) params.role = roleFilter
      if (statusFilter) params.status = statusFilter
      if (selectedRoleId) params.roleId = selectedRoleId
      const res: any = await request.get('/users', { params })
      return { list: res?.list || [], pagination: res?.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [keyword, roleFilter, statusFilter, selectedRoleId],
  })

  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
      role: roleFilter || null,
      status: statusFilter || null,
      roleId: selectedRoleId || null,
    })
  }, [page, pageSize, keyword, roleFilter, statusFilter, selectedRoleId, setMultiple])

  const [modalType, setModalType] = useState<'create' | 'edit' | 'detail' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailUser, setDetailUser] = useState<User | null>(null)
  const [form, setForm] = useState<FormData>({
    username: '', realName: '', role: 'operator', roles: [], primaryRole: '', department: '', phone: '', email: '', status: 'active'
  })

  const [roles, setRoles] = useState<RoleItem[]>([])

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

  const fetchRoles = async () => {
    try {
      const res: any = await request.get('/roles', { params: { page: 1, pageSize: 100 } })
      const list = res?.list || []
      setRoles(list.map((r: any) => ({
        id: r.id, name: r.name, code: r.code, userCount: 0,
        description: r.description || '', permissions: r.permissions || [],
        isSystem: r.code === 'admin'
      })))
    } catch (e) { console.error(e) }
  }

  useEffect(() => { fetchRoles() }, [])

  const stats = useMemo(() => {
    const totalUsers = total
    const activeUsers = data.filter(u => u.status === 'active').length
    const inactiveUsers = data.filter(u => u.status === 'inactive').length
    const adminUsers = data.filter(u => u.role === 'admin').length
    return { totalUsers, activeUsers, inactiveUsers, adminUsers }
  }, [data, total])

  const openCreate = () => {
    setEditingId(null)
    setForm({ username: '', realName: '', role: 'operator', roles: [], primaryRole: '', department: '', phone: '', email: '', status: 'active' })
    setModalType('create')
  }

  const openEdit = (row: User) => {
    setEditingId(row.id)
    const rowRoles = Array.isArray((row as any).roles) && (row as any).roles.length ? (row as any).roles : [row.role]
    setForm({
      username: row.username, realName: row.realName, role: row.role,
      roles: rowRoles, primaryRole: (row as any).primaryRole || row.role,
      department: row.department || '', phone: row.phone || '', email: row.email || '',
      status: row.status
    })
    setModalType('edit')
  }

  const openDetail = (row: User) => {
    setDetailUser(row)
    setModalType('detail')
  }

  const handleSubmit = async () => {
    if (!form.username.trim() || !form.realName.trim()) {
      toast.error('请填写必填字段')
      return
    }
    if (!form.roles || form.roles.length === 0) {
      toast.error('请至少分配一个角色')
      return
    }
    const primary = form.primaryRole && form.roles.includes(form.primaryRole) ? form.primaryRole : form.roles[0]
    const payload = { ...form, role: primary, primaryRole: primary }
    try {
      const res: any = editingId
        ? await request.put(`/users/${editingId}`, payload)
        : await request.post('/users', payload)
      const sod: string[] = res?.sodWarning || []
      if (sod.length > 0) {
        toast.warning(`已保存，但存在职责分离(SoD)提醒：${sod.join('、')}（建议复核或走豁免审批）`)
      } else {
        toast.success(editingId ? '保存成功' : '创建成功')
      }
      setModalType(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  const handleDelete = async (id: string) => {
    openConfirm({
      title: '确认删除',
      description: '确认删除该用户？删除后不可恢复。',
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          await request.delete(`/users/${id}`)
          toast.success('删除成功')
          refresh()
        } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
      },
    })
  }

  const handleToggleStatus = async (row: User) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    try {
      await request.put(`/users/${row.id}`, { status: newStatus })
      toast.success(newStatus === 'active' ? '已启用' : '已停用')
      refresh()
    } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
  }

  const handleResetPassword = async (id: string) => {
    openConfirm({
      title: '确认重置密码',
      description: '确认重置该用户密码？重置后用户需使用新密码登录。',
      confirmText: '重置',
      confirmVariant: 'primary',
      onConfirm: async () => {
        try {
          await request.post(`/users/${id}/reset-password`, {})
          toast.success('密码重置成功')
        } catch { /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */ }
      },
    })
  }

  const handleSearch = () => { setPage(1) }
  const handleReset = () => {
    setKeyword(''); setRoleFilter(''); setStatusFilter(''); setSelectedRoleId(''); setPage(1)
  }

  const getAvatarChar = (name: string) => name ? name.charAt(0) : '?'

  return {
    data, loading, page, pageSize, total, setPage, setPageSize, refresh,
    keyword, setKeyword, roleFilter, setRoleFilter, statusFilter, setStatusFilter,
    selectedRoleId, setSelectedRoleId,
    modalType, setModalType,
    editingId, setEditingId,
    detailUser, setDetailUser,
    form, setForm,
    roles, setRoles,
    confirmOpen, setConfirmOpen, confirmProps, setConfirmProps,
    stats,
    handleSearch, handleReset,
    openCreate, openEdit, openDetail,
    handleSubmit, handleDelete, handleToggleStatus, handleResetPassword,
    getAvatarChar,
  }
}
