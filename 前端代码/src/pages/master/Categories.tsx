import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Plus, Edit2, Trash2, X, ChevronRight, Folder, Circle,
  Search, ChevronDown, ChevronUp, AlertTriangle,
} from 'lucide-react'
import { categoryApi } from '@/api/master'
import type { Category } from '@/types'
import { toast } from 'sonner'

interface FormData {
  code: string
  name: string
  parentId: string | null
  level: number
  sortOrder: number
  status: 'active' | 'inactive'
  remark: string
}

function countStats(nodes: Category[]) {
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

export default function Categories() {
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

  const fetchData = async () => {
    setLoading(true)
    try {
      const res: any = await categoryApi.getTree()
      const t = res || []
      setTree(t)
      // Auto-expand first level
      const firstLevelIds = new Set<string>()
      t.forEach((n: Category) => firstLevelIds.add(n.id))
      setExpandedIds(firstLevelIds)
      const listRes: any = await categoryApi.getList({ page: 1, pageSize: 999 })
      setFlatList(listRes?.list || [])
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => { fetchData() }, [])

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

  const renderTree = (nodes: Category[], depth = 0): React.ReactNode => {
    return nodes.map(node => {
      const hasChildren = node.children && node.children.length > 0
      const isExpanded = expandedIds.has(node.id)
      const isSelected = selectedId === node.id
      const matched = filterMatch(node)
      if (!matched && !searchKeyword.trim()) return null
      // When searching, show nodes that match or have matching descendants
      if (searchKeyword.trim() && !matched) return null

      return (
        <div key={node.id}>
          <div
            className={`group flex items-center gap-2 py-2.5 pr-3 cursor-pointer transition-colors select-none ${
              isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
            }`}
            style={{ paddingLeft: `${depth * 20 + 12}px` }}
            onClick={() => setSelectedId(node.id)}
            onContextMenu={(e) => handleContextMenu(e, node)}
          >
            <button
              className={`w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 transition-colors ${hasChildren ? '' : 'invisible'}`}
              onClick={(e) => { e.stopPropagation(); toggleExpand(node.id) }}
            >
              {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}
            </button>
            {node.level === 3 ? (
              <Circle className="w-3.5 h-3.5 text-blue-400" />
            ) : (
              <Folder className="w-4 h-4 text-blue-500" />
            )}
            <span className={`text-sm flex-1 truncate ${isSelected ? 'font-semibold text-blue-700' : 'text-gray-700'}`}>{node.name}</span>
            <span className="text-xs text-gray-400">{node.count || 0}</span>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {node.level < 3 && (
                <button
                  onClick={(e) => { e.stopPropagation(); openCreate(node.id, node.level + 1) }}
                  className="p-1 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded"
                  title="添加子分类"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); openEdit(node) }}
                className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                title="编辑"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              {!hasChildren && (
                <button
                  onClick={(e) => { e.stopPropagation(); openDelete(node) }}
                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          {hasChildren && isExpanded && (
            <div>{renderTree(node.children!, depth + 1)}</div>
          )}
        </div>
      )
    })
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

  const statusBadge = (status: string) => (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
    }`}>
      {status === 'active' ? '已启用' : '已停用'}
    </span>
  )

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">物料分类</h1>
          <p className="text-sm text-gray-500 mt-1">病理实验室物料三级分类管理</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={expandAll} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-[6px] hover:bg-gray-50 text-sm font-medium">
            <ChevronDown className="w-4 h-4" />
            展开全部
          </button>
          <button onClick={collapseAll} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-[6px] hover:bg-gray-50 text-sm font-medium">
            <ChevronUp className="w-4 h-4" />
            收起全部
          </button>
          <button onClick={() => openCreate(null, 1)} className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-[6px] hover:bg-blue-600 text-sm font-medium">
            <Plus className="w-4 h-4" />
            新建分类
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-2xl font-semibold text-blue-600">{stats.total}</div>
          <div className="text-sm text-gray-500 mt-1">分类总数</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-2xl font-semibold text-green-600">{stats.active}</div>
          <div className="text-sm text-gray-500 mt-1">已启用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-2xl font-semibold text-gray-500">{stats.inactive}</div>
          <div className="text-sm text-gray-500 mt-1">已停用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-2xl font-semibold text-blue-600">{stats.totalMaterials}</div>
          <div className="text-sm text-gray-500 mt-1">关联物料数</div>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex gap-5 min-h-[500px]">
        {/* Category Tree */}
        <div className="w-[380px] flex-shrink-0 bg-white rounded-lg border border-gray-200 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">分类目录</h3>
            <div className="flex items-center gap-2">
              <button onClick={expandAll} className="text-xs text-blue-600 hover:text-blue-700">展开</button>
              <button onClick={collapseAll} className="text-xs text-blue-600 hover:text-blue-700">收起</button>
            </div>
          </div>
          <div className="p-3 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索分类名称..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="w-full pl-9 pr-8 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {searchKeyword && (
                <button onClick={() => setSearchKeyword('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {loading ? (
              <div className="p-8 text-center text-gray-400 text-sm">加载中...</div>
            ) : tree.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">暂无分类数据</div>
            ) : searchKeyword.trim() && !tree.some(filterMatch) ? (
              <div className="p-8 text-center text-gray-400 text-sm">未找到匹配的分类</div>
            ) : (
              renderTree(tree)
            )}
          </div>
        </div>

        {/* Detail Panel */}
        <div className="flex-1 bg-white rounded-lg border border-gray-200">
          {!selectedNode ? (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center">
              <div className="w-14 h-14 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                <Folder className="w-7 h-7 text-gray-300" />
              </div>
              <div className="text-base font-medium text-gray-900">选择分类查看详情</div>
              <p className="text-sm text-gray-500 mt-1 max-w-xs">从左侧分类树中点击任意分类，查看该分类下的物料信息和统计数据</p>
            </div>
          ) : (
            <div className="p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-lg font-semibold text-gray-900">{selectedNode.name}</h3>
                <div className="flex items-center gap-2">
                  <button onClick={() => openEdit(selectedNode)} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 rounded-[6px] hover:bg-gray-50 text-sm">
                    <Edit2 className="w-3.5 h-3.5" />
                    编辑
                  </button>
                  {selectedNode.level < 3 && (
                    <button onClick={() => openCreate(selectedNode.id, selectedNode.level + 1)} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-[6px] hover:bg-blue-600 text-sm">
                      <Plus className="w-3.5 h-3.5" />
                      添加子分类
                    </button>
                  )}
                </div>
              </div>

              {/* Breadcrumb */}
              <div className="flex items-center gap-1 text-sm text-gray-500 mb-5 flex-wrap">
                {getBreadcrumb(selectedNode.id).map((item, idx, arr) => (
                  <span key={item.id} className="flex items-center gap-1">
                    <span className={idx === arr.length - 1 ? 'text-gray-900 font-medium' : ''}>{item.name}</span>
                    {idx < arr.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                  </span>
                ))}
              </div>

              {/* Basic Info */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">基本信息</h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 bg-gray-50 rounded-lg p-4">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">分类名称</div>
                    <div className="text-sm font-medium text-gray-900">{selectedNode.name}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">分类编码</div>
                    <div className="text-sm font-mono text-gray-900">{selectedNode.code}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">分类层级</div>
                    <div className="text-sm text-gray-900">
                      {selectedNode.level === 1 ? '一级分类' : selectedNode.level === 2 ? '二级分类' : '三级分类'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">物料数量</div>
                    <div className="text-sm text-gray-900">{selectedNode.count || 0}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">状态</div>
                    <div>{statusBadge(selectedNode.status)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">排序</div>
                    <div className="text-sm text-gray-900">{selectedNode.sortOrder ?? 0}</div>
                  </div>
                </div>
              </div>

              {/* Associated materials placeholder - could be expanded with real data */}
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3">关联物料</h4>
                <div className="bg-gray-50 rounded-lg p-8 text-center">
                  <div className="text-sm text-gray-500">该分类下共 {selectedNode.count || 0} 个物料</div>
                  <p className="text-xs text-gray-400 mt-1">物料详情可在库存列表中查看</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextRef}
          className="fixed z-[60] bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node.level < 3 && (
            <button
              onClick={() => { openCreate(contextMenu.node.id, contextMenu.node.level + 1); setContextMenu(null) }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              添加子分类
            </button>
          )}
          <button
            onClick={() => { openEdit(contextMenu.node); setContextMenu(null) }}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
          >
            <Edit2 className="w-4 h-4" />
            编辑分类
          </button>
          <div className="h-px bg-gray-100 my-1" />
          <button
            onClick={() => { openDelete(contextMenu.node); setContextMenu(null) }}
            className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            删除分类
          </button>
        </div>
      )}

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">{editingId ? '编辑分类' : '新建分类'}</h3>
              <button onClick={() => setModalOpen(false)} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  分类名称 <span className="text-red-500">*</span>
                </label>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="请输入分类名称"
                  className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  分类编码
                  <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
                </label>
                <input
                  value={form.code}
                  disabled
                  readOnly
                  placeholder="保存后自动生成"
                  className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">上级分类</label>
                <select
                  value={form.parentId || ''}
                  onChange={e => setForm({ ...form, parentId: e.target.value || null })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">无（作为一级分类）</option>
                  {flatList.filter(c => c.id !== editingId).map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">排序</label>
                <input
                  type="number"
                  value={form.sortOrder}
                  onChange={e => setForm({ ...form, sortOrder: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">状态</label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      name="status"
                      checked={form.status === 'active'}
                      onChange={() => setForm({ ...form, status: 'active' })}
                      className="w-4 h-4 text-blue-600"
                    />
                    启用
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      name="status"
                      checked={form.status === 'inactive'}
                      onChange={() => setForm({ ...form, status: 'inactive' })}
                      className="w-4 h-4 text-blue-600"
                    />
                    停用
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">备注</label>
                <textarea
                  value={form.remark}
                  onChange={e => setForm({ ...form, remark: e.target.value })}
                  rows={2}
                  placeholder="请输入备注信息"
                  className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px]">取消</button>
              <button onClick={handleSubmit} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-[6px] hover:bg-blue-600">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteModalOpen && deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">确认删除</h3>
              <button onClick={() => setDeleteModalOpen(false)} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
                <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <div className="font-medium text-amber-800 mb-1">删除确认</div>
                  <p className="text-amber-700">确定要删除分类 "{deleteTarget.name}" 吗？</p>
                  {deleteTarget.children && deleteTarget.children.length > 0 ? (
                    <p className="text-amber-700 mt-1.5 text-xs">⚠️ 该分类下有 {deleteTarget.children.length} 个子分类，请先删除子分类。</p>
                  ) : deleteTarget.count ? (
                    <p className="text-amber-700 mt-1.5 text-xs">⚠️ 该分类下有关联物料，删除后物料将变为未分类状态。</p>
                  ) : (
                    <p className="text-amber-700 mt-1.5 text-xs">此操作不可恢复。</p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button onClick={() => setDeleteModalOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px]">取消</button>
              <button
                onClick={confirmDelete}
                disabled={!!(deleteTarget.children && deleteTarget.children.length > 0)}
                className="px-4 py-2 bg-red-500 text-white text-sm rounded-[6px] hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
