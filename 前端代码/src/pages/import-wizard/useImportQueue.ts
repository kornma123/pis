import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { statementImportApi, type Grid } from '@/api/statement-import'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import type { PreviewResult, CommitResult } from '@/types/statement-import'
import type { PartnerConfigLine } from '@/types/partner-config'
import { readGrid } from '@/pages/import-shared/ImportShared'

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
  const [busy, setBusy] = useState(false)
  // 队列最新态引用（防陈旧闭包）：setPartner/setMonth 读它拿到最新 item，而非 useCallback 捕获的旧 queue。
  const queueRef = useRef<QueueItem[]>([])
  queueRef.current = queue

  const patch = useCallback((id: string, p: Partial<QueueItem>) => {
    setQueue((q) => q.map((it) => (it.id === id ? { ...it, ...p } : it)))
  }, [])

  const loadLines = useCallback(async (id: string, partnerId: string) => {
    if (!partnerId) { patch(id, { lines: [] }); return }
    try { const env = await partnerConfigApi.get(partnerId); patch(id, { lines: env.config.lines }) } catch { /* 忽略 */ }
  }, [patch])

  const runPreview = useCallback(async (item: QueueItem) => {
    const partnerId = item.partnerId, month = item.month
    if (!partnerId || !month) return
    // 请求守卫：若响应返回时该 item 的院/账期已变（用户又改了），丢弃本次结果，避免陈旧请求覆盖最新预览。
    const stale = () => { const c = queueRef.current.find((x) => x.id === item.id); return !c || c.partnerId !== partnerId || c.month !== month }
    patch(item.id, { error: '' })
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
    setBusy(true)
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
        await loadLines(it.id, it.partnerId)
        if (it.month) await runPreview(it)
      }))
      const unmatched = created.filter((c) => !c.partnerId).length
      if (unmatched) toast.info(`${created.length} 家已入队，其中 ${unmatched} 家没自动认出医院，请手选`)
      else toast.success(`${created.length} 家已入队`)
    }
    setBusy(false)
  }, [hospitals, loadLines, runPreview])

  const addFile = useCallback((f: File) => addFiles([f]), [addFiles])

  const setPartner = useCallback(async (id: string, partnerId: string) => {
    patch(id, { partnerId, preview: null, committed: null })
    await loadLines(id, partnerId)
    const it = queueRef.current.find((x) => x.id === id)
    if (it) await runPreview({ ...it, partnerId })
  }, [patch, loadLines, runPreview])

  const setMonth = useCallback(async (id: string, month: string) => {
    patch(id, { month, preview: null, committed: null })
    const it = queueRef.current.find((x) => x.id === id)
    if (it) await runPreview({ ...it, month })
  }, [patch, runPreview])

  const classify = useCallback(async (item: QueueItem, lineKey: string, ruleType: 'keyword' | 'prefix' | 'remark', value: string) => {
    if (!item.partnerId || !lineKey || !value.trim()) return
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

  const commit = useCallback(async (item: QueueItem, confirm: boolean): Promise<'ok' | 'confirm' | 'err'> => {
    if (!item.partnerId || !item.month) { toast.error('先选医院和账期'); return 'err' }
    setBusy(true)
    try {
      const r = await statementImportApi.commit({ partnerId: item.partnerId, grid: item.grid, serviceMonth: item.month, confirm })
      patch(item.id, { committed: r, error: '', status: 'committed' })
      toast.success(`${item.fileName}：已入库 ${r.caseCount} 例`)
      return 'ok'
    } catch (e: any) {
      const be = e?.response?.data?.error
      if (be?.code === 'NEEDS_CONFIRM' || e?.response?.status === 409) return 'confirm'
      patch(item.id, { error: be?.message || e?.message || '入库失败' }); return 'err'
    } finally { setBusy(false) }
  }, [patch])

  const removeItem = useCallback((id: string) => {
    const remaining = queueRef.current.filter((it) => it.id !== id)
    setQueue(remaining)
    setActiveId((cur) => (cur === id ? (remaining[0]?.id || '') : cur)) // 删掉 active → 回落到剩余项，别留空占位
  }, [])

  const active = queue.find((it) => it.id === activeId) || null
  return { queue, active, activeId, setActiveId, busy, addFile, addFiles, setPartner, setMonth, classify, commit, removeItem, runPreview }
}
