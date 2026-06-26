import React, { useState, useEffect } from 'react'
import { Plus, Search, Shield, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { Modal } from '@/components/ui/Modal'

interface QualityCost {
  id: string
  yearMonth: string
  costType: string
  subType: string
  amount: number
  description: string
}

interface QualitySummary {
  totalQualityCost: number
  preventionCost: number
  appraisalCost: number
  internalFailureCost: number
  externalFailureCost: number
}

const COST_TYPE_LABELS: Record<string, string> = {
  prevention: '预防成本',
  appraisal: '鉴定成本',
  internal_failure: '内部失败',
  external_failure: '外部失败',
}

const COST_TYPE_OPTIONS = [
  { value: 'prevention', label: '预防成本' },
  { value: 'appraisal', label: '鉴定成本' },
  { value: 'internal_failure', label: '内部失败' },
  { value: 'external_failure', label: '外部失败' },
]

const SUB_TYPE_OPTIONS: Record<string, { value: string; label: string }[]> = {
  prevention: [
    { value: 'training', label: '培训费用' },
    { value: 'process_improvement', label: '流程改进' },
    { value: 'quality_planning', label: '质量规划' },
    { value: 'supplier_audit', label: '供应商审核' },
  ],
  appraisal: [
    { value: 'inspection', label: '检验费用' },
    { value: 'testing', label: '测试费用' },
    { value: 'calibration', label: '设备校准' },
    { value: 'quality_audit', label: '质量审核' },
  ],
  internal_failure: [
    { value: 'rework', label: '返工费用' },
    { value: 'scrap', label: '报废损失' },
    { value: 'retesting', label: '复检费用' },
    { value: 'downtime', label: '停工损失' },
  ],
  external_failure: [
    { value: 'complaint', label: '投诉处理' },
    { value: 'recall', label: '召回费用' },
    { value: 'warranty', label: '保修费用' },
    { value: 'liability', label: '赔偿费用' },
  ],
}

const COST_TYPE_ICONS: Record<string, typeof Shield> = {
  prevention: Shield,
  appraisal: CheckCircle,
  internal_failure: XCircle,
  external_failure: AlertTriangle,
}

const COST_TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  prevention: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  appraisal: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
  internal_failure: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
  external_failure: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
}

const getSubTypeLabel = (costType: string, subType: string) =>
  SUB_TYPE_OPTIONS[costType]?.find(option => option.value === subType)?.label || subType

const normalizeQualityCosts = (response: any): QualityCost[] => {
  if (Array.isArray(response)) return response
  if (Array.isArray(response?.list)) return response.list
  if (Array.isArray(response?.items)) return response.items
  if (Array.isArray(response?.data)) return response.data
  if (Array.isArray(response?.data?.list)) return response.data.list
  if (Array.isArray(response?.data?.items)) return response.data.items
  return []
}

const normalizeQualitySummary = (response: any): QualitySummary | null =>
  response?.data || response || null

export default function QualityCostAnalysis() {
  const urlParams = new URLSearchParams(window.location.search)
  const [deepLinkKeyword] = useState(() => urlParams.get('keyword')?.trim() || '')
  const [costs, setCosts] = useState<QualityCost[]>([])
  const [summary, setSummary] = useState<QualitySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [filterMonth, setFilterMonth] = useState(() => (
    urlParams.get('month')?.trim() ||
    urlParams.get('yearMonth')?.trim() ||
    (deepLinkKeyword ? '' : new Date().toISOString().slice(0, 7))
  ))
  const [searchKeyword, setSearchKeyword] = useState(deepLinkKeyword)
  const [showDialog, setShowDialog] = useState(false)
  const [editingCost, setEditingCost] = useState<QualityCost | null>(null)
  const [formData, setFormData] = useState({
    yearMonth: new Date().toISOString().slice(0, 7),
    costType: 'prevention',
    subType: 'training',
    amount: '',
    description: '',
  })

  useEffect(() => {
    loadData()
  }, [filterMonth])

  const loadData = async () => {
    try {
      setLoading(true)
      const params: Record<string, string> = {}
      if (filterMonth) params.yearMonth = filterMonth
      if (deepLinkKeyword) params.keyword = deepLinkKeyword
      const [costsRes, summaryRes] = await Promise.all([
        abcApi.getQualityCosts(params),
        abcApi.getQualityCostSummary(filterMonth || undefined),
      ])
      setCosts(normalizeQualityCosts(costsRes))
      setSummary(normalizeQualitySummary(summaryRes))
    } catch {
      toast.error('加载质量成本数据失败')
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setEditingCost(null)
    setFormData({
      yearMonth: new Date().toISOString().slice(0, 7),
      costType: 'prevention',
      subType: 'training',
      amount: '',
      description: '',
    })
  }

  const handleAdd = () => {
    resetForm()
    setShowDialog(true)
  }

  const handleEdit = (cost: QualityCost) => {
    setEditingCost(cost)
    setFormData({
      yearMonth: cost.yearMonth,
      costType: cost.costType,
      subType: cost.subType,
      amount: String(cost.amount),
      description: cost.description || '',
    })
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (qualityCostValidationMessage) {
      toast.error(qualityCostValidationMessage)
      return
    }
    const amount = parseFloat(formData.amount)
    try {
      const payload = {
        yearMonth: formData.yearMonth,
        costType: formData.costType,
        subType: formData.subType,
        amount,
        description: formData.description,
      }
      if (editingCost) {
        await abcApi.updateQualityCost(editingCost.id, payload)
      } else {
        await abcApi.createQualityCost(payload)
      }
      toast.success(editingCost ? '更新成功' : '录入成功')
      setShowDialog(false)
      setEditingCost(null)
      loadData()
    } catch {
      toast.error(editingCost ? '更新失败' : '录入失败')
    }
  }

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value)

  const handleCostTypeChange = (costType: string) => {
    const subTypes = SUB_TYPE_OPTIONS[costType]
    setFormData({
      ...formData,
      costType,
      subType: subTypes?.[0]?.value || '',
    })
  }

  const summaryCards = [
    { key: 'prevention', label: '预防成本', value: summary?.preventionCost || 0 },
    { key: 'appraisal', label: '鉴定成本', value: summary?.appraisalCost || 0 },
    { key: 'internal_failure', label: '内部失败', value: summary?.internalFailureCost || 0 },
    { key: 'external_failure', label: '外部失败', value: summary?.externalFailureCost || 0 },
  ]
  const qualityCostDownstreamFacts = '质量成本、成本预算、成本看板、质量改进、审计记录'
  const qualityCostAmount = Number(formData.amount || 0)
  const qualityCostValidationMessage = !formData.yearMonth || !formData.costType || !formData.subType || !formData.amount
    ? '请填写月份、成本类型、子类型和金额，系统才能建立质量成本记录。'
    : !Number.isFinite(qualityCostAmount) || qualityCostAmount <= 0
      ? '请填写大于 0 的金额，系统才能纳入质量成本、预算和看板统计。'
      : !formData.description.trim()
        ? '请填写描述，系统才能解释质量成本来源、改进动作和审计依据。'
        : ''
  const canSaveQualityCost = qualityCostValidationMessage === ''

  const filteredCosts = costs.filter(c => {
    if (!searchKeyword) return true
    const typeLabel = COST_TYPE_LABELS[c.costType] || c.costType
    const subTypeLabel = getSubTypeLabel(c.costType, c.subType)
    return (
      typeLabel.includes(searchKeyword) ||
      subTypeLabel.includes(searchKeyword) ||
      c.id.includes(searchKeyword) ||
      c.yearMonth.includes(searchKeyword) ||
      c.costType.includes(searchKeyword) ||
      c.subType.includes(searchKeyword) ||
      c.description?.includes(searchKeyword)
    )
  })

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">质量成本分析</h1>
          <p className="text-sm text-gray-500 mt-1">ISO 15189 质量成本分类管理：预防/鉴定/失败成本</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="month"
            value={filterMonth}
            onChange={(e) => setFilterMonth(e.target.value)}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
          <button
            onClick={handleAdd}
            className="h-10 px-4 bg-[#3b82f6] text-white rounded-md hover:bg-blue-600 transition-colors flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            录入质量成本
          </button>
        </div>
      </div>

      {/* 四类质量成本卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map(card => {
          const Icon = COST_TYPE_ICONS[card.key]
          const colors = COST_TYPE_COLORS[card.key]
          return (
            <div
              key={card.key}
              className={`bg-white rounded-lg border border-gray-200 p-4`}
            >
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors.bg}`}>
                  <Icon className={`h-4 w-4 ${colors.text}`} />
                </div>
                <span className="text-sm text-gray-500">{card.label}</span>
              </div>
              <div className="text-2xl font-bold text-gray-900">{formatCurrency(card.value)}</div>
              {summary?.totalQualityCost ? (
                <div className="text-xs text-gray-400 mt-1">
                  占比 {((card.value / summary.totalQualityCost) * 100).toFixed(1)}%
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* 总计卡片 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">质量成本总计</span>
          <span className="text-xl font-bold text-gray-900">{formatCurrency(summary?.totalQualityCost || 0)}</span>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
          <input
            type="text"
            placeholder="搜索质量成本..."
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            className="w-full h-10 pl-10 pr-4 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
        </div>
      </div>

      {/* 质量成本明细表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">月份</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">成本类型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">子类型</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">金额</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">描述</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : filteredCosts.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-400">暂无质量成本数据</td>
              </tr>
            ) : (
              filteredCosts.map(cost => {
                const colors = COST_TYPE_COLORS[cost.costType]
                return (
                  <tr key={cost.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900">{cost.yearMonth}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs ${colors?.bg} ${colors?.text}`}>
                        {COST_TYPE_LABELS[cost.costType] || cost.costType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{getSubTypeLabel(cost.costType, cost.subType)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(cost.amount)}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{cost.description || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleEdit(cost)}
                        className="text-sm text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 录入弹窗 */}
      {showDialog && (
        <Modal onClose={() => setShowDialog(false)} title={editingCost ? '编辑质量成本' : '录入质量成本'}>
          <div className="space-y-4">
            <div>
              <label htmlFor="quality-cost-year-month" className="block text-sm font-medium text-gray-700 mb-1">月份 *</label>
              <input
                id="quality-cost-year-month"
                type="month"
                value={formData.yearMonth}
                onChange={(e) => setFormData({ ...formData, yearMonth: e.target.value })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor="quality-cost-type" className="block text-sm font-medium text-gray-700 mb-1">成本类型 *</label>
              <select
                id="quality-cost-type"
                value={formData.costType}
                onChange={(e) => handleCostTypeChange(e.target.value)}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                {COST_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="quality-cost-sub-type" className="block text-sm font-medium text-gray-700 mb-1">子类型 *</label>
              <select
                id="quality-cost-sub-type"
                value={formData.subType}
                onChange={(e) => setFormData({ ...formData, subType: e.target.value })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                {(SUB_TYPE_OPTIONS[formData.costType] || []).map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="quality-cost-amount" className="block text-sm font-medium text-gray-700 mb-1">金额 (元) *</label>
              <input
                id="quality-cost-amount"
                type="number"
                min="0"
                step="0.01"
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                placeholder="0.00"
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor="quality-cost-description" className="block text-sm font-medium text-gray-700 mb-1">描述 *</label>
              <textarea
                id="quality-cost-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="成本描述说明"
                rows={3}
                className="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-emerald-900">质量成本结果确认</div>
                <div className="text-xs text-emerald-700">确认后将接住：{qualityCostDownstreamFacts}</div>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-emerald-700 sm:grid-cols-2">
                <div>月份 {formData.yearMonth || '-'}</div>
                <div>成本类型 {COST_TYPE_LABELS[formData.costType] || formData.costType}</div>
                <div>子类型 {getSubTypeLabel(formData.costType, formData.subType)}</div>
                <div>金额 {formatCurrency(Number.isFinite(qualityCostAmount) ? qualityCostAmount : 0)}</div>
                <div>描述 {formData.description.trim() || '待填写'}</div>
              </div>
            </div>
            {qualityCostValidationMessage ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                {qualityCostValidationMessage}
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-200">
            <button
              onClick={() => setShowDialog(false)}
              className="h-10 px-4 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!canSaveQualityCost}
              className="h-10 px-4 text-sm text-white bg-[#3b82f6] rounded-md hover:bg-blue-600 transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {editingCost ? '更新' : '录入'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
