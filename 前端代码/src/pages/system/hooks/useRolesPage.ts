import { useState, useEffect, useMemo } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import request from '@/api/request'
import type { Role } from '@/types'
import { toast } from 'sonner'

export type PermLevel = 'R' | 'W'

export interface FormData {
  code: string
  name: string
  description: string
  permissions: Record<string, PermLevel> // 数据驱动 RBAC：模块 → R/W（缺省=无权限）
  status: 'active' | 'inactive'
  dataScope?: 'all' | 'dept' | 'self'
}

export interface PermissionModule {
  key: string
  label: string
}

// 30 模块矩阵（与后端 SEED_MATRIX / MODULES 对齐）。分组仅用于 UI 呈现。
export const PERMISSION_MODULES: PermissionModule[] = [
  { key: 'inventory', label: '库存' },
  { key: 'inbound', label: '入库' },
  { key: 'outbound', label: '出库（领用消耗）' },
  { key: 'transfers', label: '调拨' },
  { key: 'stocktaking', label: '盘点' },
  { key: 'returns', label: '退库' },
  { key: 'scraps', label: '报废' },
  { key: 'materials', label: '耗材物料' },
  { key: 'categories', label: '物料分类' },
  { key: 'locations', label: '库位' },
  { key: 'bom', label: 'BOM' },
  { key: 'projects', label: '检测项目' },
  { key: 'suppliers', label: '供应商' },
  { key: 'purchase_orders', label: '采购订单' },
  { key: 'supplier_returns', label: '退货给供应商' },
  { key: 'reconciliation', label: '消耗对账' },
  { key: 'cost_analysis', label: '物料成本分析' },
  { key: 'abc_dashboard', label: 'ABC 成本看板' },
  { key: 'slide_cost', label: '单片成本' },
  { key: 'profitability', label: '盈利分析' },
  { key: 'abc_config', label: 'ABC 配置' },
  { key: 'antibody_cost', label: '逐抗体成本' },
  { key: 'equipment', label: '设备管理' },
  { key: 'labor_times', label: '标准工时' },
  { key: 'partners', label: '合作医院' },
  { key: 'partner_pricing', label: '医院定价与扣率' },
  { key: 'alerts', label: '预警' },
  { key: 'users', label: '用户管理' },
  { key: 'roles', label: '角色权限' },
  { key: 'logs', label: '操作日志' },
]

// 规范化角色权限为对象矩阵（兼容后端对象形态 / 旧扁平数组）
export function normalizeRolePerms(raw: any): Record<string, PermLevel> {
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const out: Record<string, PermLevel> = {}
    for (const [k, v] of Object.entries(raw)) if (v === 'R' || v === 'W') out[k] = v
    return out
  }
  if (Array.isArray(raw)) {
    const out: Record<string, PermLevel> = {}
    for (const code of raw) if (typeof code === 'string' && PERMISSION_MODULES.some(m => m.key === code)) out[code] = 'W'
    return out
  }
  return {}
}

export const DATA_SCOPE_OPTIONS = [
  { value: 'all' as const, label: '全部数据', desc: '可查看所有部门数据' },
  { value: 'dept' as const, label: '本部门数据', desc: '仅查看所属部门数据' },
  { value: 'self' as const, label: '仅本人数据', desc: '仅查看自己操作的数据' },
]

export function useRolesPage() {
  const { getNumber, setMultiple } = useUrlParams()

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
    code: '', name: '', description: '', permissions: {}, status: 'active', dataScope: 'dept'
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
    setForm({ code: `ROLE-${Date.now()}`, name: '', description: '', permissions: {}, status: 'active', dataScope: 'dept' })
    setModalType('create')
  }

  const openEdit = (row: Role) => {
    setEditingId(row.id)
    setForm({
      code: row.code,
      name: row.name,
      description: row.description || '',
      permissions: normalizeRolePerms((row as any).permissions),
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

  // 设置某模块权限级别：'R' | 'W' | null（无权限）
  const setPermLevel = (moduleKey: string, level: PermLevel | null) => {
    setForm(prev => {
      const next = { ...prev.permissions }
      if (level === null) delete next[moduleKey]
      else next[moduleKey] = level
      return { ...prev, permissions: next }
    })
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
    setPermLevel,
    handleSubmit,
    handleDelete,
    getDataScopeLabel,
  }
}
