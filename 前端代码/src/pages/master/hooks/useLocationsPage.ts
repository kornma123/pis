import { useState, useEffect, useMemo, useCallback } from 'react'
import { locationApi } from '@/api/master'
import type { Location } from '@/types'
import { toast } from 'sonner'

export interface TreeNode {
  id: string
  code: string
  name: string
  type: string
  zone: string
  children?: TreeNode[]
  isLeaf?: boolean
}

export interface FormData {
  code: string
  name: string
  type: 'shelf' | 'fridge' | 'cabinet' | 'counter' | 'other'
  parentId: string
  levelData: string[]
  capacity: number
  status: 'active' | 'inactive'
}

export const typeOptions = [
  { value: 'shelf', label: '货架' },
  { value: 'fridge', label: '冰箱' },
  { value: 'cabinet', label: '柜' },
  { value: 'counter', label: '操作台' },
  { value: 'other', label: '其他' },
] as const

export function getTypeIcon(type?: string) {
  switch (type) {
    case 'fridge': return '🧊'
    case 'cabinet': return '🗄️'
    case 'counter': return '🔬'
    case 'shelf': return '📦'
    default: return '📍'
  }
}

export function getTypeLabel(type?: string) {
  return typeOptions.find(t => t.value === type)?.label || type || '货架'
}

export type ModalType = 'create' | 'edit' | 'levelConfig' | null

export function useLocationsPage() {
  const [data, setData] = useState<Location[]>([])
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchStatus, setSearchStatus] = useState<string>('all')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const flatLocations = useMemo(() => {
    const map = new Map<string, Location>()
    data.forEach(d => map.set(d.id, d))
    return map
  }, [data])
  const [modalType, setModalType] = useState<ModalType>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [levelTab, setLevelTab] = useState<string>('shelf')
  const [levelConfigs, setLevelConfigs] = useState<Record<string, string[]>>({
    shelf: ['库区', '货架', '库位'],
    fridge: ['冷冻区', '层', '抽屉'],
    cabinet: ['柜号', '层', '格'],
    counter: ['操作台', '区域'],
    other: ['区域', '位置'],
  })
  const [form, setForm] = useState<FormData>({
    code: '',
    name: '',
    type: 'shelf',
    parentId: '',
    levelData: [''],
    capacity: 999999,
    status: 'active',
  })

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [listRes, treeRes] = await Promise.all([
        locationApi.getList({ page: 1, pageSize: 1000, keyword: keyword || undefined, status: statusFilter !== 'all' ? statusFilter : undefined }),
        locationApi.getTree(),
      ])
      setData((listRes as any).list || [])
      setTreeData((treeRes as any).data || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [keyword, statusFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const toggleExpand = (id: string) => {
    const next = new Set(expandedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpandedIds(next)
  }

  const expandAll = () => {
    const collect = (nodes: TreeNode[]): string[] =>
      nodes.flatMap(n => [n.id, ...(n.children ? collect(n.children) : [])])
    setExpandedIds(new Set(collect(treeData)))
  }

  const collapseAll = () => setExpandedIds(new Set())

  const getDescendantIds = useCallback((node: TreeNode): string[] => {
    const ids = [node.id]
    if (node.children) {
      node.children.forEach(c => ids.push(...getDescendantIds(c)))
    }
    return ids
  }, [])

  const displayLocations = useMemo(() => {
    if (!selectedNodeId) return data
    const findNode = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.id === selectedNodeId) return n
        if (n.children) { const f = findNode(n.children); if (f) return f }
      }
      return null
    }
    const node = findNode(treeData)
    if (!node) return data
    const ids = new Set(getDescendantIds(node))
    return data.filter(d => ids.has(d.id))
  }, [data, selectedNodeId, treeData, getDescendantIds])

  const stats = useMemo(() => ({
    total: data.length,
    active: data.filter((d) => d.status === 'active').length,
    inactive: data.filter((d) => d.status === 'inactive').length,
    avgUtilization:
      data.length > 0
        ? Math.round(data.reduce((sum, d) => sum + (d.capacity > 0 ? (d.used / d.capacity) * 100 : 0), 0) / data.length)
        : 0,
  }), [data])

  const handleSearch = () => {
    setKeyword(searchKeyword)
    setStatusFilter(searchStatus)
  }

  const handleReset = () => {
    setSearchKeyword('')
    setSearchStatus('all')
    setKeyword('')
    setStatusFilter('all')
    setSelectedNodeId(null)
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({
      code: '',
      name: '',
      type: 'shelf',
      parentId: '',
      levelData: [''],
      capacity: 999999,
      status: 'active',
    })
    setModalType('create')
  }

  const openEdit = (row: Location) => {
    setEditingId(row.id)
    const labels = levelConfigs[row.type || 'shelf'] || []
    const levelData = [
      row.zone || '',
      row.shelf || '',
      row.position || '',
    ].slice(0, Math.max(3, labels.length))
    while (levelData.length < labels.length) levelData.push('')
    setForm({
      code: row.code,
      name: row.name,
      type: row.type || 'shelf',
      parentId: row.parentId || '',
      levelData,
      capacity: row.capacity,
      status: row.status,
    })
    setModalType('edit')
  }

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.levelData[0]?.trim()) {
      toast.error('请填写必填字段')
      return
    }
    const payload = {
      ...form,
      zone: form.levelData[0] || '',
      shelf: form.levelData[1] || '',
      position: form.levelData[2] || '',
    }
    try {
      if (editingId) {
        await locationApi.update(editingId, payload)
      } else {
        await locationApi.create(payload)
      }
      toast.success('保存成功')
      setModalType(null)
      fetchData()
    } catch (e) {
      toast.error('保存失败')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除该库位？')) return
    try {
      await locationApi.delete(id)
      toast.success('删除成功')
      fetchData()
    } catch (e) {
      toast.error('删除失败')
    }
  }

  const handleToggleStatus = async (row: Location) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    try {
      await locationApi.update(row.id, { status: newStatus })
      toast.success(newStatus === 'active' ? '已启用' : '已停用')
      fetchData()
    } catch (e) {
      toast.error('操作失败')
    }
  }

  const saveLevelConfigs = () => {
    toast.success('配置已保存')
    setModalType(null)
  }

  return {
    data,
    treeData,
    loading,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    searchKeyword,
    setSearchKeyword,
    searchStatus,
    setSearchStatus,
    selectedNodeId,
    setSelectedNodeId,
    expandedIds,
    setExpandedIds,
    flatLocations,
    modalType,
    setModalType,
    editingId,
    setEditingId,
    levelTab,
    setLevelTab,
    levelConfigs,
    setLevelConfigs,
    form,
    setForm,
    fetchData,
    toggleExpand,
    expandAll,
    collapseAll,
    getDescendantIds,
    displayLocations,
    stats,
    handleSearch,
    handleReset,
    openCreate,
    openEdit,
    handleSubmit,
    handleDelete,
    handleToggleStatus,
    saveLevelConfigs,
  }
}
