import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { accountReconcileApi } from '@/api/account-reconcile'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import { canAccess } from '@/lib/permissions'
import type { HospitalMonth, OverviewBoard } from '@/types/account-reconcile'

export type ReconTab = 'overview' | 'workbench' | 'supplement'
export interface CloseMonthRequest { serviceMonth: string; partnerIds: string[] }

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

/** 账实核对页顶层状态：月份 + 页签 + 总览数据 + 计算/关账 + 进工作台。 */
export function useAccountReconcile() {
  const canWrite = canAccess('account_reconcile', 'W')
  const [month, setMonthState] = useState<string>(currentMonth())
  const monthRef = useRef(month)
  monthRef.current = month
  const overviewRequest = useRef(0)
  const busyRef = useRef(false)
  const [tab, setTab] = useState<ReconTab>('overview')
  const [selected, setSelected] = useState<{ partnerId: string; partnerName: string } | null>(null)

  const [list, setList] = useState<HospitalMonth[]>([])
  const [board, setBoard] = useState<OverviewBoard | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [partners, setPartners] = useState<PartnerListItem[]>([])

  const setMonth = useCallback((nextMonth: string) => {
    if (nextMonth === monthRef.current) return
    monthRef.current = nextMonth
    overviewRequest.current += 1
    setMonthState(nextMonth)
    setSelected(null)
    setList([])
    setBoard(null)
    setLoadedMonth(null)
    setLoadError(false)
    setLoading(true)
  }, [])

  const loadOverview = useCallback(async (requestedMonth: string = monthRef.current) => {
    if (requestedMonth !== monthRef.current) return
    const requestId = ++overviewRequest.current
    setSelected(null)
    setLoading(true)
    setLoadError(false)
    setList([])
    setBoard(null)
    setLoadedMonth(null)
    try {
      const res = await accountReconcileApi.overview(requestedMonth)
      if (requestId !== overviewRequest.current || requestedMonth !== monthRef.current) return
      setList(res.list || [])
      setBoard(res.board || null)
      setLoadedMonth(requestedMonth)
    } catch {
      if (requestId !== overviewRequest.current || requestedMonth !== monthRef.current) return
      setList([])
      setBoard(null)
      setLoadedMonth(null)
      setLoadError(true)
    } finally {
      if (requestId === overviewRequest.current && requestedMonth === monthRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'overview') void loadOverview(month)
  }, [tab, month, loadOverview])

  const writeReady = canWrite && !busy && !loading && !loadError && loadedMonth === month
  const beginWrite = useCallback((): string | null => {
    const snapshotMonth = loadedMonth
    if (!canWrite || busyRef.current || loading || loadError || !snapshotMonth || snapshotMonth !== monthRef.current) {
      toast.error('当前月份数据尚未加载完成，请重试后再操作')
      return null
    }
    busyRef.current = true
    setBusy(true)
    return snapshotMonth
  }, [canWrite, loadedMonth, loading, loadError])
  const endWrite = useCallback(() => {
    busyRef.current = false
    setBusy(false)
  }, [])

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
      const snapshotMonth = beginWrite()
      if (!snapshotMonth) return
      try {
        const r = await accountReconcileApi.compute(partnerId, snapshotMonth)
        if (snapshotMonth !== monthRef.current) return
        toast.success(`已计算：匹配${Math.round((r.matchRate || 0) * 100)}%（${r.matchStatus}）· ${r.diffCount} 条差异`)
        await loadOverview(snapshotMonth)
      } catch {
        /* toast handled */
      } finally {
        endWrite()
      }
    },
    [beginWrite, endWrite, loadOverview],
  )

  /** 重算本月所有已在册院·月（导入新数据后刷新；已关账的会被后端拒、跳过）。 */
  const recomputeAll = useCallback(async () => {
    const snapshotMonth = beginWrite()
    if (!snapshotMonth) return
    try {
      const targets = list.filter((h) => h.serviceMonth === snapshotMonth && h.status !== '已关账')
      if (!targets.length) {
        toast.info('本月没有可重算的院（未关账）')
        return
      }
      let ok = 0
      for (const h of targets) {
        if (snapshotMonth !== monthRef.current) return
        try {
          await accountReconcileApi.compute(h.partnerId, snapshotMonth)
          ok++
        } catch {
          /* 单院失败不中断 */
        }
      }
      if (snapshotMonth !== monthRef.current) return
      toast.success(`已重算 ${ok}/${targets.length} 家`)
      await loadOverview(snapshotMonth)
    } finally {
      endWrite()
    }
  }, [beginWrite, endWrite, list, loadOverview])

  const closeMonth = useCallback(
    async (request: CloseMonthRequest) => {
      if (!request.partnerIds.length) return
      if (request.serviceMonth !== loadedMonth || request.serviceMonth !== monthRef.current) {
        toast.error('关账月份已变化，请按当前月份重新确认')
        return
      }
      const allowed = new Set(list.filter((h) => h.serviceMonth === request.serviceMonth && h.status === '复核完成').map((h) => h.partnerId))
      if (request.partnerIds.some((partnerId) => !allowed.has(partnerId))) {
        toast.error('关账医院范围已变化，请刷新后重新确认')
        return
      }
      const snapshotMonth = beginWrite()
      if (!snapshotMonth || snapshotMonth !== request.serviceMonth) return
      try {
        const r = await accountReconcileApi.close(snapshotMonth, request.partnerIds)
        if (snapshotMonth !== monthRef.current) return
        toast.success(`关账完成：${r.closed.length} 家已定版，${r.skipped.length} 家挂起`)
        await loadOverview(snapshotMonth)
      } catch {
        /* toast handled */
      } finally {
        endWrite()
      }
    },
    [beginWrite, endWrite, list, loadedMonth, loadOverview],
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
    list, board, loading, loadedMonth, loadError, busy, writeReady,
    loadOverview,
    partners, loadPartners,
    computePartner, recomputeAll, closeMonth,
  }
}
