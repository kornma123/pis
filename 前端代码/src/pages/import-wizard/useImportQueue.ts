import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { statementImportApi, type Grid } from '@/api/statement-import'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import type { PreviewResult, CommitResult } from '@/types/statement-import'
import type { PartnerConfigLine } from '@/types/partner-config'
import { readGrid } from '@/pages/import-shared/ImportShared'
import {
  clearImportWorkflowJournal,
  readImportWorkflowJournal,
  writeImportWorkflowJournal,
} from '@/pages/import-shared/importWorkflowJournal'
import type { StatementImportWorkflowJournal } from '@/pages/import-shared/importWorkflowJournal'

export type QStatus = 'pending' | 'attention' | 'ready' | 'committed' | 'error'
export interface QueueItem {
  id: string
  fileName: string
  grid: Grid
  partnerId: string        // 自动猜 + 可改
  suggestedName: string    // 从「客户：」解析出的原始院名（没匹配到医院时提示用）
  month: string            // 自动猜 + 可改
  preview: PreviewResult | null
  committed: CommitResult | null
  error: string
  configVersion: number
  lines: PartnerConfigLine[]
  status: QStatus
}

export interface CommitConfirmation {
  kind: 'confirm'
  itemId: string
  partnerId: string
  serviceMonth: string
  message: string
}

export type CommitOutcome = 'ok' | 'err' | 'busy' | CommitConfirmation

let seq = 0
const nextId = () => `q${++seq}`

/** 从对账单头几行找「客户：XXX」→ 院名。 */
function parseCustomerName(grid: Grid): string {
  for (const row of grid.slice(0, 6)) {
    for (const cell of row) {
      const s = String(cell ?? '')
      const m = s.match(/客户[:：]\s*([^\s，,]+)/)
      if (m) return m[1].trim()
    }
  }
  return ''
}

/** 去噪归一（市/省/区/·演示/（…）等），用于院名模糊匹配。 */
function norm(s: string): string {
  return String(s || '').replace(/[·（(].*$/, '').replace(/[市省区县\s]/g, '').trim()
}
/** 院名 → 合作医院 id（模糊匹配；**仅唯一命中才自动选**，多候选/无命中返回空、由人确认，防认错院）。 */
function matchHospital(name: string, hospitals: PartnerListItem[]): string {
  const c = norm(name)
  if (!c) return ''
  const hits = hospitals.filter((h) => { const hn = norm(h.name); return hn && (hn === c || hn.includes(c) || c.includes(hn)) })
  return hits.length === 1 ? hits[0].id : ''
}
/** 从文件名猜账期 YYYY-MM（如「…2026.01」「…202601」「…2026年1月」）；仅作建议、用户可改。 */
function parseMonth(fileName: string): string {
  const m = fileName.match(/(20\d{2})\s*[.\-_年/]?\s*(1[0-2]|0?[1-9])(?!\d)/)
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : ''
}

/** 批量导入队列：拖多家进来 → 自动猜院/账期 → 逐家核对入库。单文件亦复用（队列长度 1）。 */
export function useImportQueue(hospitals: PartnerListItem[]) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [busyCount, setBusyCount] = useState(0)
  const [lastJournal, setLastJournal] = useState(() => readImportWorkflowJournal('statement-import'))
  // 队列最新态引用（防陈旧闭包）：setPartner/setMonth 读它拿到最新 item，而非 useCallback 捕获的旧 queue。
  const queueRef = useRef<QueueItem[]>([])
  const linesGeneration = useRef(new Map<string, number>())
  const previewGeneration = useRef(new Map<string, number>())
  const commitLocks = useRef(new Set<string>())
  queueRef.current = queue
  const busy = busyCount > 0

  const beginBusy = useCallback(() => setBusyCount(count => count + 1), [])
  const endBusy = useCallback(() => setBusyCount(count => Math.max(0, count - 1)), [])
  const recordJournal = useCallback((journal: StatementImportWorkflowJournal) => {
    writeImportWorkflowJournal(journal)
  }, [])
  const dismissJournal = useCallback(() => {
    clearImportWorkflowJournal('statement-import')
    setLastJournal(null)
  }, [])

  const patch = useCallback((id: string, p: Partial<QueueItem>) => {
    const next = queueRef.current.map((it) => (it.id === id ? { ...it, ...p } : it))
    queueRef.current = next
    setQueue(next)
  }, [])

  const loadLines = useCallback(async (id: string, partnerId: string) => {
    const generation = (linesGeneration.current.get(id) || 0) + 1
    linesGeneration.current.set(id, generation)
    const isCurrent = () => {
      const item = queueRef.current.find((current) => current.id === id)
      return linesGeneration.current.get(id) === generation && !!item && item.partnerId === partnerId
    }
    patch(id, { lines: [] })
    if (!partnerId) return isCurrent()
    try {
      const env = await partnerConfigApi.get(partnerId)
      if (!isCurrent()) return false
      patch(id, { lines: env.config.lines })
      return true
    } catch {
      return isCurrent()
    }
  }, [patch])

  const runPreview = useCallback(async (item: QueueItem) => {
    const partnerId = item.partnerId, month = item.month
    if (!partnerId || !month) return
    const generation = (previewGeneration.current.get(item.id) || 0) + 1
    previewGeneration.current.set(item.id, generation)
    // 请求守卫：若响应返回时该 item 的院/账期已变（用户又改了），丢弃本次结果，避免陈旧请求覆盖最新预览。
    const stale = () => {
      const current = queueRef.current.find((candidate) => candidate.id === item.id)
      return previewGeneration.current.get(item.id) !== generation || !current || current.partnerId !== partnerId || current.month !== month
    }
    patch(item.id, { error: '', preview: null, committed: null, status: 'pending' })
    try {
      const r = await statementImportApi.preview({ partnerId, grid: item.grid, serviceMonth: month })
      if (stale()) return
      const st: QStatus = r.note ? 'ready' : r.needsAttention.length > 0 ? 'attention' : 'ready'
      patch(item.id, { preview: r, configVersion: r.configVersion, error: '', committed: null, status: st })
    } catch (e: any) {
      if (stale()) return
      patch(item.id, { error: e?.message || '预览失败', preview: null, status: 'error' })
    }
  }, [patch])

  // 拖入/选中多个文件 → 逐个建队列项（自动猜院/账期）
  const addFiles = useCallback(async (files: File[]) => {
    beginBusy()
    try {
      const created: QueueItem[] = []
      for (const f of files) {
        try {
          const grid = await readGrid(f)
          const name = parseCustomerName(grid)
          const partnerId = matchHospital(name, hospitals)
          const month = parseMonth(f.name)
          const item: QueueItem = { id: nextId(), fileName: f.name, grid, partnerId, suggestedName: name, month, preview: null, committed: null, error: '', configVersion: 0, lines: [], status: 'pending' }
          created.push(item)
        } catch {
          toast.error(`读取失败：${f.name}`)
        }
      }
      if (created.length) {
        setQueue((q) => [...q, ...created])
        queueRef.current = [...queueRef.current, ...created] // 立即同步 ref：本轮预览守卫要能看到刚建的项（setQueue 异步、ref 下次 render 才更新）
        setActiveId((cur) => cur || created[0].id)
        // 自动认到院的，并发预载业务线 + 预览（各家按 id 函数式合并、runPreview 有守卫，互不覆盖；串行会拖慢批量）。
        await Promise.allSettled(created.filter((it) => it.partnerId).map(async (it) => {
          if (!queueRef.current.find((x) => x.id === it.id)) return // 循环期间被删 → 跳过，不发无谓请求
          const linesReady = await loadLines(it.id, it.partnerId)
          const current = queueRef.current.find((candidate) => candidate.id === it.id)
          if (linesReady && current?.partnerId === it.partnerId && current.month) await runPreview(current)
        }))
        const unmatched = created.filter((c) => !c.partnerId).length
        if (unmatched) toast.info(`${created.length} 家已入队，其中 ${unmatched} 家没自动认出医院，请手选`)
        else toast.success(`${created.length} 家已入队`)
      }
    } finally {
      endBusy()
    }
  }, [beginBusy, endBusy, hospitals, loadLines, runPreview])

  const addFile = useCallback((f: File) => addFiles([f]), [addFiles])

  const setPartner = useCallback(async (id: string, partnerId: string) => {
    patch(id, { partnerId, preview: null, committed: null, error: '', status: 'pending' })
    const linesReady = await loadLines(id, partnerId)
    if (!linesReady) return
    const it = queueRef.current.find((x) => x.id === id)
    if (it?.partnerId === partnerId) await runPreview(it)
  }, [patch, loadLines, runPreview])

  const setMonth = useCallback(async (id: string, month: string) => {
    patch(id, { month, preview: null, committed: null, error: '', status: 'pending' })
    const it = queueRef.current.find((x) => x.id === id)
    if (it) await runPreview({ ...it, month })
  }, [patch, runPreview])

  const classify = useCallback(async (item: QueueItem, lineKey: string, ruleType: 'keyword' | 'prefix' | 'remark', value: string) => {
    if (!item.partnerId || !lineKey || !value.trim()) return
    const latest = queueRef.current.find((x) => x.id === item.id)
    if (!latest || latest.partnerId !== item.partnerId || !['attention', 'ready'].includes(latest.status)) return
    try {
      await statementImportApi.classifyRule({ partnerId: item.partnerId, lineKey, ruleType, value, expectedVersion: item.configVersion })
      const env = await partnerConfigApi.get(item.partnerId)
      // 守卫：分类往返期间用户把该项切了院 → 别把院A 的 lines/version 贴到已是院B 的 item 上（configVersion 与 partnerId 须绑定）。
      const cur = queueRef.current.find((x) => x.id === item.id)
      if (!cur || cur.partnerId !== item.partnerId) return
      patch(item.id, { lines: env.config.lines, configVersion: env.version }) // 先写回新版本，乐观锁链完整
      toast.success('已写回该院配置，重新预览')
      await runPreview(cur)
    } catch (e: any) {
      if (e?.response?.data?.error?.code === 'CONFLICT' || e?.response?.status === 409) toast.error('该院配置已更新，请重新上传预览后再归类')
    }
  }, [patch, runPreview])

  const commit = useCallback(async (item: QueueItem, confirm: boolean, overrideReason?: string): Promise<CommitOutcome> => {
    if (!item.partnerId || !item.month) { toast.error('先选医院和账期'); return 'err' }
    const latest = queueRef.current.find((x) => x.id === item.id)
    if (!latest || latest.partnerId !== item.partnerId || latest.month !== item.month || !['attention', 'ready'].includes(latest.status)) {
      toast.error('当前预览已失效，请重新预览后再入库')
      return 'err'
    }
    const reason = overrideReason?.trim() || ''
    if (confirm && !reason) { toast.error('请填写确认理由'); return 'err' }
    if (commitLocks.current.has(item.id)) return 'busy'
    commitLocks.current.add(item.id)
    const stale = () => {
      const current = queueRef.current.find((x) => x.id === item.id)
      return !current || current.partnerId !== item.partnerId || current.month !== item.month
    }
    beginBusy()
    recordJournal({
      version: 1,
      kind: 'statement-import',
      phase: 'submitting',
      updatedAt: new Date().toISOString(),
      fileName: item.fileName,
      partnerId: item.partnerId,
      serviceMonth: item.month,
    })
    try {
      const base = { partnerId: item.partnerId, grid: item.grid, serviceMonth: item.month }
      const r = confirm
        ? await statementImportApi.commit({ ...base, confirm: true, overrideReason: reason })
        : await statementImportApi.commit({ ...base, confirm: false })
      recordJournal({
        version: 1,
        kind: 'statement-import',
        phase: 'settled',
        updatedAt: new Date().toISOString(),
        fileName: item.fileName,
        partnerId: item.partnerId,
        serviceMonth: item.month,
        receipt: { importBatch: r.importBatch, caseCount: r.caseCount },
      })
      if (stale()) return 'err'
      patch(item.id, { committed: r, error: '', status: 'committed' })
      toast.success(`${item.fileName}：已入库 ${r.caseCount} 例`)
      return 'ok'
    } catch (e: any) {
      const be = e?.response?.data?.error
      if (e?.response?.status === 409 && be?.code === 'NEEDS_CONFIRM') {
        recordJournal({
          version: 1,
          kind: 'statement-import',
          phase: 'needs-confirmation',
          updatedAt: new Date().toISOString(),
          fileName: item.fileName,
          partnerId: item.partnerId,
          serviceMonth: item.month,
        })
        if (stale()) return 'err'
        return {
          kind: 'confirm',
          itemId: item.id,
          partnerId: item.partnerId,
          serviceMonth: item.month,
          message: be?.message || '本次对账单未通过自动入库门禁，请核对后填写旁路理由',
        }
      }
      const message = be?.message || e?.message || '入库失败'
      recordJournal({
        version: 1,
        kind: 'statement-import',
        phase: 'failed',
        updatedAt: new Date().toISOString(),
        fileName: item.fileName,
        partnerId: item.partnerId,
        serviceMonth: item.month,
      })
      if (stale()) return 'err'
      patch(item.id, { error: message, committed: null, status: 'error' }); return 'err'
    } finally {
      commitLocks.current.delete(item.id)
      endBusy()
    }
  }, [beginBusy, endBusy, patch, recordJournal])

  const removeItem = useCallback((id: string) => {
    const remaining = queueRef.current.filter((it) => it.id !== id)
    linesGeneration.current.delete(id)
    previewGeneration.current.delete(id)
    queueRef.current = remaining
    setQueue(remaining)
    setActiveId((cur) => (cur === id ? (remaining[0]?.id || '') : cur)) // 删掉 active → 回落到剩余项，别留空占位
  }, [])

  const active = queue.find((it) => it.id === activeId) || null
  return {
    queue, active, activeId, setActiveId, busy, lastJournal, dismissJournal,
    addFile, addFiles, setPartner, setMonth, classify, commit, removeItem, runPreview,
  }
}
