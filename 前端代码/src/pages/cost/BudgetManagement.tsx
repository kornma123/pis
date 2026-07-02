import React, { useState, useEffect } from 'react'
import { Plus, Search, DollarSign } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { Modal } from '@/components/ui/Modal'

interface Budget {
  id: string
  yearMonth: string
  category: string
  budgetAmount: number
  actualAmount: number
  executionRate?: number
  status?: string
  description?: string
}

interface BudgetQueryOverrides {
  yearMonth?: string
  keyword?: string
}

const CATEGORY_LABELS: Record<string, string> = {
  total: '总预算',
  material: '材料成本',
  labor: '人工成本',
  equipment: '设备折旧',
  qc: '质控成本',
  indirect: '间接成本',
}

const CATEGORY_OPTIONS = [
  { value: 'total', label: '总预算' },
  { value: 'material', label: '材料成本' },
  { value: 'labor', label: '人工成本' },
  { value: 'equipment', label: '设备折旧' },
  { value: 'qc', label: '质控成本' },
  { value: 'indirect', label: '间接成本' },
]

const normalizeBudgetResponse = (response: any): Budget[] => {
  const rows = Array.isArray(response)
    ? response
    : Array.isArray(response?.list)
      ? response.list
      : Array.isArray(response?.items)
        ? response.items
        : Array.isArray(response?.data)
          ? response.data
          : Array.isArray(response?.data?.list)
            ? response.data.list
            : Array.isArray(response?.data?.items)
              ? response.data.items
              : []

  return rows.map((budget: Budget) => {
    const budgetAmount = Number(budget.budgetAmount) || 0
    const actualAmount = Number(budget.actualAmount) || 0
    return {
      ...budget,
      budgetAmount,
      actualAmount,
      executionRate: budget.executionRate ?? (budgetAmount > 0 ? actualAmount / budgetAmount : 0),
      status: budget.status || 'active',
    }
  })
}

export default function BudgetManagement() {
  const urlParams = new URLSearchParams(window.location.search)
  const [deepLinkKeyword] = useState(() => urlParams.get('keyword')?.trim() || '')
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [loading, setLoading] = useState(true)
  const [searchKeyword, setSearchKeyword] = useState(deepLinkKeyword)
  const [backendKeyword, setBackendKeyword] = useState(deepLinkKeyword)
  const [filterMonth, setFilterMonth] = useState(() => urlParams.get('month')?.trim() || urlParams.get('yearMonth')?.trim() || '')
  const [showDialog, setShowDialog] = useState(false)
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null)
  const [formData, setFormData] = useState({
    yearMonth: new Date().toISOString().slice(0, 7),
    category: 'total',
    budgetAmount: '',
    actualAmount: '',
    description: '',
  })

  useEffect(() => {
    loadBudgets()
  }, [filterMonth])

  const loadBudgets = async (overrides: BudgetQueryOverrides = {}) => {
    try {
      setLoading(true)
      const params: Record<string, string> = {}
      const nextMonth = overrides.yearMonth ?? filterMonth
      const nextKeyword = overrides.keyword ?? backendKeyword
      if (nextMonth) params.yearMonth = nextMonth
      if (nextKeyword) params.keyword = nextKeyword
      const data = await abcApi.getBudgets(params)
      setBudgets(normalizeBudgetResponse(data))
    } catch {
      toast.error('加载预算数据失败')
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = () => {
    setEditingBudget(null)
    setFormData({
      yearMonth: new Date().toISOString().slice(0, 7),
      category: 'total',
      budgetAmount: '',
      actualAmount: '',
      description: '',
    })
    setShowDialog(true)
  }

  const handleEdit = (budget: Budget) => {
    setEditingBudget(budget)
    setFormData({
      yearMonth: budget.yearMonth,
      category: budget.category,
      budgetAmount: String(budget.budgetAmount),
      actualAmount: String(budget.actualAmount ?? 0),
      description: budget.description || '',
    })
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (budgetValidationMessage) {
      toast.error(budgetValidationMessage)
      return
    }
    const amount = parseFloat(formData.budgetAmount)
    const actualAmount = formData.actualAmount.trim() ? parseFloat(formData.actualAmount) : 0
    try {
      const payload = {
        yearMonth: formData.yearMonth,
        category: formData.category,
        budgetAmount: amount,
        actualAmount,
        description: formData.description.trim(),
      }
      let focusKeyword = ''
      if (editingBudget) {
        const updated: any = await abcApi.updateBudget(editingBudget.id, payload)
        focusKeyword = String(updated?.id || editingBudget.id).trim()
      } else {
        const created: any = await abcApi.createBudget(payload)
        focusKeyword = String(created?.id || payload.category).trim()
      }
      toast.success(editingBudget ? '更新成功' : '创建成功')
      setSearchKeyword(focusKeyword)
      setBackendKeyword(focusKeyword)
      setFilterMonth(payload.yearMonth)
      setShowDialog(false)
      await loadBudgets({
        yearMonth: payload.yearMonth,
        keyword: focusKeyword,
      })
    } catch {
      toast.error('操作失败')
    }
  }

  const getProgressColor = (rate: number) => {
    if (rate < 0.8) return 'bg-green-500'
    if (rate <= 1) return 'bg-yellow-500'
    return 'bg-red-500'
  }

  const getProgressTextColor = (rate: number) => {
    if (rate < 0.8) return 'text-green-600'
    if (rate <= 1) return 'text-yellow-600'
    return 'text-red-600'
  }

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value)
  const budgetAmountPreview = Number(formData.budgetAmount || 0)
  const actualAmountPreview = Number(formData.actualAmount || 0)
  const safeBudgetAmountPreview = Number.isFinite(budgetAmountPreview) ? budgetAmountPreview : 0
  const safeActualAmountPreview = Number.isFinite(actualAmountPreview) ? actualAmountPreview : 0
  const budgetExecutionRate = safeBudgetAmountPreview > 0 ? safeActualAmountPreview / safeBudgetAmountPreview : 0
  const budgetDownstreamFacts = '成本预算、成本看板、执行进度、成本预警、审计记录'
  const budgetValidationMessage = !formData.yearMonth || !formData.category || !formData.budgetAmount
    ? '请填写月份、成本类型和预算金额，系统才能建立预算跟踪对象。'
    : !Number.isFinite(budgetAmountPreview) || budgetAmountPreview < 0
      ? '请填写大于等于 0 的预算金额，系统才能计算执行进度。'
      : !Number.isFinite(actualAmountPreview) || actualAmountPreview < 0
        ? '请填写大于等于 0 的实际金额，系统才能计算预算执行率。'
        : !formData.description.trim()
          ? '请填写口径说明，系统才能解释预算来源、实际金额口径和审计依据。'
          : ''
  const canSaveBudget = budgetValidationMessage === ''

  const filteredBudgets = budgets.filter(b => {
    if (!searchKeyword) return true
    const label = CATEGORY_LABELS[b.category] || b.category
    return (
      b.id.includes(searchKeyword) ||
      label.includes(searchKeyword) ||
      b.category.includes(searchKeyword) ||
      b.yearMonth.includes(searchKeyword) ||
      Boolean(b.description?.includes(searchKeyword))
    )
  })

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">成本预算管理</h1>
          <p className="text-sm text-gray-500 mt-1">按月份和成本类型配置预算，监控执行进度</p>
        </div>
        <button
          onClick={handleAdd}
          className="h-10 px-4 bg-[#3b82f6] text-white rounded-md hover:bg-blue-600 transition-colors flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          新增预算
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <input
              type="text"
              placeholder="搜索预算类型..."
              value={searchKeyword}
              onChange={(e) => {
                setSearchKeyword(e.target.value)
                setBackendKeyword('')
              }}
              className="w-full h-10 pl-10 pr-4 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
            />
          </div>
          <input
            type="month"
            value={filterMonth}
            onChange={(e) => setFilterMonth(e.target.value)}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          />
          {filterMonth && (
            <button
              onClick={() => setFilterMonth('')}
              className="h-10 px-3 text-sm text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              清除筛选
            </button>
          )}
        </div>
      </div>

      {/* 预算表格 */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">月份</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">成本类型</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">预算金额</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">实际金额</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">口径说明</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase" style={{ minWidth: 200 }}>执行进度</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : filteredBudgets.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">暂无预算数据</td>
              </tr>
            ) : (
              filteredBudgets.map(budget => (
                <tr key={budget.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-900">{budget.yearMonth}</td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    <span className="px-2 py-1 rounded-full text-xs bg-blue-100 text-blue-700">
                      {CATEGORY_LABELS[budget.category] || budget.category}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(budget.budgetAmount)}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(budget.actualAmount)}</td>
                  <td className="px-4 py-3 text-sm text-gray-600 max-w-xs">
                    <span className="line-clamp-2">{budget.description || '-'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${getProgressColor(budget.executionRate ?? 0)}`}
                          style={{ width: `${Math.min((budget.executionRate ?? 0) * 100, 100)}%` }}
                        />
                      </div>
                      <span className={`text-sm font-medium w-14 text-right ${getProgressTextColor(budget.executionRate ?? 0)}`}>
                        {((budget.executionRate ?? 0) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleEdit(budget)}
                      className="text-sm text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      编辑
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 新增/编辑弹窗 */}
      {showDialog && (
        <Modal onClose={() => setShowDialog(false)} title={editingBudget ? '编辑预算' : '新增预算'}>
          <div className="space-y-4">
            <div>
              <label htmlFor="budget-year-month" className="block text-sm font-medium text-gray-700 mb-1">月份 *</label>
              <input
                id="budget-year-month"
                type="month"
                value={formData.yearMonth}
                onChange={(e) => setFormData({ ...formData, yearMonth: e.target.value })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor="budget-category" className="block text-sm font-medium text-gray-700 mb-1">成本类型 *</label>
              <select
                id="budget-category"
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                {CATEGORY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="budget-amount" className="block text-sm font-medium text-gray-700 mb-1">预算金额 (元) *</label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <input
                  id="budget-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.budgetAmount}
                  onChange={(e) => setFormData({ ...formData, budgetAmount: e.target.value })}
                  placeholder="0.00"
                  className="w-full h-10 pl-10 pr-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                />
              </div>
            </div>
            <div>
              <label htmlFor="budget-actual-amount" className="block text-sm font-medium text-gray-700 mb-1">实际金额 (元)</label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <input
                  id="budget-actual-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.actualAmount}
                  onChange={(e) => setFormData({ ...formData, actualAmount: e.target.value })}
                  placeholder="0.00"
                  className="w-full h-10 pl-10 pr-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                />
              </div>
            </div>
            <div>
              <label htmlFor="budget-description" className="block text-sm font-medium text-gray-700 mb-1">口径说明 *</label>
              <textarea
                id="budget-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                placeholder="说明预算口径、实际金额来源或本月特殊调整"
                className="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 resize-none"
              />
            </div>
            <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-emerald-900">预算结果确认</div>
                <div className="text-xs text-emerald-700">确认后将接住：{budgetDownstreamFacts}</div>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-emerald-700 sm:grid-cols-2">
                <div>月份 {formData.yearMonth || '-'}</div>
                <div>成本类型 {CATEGORY_LABELS[formData.category] || formData.category}</div>
                <div>预算金额 {formatCurrency(safeBudgetAmountPreview)}</div>
                <div>实际金额 {formatCurrency(safeActualAmountPreview)}</div>
                <div>执行率 {(budgetExecutionRate * 100).toFixed(1)}%</div>
                <div>口径说明 {formData.description.trim() || '待填写'}</div>
              </div>
            </div>
            {budgetValidationMessage ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                {budgetValidationMessage}
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
              disabled={!canSaveBudget}
              className="h-10 px-4 text-sm text-white bg-[#3b82f6] rounded-md hover:bg-blue-600 transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {editingBudget ? '更新' : '创建'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
