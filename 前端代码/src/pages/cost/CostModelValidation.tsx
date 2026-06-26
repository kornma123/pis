import { useState, useEffect, useMemo } from 'react'
import { Calculator, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { abcApi } from '@/api/abc'
import { bomApi } from '@/api/master'
import { formatCurrency } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'

interface BomOption {
  id: string
  name: string
  projectType: string
  standardSlideCost: number
  standardFeePerSlide: number
  materialCost: number
}

interface BomLink {
  id: string
  activityCenterId: string
  activityCenterName: string
  costDriverId: string
  costDriverName: string
  quantity: number
  unitCost: number
}

interface CalculationResult {
  materialCost: number
  activityCost: number
  totalCost: number
  feeAmount: number
  profit: number
  profitRate: number
  costPerSlide: number
  activityBreakdown: ActivityBreakdownItem[]
}

interface ActivityBreakdownItem {
  activityCenterName: string
  costDriverName: string
  quantity: number
  unitCost: number
  totalCost: number
  proportion: number
}

export default function CostModelValidation() {
  const [loading, setLoading] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [bomList, setBomList] = useState<BomOption[]>([])
  const [selectedBomId, setSelectedBomId] = useState('')
  const [sampleCount, setSampleCount] = useState(10)
  const [result, setResult] = useState<CalculationResult | null>(null)
  const [showBreakdown, setShowBreakdown] = useState(true)

  useEffect(() => {
    loadBomList()
  }, [])

  const loadBomList = async () => {
    try {
      setLoading(true)
      const res = await bomApi.getList({ pageSize: 200 })
      const items = res?.items || res?.list || []
      setBomList(items.map((b: any) => ({
        id: b.id,
        name: b.name,
        projectType: b.projectType || '',
        standardSlideCost: b.standardSlideCost || 0,
        standardFeePerSlide: b.standardFeePerSlide || 0,
        materialCost: b.materialCost || 0,
      })))
    } catch {
      toast.error('加载 BOM 列表失败')
    } finally {
      setLoading(false)
    }
  }

  const selectedBom = useMemo(() => {
    return bomList.find(b => b.id === selectedBomId)
  }, [bomList, selectedBomId])

  const handleCalculate = async () => {
    if (!selectedBomId) {
      toast.warning('请先选择 BOM')
      return
    }
    if (sampleCount <= 0) {
      toast.warning('样本数必须大于 0')
      return
    }
    try {
      setCalculating(true)
      setResult(null)

      // Fetch BOM detail and activity links in parallel
      const [bomDetail, bomLinksRes] = await Promise.all([
        bomApi.getDetail(selectedBomId),
        abcApi.getBomLinks(selectedBomId).catch(() => null),
      ])

      const materialCostPerSlide = bomDetail?.materialCost || bomDetail?.standardSlideCost || selectedBom?.materialCost || 0
      const feePerSlide = bomDetail?.standardFeePerSlide || selectedBom?.standardFeePerSlide || 0

      // Parse activity links
      const links: BomLink[] = (bomLinksRes?.links || bomLinksRes || []).map((l: any) => ({
        id: l.id,
        activityCenterId: l.activityCenterId,
        activityCenterName: l.activityCenterName || l.centerName || '未知作业中心',
        costDriverId: l.costDriverId,
        costDriverName: l.costDriverName || l.driverName || '未知动因',
        quantity: l.quantity || l.driverQuantity || 0,
        unitCost: l.unitCost || l.driverRate || 0,
      }))

      // Calculate activity cost breakdown
      const activityBreakdown: ActivityBreakdownItem[] = links.map(link => {
        const totalCost = link.quantity * link.unitCost
        return {
          activityCenterName: link.activityCenterName,
          costDriverName: link.costDriverName,
          quantity: link.quantity,
          unitCost: link.unitCost,
          totalCost,
          proportion: 0, // will calculate after
        }
      })

      const totalActivityCostPerSlide = activityBreakdown.reduce((s, a) => s + a.totalCost, 0)

      // Calculate proportions
      for (const item of activityBreakdown) {
        item.proportion = totalActivityCostPerSlide > 0
          ? item.totalCost / totalActivityCostPerSlide
          : 0
      }

      const totalCostPerSlide = materialCostPerSlide + totalActivityCostPerSlide
      const totalMaterialCost = materialCostPerSlide * sampleCount
      const totalActivityCost = totalActivityCostPerSlide * sampleCount
      const totalCost = totalCostPerSlide * sampleCount
      const feeAmount = feePerSlide * sampleCount
      const profit = feeAmount - totalCost
      const profitRate = feeAmount > 0 ? profit / feeAmount : 0

      setResult({
        materialCost: totalMaterialCost,
        activityCost: totalActivityCost,
        totalCost,
        feeAmount,
        profit,
        profitRate,
        costPerSlide: totalCostPerSlide,
        activityBreakdown,
      })
    } catch {
      toast.error('计算失败，请检查 BOM 配置')
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
              <option value="">{loading ? '加载中...' : '-- 请选择 BOM --'}</option>
              {bomList.map(bom => (
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
            disabled={calculating || !selectedBomId}
            className="h-10 px-6 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Calculator className="h-4 w-4" />
            {calculating ? '计算中...' : '开始计算'}
          </button>
        </div>
        {selectedBom && (
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
            <span>类型: {selectedBom.projectType || '-'}</span>
            <span>标准切片成本: {formatCurrency(selectedBom.standardSlideCost)}</span>
            <span>标准收费: {formatCurrency(selectedBom.standardFeePerSlide)}</span>
          </div>
        )}
      </div>

      {/* 计算结果 */}
      {!result && !calculating && (
        <EmptyState
          icon={Calculator}
          title="选择 BOM 并输入样本数后开始计算"
          description="计算结果将展示材料成本、作业成本、总成本、收费金额和利润"
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
              <div className="text-xs text-gray-400 mt-1">{formatCurrency(result.materialCost / sampleCount)}/片</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">作业成本</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(result.activityCost)}</div>
              <div className="text-xs text-gray-400 mt-1">{formatCurrency(result.activityCost / sampleCount)}/片</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">总成本</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(result.totalCost)}</div>
              <div className="text-xs text-gray-400 mt-1">{formatCurrency(result.costPerSlide)}/片</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">收费金额</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(result.feeAmount)}</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm text-gray-500">利润</div>
              <div className={`text-2xl font-bold mt-1 ${result.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatCurrency(result.profit)}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                利润率 {(result.profitRate * 100).toFixed(2)}%
              </div>
            </div>
          </div>

          {/* 成本构成比例 */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">成本构成</h3>
            <div className="flex h-6 rounded-full overflow-hidden">
              {result.materialCost > 0 && (
                <div
                  className="bg-blue-500 flex items-center justify-center text-xs text-white font-medium"
                  style={{ width: `${(result.materialCost / result.totalCost) * 100}%` }}
                >
                  材料 {(result.materialCost / result.totalCost * 100).toFixed(0)}%
                </div>
              )}
              {result.activityCost > 0 && (
                <div
                  className="bg-emerald-500 flex items-center justify-center text-xs text-white font-medium"
                  style={{ width: `${(result.activityCost / result.totalCost) * 100}%` }}
                >
                  作业 {(result.activityCost / result.totalCost * 100).toFixed(0)}%
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
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">成本动因</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">数量</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">单位费率</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">小计</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">占比</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {result.activityBreakdown.map((item, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.activityCenterName}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{item.costDriverName}</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-500">{item.quantity}</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-500">{formatCurrency(item.unitCost)}</td>
                          <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">{formatCurrency(item.totalCost)}</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-500">
                            {(item.proportion * 100).toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-gray-50 font-medium">
                        <td colSpan={4} className="px-4 py-3 text-sm text-gray-900">作业成本合计（每片）</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-900">
                          {formatCurrency(result.activityBreakdown.reduce((s, a) => s + a.totalCost, 0))}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-gray-500">100%</td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {/* Material + Activity total */}
                <div className="border-t border-gray-200 px-4 py-3 bg-gray-50">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">材料成本（每片）</span>
                    <span className="font-medium text-gray-900">{formatCurrency(result.materialCost / sampleCount)}</span>
                  </div>
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-500">作业成本（每片）</span>
                    <span className="font-medium text-gray-900">{formatCurrency(result.activityCost / sampleCount)}</span>
                  </div>
                  <div className="flex justify-between text-sm mt-1 pt-1 border-t border-gray-200">
                    <span className="font-semibold text-gray-900">总成本（每片）</span>
                    <span className="font-semibold text-gray-900">{formatCurrency(result.costPerSlide)}</span>
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
