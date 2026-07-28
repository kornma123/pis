import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { accountReconcileApi } from '@/api/account-reconcile'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import { canAccess } from '@/lib/permissions'
import type { BoardItem, OverviewBoard, ReconcileBinding } from '@/types/account-reconcile'

export type ReconTab = 'overview' | 'workbench' | 'supplement'

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

function newReconcileGenerationId(): string {
  return crypto.randomUUID()
}

/** 账实核对页顶层状态：月份 + 页签 + board 数据 + 计算/关账 + 进工作台。
 *  所有读/写调用经 board 解析四元组 binding（LOC-005 权威代次合同）。 */
export function useAccountReconcile() {
  const canWrite = canAccess('account_reconcile', 'W')
  const [month, setMonth] = useState<string>(currentMonth())
  const [tab, setTab] = useState<ReconTab>('overview')
  const [selected, setSelected] = useState<{ partnerId: string; partnerName: string; binding: ReconcileBinding } | null>(null)

  const [items, setItems] = useState<BoardItem[]>([])
  const [board, setBoard] = useState<OverviewBoard | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [partners, setPartners] = useState<PartnerListItem[]>([])

  // 总览列表只展示已计算的院·月（有 hospitalMonthId）；未计算院仅存于 items 供 binding 解析。
  const list = items.filter((h) => h.hospitalMonthId !== null)

  const bindingFor = useCallback((partnerId: string): ReconcileBinding | null => {
    const item = items.find((i) => i.partnerId === partnerId)
    if (!item?.statementGenerationId || !item.reconcileGenerationId) return null
    return {
      partnerId,
      settlementMonth: month,
      statementGenerationId: item.statementGenerationId,
      reconcileGenerationId: item.reconcileGenerationId,
    }
  }, [items, month])

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      const res = await accountReconcileApi.board(month)
      setItems(res.items || [])
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

  /** 计算/重算某院：statement 代未变且已有对账代 → 沿用（幂等重放）；否则铸新对账代（supersede）。 */
  const computePartner = useCallback(
    async (partnerId: string): Promise<boolean> => {
      const item = items.find((i) => i.partnerId === partnerId)
      if (!item?.statementGenerationId) {
        toast.error('该院本月还没有可用对账单（未导入或未过账），先导入再计算')
        return false
      }
      const reuse = !!item.reconcileGenerationId
        && item.reconcileStatementGenerationId === item.statementGenerationId
      const binding: ReconcileBinding = {
        partnerId,
        settlementMonth: month,
        statementGenerationId: item.statementGenerationId,
        reconcileGenerationId: reuse ? item.reconcileGenerationId! : newReconcileGenerationId(),
      }
      setBusy(true)
      try {
        const r = await accountReconcileApi.compute(binding)
        const matchRate = r.result?.matchRate || 0
        const matchStatus = r.result?.matchStatus ?? ''
        const diffCount = r.result?.diffs?.length ?? 0
        toast.success(`已计算：匹配${Math.round(matchRate * 100)}%（${matchStatus}）· ${diffCount} 条差异`)
        await loadOverview()
        return true
      } catch {
        /* toast handled（如 RECONCILE_GENERATION_HAS_OPEN_SUPPLEMENTS 由后端文案提示） */
        return false
      } finally {
        setBusy(false)
      }
    },
    [items, month, loadOverview],
  )

  /** 重算本月所有已在册且未关账的院·月（导入新数据后刷新；关账院与未终结补收单院会被后端拒、跳过）。 */
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
        const item = items.find((i) => i.partnerId === h.partnerId)
        if (!item?.statementGenerationId) continue
        const reuse = !!item.reconcileGenerationId
          && item.reconcileStatementGenerationId === item.statementGenerationId
        await accountReconcileApi.compute({
          partnerId: h.partnerId,
          settlementMonth: month,
          statementGenerationId: item.statementGenerationId,
          reconcileGenerationId: reuse ? item.reconcileGenerationId! : newReconcileGenerationId(),
        })
        ok++
      } catch {
        /* 单院失败不中断 */
      }
    }
    toast.success(`已重算 ${ok}/${targets.length} 家`)
    await loadOverview()
    setBusy(false)
  }, [list, items, month, loadOverview])

  /** 关账：新合同每次只关一家，逐院调用并聚合成功/挂起。 */
  const closeMonth = useCallback(
    async (partnerIds: string[]) => {
      if (!partnerIds.length) return
      setBusy(true)
      let closed = 0
      let skipped = 0
      for (const partnerId of partnerIds) {
        const binding = bindingFor(partnerId)
        if (!binding) { skipped++; continue }
        try {
          await accountReconcileApi.close(binding)
          closed++
        } catch {
          skipped++
        }
      }
      toast.success(`关账完成：${closed} 家已定版，${skipped} 家挂起`)
      await loadOverview()
      setBusy(false)
    },
    [bindingFor, loadOverview],
  )

  const openWorkbench = useCallback((partnerId: string, partnerName: string) => {
    const binding = bindingFor(partnerId)
    if (!binding) {
      toast.error('该院本月还没有可用的对账代次，请先计算')
      return
    }
    setSelected({ partnerId, partnerName, binding })
    setTab('workbench')
  }, [bindingFor])

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
