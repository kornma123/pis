import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CornerUpLeft, Search } from 'lucide-react'
import { toast } from 'sonner'
import { reportsApi } from '@/api/reports'
import { formatCurrency } from '@/lib/utils'
import type { SupplierCostReport } from '@/types'

type SupplierCostRow = SupplierCostReport['suppliers'][number]

function normalizeSupplierCostRow(row: Partial<SupplierCostRow>): SupplierCostRow {
  const refundedAmount = Number(row.refundedAmount) || 0
  const grossAmount = Number(row.grossAmount ?? ((Number(row.amount) || 0) + refundedAmount)) || 0
  const id = String(row.id || '')
  return {
    id,
    name: row.name || 'Unknown',
    grossAmount,
    refundedAmount,
    refundedReturnCount: Number(row.refundedReturnCount) || 0,
    amount: Number(row.amount) || Math.max(0, grossAmount - refundedAmount),
    ratio: Number(row.ratio) || 0,
    orderCount: Number(row.orderCount) || 0,
    status: row.status || 'long-term',
    supplierReturnUrl: row.supplierReturnUrl || `/supplier-returns?supplierId=${encodeURIComponent(id)}&status=refunded`,
  }
}

export default function SupplierCostAnalysis() {
  const [loading, setLoading] = useState(true)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rows, setRows] = useState<SupplierCostRow[]>([])

  const loadData = useCallback(async (params: { startDate?: string; endDate?: string } = {}) => {
    try {
      setLoading(true)
      const res = await reportsApi.getCostBySupplier(params)
      setRows(((res as SupplierCostReport)?.suppliers || []).map(normalizeSupplierCostRow))
    } catch {
      toast.error('加载供应商成本失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSearch = () => {
    const params: { startDate?: string; endDate?: string } = {}
    if (startDate) params.startDate = startDate
    if (endDate) params.endDate = endDate
    loadData(params)
  }

  const summary = useMemo(() => rows.reduce(
    (acc, row) => ({
      grossAmount: acc.grossAmount + row.grossAmount,
      refundedAmount: acc.refundedAmount + row.refundedAmount,
      amount: acc.amount + row.amount,
      orderCount: acc.orderCount + row.orderCount,
      refundedReturnCount: acc.refundedReturnCount + row.refundedReturnCount,
    }),
    { grossAmount: 0, refundedAmount: 0, amount: 0, orderCount: 0, refundedReturnCount: 0 },
  ), [rows])

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">供应商成本</h1>
          <p className="mt-1 text-sm text-gray-500">按供应商查看采购总额、已退款扣减和净成本</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">采购总额</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(summary.grossAmount)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">已退款扣减</div>
          <div className="mt-1 text-2xl font-bold text-red-600">{formatCurrency(summary.refundedAmount)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">净供应商成本</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(summary.amount)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">已退款退供单</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{summary.refundedReturnCount}</div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="supplier-cost-start-date" className="mb-1 block text-xs text-gray-500">开始日期</label>
            <input
              id="supplier-cost-start-date"
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="h-10 rounded-md border border-gray-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <div>
            <label htmlFor="supplier-cost-end-date" className="mb-1 block text-xs text-gray-500">结束日期</label>
            <input
              id="supplier-cost-end-date"
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="h-10 rounded-md border border-gray-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/10"
            />
          </div>
          <button
            type="button"
            onClick={handleSearch}
            className="flex h-10 items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            <Search className="h-4 w-4" /> 查询
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">供应商</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">采购总额</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">已退款扣减</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">净供应商成本</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">入库单数</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">已退款退供单</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">证据</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-500">加载中...</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-500">暂无供应商成本记录</td>
                </tr>
              ) : rows.map(row => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(row.grossAmount)}</td>
                  <td className="px-4 py-3 text-right text-red-600">{formatCurrency(row.refundedAmount)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(row.amount)}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{row.orderCount}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{row.refundedReturnCount}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={row.supplierReturnUrl}
                      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700"
                    >
                      <CornerUpLeft className="h-4 w-4" /> 查看退款退供证据
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
