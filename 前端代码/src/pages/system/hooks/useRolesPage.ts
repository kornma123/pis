import { useState, useEffect, useMemo } from 'react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import request from '@/api/request'
import type { Role } from '@/types'
import { toast } from 'sonner'
import { canAccess } from '@/lib/permissions'

export type PermLevel = 'R' | 'W'

export interface FormData {
  code: string
  name: string
  description: string
  permissions: Record<string, PermLevel> // 数据驱动 RBAC：模块 → R/W（缺省=无权限）
  status: 'active' | 'inactive'
}

export interface PermissionModule {
  key: string
  label: string
}

// 31 模块矩阵（与后端 SEED_MATRIX / MODULES 对齐）。分组仅用于 UI 呈现。
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
  { key: 'account_reconcile', label: '账实核对' },
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

export function useRolesPage() {
  const { getNumber, setMultiple } = useUrlParams()
  const canWrite = canAccess('roles', 'W')

  const [keyword, setKeyword] = useState('')

  const urlPage = Math.max(1, getNumber('page', 1))
  const urlPageSize = [10, 20, 50, 100].includes(getNumber('pageSize', 20))
    ? getNumber('pageSize', 20)
    : 20

  const {
    data,
    loading,
    error,
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
    })
  }, [page, pageSize, keyword, setMultiple])

  const [modalType, setModalType] = useState<'create' | 'edit' | 'detail' | 'delete' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailRole, setDetailRole] = useState<Role | null>(null)
  const [deleteRole, setDeleteRole] = useState<Role | null>(null)

  const [form, setForm] = useState<FormData>({
    code: '', name: '', description: '', permissions: {}, status: 'active'
  })
  const [formError, setFormError] = useState('')

  const stats = useMemo(() => {
    const totalRoles = total
    const pageRoles = data.length
    const activeRoles = data.filter(role => role.status === 'active').length
    const inactiveRoles = data.filter(role => role.status === 'inactive').length
    return { totalRoles, pageRoles, activeRoles, inactiveRoles }
  }, [data, total])

  const filteredData = useMemo(() => {
    let list = [...data]
    if (keyword.trim()) {
      const kw = keyword.toLowerCase()
      list = list.filter(r => r.name.toLowerCase().includes(kw) || r.code.toLowerCase().includes(kw))
    }
    return list
  }, [data, keyword])

  const openCreate = () => {
    if (!canWrite) return
    setFormError('')
    setEditingId(null)
    setForm({ code: '', name: '', description: '', permissions: {}, status: 'active' })
    setModalType('create')
  }

  const openEdit = (row: Role) => {
    if (!canWrite) return
    setFormError('')
    setEditingId(row.id)
    setForm({
      code: row.code,
      name: row.name,
      description: row.description || '',
      permissions: normalizeRolePerms((row as any).permissions),
      status: row.status,
    })
    setModalType('edit')
  }

  const openDetail = (row: Role) => {
    setDetailRole(row)
    setModalType('detail')
  }

  const openDelete = (row: Role) => {
    if (!canWrite) return
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
    if (!canWrite) return
    if (!form.code.trim() || !form.name.trim()) {
      setFormError('请填写角色名称和唯一角色标识。')
      return
    }
    try {
      if (editingId) {
        await request.put(`/roles/${editingId}`, form)
      } else {
        await request.post('/roles', form)
      }
      setFormError('')
      toast.success(editingId ? '保存成功' : '创建成功')
      setModalType(null)
      refresh()
    } catch {
      setFormError('保存未完成，请检查输入或稍后重试。')
    }
  }

  const handleDelete = async () => {
    if (!canWrite || !deleteRole) return
    try {
      await request.delete(`/roles/${deleteRole.id}`)
      toast.success('删除成功')
      setModalType(null)
      refresh()
    } catch {
      /* 错误由全局响应拦截器统一提示后端真因，不再重复弹通用文案 */
    }
  }

  return {
    data,
    loading,
    error: error ? '角色服务暂时不可用，请重新加载。' : null,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
    keyword,
    setKeyword,
    canWrite,
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
    formError,
    setFormError,
    stats,
    filteredData,
    openCreate,
    openEdit,
    openDetail,
    openDelete,
    setPermLevel,
    handleSubmit,
    handleDelete,
  }
}
