import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, Plus, X, ChevronDown, ChevronRight, Settings, Box } from 'lucide-react'
import { locationApi } from '@/api/master'
import type { Location } from '@/types'
import { toast } from 'sonner'

interface TreeNode {
  id: string
  code: string
  name: string
  type: string
  zone: string
  children?: TreeNode[]
  isLeaf?: boolean
}

interface FormData {
  code: string
  name: string
  type: 'shelf' | 'fridge' | 'cabinet' | 'counter' | 'other'
  parentId: string
  levelData: string[]
  capacity: number
  status: 'active' | 'inactive'
}

function getTypeIcon(type?: string) {
  switch (type) {
    case 'fridge': return '🧊'
    case 'cabinet': return '🗄️'
    case 'counter': return '🔬'
    case 'shelf': return '📦'
    default: return '📍'
  }
}

const typeOptions = [
  { value: 'shelf', label: '货架' },
  { value: 'fridge', label: '冰箱' },
  { value: 'cabinet', label: '柜' },
  { value: 'counter', label: '操作台' },
  { value: 'other', label: '其他' },
] as const

function getTypeLabel(type?: string) {
  return typeOptions.find(t => t.value === type)?.label || type || '货架'
}

// getLevelLabels 已从组件 state levelConfigs 动态获取

type ModalType = 'create' | 'edit' | 'levelConfig' | null

export default function Locations() {
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

  const fetchData = async () => {
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
  }

  useEffect(() => {
    fetchData()
  }, [keyword, statusFilter])

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

  const renderTree = (nodes: TreeNode[], depth = 0): React.ReactNode => {
    return nodes.map(node => (
      <div key={node.id}>
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer text-sm ${
            selectedNodeId === node.id ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-50 text-gray-700'
          }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => setSelectedNodeId(node.id)}
        >
          {node.children && node.children.length > 0 ? (
            <button onClick={(e) => { e.stopPropagation(); toggleExpand(node.id) }} className="p-0.5 hover:bg-gray-200 rounded">
              {expandedIds.has(node.id) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          ) : <span className="w-5" />}
          <span className="text-base">{getTypeIcon(node.type)}</span>
          <span className="flex-1">{node.name}</span>
          {node.children && node.children.length > 0 && (
            <span className="text-xs text-gray-400">{node.children.length}</span>
          )}
        </div>
        {expandedIds.has(node.id) && node.children && (
          <div>{renderTree(node.children, depth + 1)}</div>
        )}
      </div>
    ))
  }

  const getDescendantIds = (node: TreeNode): string[] => {
    const ids = [node.id]
    if (node.children) {
      node.children.forEach(c => ids.push(...getDescendantIds(c)))
    }
    return ids
  }

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
  }, [data, selectedNodeId, treeData])

  const stats = {
    total: data.length,
    active: data.filter((d) => d.status === 'active').length,
    inactive: data.filter((d) => d.status === 'inactive').length,
    avgUtilization:
      data.length > 0
        ? Math.round(data.reduce((sum, d) => sum + (d.capacity > 0 ? (d.used / d.capacity) * 100 : 0), 0) / data.length)
        : 0,
  }

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

  return (
    <div className="space-y-5">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight">
            库位管理
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            管理仓库库位，支持自定义多层级库位结构
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setModalType('levelConfig')}
            className="inline-flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 rounded-[6px] hover:bg-gray-50 text-sm font-medium transition-colors"
          >
            <Settings className="w-4 h-4" />
            层级配置
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#3b82f6] text-white rounded-[6px] hover:bg-blue-700 text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            新建库位
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { value: stats.total, label: '库位总数' },
          { value: stats.active, label: '已启用' },
          { value: stats.inactive, label: '已停用' },
          { value: `${stats.avgUtilization}%`, label: '平均使用率' },
        ].map((stat, i) => (
          <div
            key={i}
            className="bg-white rounded-[8px] border border-gray-200 p-5"
          >
            <div className="text-[24px] font-semibold text-gray-900">
              {stat.value}
            </div>
            <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* 主内容区：左侧树 + 右侧卡片 */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        {/* 左侧树 */}
        <div className="bg-white rounded-[8px] border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900">库位结构</span>
            <div className="flex gap-2">
              <button onClick={expandAll} className="text-xs text-blue-600 hover:underline">展开</button>
              <button onClick={collapseAll} className="text-xs text-gray-500 hover:underline">收起</button>
            </div>
          </div>
          <div className="p-3">
            {treeData.length === 0 ? (
              <div className="text-center text-sm text-gray-400 py-8">
                暂无库位数据
              </div>
            ) : (
              renderTree(treeData)
            )}
          </div>
        </div>

        {/* 右侧卡片 */}
        <div className="bg-white rounded-[8px] border border-gray-200 overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-100">
            <span className="text-sm font-medium text-gray-900">
              {selectedNodeId && flatLocations.get(selectedNodeId)
                ? `${flatLocations.get(selectedNodeId)!.name} 及其子库位`
                : '全部库位'}
            </span>
            <div className="flex-1" />
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="搜索库位"
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  className="w-48 h-10 pl-9 pr-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <select
                value={searchStatus}
                onChange={(e) => setSearchStatus(e.target.value)}
                className="h-10 px-3 border border-gray-200 rounded-[6px] text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">全部状态</option>
                <option value="active">已启用</option>
                <option value="inactive">已停用</option>
              </select>
              <button
                onClick={handleSearch}
                className="h-10 px-4 text-sm text-gray-700 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
              >
                查询
              </button>
              <button
                onClick={handleReset}
                className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
              >
                重置
              </button>
            </div>
          </div>

          <div className="p-5">
            {loading ? (
              <div className="text-center text-sm text-gray-400 py-12">
                加载中...
              </div>
            ) : displayLocations.length === 0 ? (
              <div className="text-center text-sm text-gray-400 py-12">
                暂无库位数据
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {displayLocations.map((loc) => {
                  const utilization =
                    loc.capacity > 0
                      ? Math.round((loc.used / loc.capacity) * 100)
                      : 0
                  return (
                    <div
                      key={loc.id}
                      className="border border-gray-200 rounded-[8px] p-4 hover:border-blue-300 transition-colors"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-semibold text-gray-900">
                          {loc.code}
                        </span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            loc.status === 'active'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {loc.status === 'active' ? '已启用' : '已停用'}
                        </span>
                      </div>
                      <div className="space-y-2 mb-4">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500">名称</span>
                          <span className="text-gray-900">{loc.name}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500">类型</span>
                          <span className="text-gray-900">{getTypeLabel(loc.type)}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500">容量</span>
                          <span className="text-gray-900">{loc.capacity}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500">当前库存</span>
                          <span className="text-gray-900">{loc.used}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500">使用率</span>
                          <span
                            className={`font-medium ${
                              utilization > 90
                                ? 'text-red-500'
                                : utilization > 70
                                  ? 'text-orange-500'
                                  : 'text-green-600'
                            }`}
                          >
                            {utilization}%
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-3 border-t border-gray-100">
                        <button
                          onClick={() => openEdit(loc)}
                          className="flex-1 py-1.5 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleToggleStatus(loc)}
                          className="flex-1 py-1.5 text-xs text-gray-600 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors"
                        >
                          {loc.status === 'active' ? '停用' : '启用'}
                        </button>
                        <button
                          onClick={() => handleDelete(loc.id)}
                          className="flex-1 py-1.5 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 新建/编辑弹窗 */}
      {(modalType === 'create' || modalType === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold">
                {modalType === 'create' ? '新建库位' : '编辑库位'}
              </h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    库位编码
                    <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
                  </label>
                  <input
                    value={form.code}
                    disabled
                    readOnly
                    placeholder="保存后自动生成"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    库位名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.name}
                    onChange={(e) =>
                      setForm({ ...form, name: e.target.value })
                    }
                    placeholder="请输入库位名称"
                    className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  库位类型 <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.type}
                  onChange={(e) =>
                    setForm({ ...form, type: e.target.value as FormData['type'] })
                  }
                  className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {typeOptions.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  上级库位
                  <span className="text-xs text-gray-400 font-normal ml-1">（留空则为顶级库位）</span>
                </label>
                <select
                  value={form.parentId}
                  onChange={(e) => {
                    const pid = e.target.value
                    const parent = pid ? flatLocations.get(pid) : null
                    const labels = levelConfigs[form.type] || []
                    const nextLevelData = [...form.levelData]
                    if (parent && labels.length > 0) {
                      nextLevelData[0] = parent.zone || nextLevelData[0] || ''
                    }
                    setForm({ ...form, parentId: pid, levelData: nextLevelData })
                  }}
                  className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">无（作为顶级库位）</option>
                  {data.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {getTypeIcon(loc.type)} {loc.name} ({loc.zone})
                    </option>
                  ))}
                </select>
              </div>
              {(() => {
                const labels = levelConfigs[form.type] || []
                const cols = labels.length >= 5 ? 3 : labels.length >= 3 ? 2 : 1
                return (
                  <>
                    <div className={`grid grid-cols-${cols} gap-4`}>
                      {labels.map((label, i) => (
                        <div key={i}>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            {label} {i === 0 ? <span className="text-red-500">*</span> : ''}
                          </label>
                          <input
                            value={form.levelData[i] || ''}
                            onChange={(e) => {
                              const next = [...form.levelData]
                              next[i] = e.target.value
                              setForm({ ...form, levelData: next })
                            }}
                            placeholder={`请输入${label}`}
                            className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        容量限制
                      </label>
                      <input
                        type="number"
                        value={form.capacity}
                        onChange={(e) =>
                          setForm({ ...form, capacity: Number(e.target.value) })
                        }
                        placeholder="请输入容量"
                        className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </>
                )
              })()}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  状态
                </label>
                <select
                  value={form.status}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      status: e.target.value as 'active' | 'inactive',
                    })
                  }
                  className="w-full h-10 px-3 border border-gray-200 rounded-[6px] text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="active">已启用</option>
                  <option value="inactive">已停用</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setModalType(null)}
                className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                className="h-10 px-4 bg-[#3b82f6] text-white text-sm rounded-[6px] hover:bg-blue-700 transition-colors"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 层级配置弹窗 */}
      {modalType === 'levelConfig' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold">库位层级配置</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="p-3 bg-blue-50 rounded-md text-sm text-blue-700">
                <strong>提示：</strong>
                层级配置修改后，需要重新调整库位结构。建议在初始化时设置好层级。
              </div>
              {/* Tab */}
              <div className="flex gap-2 border-b border-gray-200 pb-2">
                {typeOptions.map(t => (
                  <button
                    key={t.value}
                    onClick={() => setLevelTab(t.value)}
                    className={`px-3 py-1.5 text-sm rounded-t-md transition-colors ${
                      levelTab === t.value
                        ? 'text-blue-600 border-b-2 border-blue-600 font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                {levelConfigs[levelTab]?.map((level, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-3 border border-gray-200 rounded-md"
                  >
                    <span className="text-gray-400 text-xs">⋮⋮</span>
                    <span className="text-sm font-medium w-12">
                      第{i + 1}层
                    </span>
                    <input
                      value={level}
                      onChange={(e) => {
                        const next = { ...levelConfigs }
                        next[levelTab] = [...next[levelTab]]
                        next[levelTab][i] = e.target.value
                        setLevelConfigs(next)
                      }}
                      className="flex-1 h-9 px-3 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {levelConfigs[levelTab].length > 1 && (
                      <button
                        onClick={() => {
                          const next = { ...levelConfigs }
                          next[levelTab] = next[levelTab].filter((_, idx) => idx !== i)
                          setLevelConfigs(next)
                        }}
                        className="p-1.5 hover:bg-red-50 text-red-400 hover:text-red-600 rounded transition-colors"
                        title="删除层级"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  const next = { ...levelConfigs }
                  next[levelTab] = [...next[levelTab], `第${next[levelTab].length + 1}层`]
                  setLevelConfigs(next)
                }}
                className="w-full h-10 inline-flex items-center justify-center gap-2 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
              >
                <Plus className="w-4 h-4" />
                添加层级
              </button>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setModalType(null)}
                className="h-10 px-4 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] border border-gray-200 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  toast.success('配置已保存')
                  setModalType(null)
                }}
                className="h-10 px-4 bg-[#3b82f6] text-white text-sm rounded-[6px] hover:bg-blue-700 transition-colors"
              >
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
