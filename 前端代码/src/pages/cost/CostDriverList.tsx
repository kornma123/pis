import React, { useEffect, useState } from 'react'
import { Plus, Edit, Trash2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export interface CostDriverTierRule {
  from: number
  to: number | null
  rate: number
  label: string
}

interface CostDriverTierRuleInput {
  from: string | number
  to?: string | number | null
  rate: string | number
  label?: string
}

interface CostDriver {
  id: string
  code: string
  name: string
  unit: string
  calculationMethod: string
  tierRules: CostDriverTierRule[] | null
  description: string
  status: string
  createdAt: string
}

const CALCULATION_METHODS = [
  { value: 'linear', label: '线性' },
  { value: 'tiered', label: '阶梯' },
  { value: 'fixed', label: '固定' },
]

const EMPTY_TIER_RULE = { from: '0', to: '', rate: '', label: '' }

export function normalizeTierRulesForSubmit(rules: CostDriverTierRuleInput[], unit = '') {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { ok: false as const, message: '阶梯成本动因必须配置区间费率' }
  }

  const normalized: CostDriverTierRule[] = []
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    const from = Number(rule.from)
    const hasOpenEnd = rule.to === null || rule.to === undefined || String(rule.to).trim() === ''
    const to = hasOpenEnd ? null : Number(rule.to)
    const rate = Number(rule.rate)

    if (!Number.isFinite(from) || from < 0) {
      return { ok: false as const, message: `第${index + 1}行起始数量必须大于等于0` }
    }
    if (to !== null && (!Number.isFinite(to) || to <= from)) {
      return { ok: false as const, message: `第${index + 1}行结束数量必须大于起始数量` }
    }
    if (!Number.isFinite(rate) || rate < 0) {
      return { ok: false as const, message: `第${index + 1}行费率必须大于等于0` }
    }

    const label = String(rule.label || '').trim() || `${from}${to === null ? `${unit}以上` : `-${to}${unit}`}`
    normalized.push({ from, to, rate, label })
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const rule = normalized[index]
    if (index === 0 && rule.from !== 0) {
      return { ok: false as const, message: '阶梯费率必须从0开始' }
    }
    if (index > 0) {
      const previous = normalized[index - 1]
      if (previous.to === null || rule.from !== previous.to) {
        return { ok: false as const, message: '阶梯区间必须连续且不能重叠' }
      }
    }
    if (rule.to === null && index !== normalized.length - 1) {
      return { ok: false as const, message: '开口阶梯只能放在最后一行' }
    }
  }

  return { ok: true as const, tierRules: normalized }
}

export function formatTierRulesForDisplay(rules: CostDriverTierRule[] | null | undefined, unit = '') {
  if (!Array.isArray(rules) || rules.length === 0) return '-'
  const denominator = unit || '单位'
  return rules
    .map(rule => `${rule.label || `${rule.from}-${rule.to ?? '以上'}`}：¥${rule.rate}/${denominator}`)
    .join('；')
}

export function CostDriverList() {
  const initialKeyword = new URLSearchParams(window.location.search).get('keyword') || ''
  const [costDrivers, setCostDrivers] = useState<CostDriver[]>([])
  const [loading, setLoading] = useState(true)
  const [searchKeyword, setSearchKeyword] = useState(initialKeyword)
  const [showDialog, setShowDialog] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingDriver, setEditingDriver] = useState<CostDriver | null>(null)
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    unit: '',
    calculationMethod: 'linear',
    tierRules: [EMPTY_TIER_RULE],
    description: '',
    status: 'active',
  })

  useEffect(() => {
    loadCostDrivers()
  }, [])

  const loadCostDrivers = async (keywordOverride = searchKeyword) => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      const keyword = keywordOverride.trim()
      if (keyword) params.set('keyword', keyword)
      const url = `/api/v1/abc/cost-drivers${params.toString() ? `?${params.toString()}` : ''}`
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      })
      const data = await response.json()
      if (data.success) {
        setCostDrivers(data.data?.list || data.data?.items || data.data || [])
      }
    } catch (error) {
      console.error('Failed to load cost drivers:', error)
      toast.error('加载成本动因失败')
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = () => {
    setEditingDriver(null)
    setFormData({ code: '', name: '', unit: '', calculationMethod: 'linear', tierRules: [EMPTY_TIER_RULE], description: '', status: 'active' })
    setShowDialog(true)
  }

  const handleEdit = (driver: CostDriver) => {
    setEditingDriver(driver)
    setFormData({
      code: driver.code,
      name: driver.name,
      unit: driver.unit,
      calculationMethod: driver.calculationMethod,
      tierRules: (driver.tierRules || [EMPTY_TIER_RULE]).map(rule => ({
        from: String(rule.from),
        to: rule.to === null ? '' : String(rule.to),
        rate: String(rule.rate),
        label: rule.label || '',
      })),
      description: driver.description || '',
      status: driver.status || 'active',
    })
    setShowDialog(true)
  }

  const updateTierRule = (index: number, key: keyof typeof EMPTY_TIER_RULE, value: string) => {
    setFormData(current => ({
      ...current,
      tierRules: current.tierRules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, [key]: value } : rule
      ),
    }))
  }

  const addTierRule = () => {
    setFormData(current => {
      const previous = current.tierRules[current.tierRules.length - 1]
      return {
        ...current,
        tierRules: [
          ...current.tierRules,
          { from: previous?.to || previous?.from || '0', to: '', rate: previous?.rate || '', label: '' },
        ],
      }
    })
  }

  const removeTierRule = (index: number) => {
    setFormData(current => ({
      ...current,
      tierRules: current.tierRules.length === 1
        ? [EMPTY_TIER_RULE]
        : current.tierRules.filter((_rule, ruleIndex) => ruleIndex !== index),
    }))
  }

  const handleCalculationMethodChange = (calculationMethod: string) => {
    setFormData(current => ({
      ...current,
      calculationMethod,
      tierRules: calculationMethod === 'tiered' && current.tierRules.length === 0 ? [EMPTY_TIER_RULE] : current.tierRules,
    }))
  }

  const handleSave = async () => {
    if (!formData.code || !formData.name || !formData.unit) {
      toast.error('请填写必填字段')
      return
    }

    const payload: Record<string, unknown> = {
      code: formData.code.trim(),
      name: formData.name.trim(),
      unit: formData.unit.trim(),
      calculationMethod: formData.calculationMethod,
      description: formData.description,
      status: formData.status,
      tierRules: null,
    }

    if (formData.calculationMethod === 'tiered') {
      const normalized = normalizeTierRulesForSubmit(formData.tierRules, formData.unit.trim())
      if (!normalized.ok) {
        toast.error(normalized.message)
        return
      }
      payload.tierRules = normalized.tierRules
    }

    try {
      const url = editingDriver
        ? `/api/v1/abc/cost-drivers/${editingDriver.id}`
        : '/api/v1/abc/cost-drivers'

      const response = await fetch(url, {
        method: editingDriver ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(payload),
      })

      const data = await response.json()
      if (data.success) {
        const nextKeyword = editingDriver
          ? searchKeyword
          : String(data.data?.code || payload.code || '').trim()
        toast.success(editingDriver ? '更新成功' : '创建成功')
        setShowDialog(false)
        if (!editingDriver && nextKeyword) {
          setSearchKeyword(nextKeyword)
          await loadCostDrivers(nextKeyword)
        } else {
          await loadCostDrivers()
        }
      } else {
        toast.error(data.error?.message || '操作失败')
      }
    } catch (error) {
      console.error('Failed to save cost driver:', error)
      toast.error('保存失败')
    }
  }

  const handleDeleteClick = (id: string) => {
    setDeletingId(id)
    setShowDeleteConfirm(true)
  }

  const handleDeleteConfirm = async () => {
    if (!deletingId) return

    try {
      const response = await fetch(`/api/v1/abc/cost-drivers/${deletingId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      })

      const data = await response.json()
      if (data.success) {
        toast.success('删除成功')
        loadCostDrivers()
      } else {
        toast.error(data.error?.message || '删除失败')
      }
    } catch (error) {
      console.error('Failed to delete cost driver:', error)
      toast.error('删除失败')
    } finally {
      setShowDeleteConfirm(false)
      setDeletingId(null)
    }
  }

  const filteredDrivers = costDrivers.filter(driver =>
    driver.id.includes(searchKeyword) ||
    driver.name.includes(searchKeyword) ||
    driver.code.includes(searchKeyword) ||
    driver.unit.includes(searchKeyword) ||
    driver.calculationMethod.includes(searchKeyword) ||
    formatTierRulesForDisplay(driver.tierRules, driver.unit).includes(searchKeyword) ||
    driver.description?.includes(searchKeyword)
  )
  const selectedCalculationMethodLabel =
    CALCULATION_METHODS.find(method => method.value === formData.calculationMethod)?.label || formData.calculationMethod
  const tierRulesPreview = (() => {
    if (formData.calculationMethod !== 'tiered') return '不适用'
    const normalized = normalizeTierRulesForSubmit(formData.tierRules, formData.unit.trim())
    return normalized.ok ? formatTierRulesForDisplay(normalized.tierRules, formData.unit.trim()) : '阶梯口径待补齐'
  })()

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">成本动因管理</h1>
          <p className="text-sm text-gray-500 mt-1">配置 ABC 作业成本法的成本动因</p>
        </div>
        <button
          onClick={handleAdd}
          className="h-10 px-4 bg-[#3b82f6] text-white rounded-md hover:bg-blue-600 transition-colors flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          新增成本动因
        </button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
          <input
            type="text"
            placeholder="搜索成本动因..."
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            className="w-full h-10 pl-10 pr-4 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-[980px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">代码</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">名称</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">单位</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">计算方法</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">阶梯口径</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">描述</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : filteredDrivers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">暂无数据</td>
              </tr>
            ) : (
              filteredDrivers.map(driver => (
                <tr key={driver.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-mono text-gray-900">{driver.code}</td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{driver.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{driver.unit}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {CALCULATION_METHODS.find(m => m.value === driver.calculationMethod)?.label || driver.calculationMethod}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 max-w-sm">
                    {driver.calculationMethod === 'tiered' ? formatTierRulesForDisplay(driver.tierRules, driver.unit) : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{driver.description || '-'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      driver.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {driver.status === 'active' ? '启用' : '禁用'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleEdit(driver)} className="p-1 text-gray-400 hover:text-blue-600 transition-colors" title="编辑">
                      <Edit className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDeleteClick(driver.id)} className="p-1 text-gray-400 hover:text-red-600 transition-colors ml-1" title="删除">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showDialog && (
        <Modal onClose={() => setShowDialog(false)} title={editingDriver ? '编辑成本动因' : '新增成本动因'} size="lg">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">代码 *</label>
              <input type="text" value={formData.code} onChange={(e) => setFormData({ ...formData, code: e.target.value })} placeholder="例如：slide_count" disabled={!!editingDriver} className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 disabled:bg-gray-100" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">名称 *</label>
              <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="例如：切片数" className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">单位 *</label>
              <input type="text" value={formData.unit} onChange={(e) => setFormData({ ...formData, unit: e.target.value })} placeholder="例如：张、个、次" className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">计算方法</label>
              <select value={formData.calculationMethod} onChange={(e) => handleCalculationMethodChange(e.target.value)} className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500">
                {CALCULATION_METHODS.map(method => (
                  <option key={method.value} value={method.value}>{method.label}</option>
                ))}
              </select>
            </div>
            {formData.calculationMethod === 'tiered' && (
              <div className="rounded-md border border-gray-200 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="block text-sm font-medium text-gray-700">阶梯费率 *</label>
                  <button type="button" onClick={addTierRule} className="h-8 px-3 text-sm text-[#3b82f6] bg-blue-50 rounded-md hover:bg-blue-100 transition-colors flex items-center gap-1">
                    <Plus className="h-4 w-4" />
                    添加阶梯
                  </button>
                </div>
                <div className="space-y-2">
                  {formData.tierRules.map((rule, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1fr_1fr_1.4fr_auto] gap-2 items-end">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">起始数量</label>
                        <input type="number" min="0" value={rule.from} onChange={(e) => updateTierRule(index, 'from', e.target.value)} className="w-full h-9 px-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">结束数量</label>
                        <input type="number" min="0" value={rule.to} onChange={(e) => updateTierRule(index, 'to', e.target.value)} placeholder="留空为以上" className="w-full h-9 px-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">单位费率</label>
                        <input type="number" min="0" step="0.01" value={rule.rate} onChange={(e) => updateTierRule(index, 'rate', e.target.value)} className="w-full h-9 px-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">阶梯名称</label>
                        <input type="text" value={rule.label} onChange={(e) => updateTierRule(index, 'label', e.target.value)} placeholder="例如：100张以上" className="w-full h-9 px-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
                      </div>
                      <button type="button" onClick={() => removeTierRule(index)} className="h-9 w-9 inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors" title="删除阶梯">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
              <select value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value })} className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500">
                <option value="active">启用</option>
                <option value="inactive">禁用</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
              <textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="成本动因的详细描述" rows={3} className="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500" />
            </div>
            <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-emerald-900">成本动因结果确认</div>
                <div className="text-xs text-emerald-700">确认后将接住：成本动因、作业中心、成本池、动因费率、项目成本、审计记录</div>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-emerald-700 sm:grid-cols-2">
                <div>代码 {formData.code.trim() || '-'}</div>
                <div>名称 {formData.name.trim() || '-'}</div>
                <div>单位 {formData.unit.trim() || '-'}</div>
                <div>计算方法 {selectedCalculationMethodLabel}</div>
                <div>状态 {formData.status === 'active' ? '启用' : '禁用'}</div>
                <div>阶梯口径 {tierRulesPreview}</div>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
            <button onClick={() => setShowDialog(false)} className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">取消</button>
            <button onClick={handleSave} className="h-10 px-4 text-sm text-white bg-[#3b82f6] rounded-md hover:bg-blue-600 transition-colors">{editingDriver ? '更新' : '创建'}</button>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认删除"
        description="确定要删除此成本动因吗？删除后无法恢复。"
        confirmText="确认删除"
        onConfirm={handleDeleteConfirm}
        onCancel={() => { setShowDeleteConfirm(false); setDeletingId(null) }}
      />
    </div>
  )
}
