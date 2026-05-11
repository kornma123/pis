import { useState, useEffect, useMemo } from 'react'
import {
  Search, Plus, X, CheckCircle, ArrowRight, ArrowLeft,
  FolderOpen, AlertTriangle, Loader2, BarChart3,
  FileText, ChevronLeft, ChevronRight
} from 'lucide-react'
import request from '@/api/request'
import { materialApi } from '@/api/master'
import type { Material } from '@/types'
import { toast } from 'sonner'

interface StocktakingRecord {
  id: string
  stocktakingNo: string
  materialId: string
  materialName: string
  systemStock: number
  actualStock: number
  difference: number
  operator: string
  createdAt: string
  remark?: string
}

interface FormData {
  materialId: string
  systemStock: number
  actualStock: number
  remark: string
  name: string
  type: 'full' | 'sample'
  scope: string
  manager: string
}

const scopeOptions = [
  { value: '', label: '全部范围' },
  { value: 'all', label: '全部物料' },
  { value: 'category', label: '指定分类' },
  { value: 'location', label: '指定库位' },
]

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
]

export default function Stocktaking() {
  const [data, setData] = useState<StocktakingRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [scopeFilter, setScopeFilter] = useState('')

  const [modalType, setModalType] = useState<'create' | 'detail' | 'adjust' | null>(null)
  const [detailRow, setDetailRow] = useState<StocktakingRecord | null>(null)
  const [createStep, setCreateStep] = useState(1)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [materials, setMaterials] = useState<Material[]>([])
  const [form, setForm] = useState<FormData>({
    materialId: '', systemStock: 0, actualStock: 0, remark: '',
    name: '', type: 'full', scope: 'all', manager: ''
  })

  const fetchData = async () => {
    setLoading(true)
    try {
      const res: any = await request.get('/stocktaking', { params: { page, pageSize, keyword: keyword || undefined } })
      setData(res?.list || [])
      setTotal(res?.pagination?.total || 0)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => { fetchData() }, [page, keyword])

  const stats = useMemo(() => {
    const inProgress = 0
    const completed = data.length
    const diffCount = data.filter(d => d.difference !== 0).length
    const accuracy = data.length > 0
      ? ((data.filter(d => d.difference === 0).length / data.length) * 100).toFixed(1)
      : '100.0'
    return { inProgress, completed, diffCount, accuracy }
  }, [data])

  const openCreate = async () => {
    const res: any = await materialApi.getList({ page: 1, pageSize: 999, status: 'active' })
    setMaterials(res?.list || [])
    setForm({
      materialId: '', systemStock: 0, actualStock: 0, remark: '',
      name: '', type: 'full', scope: 'all', manager: ''
    })
    setCreateStep(1)
    setModalType('create')
  }

  const handleSubmit = async () => {
    if (!form.materialId) { toast.error('请选择物料'); return }
    if (form.actualStock === undefined || form.actualStock === null) {
      toast.error('请输入实盘数量')
      return
    }
    setIsSubmitting(true)
    try {
      await request.post('/stocktaking', {
        materialId: form.materialId,
        systemStock: form.systemStock,
        actualStock: form.actualStock,
        remark: form.remark
      })
      toast.success('盘点记录已创建')
      setModalType(null)
      fetchData()
    } catch (e) { toast.error('操作失败') } finally { setIsSubmitting(false) }
  }

  const openDetail = (row: StocktakingRecord) => {
    setDetailRow(row)
    setModalType('detail')
  }

  const openAdjust = (row: StocktakingRecord) => {
    setDetailRow(row)
    setModalType('adjust')
  }

  const handleQuery = () => { setPage(1); fetchData() }
  const handleReset = () => { setKeyword(''); setStatusFilter(''); setScopeFilter(''); setPage(1); fetchData() }

  const totalPages = Math.ceil(total / pageSize)
  const selectedMaterial = materials.find(m => m.id === form.materialId)

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 leading-tight tracking-tight">库存盘点</h1>
          <p className="mt-1 text-sm text-gray-500">管理库存盘点任务，确保账实相符</p>
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm font-medium shadow-sm transition-colors">
          <Plus className="w-4 h-4" />新建盘点
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-blue-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-blue-600">{stats.inProgress}</div>
          <div className="mt-1 text-sm text-gray-500">进行中</div>
        </div>
        <div className="bg-white rounded-lg border border-green-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-green-600">{stats.completed}</div>
          <div className="mt-1 text-sm text-gray-500">已完成</div>
        </div>
        <div className="bg-white rounded-lg border border-amber-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-amber-600">{stats.diffCount}</div>
          <div className="mt-1 text-sm text-gray-500">待处理差异</div>
        </div>
        <div className="bg-white rounded-lg border border-blue-100 p-5 shadow-sm">
          <div className="text-3xl font-semibold text-blue-600">{stats.accuracy}%</div>
          <div className="mt-1 text-sm text-gray-500">账实相符率</div>
        </div>
      </div>

      {/* Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <span className="text-base font-semibold text-gray-900">盘点记录</span>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="搜索盘点编号/盘点名称..." value={keyword} onChange={e => setKeyword(e.target.value)} className="w-56 pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              {statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              {scopeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button onClick={handleQuery} className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 text-sm font-medium transition-colors">查询</button>
            <button onClick={handleReset} className="px-4 py-2 text-gray-500 hover:text-gray-700 text-sm font-medium transition-colors">重置</button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点编号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点名称</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点范围</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点方式</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">盘点进度</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">差异数量</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">负责人</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">创建时间</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400"><div className="flex items-center justify-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />加载中...</div></td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400"><FolderOpen className="w-10 h-10 mx-auto mb-2 text-gray-300" /><div>暂无盘点记录</div><div className="text-xs mt-1">点击"新建盘点"创建盘点任务</div></td></tr>
              ) : data.map(row => (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.stocktakingNo}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{row.materialName ? `${row.materialName}盘点` : row.stocktakingNo}</td>
                  <td className="px-4 py-3 text-gray-500">全部物料</td>
                  <td className="px-4 py-3 text-gray-500">全盘</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full" style={{ width: '100%' }} />
                      </div>
                      <span className="text-xs text-gray-500">1/1</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-sm font-medium ${row.difference === 0 ? 'text-gray-400' : row.difference > 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {row.difference === 0 ? '0项' : `${Math.abs(row.difference)}项`}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{row.operator || '-'}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-') : '-'}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-600">已完成</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openDetail(row)} className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors">详情</button>
                      {row.difference !== 0 && (
                        <button onClick={() => openAdjust(row)} className="px-2 py-1 text-gray-500 hover:text-blue-600 text-xs font-medium transition-colors">查看差异</button>
                      )}
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
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-40 transition-colors">上一页</button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <button key={p} onClick={() => setPage(p)} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${page === p ? 'bg-blue-500 text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'}`}>{p}</button>
              ))}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-40 transition-colors">下一页</button>
            </div>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {modalType === 'create' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">新建盘点</h3>
              <button onClick={() => setModalType(null)} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-500" /></button>
            </div>
            {/* Step indicator */}
            <div className="px-6 py-4 border-b border-gray-100 shrink-0">
              <div className="flex items-center justify-center gap-2">
                {[1, 2, 3].map((s, i) => (
                  <div key={s} className="flex items-center gap-2">
                    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${s === createStep ? 'bg-blue-500 text-white' : s < createStep ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${s === createStep ? 'bg-white text-blue-600' : s < createStep ? 'bg-blue-500 text-white' : 'bg-gray-300 text-white'}`}>{s < createStep ? <CheckCircle className="w-3 h-3" /> : s}</span>
                      {s === 1 ? '基本信息' : s === 2 ? '确认清单' : '创建完成'}
                    </div>
                    {i < 2 && <div className={`w-8 h-0.5 ${s < createStep ? 'bg-blue-500' : 'bg-gray-200'}`} />}
                  </div>
                ))}
              </div>
            </div>
            <div className="p-6 overflow-y-auto">
              {createStep === 1 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">盘点名称 <span className="text-red-500">*</span></label>
                      <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="请输入盘点名称" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">盘点方式 <span className="text-red-500">*</span></label>
                      <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value as 'full' | 'sample' })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                        <option value="">请选择盘点方式</option>
                        <option value="full">全盘</option>
                        <option value="sample">抽盘</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">盘点范围 <span className="text-red-500">*</span></label>
                      <select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                        <option value="">请选择盘点范围</option>
                        <option value="all">全部物料</option>
                        <option value="category">指定分类</option>
                        <option value="location">指定库位</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">负责人 <span className="text-red-500">*</span></label>
                      <input value={form.manager} onChange={e => setForm({ ...form, manager: e.target.value })} placeholder="请输入负责人" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                    <textarea value={form.remark} onChange={e => setForm({ ...form, remark: e.target.value })} rows={3} placeholder="请输入备注" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                </div>
              )}
              {createStep === 2 && (
                <div className="space-y-4">
                  <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 flex items-start gap-3">
                    <BarChart3 className="w-5 h-5 text-blue-500 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-blue-900">盘点范围预览</div>
                      <div className="text-xs text-blue-700 mt-0.5">全部物料，共 {materials.length} 种</div>
                    </div>
                  </div>
                  <div className="overflow-x-auto max-h-80 border border-gray-200 rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 sticky top-0 z-10">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-10"><input type="checkbox" checked className="rounded border-gray-300 text-blue-600" /></th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料编码</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">分类</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">账面数量</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">库位</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {materials.slice(0, 8).map(m => (
                          <tr key={m.id} className="hover:bg-gray-50">
                            <td className="px-3 py-2"><input type="checkbox" checked className="rounded border-gray-300 text-blue-600" /></td>
                            <td className="px-3 py-2 font-mono text-gray-600 text-xs">{m.code}</td>
                            <td className="px-3 py-2">{m.name}</td>
                            <td className="px-3 py-2 text-gray-500">{m.categoryPath || '-'}</td>
                            <td className="px-3 py-2">{m.stock}</td>
                            <td className="px-3 py-2 text-gray-500">{m.locationName || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between px-2">
                    <span className="text-sm text-gray-500">已选择 <strong>{materials.length}</strong> 种物料</span>
                    <div className="flex gap-2">
                      <button className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">全选</button>
                      <button className="px-3 py-1.5 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">取消全选</button>
                    </div>
                  </div>
                </div>
              )}
              {createStep === 3 && (
                <div className="text-center py-10">
                  <CheckCircle className="w-14 h-14 mx-auto mb-4 text-green-500" />
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">盘点任务创建成功</h3>
                  <p className="text-gray-500 mb-2">盘点编号: <strong className="font-mono">ST-{new Date().getFullYear()}-{String(data.length + 1).padStart(3, '0')}</strong></p>
                  <div className="bg-gray-50 rounded-lg p-4 text-left space-y-2 max-w-sm mx-auto mb-6">
                    <div className="flex justify-between text-sm"><span className="text-gray-500">盘点名称</span><span>{form.name || '-'}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-500">盘点范围</span><span>全部物料</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-500">物料数量</span><span>{materials.length} 种</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-500">负责人</span><span>{form.manager || '-'}</span></div>
                  </div>
                  <div className="flex items-center justify-center gap-3">
                    <button onClick={() => setModalType(null)} className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600">开始盘点</button>
                    <button onClick={() => setModalType(null)} className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md text-sm hover:bg-gray-50">返回列表</button>
                  </div>
                </div>
              )}
            </div>
            {createStep < 3 && (
              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
                <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">取消</button>
                {createStep > 1 && <button onClick={() => setCreateStep(s => s - 1)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300 flex items-center gap-1"><ArrowLeft className="w-4 h-4" />上一步</button>}
                <button onClick={() => {
                  if (createStep === 1) {
                    if (!form.name.trim() || !form.type || !form.scope || !form.manager.trim()) { toast.error('请填写必填字段'); return }
                    setCreateStep(2)
                  } else if (createStep === 2) {
                    setCreateStep(3)
                  }
                }} disabled={isSubmitting} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1">
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : createStep === 2 ? '创建盘点' : <>下一步<ArrowRight className="w-4 h-4" /></>}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {modalType === 'detail' && detailRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">盘点详情 - {detailRow.stocktakingNo}</h3>
              <button onClick={() => setModalType(null)} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-500" /></button>
            </div>
            <div className="p-6 overflow-y-auto space-y-6">
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3">基本信息</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: '盘点编号', value: detailRow.stocktakingNo },
                    { label: '盘点名称', value: detailRow.materialName ? `${detailRow.materialName}盘点` : detailRow.stocktakingNo },
                    { label: '盘点范围', value: '全部物料' },
                    { label: '盘点方式', value: '全盘' },
                    { label: '负责人', value: detailRow.operator || '-' },
                    { label: '创建时间', value: detailRow.createdAt ? new Date(detailRow.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-') : '-' },
                    { label: '盘点进度', value: '100%' },
                    { label: '状态', value: <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-600">已完成</span> },
                  ].map(item => (
                    <div key={item.label}>
                      <div className="text-xs text-gray-500 mb-1">{item.label}</div>
                      <div className="text-sm font-medium text-gray-900">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3">盘点明细</h4>
                <div className="overflow-x-auto border border-gray-200 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料编码</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">物料名称</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">账面数量</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">实盘数量</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">差异数量</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">状态</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      <tr className="hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono text-gray-600 text-xs">{detailRow.materialId}</td>
                        <td className="px-3 py-2">{detailRow.materialName}</td>
                        <td className="px-3 py-2">{detailRow.systemStock}</td>
                        <td className="px-3 py-2">{detailRow.actualStock}</td>
                        <td className="px-3 py-2">
                          <span className={`font-semibold ${detailRow.difference > 0 ? 'text-green-600' : detailRow.difference < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                            {detailRow.difference > 0 ? '+' : ''}{detailRow.difference}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            detailRow.difference === 0 ? 'bg-green-50 text-green-600' :
                            detailRow.difference > 0 ? 'bg-green-50 text-green-600' :
                            'bg-red-50 text-red-600'
                          }`}>
                            {detailRow.difference === 0 ? '相符' : detailRow.difference > 0 ? '盘盈' : '盘亏'}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
              <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">关闭</button>
              {detailRow.difference !== 0 && (
                <button onClick={() => openAdjust(detailRow)} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600">处理差异</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Adjust Modal */}
      {modalType === 'adjust' && detailRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={e => { if (e.target === e.currentTarget) setModalType(null) }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">处理盘点差异</h3>
              <button onClick={() => setModalType(null)} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-500" /></button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-amber-900">发现差异需要处理</div>
                  <div className="text-xs text-amber-700 mt-0.5">选择差异原因后确认调整，系统将自动更新库存并记录操作日志</div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3">差异明细</h4>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                  <div className="p-4 flex items-center gap-4">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${detailRow.difference > 0 ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                      {detailRow.difference > 0 ? '+' : '-'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{detailRow.materialName} ({detailRow.materialId})</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        账面: {detailRow.systemStock} | 实盘: {detailRow.actualStock} | 差异: <span className={detailRow.difference > 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>{detailRow.difference > 0 ? '+' : ''}{detailRow.difference}</span>
                      </div>
                    </div>
                    <select className="px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-32">
                      <option value="">选择原因</option>
                      <option value="normal">正常损耗</option>
                      <option value="record">账务问题</option>
                      <option value="physical">实物问题</option>
                      <option value="other">其他</option>
                    </select>
                    <input placeholder="备注（选填）" className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-28" />
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-500">差异汇总</span>
                  <span className="text-sm font-semibold">净差异: <span className={detailRow.difference > 0 ? 'text-green-600' : 'text-red-600'}>{detailRow.difference > 0 ? '+' : ''}{detailRow.difference}</span></span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">处理说明</label>
                <textarea rows={2} placeholder="请输入处理说明（选填）" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
              <button onClick={() => setModalType(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-300">取消</button>
              <button className="px-4 py-2 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 flex items-center gap-1"><CheckCircle className="w-4 h-4" />确认调整</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
