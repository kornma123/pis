import { useState, useEffect, useMemo } from 'react'
import {
  Plus, Search, X, Download, Upload, FileText,
  AlertTriangle, CheckCircle, XCircle, Clock,
  Layers, FileSpreadsheet
} from 'lucide-react'
import { usePagination } from '@/hooks/usePagination'
import { useUrlParams } from '@/hooks/useUrlParams'
import { Pagination } from '@/components/ui/Pagination'
import { bomApi } from '@/api/master'
import type { BOM, BOMMaterial, BOMVersion } from '@/types'
import { toast } from 'sonner'

/* ===================== 常量与辅助函数 ===================== */

const TYPE_MAP: Record<string, string> = {
  he: 'HE制片',
  ihc: '免疫组化',
  ss: '特殊染色',
  mp: '分子检测',
  cyto: '细胞学',
}

const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'he', label: 'HE制片' },
  { value: 'ihc', label: '免疫组化' },
  { value: 'ss', label: '特殊染色' },
  { value: 'mp', label: '分子检测' },
  { value: 'cyto', label: '细胞学' },
]

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '已启用' },
  { value: 'inactive', label: '已停用' },
]

const QUICK_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '已启用' },
  { key: 'inactive', label: '已停用' },
] as const

/** 根据 BOM 数据计算物料状态（用于表格标签与统计卡片） */
function getMaterialStatus(bom: BOM): 'sufficient' | 'low' | 'insufficient' | 'missing' {
  if (bom.status === 'inactive') return 'missing'
  if (bom.supportableSamples === undefined || bom.supportableSamples === null) return 'missing'
  if (bom.supportableSamples === 0) return 'insufficient'
  if (bom.supportableSamples < 30) return 'low'
  return 'sufficient'
}

/** 状态标签样式配置 */
const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string; border: string }> = {
  sufficient: { label: '充足', bg: 'bg-green-50', text: 'text-green-600', dot: 'bg-green-500', border: 'border-green-200' },
  low: { label: '偏低', bg: 'bg-yellow-50', text: 'text-yellow-600', dot: 'bg-yellow-500', border: 'border-yellow-200' },
  insufficient: { label: '不足', bg: 'bg-orange-50', text: 'text-orange-600', dot: 'bg-orange-500', border: 'border-orange-200' },
  missing: { label: '缺失', bg: 'bg-red-50', text: 'text-red-600', dot: 'bg-red-500', border: 'border-red-200' },
}

/** 快捷筛选对应的颜色 */
const QUICK_FILTER_COLORS: Record<string, { active: string; inactive: string }> = {
  all: { active: 'bg-blue-600 text-white', inactive: 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50' },
  active: { active: 'bg-green-600 text-white', inactive: 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50' },
  inactive: { active: 'bg-gray-600 text-white', inactive: 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50' },
}

function formatDateTime(dt?: string): string {
  if (!dt) return '-'
  const d = new Date(dt)
  if (isNaN(d.getTime())) return dt
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ===================== 子组件 ===================== */

/** 状态标签 */
function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.missing
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text} border ${cfg.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  )
}

/** 统计卡片 */
function StatCard({
  label,
  value,
  icon: Icon,
  colorClass,
}: {
  label: string
  value: number | string
  icon: React.ElementType
  colorClass: string
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-2xl font-semibold text-gray-900">{value}</div>
          <div className="text-sm text-gray-500 mt-1">{label}</div>
        </div>
        <div className={`p-2.5 rounded-lg ${colorClass}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  )
}

/* ===================== 主页面 ===================== */

export default function BOMPage() {
  const url = useUrlParams()

  const initialPage = Math.max(1, url.getNumber('page', 1))
  const initialPageSize = [10, 20, 50, 100].includes(url.getNumber('pageSize', 20))
    ? url.getNumber('pageSize', 20)
    : 20

  /* ---------- 状态 ---------- */
  const [keyword, setKeyword] = useState(url.get('keyword', ''))
  const [searchInput, setSearchInput] = useState(url.get('keyword', ''))

  const [quickFilter, setQuickFilter] = useState<'all' | 'active' | 'inactive'>(
    (url.get('quickFilter', 'all') as 'all' | 'active' | 'inactive') || 'all'
  )
  const [filterType, setFilterType] = useState(url.get('type', ''))
  const [filterStatus, setFilterStatus] = useState(url.get('status', ''))

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 弹窗状态
  const [modalType, setModalType] = useState<
    null | 'create' | 'edit' | 'detail' | 'copy' | 'delete' | 'batchDelete' | 'import' | 'export'
  >(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailBom, setDetailBom] = useState<BOM | null>(null)
  const [detailTab, setDetailTab] = useState<'info' | 'history' | 'usage'>('info')

  // 表单
  const [form, setForm] = useState({
    code: '',
    name: '',
    version: 'v1.0',
    type: 'he',
    serviceId: '',
    description: '',
    supportableSamples: 0,
    status: 'active' as 'active' | 'inactive',
  })

  const [copyForm, setCopyForm] = useState({ name: '', copyInfo: true, copyMaterials: true })

  const effectiveStatus = filterStatus || (quickFilter !== 'all' ? quickFilter : undefined)

  const {
    data,
    loading,
    page,
    pageSize,
    total,
    setPage,
    setPageSize,
    refresh,
  } = usePagination<BOM>({
    fetchFn: async (params) => {
      const res: any = await bomApi.getList({
        ...params,
        keyword: keyword || undefined,
        type: filterType || undefined,
        status: effectiveStatus,
      })
      return {
        list: res?.list || [],
        pagination: res?.pagination,
      }
    },
    initialPage,
    initialPageSize,
    deps: [keyword, filterType, effectiveStatus],
  })

  // URL 同步
  useEffect(() => {
    url.setMultiple({
      page: page > 1 ? page : null,
      pageSize: pageSize !== 20 ? pageSize : null,
      keyword: keyword || null,
      type: filterType || null,
      status: filterStatus || null,
      quickFilter: quickFilter !== 'all' ? quickFilter : null,
    })
  }, [page, pageSize, keyword, filterType, filterStatus, quickFilter])

  /* ---------- 计算值 ---------- */
  const stats = useMemo(() => {
    const all = data
    const sufficient = all.filter((b) => getMaterialStatus(b) === 'sufficient').length
    const low = all.filter((b) => getMaterialStatus(b) === 'low').length
    const insufficient = all.filter((b) => {
      const s = getMaterialStatus(b)
      return s === 'insufficient' || s === 'missing'
    }).length
    return { total: all.length, sufficient, low, insufficient }
  }, [data])

  const isAllSelected = data.length > 0 && selectedIds.size === data.length
  const isIndeterminate = selectedIds.size > 0 && selectedIds.size < data.length

  /* ---------- 事件处理 ---------- */
  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(data.map((d) => d.id)))
    }
  }

  const toggleSelectRow = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const cancelSelection = () => setSelectedIds(new Set())

  const handleSearch = () => {
    setKeyword(searchInput)
    setPage(1)
  }

  const handleReset = () => {
    setSearchInput('')
    setKeyword('')
    setFilterType('')
    setFilterStatus('')
    setQuickFilter('all')
    setPage(1)
  }

  const openCreate = () => {
    setEditingId(null)
    setForm({
      code: '',
      name: '',
      version: 'v1.0',
      type: 'he',
      serviceId: '',
      description: '',
      supportableSamples: 0,
      status: 'active',
    })
    setModalType('create')
  }

  const openEdit = (row: BOM) => {
    setEditingId(row.id)
    setForm({
      code: row.code || '',
      name: row.name || '',
      version: row.version || 'v1.0',
      type: row.type || 'he',
      serviceId: row.serviceId || '',
      description: row.description || '',
      supportableSamples: row.supportableSamples || 0,
      status: row.status as 'active' | 'inactive',
    })
    setModalType('edit')
  }

  const openDetail = async (row: BOM) => {
    try {
      const res: any = await bomApi.getDetail(row.id)
      setDetailBom(res.data || row)
      setDetailTab('info')
      setModalType('detail')
    } catch {
      setDetailBom(row)
      setDetailTab('info')
      setModalType('detail')
    }
  }

  const openCopy = (row: BOM) => {
    setEditingId(row.id)
    setCopyForm({ name: `${row.name}(副本)`, copyInfo: true, copyMaterials: true })
    setModalType('copy')
  }

  const openDelete = (row: BOM) => {
    setEditingId(row.id)
    setModalType('delete')
  }

  const openBatchDelete = () => {
    if (selectedIds.size === 0) {
      toast.warning('请先选择要删除的BOM')
      return
    }
    setModalType('batchDelete')
  }

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('请填写必填项')
      return
    }
    try {
      if (editingId) {
        await bomApi.update(editingId, form)
        toast.success('BOM更新成功')
      } else {
        await bomApi.create(form)
        toast.success('BOM创建成功')
      }
      setModalType(null)
      refresh()
    } catch {
      toast.error('操作失败')
    }
  }

  const handleDelete = async () => {
    if (!editingId) return
    try {
      await bomApi.delete(editingId)
      toast.success('BOM已删除')
      setModalType(null)
      setEditingId(null)
      refresh()
    } catch {
      toast.error('删除失败')
    }
  }

  const handleBatchDelete = async () => {
    try {
      const ids = Array.from(selectedIds)
      await Promise.all(ids.map((id) => bomApi.delete(id)))
      toast.success(`已删除 ${ids.length} 个BOM`)
      setModalType(null)
      setSelectedIds(new Set())
      refresh()
    } catch {
      toast.error('批量删除失败')
    }
  }

  const handleCopy = async () => {
    if (!editingId || !copyForm.name.trim()) {
      toast.error('请输入新BOM名称')
      return
    }
    try {
      const source: any = await bomApi.getDetail(editingId)
      const payload: Partial<BOM> = {
        code: '',
        name: copyForm.name.trim(),
        version: 'v1.0',
        type: source.data?.type || 'he',
        serviceId: copyForm.copyInfo ? source.data?.serviceId : undefined,
        description: copyForm.copyInfo ? source.data?.description : undefined,
        status: 'active',
        materialCount: copyForm.copyMaterials ? source.data?.materialCount || 0 : 0,
        unitCost: copyForm.copyMaterials ? source.data?.unitCost || 0 : 0,
        materials: copyForm.copyMaterials ? source.data?.materials : undefined,
      }
      await bomApi.create(payload)
      toast.success('BOM复制成功')
      setModalType(null)
      refresh()
    } catch {
      toast.error('复制失败')
    }
  }

  const handleImport = () => {
    toast.info('导入功能开发中')
    setModalType(null)
  }

  const handleExport = () => {
    toast.info('导出功能开发中')
    setModalType(null)
  }

  /* ===================== 渲染 ===================== */

  return (
    <div className="space-y-5">
      {/* ---------- 页面头部 ---------- */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">BOM清单</h1>
          <p className="text-sm text-gray-500 mt-1">管理物料清单，配置检测服务所需耗材</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setModalType('import')}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors h-10"
          >
            <Upload className="w-4 h-4" />
            导入
          </button>
          <button
            onClick={() => setModalType('export')}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors h-10"
          >
            <Download className="w-4 h-4" />
            导出
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors h-10 shadow-sm"
          >
            <Plus className="w-4 h-4" />
            新建BOM
          </button>
        </div>
      </div>

      {/* ---------- 统计卡片 ---------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="BOM总数" value={stats.total} icon={Layers} colorClass="bg-blue-50 text-blue-600" />
        <StatCard label="物料充足" value={stats.sufficient} icon={CheckCircle} colorClass="bg-green-50 text-green-600" />
        <StatCard label="库存偏低" value={stats.low} icon={AlertTriangle} colorClass="bg-yellow-50 text-yellow-600" />
        <StatCard label="库存不足" value={stats.insufficient} icon={XCircle} colorClass="bg-red-50 text-red-600" />
      </div>

      {/* ---------- 快速筛选 ---------- */}
      <div className="flex items-center gap-2">
        {QUICK_FILTERS.map((f) => {
          const isActive = quickFilter === f.key
          const colors = QUICK_FILTER_COLORS[f.key]
          return (
            <button
              key={f.key}
              onClick={() => {
                setQuickFilter(f.key as any)
                setFilterStatus('')
                setPage(1)
              }}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                isActive ? colors.active : colors.inactive
              }`}
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {/* ---------- 主卡片：筛选 + 表格 ---------- */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {/* 筛选栏 */}
        <div className="px-5 py-4 border-b border-gray-200 flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="搜索BOM名称/编号..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="w-full h-10 pl-10 pr-4 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={filterType}
              onChange={(e) => { setFilterType(e.target.value); setPage(1) }}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => { setFilterStatus(e.target.value); setPage(1) }}
              className="h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={handleSearch}
              className="h-10 px-4 bg-white text-gray-700 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              查询
            </button>
            <button
              onClick={handleReset}
              className="h-10 px-4 text-gray-500 text-sm font-medium hover:text-gray-700 transition-colors"
            >
              重置
            </button>
          </div>
        </div>

        {/* 批量操作栏 */}
        {selectedIds.size > 0 && (
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-3 flex-wrap">
            <span className="text-sm text-gray-700">
              已选择 <span className="font-semibold text-blue-600">{selectedIds.size}</span> 项
            </span>
            <button
              onClick={() => { toast.info('批量启用功能开发中'); cancelSelection() }}
              className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-xs font-medium hover:bg-gray-50 transition-colors"
            >
              批量启用
            </button>
            <button
              onClick={() => { toast.info('批量停用功能开发中'); cancelSelection() }}
              className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-xs font-medium hover:bg-gray-50 transition-colors"
            >
              批量停用
            </button>
            <button
              onClick={openBatchDelete}
              className="px-3 py-1.5 bg-red-600 text-white border border-red-600 rounded-md text-xs font-medium hover:bg-red-700 transition-colors"
            >
              批量删除
            </button>
            <button
              onClick={cancelSelection}
              className="px-3 py-1.5 text-gray-500 text-xs font-medium hover:text-gray-700 transition-colors"
            >
              取消选择
            </button>
          </div>
        )}

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-12 px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    ref={(el) => { if (el) el.indeterminate = isIndeterminate }}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">BOM编号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">BOM名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">关联检测服务</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">版本</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料数</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">可支撑样本数</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">物料状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">更新时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <Clock className="w-5 h-5 animate-spin" />
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                    <div className="flex flex-col items-center gap-2">
                      <FileText className="w-12 h-12 text-gray-300" />
                      <p className="text-sm">暂无BOM数据</p>
                      <p className="text-xs text-gray-400">点击“新建BOM”添加物料清单</p>
                    </div>
                  </td>
                </tr>
              ) : (
                data.map((row) => {
                  const mStatus = getMaterialStatus(row)
                  const selected = selectedIds.has(row.id)
                  const supportable = row.supportableSamples
                  const supportableClass =
                    supportable === undefined || supportable === null
                      ? 'text-gray-400'
                      : supportable === 0
                      ? 'text-red-600 font-medium'
                      : supportable < 30
                      ? 'text-yellow-600 font-medium'
                      : 'text-gray-700'

                  return (
                    <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSelectRow(row.id)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{row.code}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 text-sm">{row.name}</div>
                        {row.description && (
                          <div className="text-xs text-gray-400 mt-0.5 line-clamp-1">{row.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{row.serviceName || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.version || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.materialCount ?? 0}</td>
                      <td className={`px-4 py-3 ${supportableClass}`}>
                        {supportable !== undefined && supportable !== null ? supportable : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={mStatus} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDateTime(row.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openDetail(row)}
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
                          <button
                            onClick={() => {
                              if (row.status === 'active') {
                                toast.info('停用功能开发中')
                              } else {
                                toast.info('启用功能开发中')
                              }
                            }}
                            className="px-2 py-1 text-gray-500 hover:text-yellow-600 text-xs font-medium transition-colors"
                          >
                            {row.status === 'active' ? '停用' : '启用'}
                          </button>
                          <button
                            onClick={() => openDelete(row)}
                            className="px-2 py-1 text-gray-500 hover:text-red-600 text-xs font-medium transition-colors"
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* ===================== 弹窗 ===================== */}

      {/* ---------- 新建/编辑 BOM ---------- */}
      {(modalType === 'create' || modalType === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">
                {modalType === 'create' ? '新建BOM' : '编辑BOM'}
              </h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    BOM名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="请输入BOM名称"
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    BOM编号 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    placeholder="请输入BOM编号"
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">关联检测服务</label>
                  <input
                    value={form.serviceId}
                    onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
                    placeholder="请选择检测服务"
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">BOM类型</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                  >
                    {TYPE_OPTIONS.filter((o) => o.value).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    {modalType === 'create' ? '初始版本' : '当前版本'}
                  </label>
                  <input
                    value={form.version}
                    readOnly={modalType === 'create'}
                    onChange={(e) => modalType === 'edit' && setForm({ ...form, version: e.target.value })}
                    className={`w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 transition-colors ${
                      modalType === 'create' ? 'bg-gray-50 text-gray-400' : ''
                    }`}
                  />
                  {modalType === 'create' && (
                    <p className="text-xs text-gray-400 mt-1">新建BOM默认版本号为 v1.0</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">状态</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
                    className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                  >
                    <option value="active">已启用</option>
                    <option value="inactive">已停用</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">可支撑样本数</label>
                <input
                  type="number"
                  value={form.supportableSamples}
                  onChange={(e) => setForm({ ...form, supportableSamples: Number(e.target.value) })}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">BOM描述</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  placeholder="请输入BOM描述"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors resize-none"
                />
              </div>
              {/* 物料清单区域（展示性） */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-sm font-medium text-gray-700">物料清单</label>
                  <span className="text-xs text-gray-400">
                    {modalType === 'edit' ? `${detailBom?.materials?.length || 0} 项物料` : '至少添加1项物料'}
                  </span>
                </div>
                <div className="border border-gray-200 rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">序号</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">规格型号</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">用量/样本</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">单位</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {modalType === 'edit' && detailBom?.materials && detailBom.materials.length > 0 ? (
                        detailBom.materials.map((m: BOMMaterial, idx: number) => (
                          <tr key={m.id || idx}>
                            <td className="px-3 py-2 text-gray-500">{idx + 1}</td>
                            <td className="px-3 py-2 font-medium text-gray-900">{m.name}</td>
                            <td className="px-3 py-2 text-gray-500">{m.spec || '-'}</td>
                            <td className="px-3 py-2 text-gray-700">{m.usagePerSample}</td>
                            <td className="px-3 py-2 text-gray-500">{m.unit}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="px-3 py-8 text-center text-gray-400">
                            <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                            <p className="text-xs">暂无物料</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
              <button
                onClick={() => setModalType(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm"
              >
                {modalType === 'create' ? '创建BOM' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- BOM 详情 ---------- */}
      {modalType === 'detail' && detailBom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">BOM详情</h3>
              <button
                onClick={() => setModalType(null)}
                className="p-1.5 hover:bg-gray-100 rounded-md transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="px-6 py-4 border-b border-gray-200 flex-shrink-0">
              <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
                {([
                  { key: 'info', label: '基本信息' },
                  { key: 'history', label: '版本历史' },
                  { key: 'usage', label: '使用记录' },
                ] as const).map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setDetailTab(t.key)}
                    className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      detailTab === t.key
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              {detailTab === 'info' && (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">BOM编号</div>
                      <div className="font-mono text-sm text-gray-900">{detailBom.code}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">BOM名称</div>
                      <div className="text-sm font-medium text-gray-900">{detailBom.name}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">当前版本</div>
                      <div className="text-sm text-gray-900">{detailBom.version}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">状态</div>
                      <div>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            detailBom.status === 'active'
                              ? 'bg-green-50 text-green-600 border border-green-200'
                              : 'bg-gray-100 text-gray-600 border border-gray-200'
                          }`}
                        >
                          {detailBom.status === 'active' ? '已启用' : '已停用'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">关联检测服务</div>
                      <div className="text-sm text-gray-900">{detailBom.serviceName || '-'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">物料数量</div>
                      <div className="text-sm text-gray-900">{detailBom.materialCount ?? 0} 项</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">创建时间</div>
                      <div className="text-sm text-gray-900">{formatDateTime(detailBom.createdAt)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">更新时间</div>
                      <div className="text-sm text-gray-900">{formatDateTime(detailBom.updatedAt)}</div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">物料清单</label>
                    <div className="border border-gray-200 rounded-md overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">序号</th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">物料名称</th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">规格型号</th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">用量/样本</th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">单位</th>
                            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">库存状态</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {detailBom.materials && detailBom.materials.length > 0 ? (
                            detailBom.materials.map((m: BOMMaterial, idx: number) => {
                              let stockStatus = '充足'
                              let stockClass = 'bg-green-50 text-green-600 border-green-200'
                              if (m.stock <= 0) {
                                stockStatus = '不足'
                                stockClass = 'bg-red-50 text-red-600 border-red-200'
                              } else if (m.stock < 10) {
                                stockStatus = '偏低'
                                stockClass = 'bg-yellow-50 text-yellow-600 border-yellow-200'
                              }
                              return (
                                <tr key={m.id || idx}>
                                  <td className="px-4 py-2.5 text-gray-500">{idx + 1}</td>
                                  <td className="px-4 py-2.5 font-medium text-gray-900">{m.name}</td>
                                  <td className="px-4 py-2.5 text-gray-500">{m.spec || '-'}</td>
                                  <td className="px-4 py-2.5 text-gray-700">{m.usagePerSample}</td>
                                  <td className="px-4 py-2.5 text-gray-500">{m.unit}</td>
                                  <td className="px-4 py-2.5">
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${stockClass}`}>
                                      {stockStatus}
                                    </span>
                                  </td>
                                </tr>
                              )
                            })
                          ) : (
                            <tr>
                              <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                                暂无物料数据
                              </td>
                            </tr>
                          )}
                        </tbody>
                        <tfoot className="bg-gray-50">
                          <tr>
                            <td colSpan={6} className="px-4 py-2.5 text-right text-sm text-gray-600">
                              共 {detailBom.materialCount ?? 0} 项物料
                              {detailBom.unitCost > 0 && ` | 单样本成本 ¥${detailBom.unitCost.toFixed(2)}`}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                </div>
              )}
              {detailTab === 'history' && (
                <div className="border border-gray-200 rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">版本号</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">修改说明</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">修改时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {detailBom.versionHistory && detailBom.versionHistory.length > 0 ? (
                        detailBom.versionHistory.map((v: BOMVersion, idx: number) => (
                          <tr key={idx}>
                            <td className="px-4 py-2.5">
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600 border border-blue-200">
                                {v.version}
                              </span>
                              {idx === 0 && (
                                <span className="ml-2 text-xs text-gray-400">当前</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-gray-700">{v.changeLog || '-'}</td>
                            <td className="px-4 py-2.5 text-gray-500 text-xs">{formatDateTime(v.updatedAt)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                            暂无版本历史
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {detailTab === 'usage' && (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <Clock className="w-12 h-12 mb-3 text-gray-300" />
                  <p className="text-sm">使用记录功能开发中</p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 flex-shrink-0">
              <button
                onClick={() => setModalType(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200"
              >
                关闭
              </button>
              <button
                onClick={() => {
                  setModalType(null)
                  openEdit(detailBom)
                }}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm"
              >
                编辑
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 复制 BOM ---------- */}
      {modalType === 'copy' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">复制BOM</h3>
              <button onClick={() => setModalType(null)} className="p-1.5 hover:bg-gray-100 rounded-md transition-colors">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-gray-50 p-4 rounded-lg">
                <div className="text-xs text-gray-500 mb-1">原BOM</div>
                <div className="font-semibold text-gray-900">
                  {data.find((d) => d.id === editingId)?.code} {data.find((d) => d.id === editingId)?.name}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  新BOM名称 <span className="text-red-500">*</span>
                </label>
                <input
                  value={copyForm.name}
                  onChange={(e) => setCopyForm({ ...copyForm, name: e.target.value })}
                  placeholder="请输入新BOM名称"
                  className="w-full h-10 px-3 border border-gray-300 rounded-md text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">复制内容</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={copyForm.copyInfo}
                      onChange={(e) => setCopyForm({ ...copyForm, copyInfo: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">基本信息（描述、关联服务）</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={copyForm.copyMaterials}
                      onChange={(e) => setCopyForm({ ...copyForm, copyMaterials: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">物料清单（所有物料及用量）</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200">
                取消
              </button>
              <button onClick={handleCopy} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm">
                确认复制
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 删除确认 ---------- */}
      {modalType === 'delete' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
              <button onClick={() => setModalType(null)} className="p-1.5 hover:bg-gray-100 rounded-md transition-colors">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex flex-col items-center text-center py-4">
                <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-4">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                </div>
                <h4 className="text-base font-semibold text-gray-900 mb-1">确定要删除该BOM吗？</h4>
                <p className="text-sm text-gray-500 mb-4">删除后将无法恢复，关联的检测服务将解除关联</p>
                <div className="w-full bg-gray-50 p-3 rounded-lg text-left">
                  <div className="text-xs text-gray-500 mb-1">待删除BOM</div>
                  <div className="font-semibold text-gray-900">
                    {data.find((d) => d.id === editingId)?.code} {data.find((d) => d.id === editingId)?.name}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200">
                取消
              </button>
              <button onClick={handleDelete} className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 transition-colors">
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 批量删除确认 ---------- */}
      {modalType === 'batchDelete' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">批量删除确认</h3>
              <button onClick={() => setModalType(null)} className="p-1.5 hover:bg-gray-100 rounded-md transition-colors">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex flex-col items-center text-center py-4">
                <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-4">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                </div>
                <h4 className="text-base font-semibold text-gray-900 mb-1">
                  确定要删除选中的 <span className="text-red-600">{selectedIds.size}</span> 个BOM吗？
                </h4>
                <p className="text-sm text-gray-500">删除后将无法恢复</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200">
                取消
              </button>
              <button onClick={handleBatchDelete} className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 transition-colors">
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 导入 BOM ---------- */}
      {modalType === 'import' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">导入BOM</h3>
              <button onClick={() => setModalType(null)} className="p-1.5 hover:bg-gray-100 rounded-md transition-colors">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">选择文件</label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-gray-400 transition-colors">
                  <Upload className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm text-gray-500 mb-3">拖拽文件到此处，或点击选择文件</p>
                  <button className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors">
                    选择文件
                  </button>
                </div>
              </div>
              <div className="bg-gray-50 p-3 rounded-lg">
                <p className="text-xs text-gray-500 mb-1">支持格式：.xlsx, .csv</p>
                <button className="text-xs text-blue-600 hover:text-blue-700 font-medium">下载导入模板</button>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200">
                取消
              </button>
              <button onClick={handleImport} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm">
                开始导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 导出 BOM ---------- */}
      {modalType === 'export' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">导出BOM</h3>
              <button onClick={() => setModalType(null)} className="p-1.5 hover:bg-gray-100 rounded-md transition-colors">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">导出范围</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="export-range" defaultChecked className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">全部BOM</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="export-range" className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">已选中的BOM</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="export-range" className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">当前筛选结果</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">导出格式</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="export-format" defaultChecked className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">Excel (.xlsx)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="export-format" className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">CSV (.csv)</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">导出内容</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">基本信息</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">物料清单</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-sm text-gray-700">版本历史</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
              <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md transition-colors border border-gray-200">
                取消
              </button>
              <button onClick={handleExport} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors shadow-sm">
                确认导出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
