import React, { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { equipmentApi, projectApi } from '@/api/master'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { Equipment, EquipmentUsage, Project } from '@/types'
import { toast } from 'sonner'

interface Props {
  open: boolean
  row: Equipment | null
  onClose: () => void
  onEdit: (row: Equipment) => void
  canEdit?: boolean
}

const STATUS_LABEL: Record<Equipment['status'], string> = {
  active: '已启用',
  inactive: '已停用',
  scrapped: '已报废',
}

const METHOD_LABEL: Record<Equipment['depreciationMethod'], string> = {
  straight_line: '直线法',
  units_of_production: '工作量法',
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-gray-900">{value || '-'}</div>
    </div>
  )
}

export function EquipmentDetailModal({ open, row, onClose, onEdit, canEdit = true }: Props) {
  const [detail, setDetail] = useState<Equipment | null>(null)
  const [usageList, setUsageList] = useState<EquipmentUsage[]>([])
  const [loadingUsage, setLoadingUsage] = useState(false)
  const [savingUsage, setSavingUsage] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [usageForm, setUsageForm] = useState({
    usageDate: new Date().toISOString().slice(0, 10),
    usageMinutes: 0,
    usageCount: 1,
    projectId: '', // P1-05：设备使用可选关联项目（REQ-24-004 按项目/出库关联，支撑折旧追溯）
  })

  const current = detail || row

  useEffect(() => {
    if (!open || !row) {
      setDetail(null)
      setUsageList([])
      return
    }

    let cancelled = false
    setDetail(row)
    setLoadingUsage(true)

    Promise.allSettled([
      equipmentApi.getDetail(row.id),
      equipmentApi.getUsage(row.id, { page: 1, pageSize: 5 }),
      projectApi.getList({ page: 1, pageSize: 200, status: 'active' }),
    ]).then(([detailResult, usageResult, projectResult]) => {
      if (cancelled) return
      if (detailResult.status === 'fulfilled') setDetail(detailResult.value as Equipment)
      if (usageResult.status === 'fulfilled') {
        setUsageList((usageResult.value as any)?.list || [])
      } else {
        setUsageList([])
      }
      if (projectResult.status === 'fulfilled') {
        setProjects((projectResult.value as any)?.list || [])
      }
    }).finally(() => {
      if (!cancelled) setLoadingUsage(false)
    })

    return () => {
      cancelled = true
    }
  }, [open, row])

  const refreshDetailAndUsage = async () => {
    if (!row) return
    const [detailRes, usageRes] = await Promise.all([
      equipmentApi.getDetail(row.id),
      equipmentApi.getUsage(row.id, { page: 1, pageSize: 5 }),
    ])
    setDetail(detailRes as Equipment)
    setUsageList((usageRes as any)?.list || [])
  }

  const handleRecordUsage = async () => {
    if (!row) return
    if (!Number.isFinite(usageForm.usageMinutes) || usageForm.usageMinutes <= 0) {
      toast.error('使用时长必须大于0')
      return
    }
    if (!Number.isFinite(usageForm.usageCount) || usageForm.usageCount <= 0) {
      toast.error('使用次数必须大于0')
      return
    }
    try {
      setSavingUsage(true)
      await equipmentApi.recordUsage(row.id, {
        usageDate: usageForm.usageDate,
        usageMinutes: usageForm.usageMinutes,
        usageCount: usageForm.usageCount,
        ...(usageForm.projectId ? { projectId: usageForm.projectId } : {}),
      })
      await refreshDetailAndUsage()
      setUsageForm({
        usageDate: new Date().toISOString().slice(0, 10),
        usageMinutes: 0,
        usageCount: 1,
        projectId: '',
      })
      toast.success('设备使用已登记')
    } catch {
      toast.error('登记设备使用失败')
    } finally {
      setSavingUsage(false)
    }
  }

  if (!open || !current) return null

  return (
    <Modal title={`设备详情 - ${current.name}`} onClose={onClose} size="xl">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-mono text-sm text-gray-500">{current.code}</div>
            <div className="mt-1 text-lg font-semibold text-gray-900">{current.name}</div>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => onEdit(current)}
              className="h-9 px-3 text-sm font-medium text-blue-600 border border-blue-200 rounded-md hover:bg-blue-50 transition-colors"
            >
              编辑设备
            </button>
          )}
        </div>

        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-3">基础信息</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Info label="设备类型" value={current.typeName || '未分类'} />
            <Info label="型号" value={current.model || '-'} />
            <Info label="制造商" value={current.manufacturer || '-'} />
            <Info label="状态" value={STATUS_LABEL[current.status]} />
            <Info label="购置日期" value={current.purchaseDate ? formatDate(current.purchaseDate) : '-'} />
            <Info label="购置价格" value={formatCurrency(current.purchasePrice)} />
            <Info label="残值" value={formatCurrency(current.residualValue)} />
            <Info label="折旧年限" value={`${current.depreciableLifeYears || 0} 年`} />
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-3">折旧信息</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Info label="折旧方式" value={METHOD_LABEL[current.depreciationMethod]} />
            <Info label="年折旧额" value={formatCurrency(current.annualDepreciation)} />
            <Info label="累计折旧" value={formatCurrency(current.accumulatedDepreciation)} />
            <Info label="账面净值" value={formatCurrency(current.netBookValue)} />
            <Info label="总工作量" value={current.totalCapacity ? `${current.totalCapacity} ${current.capacityUnit || ''}` : '-'} />
            <Info label="库位" value={current.locationId || '-'} />
            <Info label="创建时间" value={current.createdAt ? formatDate(current.createdAt) : '-'} />
            <Info label="更新时间" value={current.updatedAt ? formatDate(current.updatedAt) : '-'} />
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-sm font-semibold text-gray-900">最近使用记录</h3>
            {/* 登记使用是写操作（后端要求 equipment:W）：与「编辑设备」按钮一致仅对有写权限者显示；只读用户仍可查看下方使用记录 */}
            {canEdit && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">关联项目（可选）</span>
                <select
                  value={usageForm.projectId}
                  onChange={(e) => setUsageForm({ ...usageForm, projectId: e.target.value })}
                  className="h-9 w-44 px-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                >
                  <option value="">不关联</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.code} - {p.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">使用日期</span>
                <input
                  type="date"
                  value={usageForm.usageDate}
                  onChange={(e) => setUsageForm({ ...usageForm, usageDate: e.target.value })}
                  className="h-9 w-36 px-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">使用时长</span>
                <input
                  type="number"
                  min={1}
                  value={usageForm.usageMinutes}
                  onChange={(e) => setUsageForm({ ...usageForm, usageMinutes: Number(e.target.value) })}
                  className="h-9 w-24 px-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">使用次数</span>
                <input
                  type="number"
                  min={1}
                  value={usageForm.usageCount}
                  onChange={(e) => setUsageForm({ ...usageForm, usageCount: Number(e.target.value) })}
                  className="h-9 w-20 px-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-[3px] focus:ring-blue-500/10 focus:border-blue-500"
                />
              </label>
              <button
                type="button"
                onClick={handleRecordUsage}
                disabled={savingUsage}
                className="h-9 px-3 text-sm font-medium text-white bg-blue-500 rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                登记使用
              </button>
            </div>
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">使用日期</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">时长</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">次数</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">折旧成本</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">操作人</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loadingUsage ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-gray-400">加载中...</td>
                  </tr>
                ) : usageList.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-gray-400">暂无使用记录</td>
                  </tr>
                ) : usageList.map((usage) => (
                  <tr key={usage.id}>
                    <td className="px-3 py-2 text-gray-700">{usage.usageDate ? formatDate(usage.usageDate) : '-'}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{usage.usageMinutes} 分钟</td>
                    <td className="px-3 py-2 text-right text-gray-700">{usage.usageCount}</td>
                    <td className="px-3 py-2 text-right text-gray-900">{formatCurrency(usage.depreciationCost)}</td>
                    <td className="px-3 py-2 text-gray-700">{usage.operator || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Modal>
  )
}
