import { useState, useEffect, useCallback } from 'react'
import {
  Search, Plus, Edit2, Trash2, X,
  Eye, Power, CheckCircle2, XCircle, RotateCcw
} from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { materialApi, categoryApi, supplierApi } from '@/api/master'
import type { Material, Category, Supplier } from '@/types'
import { toast } from 'sonner'

interface FormData {
  code: string
  name: string
  spec: string
  unit: string
  categoryId: string
  supplierId: string
  price: number
  minStock: number
  maxStock: number
  safetyStock: number
  status: 'active' | 'inactive'
  remark: string
}

type QuickFilter = 'all' | 'active' | 'inactive' | 'low-stock'

export default function Materials() {
  // URL params
  const { get, getNumber, setMultiple } = useUrlParams()

  // Filters
  const [keyword, setKeyword] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')

  // Pagination
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
  } = usePagination<Material>({
    fetchFn: async ({ page, pageSize }) => {
      const params: any = { page, pageSize }
      if (keyword) params.keyword = keyword
      if (categoryId) params.categoryId = categoryId
      if (supplierId) params.supplierId = supplierId
      if (quickFilter === 'active' || quickFilter === 'inactive') {
        params.status = quickFilter
      }
      const res: any = await materialApi.getList(params)
      let list: Material[] = res.list || []
      if (quickFilter === 'low-stock') {
        list = list.filter((m: Material) => m.stock <= m.minStock)
      }
      return { list, pagination: res.pagination }
    },
    initialPage: urlPage,
    initialPageSize: urlPageSize,
    deps: [keyword, categoryId, supplierId, quickFilter],
  })

  // Sync to URL
  useEffect(() => {
    setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
      categoryId: categoryId || null,
      supplierId: supplierId || null,
      status: quickFilter !== 'all' ? quickFilter : null,
    })
  }, [page, pageSize, keyword, categoryId, supplierId, quickFilter, setMultiple])

  // Ref data
  const [categories, setCategories] = useState<Category[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  // Modals
  const [modalOpen, setModalOpen] = useState(false)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailMaterial, setDetailMaterial] = useState<Material | null>(null)

  // ConfirmDialog
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

  // Form
  const [form, setForm] = useState<FormData>({
    code: '', name: '', spec: '', unit: '个', categoryId: '', supplierId: '',
    price: 0, minStock: 0, maxStock: 999999, safetyStock: 0, status: 'active', remark: ''
  })

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const fetchRefs = async () => {
    try {
      const [catRes, supRes]: any = await Promise.all([
        categoryApi.getList({ page: 1, pageSize: 999 }),
        supplierApi.getList({ page: 1, pageSize: 999 }),
      ])
      setCategories(catRes?.list || [])
      setSuppliers(supRes?.list || [])
    } catch (e) { console.error(e) }
  }

  useEffect(() => { fetchRefs() }, [])

  // categories 加载完成后，如果新建弹窗已打开且编码为空，自动填充
  useEffect(() => {
    if (modalOpen && !editingId && categories.length > 0 && !form.code) {
      const cat = form.categoryId || categories[0]?.id
      if (cat) autoFillCode(cat)
    }
  }, [categories, modalOpen])

  // Stats
  const stats = {
    total,
    active: data.filter(m => m.status === 'active').length,
    inactive: data.filter(m => m.status === 'inactive').length,
    lowStock: data.filter(m => m.stock <= m.minStock).length,
  }

  const autoFillCode = useCallback(async (categoryId: string) => {
    if (!categoryId) return
    try {
      const res: any = await materialApi.getNextCode(categoryId)
      if (res.data?.code) {
        setForm(prev => ({ ...prev, code: res.data.code }))
      }
    } catch (e) { /* ignore */ }
  }, [])

  const [specPart, setSpecPart] = useState({ amount: '', unit: '' })

  const parseSpec = (spec?: string) => {
    if (!spec || !spec.includes('/')) return { amount: '', unit: spec || '' }
    const [a, b] = spec.split('/')
    return { amount: a, unit: b }
  }

  const openCreate = () => {
    setEditingId(null)
    setSpecPart({ amount: '', unit: '' })
    const defaultCat = categories[0]?.id || ''
    setForm({ code: '', name: '', spec: '', unit: '个', categoryId: defaultCat, supplierId: '', price: 0, minStock: 0, maxStock: 999999, safetyStock: 0, status: 'active', remark: '' })
    setModalOpen(true)
    if (defaultCat) {
      autoFillCode(defaultCat)
    }
  }

  const openEdit = (row: Material) => {
    setEditingId(row.id)
    setSpecPart(parseSpec(row.spec))
    setForm({
      code: row.code, name: row.name, spec: row.spec || '', unit: row.unit,
      categoryId: row.categoryId || '', supplierId: row.supplierId || '',
      price: row.price || 0, minStock: row.minStock || 0, maxStock: row.maxStock || 999999,
      safetyStock: row.safetyStock || 0, status: row.status, remark: row.remark || ''
    })
    setModalOpen(true)
  }

  const openDetail = (row: Material) => {
    setDetailMaterial(row)
    setDetailModalOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.unit.trim()) {
      toast.error('请填写必填字段')
      return
    }
    try {
      if (editingId) {
        await materialApi.update(editingId, form)
        toast.success('物料更新成功')
      } else {
        await materialApi.create(form)
        toast.success('物料创建成功')
      }
      setModalOpen(false)
      refresh()
    } catch (e) {
      toast.error('操作失败')
    }
  }

  const handleDelete = async (id: string) => {
    openConfirm({
      title: '确认删除',
      description: '删除后不可恢复，是否继续？',
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          await materialApi.delete(id)
          toast.success('删除成功')
          refresh()
        } catch (e) { toast.error('删除失败') }
      },
    })
  }

  const handleToggleStatus = async (row: Material) => {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    try {
      await materialApi.update(row.id, { status: newStatus })
      toast.success(newStatus === 'active' ? '物料已启用' : '物料已停用')
      refresh()
    } catch (e) { toast.error('操作失败') }
  }

  // Selection handlers
  const toggleSelectAll = () => {
    if (selectedIds.size === data.length && data.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map(d => d.id)))
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const batchDelete = async () => {
    openConfirm({
      title: '确认批量删除',
      description: `确认删除选中的 ${selectedIds.size} 个物料？删除后不可恢复。`,
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          for (const id of selectedIds) {
            await materialApi.delete(id)
          }
          toast.success('批量删除成功')
          clearSelection()
          refresh()
        } catch (e) { toast.error('批量删除失败') }
      },
    })
  }

  const batchToggleStatus = async (status: 'active' | 'inactive') => {
    try {
      for (const id of selectedIds) {
        await materialApi.update(id, { status })
      }
      toast.success(status === 'active' ? '批量启用成功' : '批量停用成功')
      clearSelection()
      refresh()
    } catch (e) { toast.error('操作失败') }
  }

  const getCategoryName = (id?: string) => {
    if (!id) return '-'
    return categories.find(c => c.id === id)?.name || id
  }

  const getSupplierName = (id?: string) => {
    if (!id) return '-'
    return suppliers.find(s => s.id === id)?.name || id
  }

  const statusBadge = (status: string) => (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
    }`}>
      {status === 'active' ? '已启用' : '已停用'}
    </span>
  )

  const quickFilterTabs = [
    { key: 'all' as QuickFilter, label: '全部' },
    { key: 'active' as QuickFilter, label: '已启用' },
    { key: 'inactive' as QuickFilter, label: '已停用' },
    { key: 'low-stock' as QuickFilter, label: '低库存' },
  ]

  const handleSearch = () => {
    setPage(1)
  }

  const handleReset = () => {
    setKeyword('')
    setCategoryId('')
    setSupplierId('')
    setQuickFilter('all')
    setPage(1)
  }

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">物料管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理耗材的基础配置信息、规格参数和供应商信息</p>
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-[6px] hover:bg-blue-600 text-sm font-medium">
          <Plus className="w-4 h-4" />
          新建物料
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-2xl font-semibold text-blue-600">{stats.total}</div>
          <div className="text-sm text-gray-500 mt-1">物料总数</div>
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
          <div className="text-2xl font-semibold text-amber-600">{stats.lowStock}</div>
          <div className="text-sm text-gray-500 mt-1">低库存预警</div>
        </div>
      </div>

      {/* Quick Filter Tabs */}
      <div className="flex items-center gap-1 bg-white rounded-lg border border-gray-200 p-1 w-fit">
        {quickFilterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setQuickFilter(tab.key); setPage(1); setSelectedIds(new Set()) }}
            className={`px-4 py-1.5 text-sm font-medium rounded-[6px] transition-colors ${
              quickFilter === tab.key ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-3 bg-white p-4 rounded-lg border border-gray-200 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索物料名称、编码"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={categoryId}
          onChange={e => setCategoryId(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[140px]"
        >
          <option value="">全部分类</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={supplierId}
          onChange={e => setSupplierId(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[140px]"
        >
          <option value="">全部供应商</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={handleSearch} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-[6px] hover:bg-gray-50 text-sm font-medium">
          <Search className="w-4 h-4" />
          查询
        </button>
        <button onClick={handleReset} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-[6px] hover:bg-gray-50 text-sm font-medium">
          <RotateCcw className="w-4 h-4" />
          重置
        </button>
      </div>

      {/* Batch Actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-blue-800">
            <input
              type="checkbox"
              checked={data.length > 0 && selectedIds.size === data.length}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-gray-300 text-blue-600"
            />
            <span>已选择 <strong>{selectedIds.size}</strong> 项</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => batchToggleStatus('active')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white rounded-[6px] border border-transparent hover:border-gray-200 transition-colors">
              <CheckCircle2 className="w-3.5 h-3.5" />
              批量启用
            </button>
            <button onClick={() => batchToggleStatus('inactive')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-white rounded-[6px] border border-transparent hover:border-gray-200 transition-colors">
              <XCircle className="w-3.5 h-3.5" />
              批量停用
            </button>
            <button onClick={batchDelete} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 hover:bg-white rounded-[6px] border border-transparent hover:border-red-200 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
              批量删除
            </button>
            <button onClick={clearSelection} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">取消选择</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left w-10">
                  <input
                    type="checkbox"
                    checked={data.length > 0 && selectedIds.size === data.length}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料编码</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">规格</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">分类</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">供应商</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">库存</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[140px]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">加载中...</td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">暂无数据</td></tr>
              ) : data.map(row => (
                <tr key={row.id} className={`hover:bg-gray-50 transition-colors ${selectedIds.has(row.id) ? 'bg-blue-50/50' : ''}`}>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.id)}
                      onChange={() => toggleSelect(row.id)}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{row.code}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                  <td className="px-4 py-3 text-gray-500">{row.spec || '-'}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                      {getCategoryName(row.categoryId)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{getSupplierName(row.supplierId)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-sm font-medium ${row.stock <= row.minStock ? 'text-red-600' : 'text-gray-900'}`}>
                      {row.stock}
                    </span>
                  </td>
                  <td className="px-4 py-3">{statusBadge(row.status)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openDetail(row)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="详情">
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => openEdit(row)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="编辑">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleToggleStatus(row)} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors" title={row.status === 'active' ? '停用' : '启用'}>
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(row.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="删除">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between bg-white p-3 rounded-lg border border-gray-200">
        <span className="text-sm text-gray-500">共 {total} 条记录</span>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChangePage={setPage}
          onChangePageSize={setPageSize}
        />
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

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">{editingId ? '编辑物料' : '新建物料'}</h3>
              <button onClick={() => setModalOpen(false)} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    物料编码
                    <span className="text-xs text-gray-400 font-normal ml-1">（自动生成）</span>
                  </label>
                  <input value={form.code} disabled readOnly placeholder="选择分类后自动生成" className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm bg-gray-50 text-gray-500 cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">物料名称 <span className="text-red-500">*</span></label>
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="请输入物料名称" className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">规格型号</label>
                <div className="flex items-center gap-2">
                  <input
                    value={specPart.amount}
                    onChange={e => {
                      const next = { ...specPart, amount: e.target.value }
                      setSpecPart(next)
                      setForm(prev => ({ ...prev, spec: `${next.amount}/${next.unit}` }))
                    }}
                    placeholder="数量，如 50、100"
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-gray-400 text-sm">/</span>
                  <input
                    value={specPart.unit}
                    onChange={e => {
                      const next = { ...specPart, unit: e.target.value }
                      setSpecPart(next)
                      setForm(prev => ({ ...prev, spec: `${next.amount}/${next.unit}` }))
                    }}
                    placeholder="单位，如 ml、盒、瓶"
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    计量单位 <span className="text-red-500">*</span>
                  </label>
                  <input value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} placeholder="如：个、盒、瓶" className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    参考单价 (¥)
                    <span className="text-xs text-gray-400 font-normal ml-1" title="用于采购预算和成本预估，实际成本以入库价为准">[预算用]</span>
                  </label>
                  <input type="number" step="0.01" value={form.price} onChange={e => setForm({ ...form, price: Number(e.target.value) })} placeholder="用于采购预算和成本预估" className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">物料分类</label>
                  <select value={form.categoryId} onChange={e => {
                    const val = e.target.value
                    setForm({ ...form, categoryId: val })
                    if (!editingId && val) autoFillCode(val)
                  }} className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                    <option value="">请选择</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">供应商</label>
                  <select value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })} className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                    <option value="">请选择</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    安全库存
                    <span className="text-xs text-gray-400 font-normal ml-1">({form.unit || '个'})</span>
                  </label>
                  <input type="number" value={form.minStock} onChange={e => setForm({ ...form, minStock: Number(e.target.value) })} placeholder={`输入数量，单位：${form.unit || '个'}`} className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    最大库存
                    <span className="text-xs text-gray-400 font-normal ml-1">({form.unit || '个'})</span>
                  </label>
                  <input type="number" value={form.maxStock} onChange={e => setForm({ ...form, maxStock: Number(e.target.value) })} placeholder={`输入数量，单位：${form.unit || '个'}`} className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    保险库存
                    <span className="text-xs text-gray-400 font-normal ml-1">({form.unit || '个'})</span>
                  </label>
                  <input type="number" value={form.safetyStock} onChange={e => setForm({ ...form, safetyStock: Number(e.target.value) })} placeholder={`输入数量，单位：${form.unit || '个'}`} className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">状态</label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="radio" name="m-status" checked={form.status === 'active'} onChange={() => setForm({ ...form, status: 'active' })} className="w-4 h-4 text-blue-600" />
                    启用
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="radio" name="m-status" checked={form.status === 'inactive'} onChange={() => setForm({ ...form, status: 'inactive' })} className="w-4 h-4 text-blue-600" />
                    停用
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">备注</label>
                <textarea value={form.remark} onChange={e => setForm({ ...form, remark: e.target.value })} rows={2} placeholder="请输入备注信息" className="w-full px-3 py-2 border border-gray-200 rounded-[6px] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] transition-colors">取消</button>
              <button onClick={handleSubmit} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-[6px] hover:bg-blue-600 transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detailModalOpen && detailMaterial && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">物料详情</h3>
              <button onClick={() => setDetailModalOpen(false)} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3">基本信息</h4>
                <div className="grid grid-cols-2 gap-4 bg-gray-50 rounded-lg p-4">
                  <div><div className="text-xs text-gray-500 mb-1">物料编码</div><div className="text-sm font-mono text-gray-900">{detailMaterial.code}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">物料名称</div><div className="text-sm font-medium text-gray-900">{detailMaterial.name}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">物料分类</div><div className="text-sm text-gray-900">{getCategoryName(detailMaterial.categoryId)}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">规格型号</div><div className="text-sm text-gray-900">{detailMaterial.spec || '-'}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">计量单位</div><div className="text-sm text-gray-900">{detailMaterial.unit}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">参考单价</div><div className="text-sm font-medium text-blue-600">¥{detailMaterial.price?.toFixed(2)}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">供应商</div><div className="text-sm text-gray-900">{getSupplierName(detailMaterial.supplierId)}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">状态</div><div>{statusBadge(detailMaterial.status)}</div></div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3">库存配置</h4>
                <div className="grid grid-cols-2 gap-4 bg-gray-50 rounded-lg p-4">
                  <div><div className="text-xs text-gray-500 mb-1">当前库存</div><div className="text-sm text-gray-900">{detailMaterial.stock} {detailMaterial.unit}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">安全库存</div><div className="text-sm text-gray-900">{detailMaterial.minStock} {detailMaterial.unit}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">最大库存</div><div className="text-sm text-gray-900">{detailMaterial.maxStock} {detailMaterial.unit}</div></div>
                  <div><div className="text-xs text-gray-500 mb-1">保险库存</div><div className="text-sm text-gray-900">{detailMaterial.safetyStock} {detailMaterial.unit}</div></div>
                </div>
              </div>
              {detailMaterial.remark && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 mb-3">备注</h4>
                  <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700">{detailMaterial.remark}</div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button onClick={() => setDetailModalOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-[6px] transition-colors">关闭</button>
              <button onClick={() => { setDetailModalOpen(false); openEdit(detailMaterial) }} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-[6px] hover:bg-blue-600 transition-colors">编辑</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
