import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Lock, Loader2, AlertCircle, CheckCircle2, Database, ArrowRight, Upload, Info, X, Circle } from 'lucide-react'
import { statementImportApi } from '@/api/statement-import'
import { useHospitals, ScoreCard, ByLineTable, AttentionItem, btnCls, btnPri, inputCls, yuan } from '@/pages/import-shared/ImportShared'
import { useImportQueue, type QueueItem, type QStatus } from './useImportQueue'

const STATUS_META: Record<QStatus, { t: string; c: string }> = {
  pending: { t: '待核对', c: 'text-gray-500 bg-gray-100' },
  attention: { t: '待归类', c: 'text-amber-700 bg-amber-50' },
  ready: { t: '已核对', c: 'text-emerald-700 bg-emerald-50' },
  committed: { t: '已入库', c: 'text-blue-700 bg-blue-50' },
  error: { t: '出错', c: 'text-rose-700 bg-rose-50' },
}

export default function ImportWizardPage() {
  const { hospitals } = useHospitals()
  const q = useImportQueue(hospitals)
  const active = q.active
  const [needConfirm, setNeedConfirm] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  // active 项预览刷新（含 classify 后重预览把未识别清空）或切换家 → 清确认横幅，避免页级 needConfirm 赖着不走。
  useEffect(() => { setNeedConfirm(null) }, [active?.id, active?.preview])

  const takeFiles = (all: File[]) => {
    if (q.busy) { toast.info('正在解析，请稍候'); return }
    const files = all.filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name))
    if (!files.length) { if (all.length) toast.error('只支持 .xlsx / .xls / .csv 对账单'); return }
    q.addFiles(files)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragOver(false)
    takeFiles(Array.from(e.dataTransfer.files || []))
  }
  const doCommit = async (confirm: boolean) => {
    if (!active) return
    const r = await q.commit(active, confirm)
    setNeedConfirm(r === 'confirm' ? '对账单有未识别行或未对平，确认后照常入库（未识别金额不计入实验室收入）。' : null)
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Database className="h-5 w-5 text-blue-500" />
        <h1 className="text-[18px] font-semibold text-gray-900">财务月度导入</h1>
        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500"><Lock className="h-3 w-3" />仅财务 / 管理员</span>
      </div>
      <p className="mb-4 text-[13px] text-gray-500">一次拖一到多家医院的对账单进来，系统自动认院、逐家核对入库。入库后院级盈亏看板即刷新。</p>

      {/* 拖拽 / 上传区（多文件） */}
      <div
        className={`mb-4 flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${dragOver ? 'border-blue-400 bg-blue-50/60' : 'border-gray-300 bg-white'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
      >
        <Upload className="h-6 w-6 text-gray-300" />
        <div className="text-[13px] text-gray-600">{dragOver ? '松开即导入' : '把一到多家医院的对账单拖到这里'}</div>
        <button type="button" className={btnPri + ' mt-1'} disabled={q.busy} onClick={() => fileRef.current?.click()}>
          {q.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}选择对账单（.xlsx）
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" multiple className="hidden" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { takeFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
      </div>

      {/* 队列 */}
      {q.queue.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-[12px] font-medium text-gray-500">本次对账单 · {q.queue.length} 家</div>
          <div className="flex flex-wrap gap-2">
            {q.queue.map((it) => {
              const m = STATUS_META[it.status]
              const on = it.id === q.activeId
              const label = hospitals.find((h) => h.id === it.partnerId)?.name || it.suggestedName || it.fileName
              return (
                <button key={it.id} onClick={() => { q.setActiveId(it.id); setNeedConfirm(null) }}
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors ${on ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                  <div>
                    <div className="font-medium text-gray-900">{label}{!it.partnerId && <span className="ml-1 text-[11px] text-amber-600">未认出</span>}</div>
                    <div className="mt-0.5 flex items-center gap-1.5"><span className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-medium ${m.c}`}>{m.t}</span><span className="text-[11px] text-gray-400">{it.month || '缺账期'}</span></div>
                  </div>
                  <X className="h-3.5 w-3.5 text-gray-300 hover:text-rose-500" onClick={(e) => { e.stopPropagation(); q.removeItem(it.id) }} />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {active ? <ActiveDetail item={active} hospitals={hospitals} q={q} needConfirm={needConfirm} onCommit={doCommit} /> : (
        <div className="rounded-lg border border-dashed border-gray-200 py-12 text-center text-[13px] text-gray-400">拖对账单进来后，在上方选一家开始核对。</div>
      )}
    </div>
  )
}

function ActiveDetail({ item, hospitals, q, needConfirm, onCommit }: {
  item: QueueItem; hospitals: { id: string; name: string }[]; q: ReturnType<typeof useImportQueue>
  needConfirm: string | null; onCommit: (confirm: boolean) => void
}) {
  const p = item.preview
  const partnerName = hospitals.find((h) => h.id === item.partnerId)?.name || '该院'
  // LIS 预检（顺序引导：该院无 LIS → 拆分只能按账单数量估、偏下限）。不阻断入库。
  const [lisCov, setLisCov] = useState<{ total: number } | null>(null)
  useEffect(() => {
    setLisCov(null)
    if (!item.partnerId) return
    let stale = false
    statementImportApi.lisCoverage(item.partnerId, item.month || undefined).then((r) => { if (!stale) setLisCov(r as { total: number }) }).catch(() => {})
    return () => { stale = true }
  }, [item.partnerId, item.month])
  if (item.committed) {
    const c = item.committed
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm">
        <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
        <div className="text-[15px] font-semibold text-gray-900">{partnerName} · 已入库 {c.caseCount} 例</div>
        <div className="mt-1 text-[13px] text-gray-500">实验室收入 <b className="tabular-nums text-gray-900">{yuan(c.labRevenue)}</b> · 诊断与报告 {yuan(c.diagnosisSettle)} · 外送转出 {yuan(c.outSettle)}{c.unmatchedSettle > 0 && <> · 未识别 {yuan(c.unmatchedSettle)}（未计入）</>}</div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Link to="/hospital-pnl" className={btnPri}>去看院级盈亏看板<ArrowRight className="h-4 w-4" /></Link>
          <button className={btnCls} onClick={() => q.removeItem(item.id)}>从队列移除</button>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-4">
      {/* 院 / 账期（自动认、可改） */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <label className="flex flex-col gap-1"><span className="text-[12px] font-medium text-gray-500">合作医院{item.suggestedName && !item.partnerId && <span className="ml-1 text-amber-600">（原文「{item.suggestedName}」没认出，请手选）</span>}{item.suggestedName && item.partnerId && <span className="ml-1 text-emerald-600">（自动认自「{item.suggestedName}」）</span>}</span>
          <select className={inputCls + ' w-64'} value={item.partnerId} onChange={(e) => q.setPartner(item.id, e.target.value)} aria-label="合作医院">
            <option value="">选择医院…</option>{hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-[12px] font-medium text-gray-500">账期</span>
          <input type="month" className={inputCls + ' tabular-nums'} value={item.month} onChange={(e) => q.setMonth(item.id, e.target.value)} aria-label="账期" /></label>
        <span className="inline-flex items-center gap-1 pb-2 text-[12px] text-gray-400"><Circle className="h-2.5 w-2.5 fill-current" />{item.fileName}</span>
      </div>

      {item.partnerId && lisCov && lisCov.total === 0 && (
        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12.5px] text-blue-800">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{partnerName}还没有 LIS 病例数据：拆分类收费只能按账单数量估算（口径偏下限）。建议先让管理员导入该院 LIS 再入库——不导也能入，之后补导 LIS 并重新导入本对账单即可更新。</span>
        </div>
      )}

      {item.error && <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{item.error}</div>}
      {!item.partnerId ? (
        <div className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-[13px] text-gray-400">先认到医院（上方手选），再出预览。</div>
      ) : !item.month ? (
        <div className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-[13px] text-gray-400">补上账期，再出预览。</div>
      ) : !p ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />解析预览中…</div>
      ) : p.note ? (
        <div className="rounded-lg border border-gray-200 bg-white p-5 text-[13px] text-gray-600 shadow-sm">{p.template} · {p.note}（该模板暂不支持逐 case 入库）</div>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm"><ScoreCard score={p.score} revenue={p.revenue} /></div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="mb-2 text-[13px] font-semibold text-gray-900">按业务线拆分 <span className="text-[12px] font-normal text-gray-400">· 每条线归到哪、其中计入实验室多少</span></h3>
            <ByLineTable revenue={p.revenue} />
          </div>
          {p.needsAttention.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-white p-4 shadow-sm">
              <h3 className="mb-1 text-[13px] font-semibold text-gray-900">待归类 <span className="text-[11.5px] font-normal text-gray-400">（{p.needsAttention.length} 行 · {yuan(p.revenue.unmatchedSettle + p.revenue.ambiguousSettle)}）</span></h3>
              <p className="mb-3 flex items-start gap-1.5 text-[12px] text-amber-700"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>当场归类会写回 <b>{partnerName}</b> 的识别规则、<b>以后每月自动照此识别</b>（不只这一张）。不想改规则就直接「入库」，未识别金额不计入实验室收入。</span></p>
              <div className="space-y-2">{p.needsAttention.map((row, i) => <AttentionItem key={i} item={row.item} no={row.no} settle={row.settle} status={row.status} lines={item.lines} onClassify={(lk, rt, v) => q.classify(item, lk, rt, v)} />)}</div>
            </div>
          )}
          {needConfirm && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900">
              <div className="mb-2">{needConfirm}</div>
              <button className={btnPri} onClick={() => onCommit(true)} disabled={q.busy}>{q.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}确认入库（含未识别）</button>
            </div>
          )}
          {!needConfirm && (
            <div className="flex justify-end"><button className={btnPri} onClick={() => onCommit(false)} disabled={q.busy}>{q.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}入库这一家</button></div>
          )}
        </>
      )}
    </div>
  )
}
