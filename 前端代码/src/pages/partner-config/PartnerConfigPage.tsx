import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Lock, ArrowLeft, Save, Plus, X, History, ChevronRight, Loader2, AlertCircle, Search, Scissors } from 'lucide-react'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import type { PartnerConfig, ConfigChange, LineScope } from '@/types/partner-config'
import { getRoles, getUserRole } from '@/lib/permissions'

// —— 设计令牌（Stripe 风，主蓝 #3b82f6；按钮 h-10=项目标准）——
const inputCls = 'h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-900 placeholder:text-gray-400 outline-none transition-colors focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10'
// 归类中文文案 + 拆分国标费率（固定，不开放自定义）+ 制片份额预览（以 2 蜡块为例）
const SCOPE_LABEL: Record<LineScope, string> = { in: '计入实验室', out: '外送转出（不计）', split: '拆分（只计制片）', diagnosis: '诊断与报告（不计）' }
const PROC_RATE_OPTS: Array<{ rate: number; label: string }> = [{ rate: 36, label: '¥36 · 组织/冰冻' }, { rate: 75, label: '¥75 · 细胞' }]
const splitInPct = (rate: number): number => Math.round(((rate * 2) / (rate * 2 + 105)) * 100)
const btnCls = 'inline-flex h-10 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:ring-[3px] focus-visible:ring-blue-500/10 focus-visible:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50'
const btnPri = 'inline-flex h-10 items-center gap-1.5 rounded-md bg-blue-500 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-blue-600 focus-visible:ring-[3px] focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50'
const label = 'mb-1 block text-[12px] font-medium text-gray-500'

// codex F10：不用 window.confirm 承载流程，改用应用内确认弹层（可样式化/焦点管理/Esc）。
type ConfirmReq = { title: string; desc?: string; danger?: boolean; onConfirm: () => void }
function ConfirmDialog({ req, onClose }: { req: ConfirmReq | null; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (req) ref.current?.focus() }, [req])
  if (!req) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={req.title}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[15px] font-semibold text-gray-900">{req.title}</h3>
        {req.desc && <p className="mt-1.5 text-[13px] text-gray-500">{req.desc}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className={btnCls} onClick={onClose}>取消</button>
          <button ref={ref} onClick={() => { req.onConfirm(); onClose() }}
            className={req.danger
              ? 'inline-flex h-10 items-center gap-1.5 rounded-md bg-rose-600 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-rose-700 focus-visible:ring-[3px] focus-visible:ring-rose-500/30'
              : btnPri}>确认</button>
        </div>
      </div>
    </div>
  )
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'basic', label: '基本档案' },
  { key: 'lines', label: '业务分类' },
  { key: 'discount', label: '结算扣率' },
  { key: 'special', label: '分成与固定费' },
  { key: 'parse', label: '对账单解析' },
  { key: 'changes', label: '变更记录' },
]
type TabKey = 'basic' | 'lines' | 'discount' | 'special' | 'parse' | 'changes'

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o))
const coopMode = (c: PartnerConfig) => (c.special.joint.on ? '共建分成' : c.special.retainer.on ? '含每月保底费' : '常规结算')

export default function PartnerConfigPage() {
  const [view, setView] = useState<'list' | 'detail'>('list')
  // —— 列表 ——
  const [partners, setPartners] = useState<PartnerListItem[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [q, setQ] = useState('')
  // —— 详情 ——
  const [curId, setCurId] = useState('')
  const [curName, setCurName] = useState('')
  const [version, setVersion] = useState(0)
  const [isBaseline, setIsBaseline] = useState(false)
  const [cfg, setCfg] = useState<PartnerConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<TabKey>('basic')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const [changes, setChanges] = useState<ConfigChange[]>([])
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const loadPartners = useCallback(async () => {
    setListLoading(true); setListError('')
    try {
      const r = await partnerConfigApi.partners()
      setPartners(r.list || [])
    } catch (e: any) {
      setListError(e?.message || '加载合作医院失败')
    } finally {
      setListLoading(false)
    }
  }, [])
  useEffect(() => { loadPartners() }, [loadPartners])

  const filtered = useMemo(
    () => partners.filter((p) => !q || p.name.includes(q) || p.code.includes(q)),
    [partners, q],
  )

  const openDetail = useCallback(async (id: string, name: string) => {
    setView('detail'); setCurId(id); setCurName(name); setTab('basic')
    setDetailLoading(true); setDetailError(''); setSaveErr(''); setDirty(false); setCfg(null)
    try {
      const env = await partnerConfigApi.get(id)
      setCfg(env.config); setVersion(env.version); setIsBaseline(env.isBaseline)
      const ch = await partnerConfigApi.changes(id)
      setChanges(ch)
    } catch (e: any) {
      setDetailError(e?.message || '加载配置失败')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const patch = useCallback((fn: (c: PartnerConfig) => void) => {
    setCfg((prev) => { if (!prev) return prev; const next = clone(prev); fn(next); return next })
    setDirty(true); setSaveErr('')
  }, [])

  function validate(c: PartnerConfig): string[] {
    const bad: string[] = []
    if (!(c.discount.def > 0 && c.discount.def <= 1)) bad.push('默认扣率须在 0–1 之间')
    c.discount.byLine.forEach((d) => { if (!(d.rate > 0 && d.rate <= 1)) bad.push('按业务线扣率须在 0–1 之间') })
    c.discount.byItem.forEach((d) => { if (!d.item.trim()) bad.push('按项目扣率的项目名不能为空'); if (!(d.rate > 0 && d.rate <= 1)) bad.push('按项目扣率须在 0–1 之间') })
    c.lines.forEach((l) => {
      if (!l.name.trim()) bad.push('业务线名称不能为空')
      if (l.scope === 'split' && !(Number(l.splitProcRate) > 0)) bad.push('拆分线需选择处理费（国标）')
    })
    return [...new Set(bad)]
  }

  const save = useCallback(async () => {
    if (!cfg || !curId) return
    const bad = validate(cfg)
    if (bad.length) { setSaveErr('保存前请先修正：' + bad.join('；')); return }
    setSaving(true); setSaveErr('')
    try {
      const tabLabel = TABS.find((t) => t.key === tab)?.label
      const r = await partnerConfigApi.save(curId, { config: cfg, expectedVersion: version, tab: tabLabel })
      setVersion(r.version); setDirty(false)
      toast.success(r.diffs.length ? `已保存 v${r.version}（${r.diffs.length} 项变更）` : '无改动')
      setChanges(await partnerConfigApi.changes(curId))
    } catch (e: any) {
      // 乐观锁冲突等 → 拦截器已 toast；这里刷新到最新
      if (/冲突|409|CONFLICT/i.test(e?.code || e?.message || '')) {
        const env = await partnerConfigApi.get(curId)
        setCfg(env.config); setVersion(env.version); setDirty(false)
        setSaveErr('配置已被他人更新，已刷新到最新版本，请重做改动')
      }
    } finally {
      setSaving(false)
    }
  }, [cfg, curId, version, tab])

  const discard = useCallback(() => {
    if (!dirty || !curId) return
    setConfirmReq({ title: '放弃所有未保存改动？', desc: '当前改动将丢失，无法恢复。', danger: true, onConfirm: async () => {
      const env = await partnerConfigApi.get(curId)
      setCfg(env.config); setVersion(env.version); setDirty(false); setSaveErr('')
    } })
  }, [dirty, curId])

  const rollback = useCallback((toVersion: number) => {
    if (!curId) return
    setConfirmReq({ title: `回滚到 v${toVersion}？`, desc: '当前未保存改动将丢失，回滚本身也会记一条变更。', onConfirm: async () => {
      try {
        const r = await partnerConfigApi.rollback(curId, toVersion)
        toast.success(`已回滚到 v${toVersion}（生成新版本 v${r.version}）`)
        const env = await partnerConfigApi.get(curId)
        setCfg(env.config); setVersion(env.version); setIsBaseline(env.isBaseline); setDirty(false)
        setChanges(await partnerConfigApi.changes(curId))
      } catch { /* 拦截器已 toast */ }
    } })
  }, [curId])

  const setBaseline = useCallback(async () => {
    if (!curId) return
    try {
      await partnerConfigApi.baseline(curId, version)
      setIsBaseline(true)
      toast.success(`已设 v${version} 为月度导入基线`)
    } catch { /* 拦截器已 toast */ }
  }, [curId, version])

  // ============ 列表视图 ============
  if (view === 'list') {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-[18px] font-semibold text-gray-900">合作医院配置</h1>
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500"><Lock className="h-3 w-3" />仅财务 / 管理员</span>
        </div>
        <p className="mb-4 text-[13px] text-gray-500">每家医院一份配置：业务分类（算不算实验室）、结算扣率、对账单解析、分成与固定费。改动会记一条可回滚的变更。</p>

        <div className="relative mb-3 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input className={inputCls + ' pl-9'} placeholder="搜索医院名称 / 编码" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          {listLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : listError ? (
            <div className="flex flex-col items-center gap-3 py-16 text-[13px] text-gray-500">
              <AlertCircle className="h-6 w-6 text-amber-500" />{listError}
              <button className={btnCls} onClick={loadPartners}>重试</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-gray-400">{q ? '没有匹配的医院' : '暂无合作医院'}</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-[12px] text-gray-500">
                  <th className="px-4 py-2.5 font-medium">医院</th>
                  <th className="px-4 py-2.5 font-medium">编码</th>
                  <th className="px-4 py-2.5 font-medium">服务范围</th>
                  <th className="px-4 py-2.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="cursor-pointer border-t border-gray-100 transition-colors hover:bg-blue-50/40" onClick={() => openDetail(p.id, p.name)}
                    role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(p.id, p.name) } }}>
                    <td className="px-4 py-3 font-medium text-gray-900">{p.name}</td>
                    <td className="px-4 py-3 text-gray-500 tabular-nums">{p.code}</td>
                    <td className="px-4 py-3 text-gray-500">{p.serviceScope === 'with_diagnosis' ? '技术+诊断' : '仅技术'}</td>
                    <td className="px-4 py-3 text-right text-blue-500"><span className="inline-flex items-center gap-0.5">配置<ChevronRight className="h-4 w-4" /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )
  }

  // ============ 详情视图 ============
  return (
    <div className="mx-auto max-w-5xl p-6">
      {/* 头部 */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button className={btnCls} onClick={() => { if (dirty) setConfirmReq({ title: '有未保存改动，确定返回？', desc: '未保存的改动将丢失。', danger: true, onConfirm: () => setView('list') }); else setView('list') }}><ArrowLeft className="h-4 w-4" />返回列表</button>
        <span className="text-[16px] font-semibold text-gray-900">{cfg?.basic.full || curName}</span>
        {cfg && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11.5px] text-gray-500">{coopMode(cfg)}</span>}
        <span className="text-[12px] text-gray-400 tabular-nums">v{version}{isBaseline ? ' · 基线' : ''}</span>
        <span className="inline-flex items-center gap-1 text-[11.5px] text-gray-400"><Lock className="h-3 w-3" />仅财务 / 管理员</span>
        {dirty && <span className="inline-flex items-center gap-1 text-[12px] text-amber-600">● 有未保存改动</span>}
        <span className="ml-auto flex items-center gap-2">
          <button className={btnCls} onClick={discard} disabled={!dirty}>放弃改动</button>
          <button className={btnCls} onClick={setBaseline} disabled={dirty} title="设当前版本为月度导入基线">设为导入基线</button>
          <button className={btnPri} onClick={save} disabled={saving || !cfg}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存</button>
        </span>
      </div>

      {saveErr && <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{saveErr}</div>}

      {/* Tab 条（codex F9：WAI-ARIA tabs 语义 + 方向键切换） */}
      <div role="tablist" aria-label="配置分区" className="mb-4 flex flex-wrap gap-1 border-b border-gray-200">
        {TABS.map((t, ti) => (
          <button key={t.key} role="tab" id={`tab-${t.key}`} aria-controls={`panel-${t.key}`} aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1} ref={(el) => { tabRefs.current[ti] = el }}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const ni = (ti + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
                setTab(TABS[ni].key); tabRefs.current[ni]?.focus()
              }
            }}
            className={`h-10 rounded-t-md px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/40 ${tab === t.key ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-800'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {detailLoading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />加载配置中…</div>
      ) : detailError ? (
        <div className="flex flex-col items-center gap-3 py-20 text-[13px] text-gray-500"><AlertCircle className="h-6 w-6 text-amber-500" />{detailError}
          <button className={btnCls} onClick={() => openDetail(curId, curName)}>重试</button></div>
      ) : !cfg ? null : (
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          {tab === 'basic' && <BasicTab cfg={cfg} patch={patch} />}
          {tab === 'lines' && <LinesTab cfg={cfg} patch={patch} askConfirm={setConfirmReq} />}
          {tab === 'discount' && <DiscountTab cfg={cfg} patch={patch} />}
          {tab === 'special' && <SpecialTab cfg={cfg} patch={patch} />}
          {tab === 'parse' && <ParseTab cfg={cfg} />}
          {tab === 'changes' && <ChangesTab changes={changes} onRollback={rollback} />}
        </div>
      )}
      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
    </div>
  )
}

// ============ 各 Tab ============
type PatchFn = (fn: (c: PartnerConfig) => void) => void

// codex F5：用 <label> 包裹，控件与标签隐式关联（读屏可念出字段名；原 <span> 无关联）。
function Field({ label: l, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className={label}>{l}</span>{children}</label>
}

function BasicTab({ cfg, patch }: { cfg: PartnerConfig; patch: PatchFn }) {
  const b = cfg.basic
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="医院全称"><input className={inputCls} value={b.full} onChange={(e) => patch((c) => { c.basic.full = e.target.value })} /></Field>
      <Field label="简称"><input className={inputCls} value={b.short} onChange={(e) => patch((c) => { c.basic.short = e.target.value })} /></Field>
      <Field label="编码"><input className={inputCls} value={b.code} onChange={(e) => patch((c) => { c.basic.code = e.target.value })} /></Field>
      <Field label="所属集团"><input className={inputCls} value={b.group} onChange={(e) => patch((c) => { c.basic.group = e.target.value })} /></Field>
      <Field label="院区"><input className={inputCls} value={b.campus} onChange={(e) => patch((c) => { c.basic.campus = e.target.value })} /></Field>
      <Field label="合作起始（YYYY-MM）"><input className={inputCls} value={b.start} placeholder="2023-07" onChange={(e) => patch((c) => { c.basic.start = e.target.value })} /></Field>
      <Field label="合作状态"><input className={inputCls} value={b.status} onChange={(e) => patch((c) => { c.basic.status = e.target.value })} /></Field>
      <Field label="联系人"><input className={inputCls} value={b.contact} onChange={(e) => patch((c) => { c.basic.contact = e.target.value })} /></Field>
      <div className="sm:col-span-2 mt-1 grid grid-cols-3 gap-4 rounded-md bg-gray-50 p-3">
        <Field label="开单计税口径">
          <select className={inputCls} value={cfg.amount.bill} onChange={(e) => patch((c) => { c.amount.bill = e.target.value as '未税' | '含税' })}><option>未税</option><option>含税</option></select>
        </Field>
        <Field label="结算计税口径">
          <select className={inputCls} value={cfg.amount.settle} onChange={(e) => patch((c) => { c.amount.settle = e.target.value as '未税' | '含税' })}><option>未税</option><option>含税</option></select>
        </Field>
        <Field label="税率（%）"><input type="number" className={inputCls + ' tabular-nums'} value={cfg.amount.rate} onChange={(e) => patch((c) => { c.amount.rate = Number(e.target.value) })} /></Field>
      </div>
    </div>
  )
}

function Chips({ words, onAdd, onDel, placeholder }: { words: string[]; onAdd: (w: string) => void; onDel: (i: number) => void; placeholder: string }) {
  const [v, setV] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {words.map((w, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[12px] text-blue-700">
          {w}<button className="text-blue-400 hover:text-red-500" aria-label={`删除 ${w}`} onClick={() => onDel(i)}><X className="h-3 w-3" /></button>
        </span>
      ))}
      <input className="h-7 w-28 rounded-md border border-gray-200 bg-white px-2 text-[12px] outline-none focus:border-blue-500" placeholder={placeholder} value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); v.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean).forEach(onAdd); setV('') } }} />
    </div>
  )
}

function LinesTab({ cfg, patch, askConfirm }: { cfg: PartnerConfig; patch: PatchFn; askConfirm: (r: ConfirmReq) => void }) {
  const hasRemark = !!(cfg.parse.colMap && (cfg.parse.colMap as any).remark != null)
  const isAdmin = getRoles().includes('admin') || getUserRole() === 'admin'
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-gray-500">每条业务线：这项收费怎么归、以及怎么从对账单认出它（病理号前缀 / 项目名含词 / 备注含词，每条只检索对应那列）。{!isAdmin && <span className="text-gray-400">「拆分」「诊断与报告」是口径设置，由管理员维护，这里只读。</span>}</p>
      {cfg.lines.map((l, i) => (
        <div key={l.key} className="rounded-md border border-gray-200 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input aria-label="业务线名称" className="h-8 w-44 rounded-md border border-gray-200 bg-white px-2 text-[13px] font-medium outline-none focus:border-blue-500" value={l.name} onChange={(e) => patch((c) => { c.lines[i].name = e.target.value })} />
            <button role="switch" aria-checked={l.on} aria-label={`${l.name || '业务线'} 是否启用`} tabIndex={0}
              onClick={() => patch((c) => { c.lines[i].on = !c.lines[i].on })}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); patch((c) => { c.lines[i].on = !c.lines[i].on }) } }}
              className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/40 ${l.on ? 'bg-blue-500' : 'bg-gray-300'}`}>
              <span className={`h-4 w-4 rounded-full bg-white transition-transform ${l.on ? 'translate-x-4' : ''}`} />
            </button>
            <span className="text-[12px] text-gray-500">{l.on ? '启用' : '停用'}</span>
            <span className="text-[12px] text-gray-500">这项怎么归</span>
            {(l.scope === 'split' || l.scope === 'diagnosis') && !isAdmin ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-[12px] text-gray-500" title="拆分/诊断口径由管理员设定">
                <Lock className="h-3 w-3" />{SCOPE_LABEL[l.scope]} · 管理员设定
              </span>
            ) : (
              <select aria-label="这项收费怎么归" value={l.scope}
                onChange={(e) => patch((c) => {
                  const s = e.target.value as LineScope
                  c.lines[i].scope = s
                  if (s === 'split') { if (!(Number(c.lines[i].splitProcRate) > 0)) c.lines[i].splitProcRate = 36; if (!c.lines[i].splitWorkload) c.lines[i].splitWorkload = 'lis_blk' }
                })}
                className="h-8 rounded-md border border-gray-200 bg-white px-2 text-[12px] text-gray-900 outline-none transition-colors focus:border-blue-500">
                <option value="in">计入实验室</option>
                {isAdmin && <option value="split">拆分（只计制片）</option>}
                {isAdmin && <option value="diagnosis">诊断与报告（不计）</option>}
                <option value="out">外送转出（不计）</option>
              </select>
            )}
            <button className="ml-auto text-gray-300 hover:text-red-500" aria-label={`删除业务线 ${l.name}`} onClick={() => askConfirm({ title: `删除业务线「${l.name}」？`, desc: '该业务线的识别词与归属设置将一并移除。', danger: true, onConfirm: () => patch((c) => { c.lines.splice(i, 1) }) })}><X className="h-4 w-4" /></button>
          </div>
          {l.scope === 'split' && (
            <div className="mb-2 rounded-md bg-blue-50 p-2.5 text-[12px]">
              <div className="mb-2 flex items-center gap-1.5 text-blue-700"><Scissors className="h-3.5 w-3.5" />拆开算：制片按工作量计入实验室，诊断部分不计</div>
              <div className="flex flex-wrap items-end gap-4">
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-gray-500">处理费（国标）</span>
                  <select value={l.splitProcRate ?? 36} disabled={!isAdmin}
                    onChange={(e) => patch((c) => { c.lines[i].splitProcRate = Number(e.target.value) })}
                    className="h-8 rounded-md border border-gray-200 bg-white px-2 text-[12px] text-gray-900 outline-none focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-400">
                    {PROC_RATE_OPTS.map((o) => <option key={o.rate} value={o.rate}>{o.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-gray-500">工作量按</span>
                  <select value={l.splitWorkload ?? 'lis_blk'} disabled={!isAdmin}
                    onChange={(e) => patch((c) => { c.lines[i].splitWorkload = e.target.value as 'lis_blk' | 'qty' })}
                    className="h-8 rounded-md border border-gray-200 bg-white px-2 text-[12px] text-gray-900 outline-none focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-400">
                    <option value="lis_blk">LIS 蜡块数（最准）</option>
                    <option value="qty">账单数量</option>
                  </select>
                </label>
              </div>
              <div className="mt-2 text-[11.5px] text-blue-700">按此设置，这类每单约拆：制片 {splitInPct(l.splitProcRate ?? 36)}% 计入 · 诊断 {100 - splitInPct(l.splitProcRate ?? 36)}% 不计（以 2 蜡块为例）</div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div><span className="mb-1 block text-[11.5px] text-gray-400">病理号前缀 · 开头</span><Chips words={l.prefixes} placeholder="如 H" onAdd={(w) => patch((c) => { if (!c.lines[i].prefixes.includes(w)) c.lines[i].prefixes.push(w) })} onDel={(k) => patch((c) => { c.lines[i].prefixes.splice(k, 1) })} /></div>
            <div><span className="mb-1 block text-[11.5px] text-gray-400">项目名 · 含</span><Chips words={l.keywords} placeholder="如 手术标本" onAdd={(w) => patch((c) => { if (!c.lines[i].keywords.includes(w)) c.lines[i].keywords.push(w) })} onDel={(k) => patch((c) => { c.lines[i].keywords.splice(k, 1) })} /></div>
            {hasRemark && <div><span className="mb-1 block text-[11.5px] text-gray-400">备注 · 含</span><Chips words={l.remarks} placeholder="如 远程" onAdd={(w) => patch((c) => { if (!c.lines[i].remarks.includes(w)) c.lines[i].remarks.push(w) })} onDel={(k) => patch((c) => { c.lines[i].remarks.splice(k, 1) })} /></div>}
          </div>
        </div>
      ))}
      <button className={btnCls} onClick={() => patch((c) => { c.lines.push({ key: 'l-' + Date.now().toString(36), name: '新业务线', on: true, scope: 'in', prefixes: [], keywords: [], remarks: [] }) })}><Plus className="h-4 w-4" />新增业务线</button>
    </div>
  )
}

function DiscountTab({ cfg, patch }: { cfg: PartnerConfig; patch: PatchFn }) {
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-gray-500">扣率 = 结算金额 ÷ 医院收费（0–1）。优先级：按项目 &gt; 按业务线 &gt; 默认。</p>
      <Field label="默认扣率"><input type="number" step="0.01" className={inputCls + ' max-w-[140px] tabular-nums'} value={cfg.discount.def} onChange={(e) => patch((c) => { c.discount.def = Number(e.target.value) })} /></Field>
      <div>
        <div className="mb-1.5 flex items-center justify-between"><span className={label + ' mb-0'}>按业务线扣率</span></div>
        <div className="space-y-1.5">
          {cfg.discount.byLine.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <select className={inputCls + ' max-w-[200px]'} value={d.key} onChange={(e) => patch((c) => { c.discount.byLine[i].key = e.target.value })}>
                <option value="">选业务线…</option>{cfg.lines.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}
              </select>
              <input type="number" step="0.01" className={inputCls + ' max-w-[120px] tabular-nums'} value={d.rate} onChange={(e) => patch((c) => { c.discount.byLine[i].rate = Number(e.target.value) })} />
              <button className="text-gray-300 hover:text-red-500" aria-label="删除" onClick={() => patch((c) => { c.discount.byLine.splice(i, 1) })}><X className="h-4 w-4" /></button>
            </div>
          ))}
          <button className={btnCls} onClick={() => patch((c) => { c.discount.byLine.push({ key: '', rate: cfg.discount.def }) })}><Plus className="h-4 w-4" />加一条</button>
        </div>
      </div>
      <div>
        <span className={label}>按项目扣率</span>
        <div className="space-y-1.5">
          {cfg.discount.byItem.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={inputCls + ' max-w-[220px]'} placeholder="项目名含…（如 PD-L1）" value={d.item} onChange={(e) => patch((c) => { c.discount.byItem[i].item = e.target.value })} />
              <input type="number" step="0.01" className={inputCls + ' max-w-[120px] tabular-nums'} value={d.rate} onChange={(e) => patch((c) => { c.discount.byItem[i].rate = Number(e.target.value) })} />
              <button className="text-gray-300 hover:text-red-500" aria-label="删除" onClick={() => patch((c) => { c.discount.byItem.splice(i, 1) })}><X className="h-4 w-4" /></button>
            </div>
          ))}
          <button className={btnCls} onClick={() => patch((c) => { c.discount.byItem.push({ item: '', rate: cfg.discount.def }) })}><Plus className="h-4 w-4" />加一条</button>
        </div>
      </div>
    </div>
  )
}

function SpecialTab({ cfg, patch }: { cfg: PartnerConfig; patch: PatchFn }) {
  const r = cfg.special.retainer, j = cfg.special.joint
  return (
    <div className="space-y-5">
      <div className="rounded-md border border-gray-200 p-4">
        <label className="flex items-center gap-2 text-[13px] font-medium text-gray-800"><input type="checkbox" checked={r.on} onChange={(e) => patch((c) => { c.special.retainer.on = e.target.checked })} />每月固定保底费</label>
        {r.on && <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="名目"><input className={inputCls} value={r.name} onChange={(e) => patch((c) => { c.special.retainer.name = e.target.value })} /></Field>
          <Field label="每月金额（元）"><input type="number" className={inputCls + ' tabular-nums'} value={r.amount} onChange={(e) => patch((c) => { c.special.retainer.amount = Number(e.target.value) })} /></Field>
        </div>}
      </div>
      <div className="rounded-md border border-gray-200 p-4">
        <label className="flex items-center gap-2 text-[13px] font-medium text-gray-800"><input type="checkbox" checked={j.on} onChange={(e) => patch((c) => { c.special.joint.on = e.target.checked })} />科室共建分成</label>
        {j.on && <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="分成比例（%）"><input type="number" className={inputCls + ' tabular-nums'} value={j.ratio} onChange={(e) => patch((c) => { c.special.joint.ratio = Number(e.target.value) })} /></Field>
          <Field label="分成说明"><input className={inputCls} value={j.share} onChange={(e) => patch((c) => { c.special.joint.share = e.target.value })} /></Field>
        </div>}
      </div>
    </div>
  )
}

function ParseTab({ cfg }: { cfg: PartnerConfig }) {
  return (
    <div className="space-y-2 text-[13px] text-gray-600">
      <p>对账单的列识别（病理号/项目名/收费金额/扣率/结算金额 在第几列）由系统在导入时<b>自动识别</b>，无需在这里手填。</p>
      <div className="rounded-md bg-gray-50 px-3 py-2 text-[12.5px] text-gray-500">
        当前模板：{cfg.parse.template || '（建档时上传一张样表自动识别）'}
      </div>
      <p className="text-[12px] text-gray-400">在「导入测试台 / 月度导入向导」上传样表后，这里会显示识别到的模板与列映射，自动认错时可在那里微调。</p>
    </div>
  )
}

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '（空）'
  if (Array.isArray(v)) return v.join('、') || '（空）'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function ChangesTab({ changes, onRollback }: { changes: ConfigChange[]; onRollback: (v: number) => void }) {
  if (!changes.length) return <div className="py-8 text-center text-[13px] text-gray-400">暂无变更记录</div>
  return (
    <div className="space-y-3">
      {changes.map((c) => (
        <div key={c.version} className="border-l-2 border-gray-200 pl-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-gray-400 tabular-nums">v{c.version}</span>
            <span className="text-[12px] text-gray-500">{c.changedAt}{c.changedBy ? ' · ' + c.changedBy : ''}{c.tab ? ' · ' + c.tab : ''}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[11px] ${c.kind === 'rollback' ? 'bg-amber-50 text-amber-700' : c.kind === 'seed' ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-600'}`}>{c.kind === 'rollback' ? '回滚' : c.kind === 'seed' ? '建档' : '编辑'}</span>
            {c.version > 1 && <button className="ml-auto inline-flex items-center gap-1 text-[12px] text-blue-600 hover:underline" onClick={() => onRollback(c.version)}><History className="h-3.5 w-3.5" />回滚到此版本</button>}
          </div>
          {c.diffs?.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {c.diffs.map((d, i) => (
                <li key={i} className="text-[12.5px] text-gray-600">{d.label}：<span className="text-gray-400 line-through">{fmtVal(d.before)}</span> → <span className="text-gray-900">{fmtVal(d.after)}</span></li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
