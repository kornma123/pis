import { useState, useEffect, useRef, useCallback } from 'react'
import { categoryApi } from '@/api/master'
import type { Category } from '@/types'
import { toast } from 'sonner'

export interface FormData {
  code: string
  name: string
  parentId: string | null
  level: number
  sortOrder: number
  status: 'active' | 'inactive'
  remark: string
}

export function countStats(nodes: Category[]) {
  let total = 0, active = 0, inactive = 0, totalMaterials = 0
  const walk = (items: Category[]) => {
    items.forEach(item => {
      total++
      if (item.status === 'active') active++
      else inactive++
      totalMaterials += item.count || 0
      if (item.children) walk(item.children)
    })
  }
  walk(nodes)
  return { total, active, inactive, totalMaterials }
}

export function useCategoriesPage() {
  const [tree, setTree] = useState<Category[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormData>({ code: '', name: '', parentId: null, level: 1, sortOrder: 0, status: 'active', remark: '' })
  const [flatList, setFlatList] = useState<Category[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: Category } | null>(null)
  const contextRef = useRef<HTMLDivElement>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await categoryApi.getTree()
      const t = res || []
      setTree(t)
      const firstLevelIds = new Set<string>()
      t.forEach((n: Category) => firstLevelIds.add(n.id))
      setExpandedIds(firstLevelIds)
      const listRes: any = await categoryApi.getList({ page: 1, pageSize: 999 })
      setFlatList(listRes?.list || [])
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const stats = countStats(tree)

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAll = () => {
    const all = new Set<string>()
    const walk = (items: Category[]) => {
      items.forEach(item => {
        if (item.children && item.children.length) {
          all.add(item.id)
          walk(item.children)
        }
      })
    }
    walk(tree)
    setExpandedIds(all)
  }

  const collapseAll = () => {
    const first = new Set<string>()
    tree.forEach(n => first.add(n.id))
    setExpandedIds(first)
  }

  const findNodeById = useCallback((items: Category[], id: string): Category | null => {
    for (const item of items) {
      if (item.id === id) return item
      if (item.children) {
        const found = findNodeById(item.children, id)
        if (found) return found
      }
    }
    return null
  }, [])

  const selectedNode = selectedId ? findNodeById(tree, selectedId) : null

  const openCreate = (parentId: string | null = null, level: number = 1) => {
    setEditingId(null)
    setForm({ code: '', name: '', parentId, level, sortOrder: 0, status: 'active', remark: '' })
    setModalOpen(true)
  }

  const openEdit = (node: Category) => {
    setEditingId(node.id)
    setForm({
      code: node.code,
      name: node.name,
      parentId: node.parentId || null,
      level: node.level,
      sortOrder: node.sortOrder || 0,
      status: node.status,
      remark: '',
    })
    setModalOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error('请填写分类名称')
      return
    }
    try {
      if (editingId) {
        await categoryApi.update(editingId, form)
        toast.success('分类更新成功')
      } else {
        await categoryApi.create(form)
        toast.success('分类创建成功')
      }
      setModalOpen(false)
      fetchData()
    } catch (e) {
      toast.error('操作失败')
    }
  }

  const openDelete = (node: Category) => {
    setDeleteTarget(node)
    setDeleteModalOpen(true)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await categoryApi.delete(deleteTarget.id)
      toast.success('分类删除成功')
      if (selectedId === deleteTarget.id) setSelectedId(null)
      setDeleteModalOpen(false)
      setDeleteTarget(null)
      fetchData()
    } catch (e) {
      toast.error('删除失败')
    }
  }

  const handleContextMenu = (e: React.MouseEvent, node: Category) => {
    e.preventDefault()
    setContextMenu({ x: e.pageX, y: e.pageY, node })
  }

  const filterMatch = (node: Category): boolean => {
    if (!searchKeyword.trim()) return true
    const kw = searchKeyword.toLowerCase()
    if (node.name.toLowerCase().includes(kw) || node.code.toLowerCase().includes(kw)) return true
    if (node.children) {
      return node.children.some(child => filterMatch(child))
    }
    return false
  }

  const getBreadcrumb = (id: string): Category[] => {
    const path: Category[] = []
    const walk = (items: Category[], target: string): boolean => {
      for (const item of items) {
        if (item.id === target) {
          path.push(item)
          return true
        }
        if (item.children) {
          if (walk(item.children, target)) {
            path.unshift(item)
            return true
          }
        }
      }
      return false
    }
    walk(tree, id)
    return path
  }

  return {
    tree,
    loading,
    modalOpen,
    setModalOpen,
    editingId,
    setEditingId,
    form,
    setForm,
    flatList,
    expandedIds,
    setExpandedIds,
    selectedId,
    setSelectedId,
    searchKeyword,
    setSearchKeyword,
    deleteModalOpen,
    setDeleteModalOpen,
    deleteTarget,
    setDeleteTarget,
    contextMenu,
    setContextMenu,
    contextRef,
    fetchData,
    stats,
    toggleExpand,
    expandAll,
    collapseAll,
    findNodeById,
    selectedNode,
    openCreate,
    openEdit,
    handleSubmit,
    openDelete,
    confirmDelete,
    handleContextMenu,
    filterMatch,
    getBreadcrumb,
  }
}
