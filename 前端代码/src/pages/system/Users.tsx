import { useState, useEffect, useMemo } from 'react'
import { Search, Plus, X } from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import request from '@/api/request'
import type { User } from '@/types'
import { toast } from 'sonner'

interface FormData {
  username: string
  realName: string
  role: string
  department: string
  phone: string
  email: string
  status: 'active' | 'inactive'
}

interface RoleItem {
  id: string
  name: string
  code: string
  userCount: number
  description: string
  permissions: string[]
  isSystem?: boolean
}

export default function Users() {
  const { get, getNumber, setMultiple } = useUrlParams()

  const [keyword, setKeyword] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedRoleId, setSelectedRoleId] = useState('')

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
    username: '', realName: '', role: 'operator', department: '', phone: '', email: '', status: 'active'
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
        id: r.id,
        name: r.name,
        code: r.code,
        userCount: 0,
        description: r.description || '',
        permissions: r.permissions || [],
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
    setForm({ username: '', realName: '', role: 'operator', department: '', phone: '', email: '', status: 'active' })
    setModalType('create')
  }

  const openEdit = (row: User) => {
    setEditingId(row.id)
    setForm({
      username: row.username,
      realName: row.realName,
      role: row.role,
      department: row.department || '',
      phone: row.phone || '',
      email: row.email || '',
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
    try {
      if (editingId) {
        await request.put(`/users/${editingId}`, form)
      } else {
        await request.post('/users', form)
      }
      toast.success(editingId ? '保存成功' : '创建成功')
      setModalType(null)
      refresh()
    } catch (e) {
      toast.error('操作失败')
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
        } catch (e) {
          toast.error('删除失败')
        }
      },
    })
  }

  const handleToggleStatus = async (row: User) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    try {
      await request.put(`/users/${row.id}`, { status: newStatus })
      toast.success(newStatus === 'active' ? '已启用' : '已停用')
      refresh()
    } catch (e) {
      toast.error('操作失败')
    }
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
        } catch (e) {
          toast.error('密码重置失败')
        }
      },
    })
  }

  const handleSearch = () => { setPage(1) }
  const handleReset = () => {
    setKeyword('')
    setRoleFilter('')
    setStatusFilter('')
    setSelectedRoleId('')
    setPage(1)
  }

  const getAvatarChar = (name: string) => name ? name.charAt(0) : '?'

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-[#111827] tracking-tight leading-tight">用户管理</h1>
          <p className="text-sm text-[#6b7280] mt-1">管理系统用户、角色和权限分配</p>
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#3b82f6] text-white rounded-md hover:bg-[#2563eb] text-sm font-medium shadow-sm transition-all">
          <Plus className="w-4 h-4" /> 新建用户
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#111827] leading-tight tracking-tight">{stats.totalUsers}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">用户总数</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#22c55e] leading-tight tracking-tight">{stats.activeUsers}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">启用用户</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#6b7280] leading-tight tracking-tight">{stats.inactiveUsers}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">停用用户</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#3b82f6] leading-tight tracking-tight">{stats.adminUsers}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">管理员</div>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-[300px_1fr] gap-5">
        {/* Role List */}
        <div className="bg-white rounded-lg shadow-sm border border-[#e5e7eb] overflow-hidden h-fit">
          <div className="px-5 py-4 border-b border-[#e5e7eb] bg-[#f9fafb]">
            <span className="text-base font-semibold text-[#111827]">角色列表</span>
          </div>
          <div className="p-4 flex flex-col gap-3">
            {roles.map(role => (
              <div
                key={role.id}
                onClick={() => setSelectedRoleId(role.id === selectedRoleId ? '' : role.id)}
                className={`p-4 rounded-lg border cursor-pointer transition-all ${selectedRoleId === role.id ? 'border-[#3b82f6] bg-[#eff6ff]' : 'border-[#e5e7eb] bg-white hover:border-[#d1d5db]'}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[#111827]">{role.name}</span>
                    {role.isSystem && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#eff6ff] text-[#3b82f6] font-medium">系统角色</span>
                    )}
                  </div>
                  <span className="text-xs text-[#6b7280]">{role.userCount} 人</span>
                </div>
                <div className="text-xs text-[#6b7280] mb-2 line-clamp-1">{role.description || '-'}</div>
                <div className="flex flex-wrap gap-1">
                  {role.permissions.slice(0, 3).map(p => (
                    <span key={p} className="text-[11px] px-2 py-0.5 rounded-full bg-[#f3f4f6] text-[#374151]">{p}</span>
                  ))}
                  {role.permissions.length > 3 && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#f3f4f6] text-[#374151]">+{role.permissions.length - 3}</span>
                  )}
                </div>
              </div>
            ))}
            {roles.length === 0 && (
              <div className="text-center text-sm text-[#9ca3af] py-8">暂无角色数据</div>
            )}
          </div>
        </div>

        {/* User Table */}
        <div className="bg-white rounded-lg shadow-sm border border-[#e5e7eb] overflow-hidden">
          <div className="px-5 py-4 border-b border-[#e5e7eb] bg-[#f9fafb] flex items-center justify-between flex-wrap gap-3">
            <span className="text-base font-semibold text-[#111827]">用户列表</span>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative w-[280px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9ca3af]" />
                <input
                  type="text"
                  placeholder="搜索用户名、姓名..."
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  className="w-full h-10 pl-10 pr-4 text-sm text-[#111827] bg-white border border-[#e5e7eb] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
                />
              </div>
              <select
                value={roleFilter}
                onChange={e => setRoleFilter(e.target.value)}
                className="h-10 px-3 pr-8 text-sm text-[#111827] bg-white border border-[#e5e7eb] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] appearance-none cursor-pointer"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
              >
                <option value="">全部角色</option>
                {roles.map(r => <option key={r.id} value={r.code}>{r.name}</option>)}
              </select>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="h-10 px-3 pr-8 text-sm text-[#111827] bg-white border border-[#e5e7eb] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] appearance-none cursor-pointer"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
              >
                <option value="">全部状态</option>
                <option value="active">正常</option>
                <option value="inactive">禁用</option>
              </select>
              <button onClick={handleSearch} className="h-10 px-4 text-sm font-medium text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">查询</button>
              <button onClick={handleReset} className="h-10 px-4 text-sm font-medium text-[#374151] bg-transparent hover:bg-[#f3f4f6] rounded-md transition-all">重置</button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-[#f9fafb] border-b border-[#e5e7eb]">
                  <th className="px-4 py-3 text-left">
                    <input type="checkbox" className="rounded border-[#d1d5db] text-[#3b82f6] focus:ring-[#3b82f6]" />
                  </th>
                  {['用户名', '姓名', '部门', '角色', '状态', '最后登录', '操作'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-[#374151] tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb]">
                {loading ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-[#9ca3af]">加载中...</td></tr>
                ) : data.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-[#9ca3af]">暂无数据</td></tr>
                ) : data.map(row => (
                  <tr key={row.id} className="hover:bg-[#f9fafb] transition-colors">
                    <td className="px-4 py-3.5">
                      <input type="checkbox" className="rounded border-[#d1d5db] text-[#3b82f6] focus:ring-[#3b82f6]" />
                    </td>
                    <td className="px-4 py-3.5 font-medium text-[#111827]">{row.username}</td>
                    <td className="px-4 py-3.5 text-[#111827]">{row.realName}</td>
                    <td className="px-4 py-3.5 text-[#374151]">{row.department || '-'}</td>
                    <td className="px-4 py-3.5 text-[#374151]">{row.role}</td>
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${row.status === 'active' ? 'bg-[#f0fdf4] text-[#22c55e]' : 'bg-[#f3f4f6] text-[#6b7280]'}`}>
                        {row.status === 'active' ? '正常' : '禁用'}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-[#6b7280] text-sm">-</td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openDetail(row)} className="h-8 px-3 text-[13px] text-[#374151] hover:bg-[#f3f4f6] rounded-md transition-colors">详情</button>
                        <button onClick={() => openEdit(row)} className="h-8 px-3 text-[13px] text-[#374151] hover:bg-[#f3f4f6] rounded-md transition-colors">编辑</button>
                        <button onClick={() => handleToggleStatus(row)} className="h-8 px-3 text-[13px] text-[#374151] hover:bg-[#f3f4f6] rounded-md transition-colors">
                          {row.status === 'active' ? '停用' : '启用'}
                        </button>
                        <button onClick={() => handleResetPassword(row.id)} className="h-8 px-3 text-[13px] text-[#374151] hover:bg-[#f3f4f6] rounded-md transition-colors">重置密码</button>
                        <button onClick={() => handleDelete(row.id)} className="h-8 px-3 text-[13px] text-[#ef4444] hover:bg-[#fef2f2] rounded-md transition-colors">删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between px-5 py-4 border-t border-[#e5e7eb] bg-[#f9fafb]">
            <span className="text-sm text-[#6b7280]">共 {total} 条记录</span>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onChangePage={setPage}
              onChangePageSize={setPageSize}
            />
          </div>
        </div>
      </div>

      {/* ConfirmDialog */}
      {confirmOpen && confirmProps && (
        <ConfirmDialog
          open={confirmOpen}
          title={confirmProps.title}
          description={confirmProps.description}
          confirmText={confirmProps.confirmText}
          confirmVariant={confirmProps.confirmVariant}
          onConfirm={() => {
            setConfirmOpen(false)
            confirmProps.onConfirm()
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {/* Create / Edit Modal */}
      {(modalType === 'create' || modalType === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.6)]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#e5e7eb]">
              <h3 className="text-lg font-semibold text-[#111827]">{modalType === 'create' ? '新建用户' : '编辑用户'}</h3>
              <button onClick={() => setModalType(null)} className="w-9 h-9 flex items-center justify-center text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827] rounded-md transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="flex gap-5 mb-5">
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">用户名 {modalType === 'create' && <span className="text-[#ef4444]">*</span>}</label>
                  <input
                    value={form.username}
                    onChange={e => setForm({ ...form, username: e.target.value })}
                    readOnly={modalType === 'edit'}
                    className={`w-full h-10 px-3 text-sm text-[#111827] border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] ${modalType === 'edit' ? 'bg-[#f9fafb] text-[#9ca3af]' : 'bg-white'}`}
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">姓名 <span className="text-[#ef4444]">*</span></label>
                  <input
                    value={form.realName}
                    onChange={e => setForm({ ...form, realName: e.target.value })}
                    className="w-full h-10 px-3 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
                  />
                </div>
              </div>
              <div className="flex gap-5 mb-5">
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">角色 <span className="text-[#ef4444]">*</span></label>
                  <select
                    value={form.role}
                    onChange={e => setForm({ ...form, role: e.target.value })}
                    className="w-full h-10 px-3 pr-8 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] appearance-none cursor-pointer"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
                  >
                    <option value="admin">系统管理员</option>
                    <option value="operator">操作员</option>
                    <option value="viewer">查看者</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">部门 <span className="text-[#ef4444]">*</span></label>
                  <select
                    value={form.department}
                    onChange={e => setForm({ ...form, department: e.target.value })}
                    className="w-full h-10 px-3 pr-8 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] appearance-none cursor-pointer"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
                  >
                    <option value="">请选择部门</option>
                    <option value="病理科">病理科</option>
                    <option value="检验科">检验科</option>
                    <option value="信息科">信息科</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-5 mb-5">
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">联系电话</label>
                  <input
                    value={form.phone}
                    onChange={e => setForm({ ...form, phone: e.target.value })}
                    className="w-full h-10 px-3 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">电子邮箱</label>
                  <input
                    value={form.email}
                    onChange={e => setForm({ ...form, email: e.target.value })}
                    className="w-full h-10 px-3 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
                  />
                </div>
              </div>
              {modalType === 'edit' && (
                <div className="mb-5">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">状态</label>
                  <select
                    value={form.status}
                    onChange={e => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
                    className="w-full h-10 px-3 pr-8 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] appearance-none cursor-pointer"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
                  >
                    <option value="active">正常</option>
                    <option value="inactive">禁用</option>
                  </select>
                </div>
              )}
              {modalType === 'create' && (
                <div>
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">初始密码 <span className="text-[#ef4444]">*</span></label>
                  <div className="flex gap-2">
                    <input value="Abc@123456" readOnly className="flex-1 h-10 px-3 text-sm text-[#111827] bg-[#f9fafb] border border-[#d1d5db] rounded-md outline-none" />
                    <button className="h-10 px-4 text-sm font-medium text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">随机生成</button>
                  </div>
                  <div className="text-xs text-[#6b7280] mt-1">初始密码将在用户首次登录时要求修改</div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#e5e7eb] bg-[#f9fafb]">
              <button onClick={() => setModalType(null)} className="h-10 px-4 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">取消</button>
              {modalType === 'edit' && (
                <button onClick={() => editingId && handleResetPassword(editingId)} className="h-10 px-4 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">重置密码</button>
              )}
              <button onClick={handleSubmit} className="h-10 px-4 text-sm font-medium text-white bg-[#3b82f6] rounded-md hover:bg-[#2563eb] shadow-sm transition-all">
                {modalType === 'create' ? '创建用户' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {modalType === 'detail' && detailUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.6)]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#e5e7eb]">
              <h3 className="text-lg font-semibold text-[#111827]">用户详情</h3>
              <button onClick={() => setModalType(null)} className="w-9 h-9 flex items-center justify-center text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827] rounded-md transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-[60px] h-[60px] bg-[#eff6ff] rounded-full flex items-center justify-center text-[#3b82f6] font-semibold text-xl">
                  {getAvatarChar(detailUser.realName)}
                </div>
                <div className="flex-1">
                  <div className="text-lg font-semibold text-[#111827]">{detailUser.realName}</div>
                  <div className="text-[13px] text-[#6b7280]">用户名: {detailUser.username}</div>
                </div>
                <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${detailUser.status === 'active' ? 'bg-[#f0fdf4] text-[#22c55e]' : 'bg-[#f3f4f6] text-[#6b7280]'}`}>
                  {detailUser.status === 'active' ? '正常' : '禁用'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-5">
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">角色</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{detailUser.role}</div>
                </div>
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">部门</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{detailUser.department || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">联系电话</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{detailUser.phone || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">电子邮箱</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{detailUser.email || '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">创建时间</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{detailUser.createdAt ? new Date(detailUser.createdAt).toLocaleString() : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">最后登录</div>
                  <div className="text-[15px] font-semibold text-[#111827]">-</div>
                </div>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-[#111827]">权限列表</h4>
                  <span className="text-xs text-[#6b7280]">数据范围: 本部门数据</span>
                </div>
                {detailUser.permissions && detailUser.permissions.length > 0 ? (
                  <div className="border border-[#e5e7eb] rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 bg-[#f9fafb] border-b border-[#e5e7eb]">
                      <span className="text-sm font-medium text-[#111827]">系统权限</span>
                      <span className="text-xs text-[#6b7280]">{detailUser.permissions.length} 项权限</span>
                    </div>
                    <div className="p-4">
                      <div className="flex flex-wrap gap-2">
                        {detailUser.permissions.map(p => (
                          <span key={p} className="text-xs px-2.5 py-1 rounded-full bg-[#f0fdf4] text-[#22c55e] font-medium">已授权: {p}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[#6b7280] py-4">暂无权限信息</div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#e5e7eb] bg-[#f9fafb]">
              <button onClick={() => setModalType(null)} className="h-10 px-4 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">关闭</button>
              <button onClick={() => { setModalType(null); openEdit(detailUser); }} className="h-10 px-4 text-sm font-medium text-white bg-[#3b82f6] rounded-md hover:bg-[#2563eb] shadow-sm transition-all">编辑</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
