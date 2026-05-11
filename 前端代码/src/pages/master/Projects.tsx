import { useState, useEffect, useMemo } from 'react'
import {
  Search, Plus, Edit2, Trash2, X, ChevronLeft, ChevronRight,
  Eye, Copy, Upload, CheckCircle, ArrowRight, ArrowLeft,
  FolderOpen, AlertTriangle, FileText, Loader2, Download
} from 'lucide-react'
import { projectApi, bomApi } from '@/api/master'
import type { Project, BOM } from '@/types'
import { toast } from 'sonner'

type ModalType = 'create' | 'edit' | 'copy' | 'delete' | 'import' | null

interface FormData {
  code: string
  name: string
  type: string
  cycle: string
  manager: string
  description: string
  supportableSamples: number
  status: 'active' | 'inactive'
}

const typeOptions = [
  { value: '', label: '全部类型' },
  { value: 'he', label: '病理技术-HE制片' },
  { value: 'ihc', label: '病理技术-免疫组化' },
  { value: 'ss', label: '病理技术-特殊染色' },
  { value: 'mp', label: '分子诊断' },
  { value: 'cyto', label: '病理诊断-细胞学检测' },
]

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '已启用' },
  { value: 'inactive', label: '已停用' },
]

const bomOptions = [
  { value: '', label: 'BOM配置' },
  { value: 'configured', label: '已配置' },
  { value: 'unconfigured', label: '未配置' },
]

const typeMap: Record<string, string> = {
  he: '病理技术',
  ihc: '病理技术',
  ss: '病理技术',
  mp: '分子诊断',
  cyto: '病理诊断',
}

const typeBadgeClass: Record<string, string> = {
  he: 'bg-blue-50 text-blue-600',
  ihc: 'bg-indigo-50 text-indigo-600',
  ss: 'bg-teal-50 text-teal-600',
  mp: 'bg-purple-50 text-purple-600',
  cyto: 'bg-amber-50 text-amber-600',
}

export default function Projects() {
  const [data, setData] = useState<Project[]>([])
  const [boms, setBoms] = useState<BOM[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [bomFilter, setBomFilter] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20
  const [modalType, setModalType] = useState<ModalType>(null)
  const [editingRow, setEditingRow] = useState<Project | null>(null)
  const [form, setForm] = useState<FormData>({
    code: '', name: '', type: 'he', cycle: '', manager: '',
    description: '', supportableSamples: 0, status: 'active'
  })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editTab, setEditTab] = useState<'basic' | 'bom'>('basic')
  const [createStep, setCreateStep] = useState(1)
  const [bomOption, setBomOption] = useState<'select' | 'create' | 'skip'>('select')
  const [selectedBomId, setSelectedBomId] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const fetchData = async () => {
    setLoading(true)
    try {
      const res: any = await projectApi.getList({
        page, pageSize, keyword: keyword || undefined
      })
      setData(res.list || [])
      setTotal(res.pagination?.total || 0)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  const fetchBoms = async () => {
    try {
      const res: any = await bomApi.getList({ page: 1, pageSize: 999 })
      setBoms(res.list || [])
    } catch (e) { console.error(e) }
  }

  useEffect(() => { fetchData() }, [page, keyword])

  const filteredData = useMemo(() => {
    let list = [...data]
    if (typeFilter) list = list.filter(r => r.type === typeFilter)
    if (statusFilter) list = list.filter(r => r.status === statusFilter)
    if (bomFilter) {
      if (bomFilter === 'configured') list = list.filter(r => r.bomId)
      if (bomFilter === 'unconfigured') list = list.filter(r => !r.bomId)
    }
    return list
  }, [data, typeFilter, statusFilter, bomFilter])

  const stats = useMemo(() => {
    const total = data.length
    const active = data.filter(s => s.status === 'active').length
    const inactive = data.filter(s => s.status === 'inactive').length
    const noBom = data.filter(s => !s.bomId).length
    return { total, active, inactive, noBom }
  }, [data])

  const openCreate = () => {
    setEditingRow(null)
    setForm({
      code: '', name: '', type: 'he', cycle: '', manager: '',
      description: '', supportableSamples: 0, status: 'active'
    })
    setCreateStep(1)
    setBomOption('select')
    setSelectedBomId('')
    setModalType('create')
    fetchBoms()
  }

  const openEdit = (row: Project) => {
    setEditingRow(row)
    setForm({
      code: row.code,
      name: row.name,
      type: row.type || 'he',
      cycle: row.cycle || '',
      manager: row.manager || '',
      description: row.description || '',
      supportableSamples: row.supportableSamples || 0,
      status: row.status,
    })
    setEditTab('basic')
    setModalType('edit')
    fetchBoms()
  }

  const openCopy = (row: Project) => {
    setEditingRow(row)
    setForm({
      code: '',
      name: row.name + '（副本）',
      type: row.type || 'he',
      cycle: row.cycle || '',
      manager: row.manager || '',
      description: row.description || '',
      supportableSamples: row.supportableSamples || 0,
      status: 'active',
    })
    setModalType('copy')
  }

  const openDelete = (row: Project) => {
    setEditingRow(row)
    setModalType('delete')
  }

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('请填写必填字段')
      return
    }
    setIsSubmitting(true)
    try {
      if (modalType === 'edit' && editingRow) {
        await projectApi.update(editingRow.id, form)
        toast.success('检测服务已更新')
      } else if (modalType === 'create') {
        await projectApi.create(form)
        toast.success('检测服务已创建')
      } else if (modalType === 'copy' && editingRow) {
        await projectApi.create({ ...form })
        toast.success('检测服务已复制')
      }
      setModalType(null)
      fetchData()
    } catch (e) { toast.error('操作失败') } finally { setIsSubmitting(false) }
  }

  const handleDeleteConfirm = async () => {
    if (!editingRow) return
    try {
      await projectApi.delete(editingRow.id)
      toast.success('已删除')
      setModalType(null)
      fetchData()
    } catch (e) { toast.error('删除失败') }
  }

  const handleQuery = () => { setPage(1); fetchData() }
  const handleReset = () => {
    setKeyword(''); setTypeFilter(''); setStatusFilter(''); setBomFilter('')
    setPage(1); fetchData()
  }

  const toggleSelectAll = (checked: boolean) => {
    if (checked) setSelectedIds(new Set(filteredData.map(r => r.id)))
    else setSelectedIds(new Set())
  }

  const toggleSelectOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds)
    if (checked) next.add(id)
    else next.delete(id)
    setSelectedIds(next)
  }

  const batchEnable = async () => {
    toast.success(`已启用 ${selectedIds.size} 个检测服务`)
    setSelectedIds(new Set())
  }

  const batchDisable = async () => {
    toast.success(`已停用 ${selectedIds.size} 个检测服务`)
    setSelectedIds(new Set())
  }

  const totalPages = Math.ceil(total / pageSize)
  const selectedBom = boms.find(b => b.id === selectedBomId)

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">
            检测服务
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            管理病理实验室检测服务类型和BOM清单关联，监控物料成本与库存支撑能力
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setModalType('import')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium shadow-sm transition-colors"
          >
            <Upload className="w-4 h-4" />导入
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />新建服务
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-blue-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-blue-600">{stats.total}</div>
          <div className="mt-1 text-sm text-gray-500">检测服务总数</div>
        </div>
        <div className="bg-white rounded-lg border border-green-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-green-600">{stats.active}</div>
          <div className="mt-1 text-sm text-gray-500">已启用</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-gray-600">{stats.inactive}</div>
          <div className="mt-1 text-sm text-gray-500">已停用</div>
        </div>
        <div className="bg-white rounded-lg border border-amber-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-amber-600">{stats.noBom}</div>
          <div className="mt-1 text-sm text-gray-500">BOM未配置</div>
        </div>
      </div>

      {/* Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <span className="text-base font-semibold text-gray-900">服务列表</span>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索服务名称/编号..."
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                className="w-56 pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {typeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select
              value={bomFilter}
              onChange={e => setBomFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {bomOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              onClick={handleQuery}
              className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium transition-colors"
            >
              查询
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 text-gray-500 hover:text-gray-700 text-sm font-medium transition-colors"
            >
              重置
            </button>
          </div>
        </div>

        {/* Batch actions */}
        {selectedIds.size > 0 && (
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-3">
            <span className="text-sm text-gray-700">
              已选择 <span className="font-semibold">{selectedIds.size}</span> 项
            </span>
            <button
              onClick={batchEnable}
              className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 transition-colors"
            >
              批量启用
            </button>
            <button
              onClick={batchDisable}
              className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 transition-colors"
            >
              批量停用
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-sm transition-colors"
            >
              取消选择
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={filteredData.length > 0 && selectedIds.size === filteredData.length}
                    onChange={e => toggleSelectAll(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  服务编号
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  服务名称
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  服务类型
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  检测周期
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  BOM配置
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  可支撑样本数
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  状态
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 className="w-5 h-5 animate-spin" />加载中...
                    </div>
                  </td>
                </tr>
              ) : filteredData.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <FolderOpen className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                    <div>暂无检测服务</div>
                    <div className="text-xs mt-1">点击"新建服务"添加检测服务</div>
                  </td>
                </tr>
              ) : filteredData.map(row => (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.id)}
                      onChange={e => toggleSelectOne(row.id, e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.code}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeBadgeClass[row.type] || 'bg-gray-100 text-gray-600'}`}>
                      {typeMap[row.type] || row.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{row.cycle || '-'}</td>
                  <td className="px-4 py-3">
                    {row.bomId ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-700 text-sm">{row.bomName || '已配置'}</span>
                      </div>
                    ) : (
                      <span className="text-gray-400 text-sm">未配置</span>
                    )}
                  </td>
                  <td className={`px-4 py-3 font-medium ${
                    row.supportableSamples !== undefined && row.supportableSamples <= 10
                      ? 'text-red-500'
                      : row.supportableSamples !== undefined && row.supportableSamples <= 50
                        ? 'text-amber-500'
                        : 'text-gray-700'
                  }`}>
                    {row.supportableSamples !== undefined ? row.supportableSamples : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      row.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {row.status === 'active' ? '已启用' : '已停用'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { setEditingRow(row); setModalType('edit') }}
                        className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors"
                      >
                        详情
                      </button>
                      <button
                        onClick={() => openEdit(row)}
                        className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => openCopy(row)}
                        className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors"
                      >
                        复制
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">共 {total} 条记录</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                上一页
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    page === p
                      ? 'bg-blue-500 text-white'
                      : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ===== Modals ===== */}

      {/* Create Modal */}
      {modalType === 'create' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">新建检测服务</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            {/* Step indicator */}
            <div className="px-6 py-4 border-b border-gray-100 shrink-0">
              <div className="flex items-center justify-center gap-2">
                {[1, 2, 3].map((s, i) => (
                  <div key={s} className="flex items-center gap-2">
                    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
                      s === createStep ? 'bg-blue-500 text-white' : s < createStep ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'
                    }`}>
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                        s === createStep ? 'bg-white text-blue-600' : s < createStep ? 'bg-blue-500 text-white' : 'bg-gray-300 text-white'
                      }`}>
                        {s < createStep ? <CheckCircle className="w-3 h-3" /> : s}
                      </span>
                      {s === 1 ? '基本信息' : s === 2 ? 'BOM配置' : '完成'}
                    </div>
                    {i < 2 && (
                      <div className={`w-8 h-0.5 ${s < createStep ? 'bg-blue-500' : 'bg-gray-200'}`} />
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="p-6 overflow-y-auto">
              {createStep === 1 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        服务类型 <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={form.type}
                        onChange={e => setForm({ ...form, type: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                      >
                        <option value="he">病理技术-HE制片</option>
                        <option value="ihc">病理技术-免疫组化</option>
                        <option value="ss">病理技术-特殊染色</option>
                        <option value="mp">分子诊断</option>
                        <option value="cyto">病理诊断-细胞学检测</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        服务编号 <span className="text-red-500">*</span>
                      </label>
                      <input
                        value={form.code}
                        onChange={e => setForm({ ...form, code: e.target.value })}
                        placeholder="请输入服务编号"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        服务名称 <span className="text-red-500">*</span>
                      </label>
                      <input
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        placeholder="请输入服务名称"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">检测周期</label>
                      <input
                        value={form.cycle}
                        onChange={e => setForm({ ...form, cycle: e.target.value })}
                        placeholder="如：1-2个工作日"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">负责人</label>
                      <input
                        value={form.manager}
                        onChange={e => setForm({ ...form, manager: e.target.value })}
                        placeholder="请输入负责人"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                      <select
                        value={form.status}
                        onChange={e => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                      >
                        <option value="active">已启用</option>
                        <option value="inactive">已停用</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">服务描述</label>
                    <textarea
                      value={form.description}
                      onChange={e => setForm({ ...form, description: e.target.value })}
                      rows={3}
                      placeholder="请输入服务描述"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
              )}
              {createStep === 2 && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">BOM清单配置</label>
                    <p className="text-xs text-gray-500 mb-3">
                      配置该检测服务所需的物料清单，可选择已有BOM或新建BOM
                    </p>
                  </div>
                  <div className="flex gap-6 mb-4">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="bom-option"
                        checked={bomOption === 'select'}
                        onChange={() => setBomOption('select')}
                        className="text-blue-600"
                      />选择已有BOM
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="bom-option"
                        checked={bomOption === 'create'}
                        onChange={() => setBomOption('create')}
                        className="text-blue-600"
                      />新建BOM
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="bom-option"
                        checked={bomOption === 'skip'}
                        onChange={() => setBomOption('skip')}
                        className="text-blue-600"
                      />稍后配置
                    </label>
                  </div>
                  {bomOption === 'select' && (
                    <div className="space-y-3">
                      <select
                        value={selectedBomId}
                        onChange={e => setSelectedBomId(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      >
                        <option value="">请选择BOM清单</option>
                        {boms.map(b => (
                          <option key={b.id} value={b.id}>{b.code} - {b.name} ({b.version})</option>
                        ))}
                      </select>
                      {selectedBom && (
                        <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium">BOM预览</span>
                          </div>
                          <div className="flex flex-wrap gap-2 mb-3">
                            {selectedBom.materials?.slice(0, 5).map(m => (
                              <span
                                key={m.id}
                                className="px-2 py-1 bg-white border border-gray-200 rounded text-xs text-gray-600"
                              >
                                {m.name}
                              </span>
                            ))}
                            {(selectedBom.materials?.length || 0) > 5 && (
                              <span className="text-xs text-gray-400">+{selectedBom.materials!.length - 5}项</span>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-500 border-t border-gray-200 pt-3">
                            <span>共 {selectedBom.materialCount} 项物料</span>
                            <span>
                              可支撑样本数:{' '}
                              <span className="text-green-600 font-medium">
                                {selectedBom.supportableSamples || '-'}
                              </span>
                            </span>
                            <span>
                              单样本成本:{' '}
                              <span className="text-blue-600 font-medium">
                                ¥{selectedBom.unitCost?.toFixed(2) || '-'}
                              </span>
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {bomOption === 'create' && (
                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                      <FileText className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                      <p className="text-sm text-gray-500 mb-4">
                        创建完成后，在编辑页面配置BOM清单
                      </p>
                      <button className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">
                        前往BOM管理
                      </button>
                    </div>
                  )}
                  {bomOption === 'skip' && (
                    <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
                      <p className="text-sm text-amber-700">
                        未配置BOM的检测服务将无法计算成本和自动扣减库存，请尽快完成配置
                      </p>
                    </div>
                  )}
                </div>
              )}
              {createStep === 3 && (
                <div className="text-center py-10">
                  <CheckCircle className="w-14 h-14 mx-auto mb-4 text-green-500" />
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">创建成功！</h3>
                  <p className="text-gray-500 mb-6">检测服务已创建完成</p>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={() => setModalType(null)}
                      className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
                    >
                      返回列表
                    </button>
                    <button className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600">
                      查看详情
                    </button>
                  </div>
                </div>
              )}
            </div>
            {createStep < 3 && (
              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
                <button
                  onClick={() => setModalType(null)}
                  className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300"
                >
                  取消
                </button>
                {createStep > 1 && (
                  <button
                    onClick={() => setCreateStep(s => s - 1)}
                    className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 flex items-center gap-1"
                  >
                    <ArrowLeft className="w-4 h-4" />上一步
                  </button>
                )}
                <button
                  onClick={() => {
                    if (createStep === 1) {
                      if (!form.type || !form.code.trim() || !form.name.trim()) {
                        toast.error('请填写必填字段')
                        return
                      }
                      setCreateStep(2)
                    } else if (createStep === 2) {
                      handleSubmit()
                      setCreateStep(3)
                    }
                  }}
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1"
                >
                  {isSubmitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : createStep === 2 ? (
                    '创建'
                  ) : (
                    <>
                      下一步<ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {modalType === 'edit' && editingRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">编辑检测服务</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="px-6 pt-4 border-b border-gray-100 shrink-0">
              <div className="flex gap-1">
                <button
                  onClick={() => setEditTab('basic')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    editTab === 'basic'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  基本信息
                </button>
                <button
                  onClick={() => setEditTab('bom')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    editTab === 'bom'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  BOM配置
                </button>
              </div>
            </div>
            <div className="p-6 overflow-y-auto">
              {editTab === 'basic' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">服务类型</label>
                      <select
                        value={form.type}
                        onChange={e => setForm({ ...form, type: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      >
                        <option value="he">病理技术-HE制片</option>
                        <option value="ihc">病理技术-免疫组化</option>
                        <option value="ss">病理技术-特殊染色</option>
                        <option value="mp">分子诊断</option>
                        <option value="cyto">病理诊断-细胞学检测</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">服务编号</label>
                      <input
                        value={form.code}
                        readOnly
                        className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-gray-50 text-gray-500"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        服务名称 <span className="text-red-500">*</span>
                      </label>
                      <input
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">检测周期</label>
                      <input
                        value={form.cycle}
                        onChange={e => setForm({ ...form, cycle: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">负责人</label>
                      <input
                        value={form.manager}
                        onChange={e => setForm({ ...form, manager: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                      <div className="flex gap-4 mt-2">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="edit-status"
                            checked={form.status === 'active'}
                            onChange={() => setForm({ ...form, status: 'active' })}
                            className="text-blue-600"
                          />已启用
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name="edit-status"
                            checked={form.status === 'inactive'}
                            onChange={() => setForm({ ...form, status: 'inactive' })}
                            className="text-blue-600"
                          />已停用
                        </label>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">服务描述</label>
                    <textarea
                      value={form.description}
                      onChange={e => setForm({ ...form, description: e.target.value })}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        当前BOM: {editingRow.bomId ? (editingRow.bomName || '已配置') : '未配置'}
                      </span>
                      <button className="text-sm text-blue-600 hover:text-blue-700">
                        前往BOM管理
                      </button>
                    </div>
                  </div>
                  {editingRow.bomId && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border border-gray-200 rounded-lg">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">序号</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">规格型号</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">用量/样本</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单位</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单价</th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库存状态</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {boms.find(b => b.id === editingRow.bomId)?.materials?.map((m, i) => (
                            <tr key={m.id} className="hover:bg-gray-50">
                              <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                              <td className="px-3 py-2 font-medium">{m.name}</td>
                              <td className="px-3 py-2 text-gray-500">{m.spec}</td>
                              <td className="px-3 py-2">{m.usagePerSample}</td>
                              <td className="px-3 py-2">{m.unit}</td>
                              <td className="px-3 py-2">¥{m.price}/{m.unit}</td>
                              <td className="px-3 py-2">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                  m.stock > 10 ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'
                                }`}>
                                  {m.stock > 10 ? '充足' : '偏低'}
                                </span>
                              </td>
                            </tr>
                          )) || (
                            <tr>
                              <td colSpan={7} className="px-3 py-4 text-center text-gray-400 text-sm">
                                暂无物料数据
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">
                      更换BOM
                    </button>
                    <button className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-sm">
                      编辑BOM详情
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 shrink-0">
              <button
                onClick={() => openDelete(editingRow)}
                className="px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-md border border-red-200"
              >
                删除服务
              </button>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setModalType(null)}
                  className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300"
                >
                  取消
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1"
                >
                  {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Copy Modal */}
      {modalType === 'copy' && editingRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">复制检测服务</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-xs text-gray-500 mb-1">原服务</div>
                <div className="font-semibold text-sm">{editingRow.code} {editingRow.name}</div>
                <div className="text-xs text-gray-500 mt-1">
                  BOM: {editingRow.bomId ? (editingRow.bomName || '已配置') : '未配置'}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  新服务名称 <span className="text-red-500">*</span>
                </label>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">复制内容</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked readOnly className="text-blue-600" />
                    基本信息（类型、周期、负责人）
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked readOnly className="text-blue-600" />
                    BOM配置（物料清单关联）
                  </label>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setModalType(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50"
              >
                确认复制
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {modalType === 'delete' && editingRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 text-center">
              <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-red-500" />
              <h3 className="text-base font-semibold text-gray-900 mb-2">
                确定要删除该检测服务吗？
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                删除后将无法恢复，关联的BOM配置将解除关联
              </p>
              <div className="bg-gray-50 rounded-lg p-3 text-left">
                <div className="text-xs text-gray-500">待删除服务</div>
                <div className="font-semibold text-sm">{editingRow.code} {editingRow.name}</div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setModalType(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300"
              >
                取消
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 bg-red-500 text-white text-sm rounded-md hover:bg-red-600"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {modalType === 'import' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">导入检测服务</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">选择文件</label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer">
                  <Upload className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm text-gray-500 mb-3">拖拽文件到此处，或点击选择文件</p>
                  <button className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">
                    选择文件
                  </button>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-1">支持格式：.xlsx, .csv</p>
                <button className="text-xs text-blue-600 hover:text-blue-700">下载导入模板</button>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setModalType(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300"
              >
                取消
              </button>
              <button className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600">
                开始导入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
