import { useState, useEffect, useMemo, useRef } from 'react'
import { Calculator, ChevronDown, ChevronRight, RefreshCw, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { bomApi } from '@/api/master'
import { formatCurrency } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'
import type { BomListItem, BomDetail } from '@/types'

/**
 * 成本模型验证（LOC-013 诚实消费版）
 *
 * 只消费后端活合同里真实存在的字段（bom-v1.1.ts / abc-v1.1.ts）：
 * - BOM list/detail 已经 endpoint 专属 exact parser 校验，畸形响应在边界即被拒；
 * - unknown/null 不折 0：unitCost、supportableSamples 等 null 一律显示「不可用」；
 * - 收费标准、作业费率不在活合同中 → 收费金额/利润/作业小计/总成本显示「不可用」，
 *   绝不显示幻影 ¥0 或按 0 费率假算；
 * - 刷新失败后旧列表仅作陈旧上下文保留可见，计算动作禁止，直到同代新鲜响应成功。
 */

type ListStatus = 'loading' | 'fresh' | 'stale' | 'unavailable'

interface ActivityBreakdownItem {
  key: string
  activityCenterName: string | null
  activityCenterCode: string | null
  quantity: number
  unit: string | null
}

interface CalculationResult {
  sampleCount: number
  materialPerSlide: number
  materialCost: number
  /** null = 作业费率不在合同中，不可计算（有作业关联时） */
  activityCost: number | null
  costPerSlide: number | null
  totalCost: number | null
  activityBreakdown: ActivityBreakdownItem[]
}

function Unavailable({ note = '合同未提供该数据' }: { note?: string }) {
  return <span className="text-gray-400" title={note}>不可用</span>
}

export default function CostModelValidation() {
  const [listState, setListState] = useState<{ status: ListStatus; items: BomListItem[] }>({
    status: 'loading',
    items: [],
  })
  const [refreshing, setRefreshing] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [selectedBomId, setSelectedBomId] = useState('')
  const [sampleCount, setSampleCount] = useState(10)
  const [result, setResult] = useState<CalculationResult | null>(null)
  const [showBreakdown, setShowBreakdown] = useState(true)
  // 同代序号：只接受最后一次发起的刷新结果，防止旧响应晚到覆盖新状态
  const requestSeq = useRef(0)

  useEffect(() => {
    loadBomList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadBomList = async () => {
    const seq = ++requestSeq.current
    setRefreshing(true)
    try {
      const res = await bomApi.getList({ pageSize: 200 })
      if (seq !== requestSeq.current) return
      // parser 已在边界保证运行时形状；此处把静态宽类型收窄为活合同类型
      const items = (res as unknown as { list: BomListItem[] }).list
      setListState({ status: 'fresh', items })
    } catch {
      if (seq !== requestSeq.current) return
      setListState(prev => ({
        status: prev.items.length > 0 ? 'stale' : 'unavailable',
        items: prev.items,
      }))
      toast.error('BOM 列表刷新失败')
    } finally {
      if (seq === requestSeq.current) setRefreshing(false)
    }
  }

  const selectedBom = useMemo(
    () => listState.items.find(b => b.id === selectedBomId),
    [listState.items, selectedBomId],
  )

  const canCalculate = listState.status === 'fresh' && !!selectedBomId && !calculating

  const handleCalculate = async () => {
    if (!selectedBomId) {
      toast.warning('请先选择 BOM')
      return
    }
    // 陈旧/不可用数据禁写：即使按钮被绕开（如脚本派发事件），这里仍硬拦
    if (listState.status !== 'fresh') {
      toast.warning('数据已过期，请先刷新')
      return
    }
    if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
      toast.warning('样本数必须是大于 0 的整数')
      return
    }
    try {
      setCalculating(true)
      setResult(null)

      const [bomDetail, links] = await Promise.all([
        bomApi.getDetail(selectedBomId) as unknown as Promise<BomDetail>,
        abcApi.getBomLinks(selectedBomId),
      ])

      // 材料成本/片 = Σ 单价×用量（与后端 detail 注释同一合同公式：主辅料一并累加）
      const materialPerSlide = bomDetail.materials.reduce((sum, m) => sum + m.price * m.usagePerSample, 0)
      const materialCost = materialPerSlide * sampleCount
      if (!Number.isFinite(materialPerSlide) || !Number.isFinite(materialCost)) {
        throw new Error('material cost overflow')
      }
      const hasActivity = links.length > 0
      const activityCost = hasActivity ? null : 0
      const totalCost = hasActivity ? null : materialCost
      const costPerSlide = hasActivity ? null : materialPerSlide

      setResult({
        sampleCount,
        materialPerSlide,
        materialCost,
        activityCost,
        totalCost,
        costPerSlide,
        activityBreakdown: links.map(l => ({
          key: l.id,
          activityCenterName: l.activityCenterName,
          activityCenterCode: l.activityCenterCode,
          quantity: l.quantity,
          unit: l.unit,
        })),
      })
    } catch {
      setResult(null)
      // 同代新鲜响应失败 → 当前数据不再可信：转陈旧并禁写
      setListState(prev => ({
        ...prev,
        status: prev.items.length > 0 ? 'stale' : 'unavailable',
      }))
      toast.error('计算失败：BOM 或作业关联数据不可用')
    } finally {
      setCalculating(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* 页面头部 */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">成本模型验证</h1>
        <p className="text-sm text-gray-500 mt-1">输入测试参数，验证 ABC 成本模型的计算结果</p>
      </div>

      {/* 陈旧数据横幅：保留查看，禁止计算 */}
      {listState.status === 'stale' && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>数据已过期：当前为上次成功加载的内容，仅可查看，禁止计算。请点「刷新」获取最新数据。</span>
        </div>
      )}

      {/* 输入表单 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">测试参数</h3>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500">选择 BOM</label>
            <select
              value={selectedBomId}
              onChange={e => { setSelectedBomId(e.target.value); setResult(null) }}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 min-w-[240px]"
            >
              <option value="">
                {listState.status === 'loading' ? '加载中...' : '-- 请选择 BOM --'}
              </option>
              {listState.items.map(bom => (
                <option key={bom.id} value={bom.id}>{bom.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500">样本数（切片数）</label>
            <input
              type="number"
              min={1}
              value={sampleCount}
              onChange={e => { setSampleCount(Number(e.target.value)); setResult(null) }}
              className="h-10 px-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500 w-32"
            />
          </div>
          <button
            onClick={handleCalculate}
            disabled={!canCalculate}
            className="h-10 px-6 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Calculator className="h-4 w-4" />
            {calculating ? '计算中...' : '开始计算'}
          </button>
          <button
            onClick={loadBomList}
            disabled={refreshing}
            className="h-10 px-4 bg-white text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '刷新中...' : '刷新'}
          </button>
        </div>
        {selectedBom && (
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
            <span>类型: {selectedBom.type}</span>
            <span>
              标准单位成本: {selectedBom.unitCost === null ? <Unavailable /> : formatCurrency(selectedBom.unitCost)}
            </span>
            <span>
              可支持样本数: {selectedBom.supportableSamples === null ? <Unavailable /> : selectedBom.supportableSamples}
            </span>
            <span>物料数: {selectedBom.materialCount}</span>
          </div>
        )}
      </div>

      {/* 数据不可用空态（加载失败或响应畸形被拒） */}
      {listState.status === 'unavailable' && !calculating && (
        <EmptyState
          icon={Calculator}
          title="BOM 数据不可用"
          description="列表加载失败或响应不完整。请点「刷新」重试；切勿基于不完整数据计算。"
        />
      )}

      {/* 待计算空态 */}
      {!result && !calculating && listState.status !== 'unavailable' && (
        <EmptyState
          icon={Calculator}
          title="选择 BOM 并输入样本数后开始计算"
          description="计算结果将展示材料成本与作业构成；收费标准未由合同提供，收费金额与利润显示为不可用"
        />
      )}

      {calculating && (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          计算中...
        </div>
      )}

      {result && (
        <>
          {/* 汇总卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">材料成本</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(result.materialCost)}</div>
              <div className="text-xs text-gray-400 mt-1">{formatCurrency(result.materialPerSlide)}/片</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">作业成本</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">
                {result.activityCost === null ? <Unavailable note="作业费率未由合同提供" /> : formatCurrency(result.activityCost)}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {result.activityCost === null ? '合同未提供费率' : `${formatCurrency((result.activityCost as number) / result.sampleCount)}/片`}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">总成本</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">
                {result.totalCost === null ? <Unavailable note="作业费率未由合同提供" /> : formatCurrency(result.totalCost)}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {result.costPerSlide === null ? '材料已知 + 作业未知' : `${formatCurrency(result.costPerSlide)}/片`}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">收费金额</div>
              <div className="text-2xl font-bold mt-1"><Unavailable note="收费标准未由合同提供" /></div>
              <div className="text-xs text-gray-400 mt-1">合同未提供收费标准</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">利润</div>
              <div className="text-2xl font-bold mt-1"><Unavailable note="缺少收费标准，利润不可计算" /></div>
              <div className="text-xs text-gray-400 mt-1">缺少收费标准，不可计算</div>
            </div>
          </div>

          {/* 成本构成比例 */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">成本构成</h3>
            {result.totalCost === null || result.totalCost <= 0 ? (
              <div className="text-sm text-gray-500">
                {result.totalCost === null
                  ? '成本构成比例不可计算：作业费率未由合同提供。'
                  : '总成本为 0（合法零成本），无构成比例。'}
              </div>
            ) : (
              <>
                <div className="flex h-6 rounded-full overflow-hidden">
                  {(result.materialCost as number) > 0 && (
                    <div
                      className="bg-blue-500 flex items-center justify-center text-xs text-white font-medium"
                      style={{ width: `${(result.materialCost / (result.totalCost as number)) * 100}%` }}
                    >
                      材料 {((result.materialCost / (result.totalCost as number)) * 100).toFixed(0)}%
                    </div>
                  )}
                  {(result.activityCost as number) > 0 && (
                    <div
                      className="bg-emerald-500 flex items-center justify-center text-xs text-white font-medium"
                      style={{ width: `${((result.activityCost as number) / (result.totalCost as number)) * 100}%` }}
                    >
                      作业 {(((result.activityCost as number) / (result.totalCost as number)) * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
                <div className="flex gap-6 mt-3 text-xs text-gray-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-blue-500" /> 材料成本
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-emerald-500" /> 作业成本
                  </span>
                </div>
              </>
            )}
          </div>

          {/* 计算过程明细 */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <button
              className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-gray-900 hover:bg-gray-50 transition-colors"
              onClick={() => setShowBreakdown(!showBreakdown)}
            >
              <span>计算过程明细（各作业中心成本分解）</span>
              {showBreakdown
                ? <ChevronDown className="h-4 w-4 text-gray-400" />
                : <ChevronRight className="h-4 w-4 text-gray-400" />}
            </button>
            {showBreakdown && (
              <div className="border-t border-gray-200">
                {result.activityBreakdown.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-gray-400">
                    该 BOM 未配置作业中心关联
                  </div>
                ) : (
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">作业中心</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">编码</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">数量</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">单位</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">小计</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {result.activityBreakdown.map((item) => (
                        <tr key={item.key} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">
                            {item.activityCenterName === null
                              ? <span className="text-gray-400">（名称不可用）</span>
                              : item.activityCenterName}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">{item.activityCenterCode ?? '—'}</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-500">{item.quantity}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{item.unit ?? '—'}</td>
                          <td className="px-4 py-3 text-sm text-right">
                            <Unavailable note="作业费率未由合同提供" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {/* Material + Activity total */}
                <div className="border-t border-gray-200 px-4 py-3 bg-gray-50">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">材料成本（每片）</span>
                    <span className="font-medium text-gray-900">{formatCurrency(result.materialPerSlide)}</span>
                  </div>
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-500">作业成本（每片）</span>
                    <span className="font-medium text-gray-900">
                      {result.activityCost === null
                        ? <Unavailable note="作业费率未由合同提供" />
                        : formatCurrency(result.activityCost / result.sampleCount)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm mt-1 pt-1 border-t border-gray-200">
                    <span className="font-semibold text-gray-900">总成本（每片）</span>
                    <span className="font-semibold text-gray-900">
                      {result.costPerSlide === null
                        ? <Unavailable note="作业费率未由合同提供" />
                        : formatCurrency(result.costPerSlide)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
