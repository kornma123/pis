import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { accountReconcileApi } from '@/api/account-reconcile'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import { canAccess } from '@/lib/permissions'
import type { HospitalMonth, OverviewBoard } from '@/types/account-reconcile'

export type ReconTab = 'overview' | 'workbench' | 'supplement'

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

/** 账实核对页顶层状态：月份 + 页签 + 总览数据 + 计算/关账 + 进工作台。 */
export function useAccountReconcile() {
  const canWrite = canAccess('account_reconcile', 'W')
  const [month, setMonth] = useState<string>(currentMonth())
  const [tab, setTab] = useState<ReconTab>('overview')
  const [selected, setSelected] = useState<{ partnerId: string; partnerName: string } | null>(null)

  const [list, setList] = useState<HospitalMonth[]>([])
  const [board, setBoard] = useState<OverviewBoard | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [partners, setPartners] = useState<PartnerListItem[]>([])

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      const res = await accountReconcileApi.overview(month)
      setList(res.list || [])
      setBoard(res.board || null)
    } catch {
      /* 拦截器已 toast */
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => {
    if (tab === 'overview') loadOverview()
  }, [tab, loadOverview])

  const loadPartners = useCallback(async () => {
    if (partners.length) return
    try {
      const res = await partnerConfigApi.partners()
      setPartners(res.list || [])
    } catch {
      /* 忽略：新增院核对入口不可用不阻断主流程 */
    }
  }, [partners.length])

  const computePartner = useCallback(
    async (partnerId: string) => {
      setBusy(true)
      try {
        const r = await accountReconcileApi.compute(partnerId, month)
        toast.success(`已计算：匹配${Math.round((r.matchRate || 0) * 100)}%（${r.matchStatus}）· ${r.diffCount} 条差异`)
        await loadOverview()
      } catch {
        /* toast handled */
      } finally {
        setBusy(false)
      }
    },
    [month, loadOverview],
  )

  /** 重算本月所有已在册院·月（导入新数据后刷新；已关账的会被后端拒、跳过）。 */
  const recomputeAll = useCallback(async () => {
    const targets = list.filter((h) => h.status !== '已关账')
    if (!targets.length) {
      toast.info('本月没有可重算的院（未关账）')
      return
    }
    setBusy(true)
    let ok = 0
    for (const h of targets) {
      try {
        await accountReconcileApi.compute(h.partnerId, month)
        ok++
      } catch {
        /* 单院失败不中断 */
      }
    }
    toast.success(`已重算 ${ok}/${targets.length} 家`)
    await loadOverview()
    setBusy(false)
  }, [list, month, loadOverview])

  const closeMonth = useCallback(
    async (partnerIds: string[]) => {
      if (!partnerIds.length) return
      setBusy(true)
      try {
        const r = await accountReconcileApi.close(month, partnerIds)
        toast.success(`关账完成：${r.closed.length} 家已定版，${r.skipped.length} 家挂起`)
        await loadOverview()
      } catch {
        /* toast handled */
      } finally {
        setBusy(false)
      }
    },
    [month, loadOverview],
  )

  const openWorkbench = useCallback((partnerId: string, partnerName: string) => {
    setSelected({ partnerId, partnerName })
    setTab('workbench')
  }, [])

  const backToOverview = useCallback(() => {
    setSelected(null)
    setTab('overview')
  }, [])

  return {
    canWrite,
    month, setMonth,
    tab, setTab,
    selected, openWorkbench, backToOverview,
    list, board, loading, busy,
    loadOverview,
    partners, loadPartners,
    computePartner, recomputeAll, closeMonth,
  }
}
