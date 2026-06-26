import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Search, CheckCircle, XCircle, Clock, AlertTriangle, Send } from 'lucide-react'
import { toast } from 'sonner'
import { costAdjustmentApi } from '@/api/master'
import { formatCurrency } from '@/lib/utils'
import { Modal } from '@/components/ui/Modal'
import type { CostAdjustment } from '@/types'

interface Suggestion {
  costCenterId: string
  costCenterName: string
  costCenterCode: string
  costType: string
  yearQuarter: string
  preProvisionAmount: number
  actualAmount: number
  adjustmentAmount: number
  isQuarterEnd: boolean
}

const STATUS_LABELS: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  pending: { label: '待审核', color: 'bg-amber-100 text-amber-700', icon: Clock },
  approved: { label: '已通过', color: 'bg-green-100 text-green-700', icon: CheckCircle },
  rejected: { label: '已驳回', color: 'bg-red-100 text-red-700', icon: XCircle },
}

const COST_TYPE_LABELS: Record<string, string> = {
  rent: '房租',
  utilities: '水电',
  maintenance: '维护',
  admin: '管理费',
  it: 'IT费用',
  other: '其他',
}

function getCurrentQuarter(): string {
  const now = new Date()
  const q = Math.ceil((now.getMonth() + 1) / 3)
  return `${now.getFullYear()}-Q${q}`
}

export default function QuarterlyAdjustment() {
  const [activeTab, setActiveTab] = useState<'suggestions' | 'records'>('suggestions')
  const [yearQuarter, setYearQuarter] = useState(getCurrentQuarter)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [records, setRecords] = useState<CostAdjustment[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('')
  const [searchKeyword, setSearchKeyword] = useState('')
  const silentNextRecordsLoadRef = useRef(false)

  // 创建调整弹窗
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({
    costCenterId: '',
    costCenterName: '',
    preProvisionAmount: 0,
    actualAmount: 0,
    adjustmentReason: '',
  })

  // 审核弹窗
  const [showReviewModal, setShowReviewModal] = useState(false)
  const [reviewForm, setReviewForm] = useState({
    id: '',
    costCenterName: '',
    status: 'approved' as 'approved' | 'rejected',
    reason: '',
  })
  const createAdjustmentAmount = createForm.actualAmount - createForm.preProvisionAmount
  const createValidationMessage = !Number.isFinite(createForm.actualAmount) || createForm.actualAmount <= 0
    ? '请输入大于 0 的实际金额，系统才能计算本季度成本调整。'
    : !createForm.adjustmentReason.trim()
      ? '请填写调整原因，系统才能留下成本结账和审计依据。'
      : ''
  const canSubmitCreate = createValidationMessage === ''
  const createDownstreamFacts = '季度调整、成本结账、成本差异、审核记录、审计记录'

  const loadSuggestions = useCallback(async (
    options: { showError?: boolean } = {},
  ) => {
    const { showError = true } = options
    try {
      setLoading(true)
      const res = await costAdjustmentApi.getSuggestions({ yearQuarter })
      setSuggestions(res?.suggestions || [])
    } catch {
      if (showError) toast.error('加载调整建议失败')
    } finally {
      setLoading(false)
    }
  }, [yearQuarter])

  const loadRecords = useCallback(async (
    statusOverride = filterStatus,
    options: { showError?: boolean } = {},
  ) => {
    const { showError = true } = options
    try {
      setLoading(true)
      const params: Record<string, string> = { yearQuarter }
      if (statusOverride) params.reviewStatus = statusOverride
      const res = await costAdjustmentApi.getList(params)
      setRecords(res?.list || [])
    } catch {
      if (showError) toast.error('加载调整记录失败')
    } finally {
      setLoading(false)
    }
  }, [yearQuarter, filterStatus])

  useEffect(() => {
    if (activeTab === 'suggestions') {
      loadSuggestions()
    } else {
      const showError = !silentNextRecordsLoadRef.current
      silentNextRecordsLoadRef.current = false
      loadRecords(filterStatus, { showError })
    }
  }, [activeTab, filterStatus, loadSuggestions, loadRecords])

  const handleCreate = (suggestion: Suggestion) => {
    setCreateForm({
      costCenterId: suggestion.costCenterId,
      costCenterName: suggestion.costCenterName,
      preProvisionAmount: suggestion.preProvisionAmount,
      actualAmount: 0,
      adjustmentReason: '',
    })
    setShowCreateModal(true)
  }

  const handleSubmitCreate = async () => {
    if (createValidationMessage) {
      toast.warning(createValidationMessage)
      return
    }
    try {
      const created: any = await costAdjustmentApi.create({
        costCenterId: createForm.costCenterId,
        yearQuarter,
        actualAmount: createForm.actualAmount,
        adjustmentReason: createForm.adjustmentReason,
      })
      const focusKeyword = String(created?.costCenterName || createForm.costCenterName || '').trim()
      toast.success('调整记录已创建')
      setShowCreateModal(false)
      silentNextRecordsLoadRef.current = true
      setActiveTab('records')
      setFilterStatus('pending')
      setSearchKeyword(focusKeyword)
      if (created?.id) {
        setRecords(prev => [
          created,
          ...prev.filter(record => record.id !== created.id),
        ])
      }
      loadSuggestions({ showError: false })
    } catch {
      toast.error('创建失败')
    }
  }

  const handleReview = (record: CostAdjustment) => {
    setReviewForm({
      id: record.id,
      costCenterName: record.costCenterName || '',
      status: 'approved',
      reason: '',
    })
    setShowReviewModal(true)
  }

  const handleSubmitReview = async () => {
    try {
      const nextStatus = reviewForm.status
      const focusKeyword = reviewForm.costCenterName.trim()
      await costAdjustmentApi.review(reviewForm.id, {
        status: nextStatus,
        reason: reviewForm.reason,
      })
      toast.success(nextStatus === 'approved' ? '已通过' : '已驳回')
      setShowReviewModal(false)
      silentNextRecordsLoadRef.current = true
      setFilterStatus(nextStatus)
      setSearchKeyword(focusKeyword)
      setRecords(prev => prev.map(record => (
        record.id === reviewForm.id ? { ...record, reviewStatus: nextStatus } : record
      )))
    } catch {
      toast.error('审核失败')
    }
  }

  const filteredRecords = records.filter(r => {
    if (!searchKeyword) return true
    return r.costCenterName?.includes(searchKeyword) || r.submittedByName?.includes(searchKeyword)
  })

  const quarterOptions = (() => {
    const now = new Date()
    const options: string[] = []
    for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
      for (let q = 4; q >= 1; q--) {
        if (y === now.getFullYear() && q > Math.ceil((now.getMonth() + 1) / 3)) continue
        options.push(`${y}-Q${q}`)
      }
    }
    return options
  })()

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">季度成本调整</h1>
          <p className="text-sm text-gray-500 mt-1">预提与实际差异调整、审核管理</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={yearQuarter}
            onChange={e => setYearQuarter(e.target.value)}
            className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
          >
            {quarterOptions.map(q => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('suggestions')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === 'suggestions' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          调整建议
        </button>
        <button
          onClick={() => setActiveTab('records')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === 'records' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          调整记录
        </button>
      </div>

      {/* 调整建议 Tab */}
      {activeTab === 'suggestions' && (
        <div className="space-y-4">
          {suggestions.length > 0 && !suggestions[0]?.isQuarterEnd && (
            <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
              <AlertTriangle className="h-4 w-4 text-blue-500 flex-shrink-0" />
              <span className="text-sm text-blue-700">当前季度尚未结束，建议金额基于已有分摊数据</span>
            </div>
          )}

          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">成本中心</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">类型</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">预提金额</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-gray-400">加载中...</td>
                  </tr>
                ) : suggestions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-gray-400">暂无调整建议</td>
                  </tr>
                ) : (
                  suggestions.map(s => (
                    <tr key={s.costCenterId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">
                        {s.costCenterName}
                        <span className="text-xs text-gray-400 ml-2">{s.costCenterCode}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {COST_TYPE_LABELS[s.costType] || s.costType}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">
                        {formatCurrency(s.preProvisionAmount)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleCreate(s)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                        >
                          <Send className="h-3 w-3" /> 提交调整
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 调整记录 Tab */}
      {activeTab === 'records' && (
        <div className="space-y-4">
          {/* 筛选栏 */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex flex-wrap gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <input
                  type="text"
                  placeholder="搜索成本中心/提交人..."
                  value={searchKeyword}
                  onChange={e => setSearchKeyword(e.target.value)}
                  className="w-64 h-10 pl-10 pr-4 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                />
              </div>
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              >
                <option value="">全部状态</option>
                <option value="pending">待审核</option>
                <option value="approved">已通过</option>
                <option value="rejected">已驳回</option>
              </select>
            </div>
          </div>

          {/* 记录表格 */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">成本中心</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">预提金额</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">实际金额</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">调整金额</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">提交人</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">加载中...</td>
                  </tr>
                ) : filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">暂无调整记录</td>
                  </tr>
                ) : (
                  filteredRecords.map(record => {
                    const status = STATUS_LABELS[record.reviewStatus] || STATUS_LABELS.pending
                    const StatusIcon = status.icon
                    return (
                      <tr key={record.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{record.costCenterName}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(record.preProvisionAmount)}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{formatCurrency(record.actualAmount)}</td>
                        <td className={`px-4 py-3 text-sm text-right font-mono font-medium ${
                          record.adjustmentAmount > 0 ? 'text-red-600' : record.adjustmentAmount < 0 ? 'text-green-600' : 'text-gray-600'
                        }`}>
                          {record.adjustmentAmount > 0 ? '+' : ''}{formatCurrency(record.adjustmentAmount)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">{record.submittedByName}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${status.color}`}>
                            <StatusIcon className="h-3 w-3" /> {status.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {record.reviewStatus === 'pending' && (
                            <button
                              onClick={() => handleReview(record)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                            >
                              审核
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 创建调整弹窗 */}
      {showCreateModal && (
        <Modal onClose={() => setShowCreateModal(false)} title="提交成本调整" size="md">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">成本中心</label>
              <div className="h-10 px-3 flex items-center bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-600">
                {createForm.costCenterName}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">预提金额</label>
              <div className="h-10 px-3 flex items-center bg-gray-50 border border-gray-200 rounded-md text-sm font-mono text-gray-600">
                {formatCurrency(createForm.preProvisionAmount)}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">实际金额 <span className="text-red-500">*</span></label>
              <input
                type="number"
                value={createForm.actualAmount || ''}
                onChange={e => setCreateForm(f => ({ ...f, actualAmount: Number(e.target.value) }))}
                placeholder="请输入实际发生的费用金额"
                className="w-full h-10 px-3 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
              />
              {createForm.actualAmount > 0 && (
                <div className="mt-1 text-xs text-gray-500">
                  调整金额: <span className={createAdjustmentAmount > 0 ? 'text-red-600' : 'text-green-600'}>
                    {formatCurrency(createAdjustmentAmount)}
                  </span>
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">调整原因 <span className="text-red-500">*</span></label>
              <textarea
                value={createForm.adjustmentReason}
                onChange={e => setCreateForm(f => ({ ...f, adjustmentReason: e.target.value }))}
                placeholder="请说明实际费用来源、差异原因或财务复核依据"
                rows={3}
                className="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 resize-none"
              />
            </div>
            <div className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-3">
              <div className="text-sm font-semibold text-emerald-900">调整结果确认</div>
              <div className="mt-1 text-xs text-emerald-700">确认后将接住：{createDownstreamFacts}</div>
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-emerald-700 sm:grid-cols-2">
                <div>成本中心 {createForm.costCenterName || '待选择'}</div>
                <div>预提金额 {formatCurrency(createForm.preProvisionAmount)}</div>
                <div>实际金额 {formatCurrency(createForm.actualAmount || 0)}</div>
                <div>调整金额 {formatCurrency(createAdjustmentAmount)}</div>
                <div className="sm:col-span-2">调整原因 {createForm.adjustmentReason.trim() || '待填写'}</div>
              </div>
            </div>
            {createValidationMessage ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                {createValidationMessage}
              </div>
            ) : null}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmitCreate}
                disabled={!canSubmitCreate}
                className="h-10 px-4 text-sm text-white bg-blue-500 rounded-md hover:bg-blue-600 transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                提交
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 审核弹窗 */}
      {showReviewModal && (
        <Modal onClose={() => setShowReviewModal(false)} title="审核成本调整" size="md">
          <div className="space-y-4">
            <div className="flex gap-3">
              <button
                onClick={() => setReviewForm(f => ({ ...f, status: 'approved' }))}
                className={`flex-1 h-10 rounded-md text-sm font-medium transition-colors ${
                  reviewForm.status === 'approved'
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                <CheckCircle className="h-4 w-4 inline mr-1" /> 通过
              </button>
              <button
                onClick={() => setReviewForm(f => ({ ...f, status: 'rejected' }))}
                className={`flex-1 h-10 rounded-md text-sm font-medium transition-colors ${
                  reviewForm.status === 'rejected'
                    ? 'bg-red-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                <XCircle className="h-4 w-4 inline mr-1" /> 驳回
              </button>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">审核意见</label>
              <textarea
                value={reviewForm.reason}
                onChange={e => setReviewForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="请输入审核意见（选填）"
                rows={3}
                className="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 resize-none"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowReviewModal(false)}
                className="h-10 px-4 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmitReview}
                className={`h-10 px-4 text-sm text-white rounded-md transition-colors ${
                  reviewForm.status === 'approved' ? 'bg-green-500 hover:bg-green-600' : 'bg-red-500 hover:bg-red-600'
                }`}
              >
                确认{reviewForm.status === 'approved' ? '通过' : '驳回'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
