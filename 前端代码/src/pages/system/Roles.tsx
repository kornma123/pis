import { useState, useEffect, useMemo } from 'react'
import { Plus, X, Users, Shield, Database } from 'lucide-react'
import request from '@/api/request'
import type { Role } from '@/types'
import { toast } from 'sonner'

interface FormData {
  code: string
  name: string
  description: string
  permissions: string[]
  status: 'active' | 'inactive'
  dataScope?: 'all' | 'dept' | 'self'
}

interface PermissionModule {
  key: string
  label: string
  actions: ('view' | 'add' | 'edit' | 'delete')[]
}

const PERMISSION_MODULES: PermissionModule[] = [
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

const DATA_SCOPE_OPTIONS = [
  { value: 'all' as const, label: '全部数据', desc: '可查看所有部门数据' },
  { value: 'dept' as const, label: '本部门数据', desc: '仅查看所属部门数据' },
  { value: 'self' as const, label: '仅本人数据', desc: '仅查看自己操作的数据' },
]

export default function Roles() {
  const [data, setData] = useState<Role[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [tabType, setTabType] = useState<'all' | 'system' | 'custom'>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20

  const [modalType, setModalType] = useState<'create' | 'edit' | 'detail' | 'delete' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailRole, setDetailRole] = useState<Role | null>(null)
  const [deleteRole, setDeleteRole] = useState<Role | null>(null)

  const [form, setForm] = useState<FormData>({
    code: '', name: '', description: '', permissions: [], status: 'active', dataScope: 'dept'
  })

  const fetchData = async () => {
    setLoading(true)
    try {
      const res: any = await request.get('/roles', { params: { page, pageSize } })
      setData(res?.list || [])
      setTotal(res?.pagination?.total || 0)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => { fetchData() }, [page])

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
    setForm({ code: '', name: '', description: '', permissions: [], status: 'active', dataScope: 'dept' })
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
      fetchData()
    } catch (e) {
      toast.error('操作失败')
    }
  }

  const handleDelete = async () => {
    if (!deleteRole) return
    try {
      await request.delete(`/roles/${deleteRole.id}`)
      toast.success('删除成功')
      setModalType(null)
      fetchData()
    } catch (e) {
      toast.error('删除失败')
    }
  }

  const getDataScopeLabel = (role: Role) => {
    if (role.code === 'admin') return '全部数据'
    return '本部门数据'
  }

  const getRoleBadge = (role: Role) => {
    if (role.code === 'admin') {
      return <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#eff6ff] text-[#3b82f6] font-medium">系统角色</span>
    }
    return <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#f3f4f6] text-[#374151] font-medium">自定义</span>
  }

  const getPermissionChips = (role: Role) => {
    if (role.code === 'admin') return [<span key="all" className="text-xs px-2.5 py-1 rounded-full bg-[#f0fdf4] text-[#22c55e] font-medium">全部权限</span>]
    const perms = role.permissions || []
    const chips: string[] = []
    const uniqueModules = new Set<string>()
    perms.forEach(p => {
      const mod = p.split(':')[0]
      if (mod) uniqueModules.add(mod)
    })
    uniqueModules.forEach(mod => {
      const found = PERMISSION_MODULES.find(m => m.key === mod)
      if (found) chips.push(found.label)
    })
    return chips.slice(0, 4).map((c, i) => (
      <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-[#f3f4f6] text-[#374151] font-medium">{c}</span>
    ))
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-[#111827] tracking-tight leading-tight">角色管理</h1>
          <p className="text-sm text-[#6b7280] mt-1">管理系统角色和权限配置</p>
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#3b82f6] text-white rounded-md hover:bg-[#2563eb] text-sm font-medium shadow-sm transition-all">
          <Plus className="w-4 h-4" /> 新建角色
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#111827] leading-tight tracking-tight">{stats.totalRoles}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">角色总数</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#3b82f6] leading-tight tracking-tight">{stats.systemRoles}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">系统角色</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#6b7280] leading-tight tracking-tight">{stats.customRoles}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">自定义角色</div>
        </div>
        <div className="bg-white p-5 rounded-lg shadow-sm border border-[#e5e7eb] transition-all hover:shadow-md hover:-translate-y-0.5">
          <div className="text-[28px] font-semibold text-[#22c55e] leading-tight tracking-tight">{stats.assignedUsers}</div>
          <div className="text-[13px] text-[#6b7280] mt-1">已分配用户</div>
        </div>
      </div>

      {/* Role Cards */}
      <div className="bg-white rounded-lg shadow-sm border border-[#e5e7eb] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#e5e7eb] bg-[#f9fafb] flex items-center justify-between flex-wrap gap-3">
          <span className="text-base font-semibold text-[#111827]">角色列表</span>
          <div className="relative w-[280px]">
            <SearchIcon />
            <input
              type="text"
              placeholder="搜索角色名称..."
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              className="w-full h-10 pl-10 pr-4 text-sm text-[#111827] bg-white border border-[#e5e7eb] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
            />
          </div>
        </div>
        <div className="p-5">
          {/* Tabs */}
          <div className="flex gap-1 border-b border-[#e5e7eb] mb-5">
            {[
              { key: 'all' as const, label: '全部角色' },
              { key: 'system' as const, label: '系统角色' },
              { key: 'custom' as const, label: '自定义角色' },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setTabType(t.key)}
                className={`px-5 py-3 text-sm font-medium border-b-2 transition-all ${tabType === t.key ? 'text-[#3b82f6] border-[#3b82f6]' : 'text-[#6b7280] border-transparent hover:text-[#111827] hover:bg-[#f9fafb]'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="text-center py-12 text-[#9ca3af]">加载中...</div>
          ) : filteredData.length === 0 ? (
            <div className="text-center py-12 text-[#9ca3af]">暂无数据</div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
              {filteredData.map(row => (
                <div key={row.id} className="bg-white border border-[#e5e7eb] rounded-lg p-5 transition-all hover:shadow-md hover:border-[#d1d5db]">
                  <div className="mb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-base font-semibold text-[#111827]">{row.name}</span>
                      {getRoleBadge(row)}
                    </div>
                    <div className="text-sm text-[#6b7280]">{row.description || '-'}</div>
                  </div>
                  <div className="flex items-center gap-4 mb-3">
                    <div className="flex items-center gap-1.5 text-sm text-[#6b7280]">
                      <Users className="w-3.5 h-3.5" />
                      {(row as any).userCount || 0} 人
                    </div>
                    <div className="flex items-center gap-1.5 text-sm text-[#6b7280]">
                      <Database className="w-3.5 h-3.5" />
                      {getDataScopeLabel(row)}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-4 min-h-[28px]">
                    {getPermissionChips(row)}
                  </div>
                  <div className="flex items-center gap-2 pt-3 border-t border-[#e5e7eb]">
                    <button onClick={() => openDetail(row)} className="h-8 px-3 text-[13px] text-[#374151] hover:bg-[#f3f4f6] rounded-md transition-colors">查看详情</button>
                    {row.code !== 'admin' && (
                      <>
                        <button onClick={() => openEdit(row)} className="h-8 px-3 text-[13px] text-[#374151] hover:bg-[#f3f4f6] rounded-md transition-colors">编辑</button>
                        <button onClick={() => openDelete(row)} className="h-8 px-3 text-[13px] text-[#ef4444] hover:bg-[#fef2f2] rounded-md transition-colors">删除</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-[#e5e7eb] bg-[#f9fafb]">
            <span className="text-sm text-[#6b7280]">共 {total} 条记录</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="h-8 px-3 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] disabled:opacity-30 transition-all">上一页</button>
              <span className="text-sm text-[#374151] px-3">{page} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="h-8 px-3 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] disabled:opacity-30 transition-all">下一页</button>
            </div>
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {(modalType === 'create' || modalType === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.6)]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#e5e7eb]">
              <h3 className="text-lg font-semibold text-[#111827]">{modalType === 'create' ? '新建角色' : '编辑角色'}</h3>
              <button onClick={() => setModalType(null)} className="w-9 h-9 flex items-center justify-center text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827] rounded-md transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="flex gap-5 mb-5">
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">角色名称 <span className="text-[#ef4444]">*</span></label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    placeholder="请输入角色名称"
                    className="w-full h-10 px-3 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-[13px] font-medium text-[#374151] mb-1.5">角色标识</label>
                  <input
                    value={form.code}
                    onChange={e => setForm({ ...form, code: e.target.value })}
                    placeholder={modalType === 'create' ? '系统自动生成' : ''}
                    readOnly={modalType === 'edit'}
                    className={`w-full h-10 px-3 text-sm text-[#111827] border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] ${modalType === 'edit' ? 'bg-[#f9fafb] text-[#9ca3af]' : 'bg-white'}`}
                  />
                </div>
              </div>
              <div className="mb-5">
                <label className="block text-[13px] font-medium text-[#374151] mb-1.5">角色描述</label>
                <input
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  placeholder="请输入角色描述"
                  className="w-full h-10 px-3 text-sm text-[#111827] bg-white border border-[#d1d5db] rounded-md outline-none transition-all focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
                />
              </div>

              <div className="mb-5">
                <label className="block text-[13px] font-medium text-[#374151] mb-2">数据权限范围</label>
                <div className="grid grid-cols-3 gap-3">
                  {DATA_SCOPE_OPTIONS.map(opt => (
                    <label
                      key={opt.value}
                      onClick={() => setForm({ ...form, dataScope: opt.value })}
                      className={`flex flex-col gap-1 p-4 border rounded-lg cursor-pointer transition-all ${form.dataScope === opt.value ? 'border-[#3b82f6] bg-[#eff6ff]' : 'border-[#e5e7eb] hover:border-[#d1d5db]'}`}
                    >
                      <div className="flex items-center gap-2">
                        <input type="radio" name="dataScope" checked={form.dataScope === opt.value} readOnly className="text-[#3b82f6]" />
                        <span className="text-sm font-medium text-[#111827]">{opt.label}</span>
                      </div>
                      <span className="text-xs text-[#6b7280] ml-6">{opt.desc}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[13px] font-medium text-[#374151] mb-2">功能权限配置</label>
                <div className="border border-[#e5e7eb] rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#f9fafb] border-b border-[#e5e7eb]">
                        <th className="px-4 py-3 text-left text-xs font-medium text-[#374151]">功能模块</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-[#374151]">查看</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-[#374151]">新增</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-[#374151]">编辑</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-[#374151]">删除</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#e5e7eb]">
                      {PERMISSION_MODULES.map(mod => (
                        <tr key={mod.key} className="hover:bg-[#f9fafb]">
                          <td className="px-4 py-3 text-[#111827]">{mod.label}</td>
                          {(['view', 'add', 'edit', 'delete'] as const).map(action => (
                            <td key={action} className="px-4 py-3 text-center">
                              {mod.actions.includes(action) ? (
                                <input
                                  type="checkbox"
                                  checked={form.permissions.includes(`${mod.key}:${action}`)}
                                  onChange={() => togglePermission(mod.key, action)}
                                  className="rounded border-[#d1d5db] text-[#3b82f6] focus:ring-[#3b82f6] w-4 h-4 cursor-pointer"
                                />
                              ) : (
                                <span className="text-[#9ca3af]">-</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#e5e7eb] bg-[#f9fafb]">
              <button onClick={() => setModalType(null)} className="h-10 px-4 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">取消</button>
              <button onClick={handleSubmit} className="h-10 px-4 text-sm font-medium text-white bg-[#3b82f6] rounded-md hover:bg-[#2563eb] shadow-sm transition-all">
                {modalType === 'create' ? '创建角色' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {modalType === 'detail' && detailRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.6)]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#e5e7eb]">
              <h3 className="text-lg font-semibold text-[#111827]">角色详情</h3>
              <button onClick={() => setModalType(null)} className="w-9 h-9 flex items-center justify-center text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827] rounded-md transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="flex items-center gap-3 mb-5">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold text-[#111827]">{detailRole.name}</span>
                  {getRoleBadge(detailRole)}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-5 mb-6">
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">用户数量</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{(detailRole as any).userCount || 0} 人</div>
                </div>
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">数据权限</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{getDataScopeLabel(detailRole)}</div>
                </div>
                <div>
                  <div className="text-xs text-[#6b7280] mb-1">创建时间</div>
                  <div className="text-[15px] font-semibold text-[#111827]">{detailRole.createdAt ? new Date(detailRole.createdAt).toLocaleDateString() : '-'}</div>
                </div>
              </div>

              <div className="mb-6">
                <h4 className="text-sm font-semibold text-[#111827] mb-3">权限配置</h4>
                {detailRole.code === 'admin' ? (
                  <div className="bg-[#f0fdf4] text-[#22c55e] px-4 py-3 rounded-lg text-sm flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    拥有系统全部权限
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {getPermissionChips(detailRole)}
                  </div>
                )}
              </div>

              <div>
                <h4 className="text-sm font-semibold text-[#111827] mb-3">关联用户</h4>
                <div className="border border-[#e5e7eb] rounded-lg divide-y divide-[#e5e7eb]">
                  {/* 这里可以展示关联用户列表 */}
                  <div className="px-4 py-3 text-sm text-[#6b7280]">暂无关联用户数据</div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#e5e7eb] bg-[#f9fafb]">
              <button onClick={() => setModalType(null)} className="h-10 px-4 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {modalType === 'delete' && deleteRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.6)]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#e5e7eb]">
              <h3 className="text-lg font-semibold text-[#111827]">确认删除</h3>
              <button onClick={() => setModalType(null)} className="w-9 h-9 flex items-center justify-center text-[#6b7280] hover:bg-[#f3f4f6] hover:text-[#111827] rounded-md transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 text-center">
              <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[#fef2f2] flex items-center justify-center">
                <Shield className="w-6 h-6 text-[#ef4444]" />
              </div>
              <h3 className="text-base font-semibold text-[#111827] mb-2">确定要删除该角色吗？</h3>
              <p className="text-sm text-[#6b7280] mb-4">删除后，该角色下的用户将失去对应权限</p>
              <div className="bg-[#f9fafb] rounded-lg p-3 text-left">
                <div className="text-xs text-[#6b7280] mb-1">待删除角色</div>
                <div className="font-semibold text-[#111827]">{deleteRole.name}</div>
                <div className="text-xs text-[#6b7280] mt-1">当前用户数: {(deleteRole as any).userCount || 0} 人</div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#e5e7eb] bg-[#f9fafb]">
              <button onClick={() => setModalType(null)} className="h-10 px-4 text-sm text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f9fafb] shadow-sm transition-all">取消</button>
              <button onClick={handleDelete} className="h-10 px-4 text-sm font-medium text-white bg-[#ef4444] rounded-md hover:bg-[#dc2626] shadow-sm transition-all">确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SearchIcon() {
  return (
    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9ca3af]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
