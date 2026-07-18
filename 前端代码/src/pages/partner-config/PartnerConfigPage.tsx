import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ChevronRight, Loader2, Lock, Save, Search } from 'lucide-react'
import { toast } from 'sonner'
import { partnerConfigApi, type PartnerListItem } from '@/api/partner-config'
import { Modal } from '@/components/ui/Modal'
import type { ConfigChange, PartnerConfig } from '@/types/partner-config'
import {
  BasicTab,
  ChangesTab,
  DiscountTab,
  LinesTab,
  ParseTab,
  SpecialTab,
  type ConfirmRequest,
  type PatchConfig,
} from './PartnerConfigTabs'

const inputClass = 'a11y-focus-ring h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-900 placeholder:text-gray-400 disabled:bg-gray-100'
const buttonClass = 'a11y-focus-ring inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50'
const primaryButton = 'a11y-focus-ring inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md bg-blue-500 px-3.5 text-[13px] font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50'

type TabKey = 'basic' | 'lines' | 'discount' | 'special' | 'parse' | 'changes'
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'basic', label: '基本档案' },
  { key: 'lines', label: '业务分类' },
  { key: 'discount', label: '结算扣率' },
  { key: 'special', label: '分成与固定费' },
  { key: 'parse', label: '对账单解析' },
  { key: 'changes', label: '变更记录' },
]

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const cooperationMode = (config: PartnerConfig) => config.special.joint.on ? '共建分成' : config.special.retainer.on ? '含每月保底费' : '常规结算'

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Modal title={request.title} description={request.desc} onClose={() => { if (!busy) onClose() }} size="sm">
      {error && <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>取消</button>
        <button
          type="button"
          disabled={busy}
          className={request.danger ? 'a11y-focus-ring min-h-10 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50' : primaryButton}
          onClick={async () => {
            if (busy) return
            setBusy(true); setError('')
            try { await request.onConfirm(); onClose() } catch (cause) {
              setError(cause instanceof Error && cause.message ? cause.message : '操作失败，未取得成功证据')
              setBusy(false)
            }
          }}
        >
          {busy ? (request.confirmLabel === '确认设置' ? '设置中…' : '处理中…') : (request.confirmLabel || '确认')}
        </button>
      </div>
    </Modal>
  )
}

function validate(config: PartnerConfig) {
  const failures: string[] = []
  if (!(config.discount.def > 0 && config.discount.def <= 1)) failures.push('默认扣率须在 0–1 之间')
  config.discount.byLine.forEach((entry) => { if (!(entry.rate > 0 && entry.rate <= 1)) failures.push('按业务线扣率须在 0–1 之间') })
  config.discount.byItem.forEach((entry) => { if (!entry.item.trim()) failures.push('按项目扣率的项目名不能为空'); if (!(entry.rate > 0 && entry.rate <= 1)) failures.push('按项目扣率须在 0–1 之间') })
  config.lines.forEach((line) => { if (!line.name.trim()) failures.push('业务线名称不能为空'); if (line.scope === 'split' && !(Number(line.splitProcRate) > 0)) failures.push('拆分线需选择处理费') })
  return [...new Set(failures)]
}

export default function PartnerConfigPage() {
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [partners, setPartners] = useState<PartnerListItem[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [partnerId, setPartnerId] = useState('')
  const [partnerName, setPartnerName] = useState('')
  const [version, setVersion] = useState(0)
  const [baseline, setBaseline] = useState(false)
  const [config, setConfig] = useState<PartnerConfig | null>(null)
  const [changes, setChanges] = useState<ConfigChange[]>([])
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<TabKey>('basic')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const loadPartners = useCallback(async () => {
    const request = ++listRequest.current
    setListLoading(true); setListError('')
    try {
      const response = await partnerConfigApi.partners()
      if (request !== listRequest.current) return
      if (!response || !Array.isArray(response.list)) throw new Error('合作医院响应格式异常')
      setPartners(response.list)
    } catch (error) {
      if (request === listRequest.current) setListError(error instanceof Error ? error.message : '合作医院加载失败')
    } finally {
      if (request === listRequest.current) setListLoading(false)
    }
  }, [])

  const openDetail = useCallback(async (id: string, name: string) => {
    const request = ++detailRequest.current
    setView('detail'); setPartnerId(id); setPartnerName(name); setTab('basic')
    setDetailLoading(true); setDetailError(''); setSaveError(''); setDirty(false); setConfig(null)
    try {
      const [envelope, history] = await Promise.all([partnerConfigApi.get(id), partnerConfigApi.changes(id)])
      if (request !== detailRequest.current) return
      setConfig(envelope.config); setVersion(envelope.version); setBaseline(envelope.isBaseline); setChanges(history)
    } catch (error) {
      if (request === detailRequest.current) setDetailError(error instanceof Error ? error.message : '配置加载失败')
    } finally {
      if (request === detailRequest.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPartners()
    return () => { listRequest.current += 1; detailRequest.current += 1 }
  }, [loadPartners])

  const filtered = useMemo(() => partners.filter((partner) => !query || partner.name.includes(query) || partner.code.includes(query)), [partners, query])
  const patch: PatchConfig = useCallback((change) => {
    setConfig((current) => { if (!current) return current; const next = clone(current); change(next); return next })
    setDirty(true); setSaveError('')
  }, [])

  const save = useCallback(async () => {
    if (!config || !partnerId || saving) return
    const failures = validate(config)
    if (failures.length) { setSaveError(`保存前请修正：${failures.join('；')}`); return }
    setSaving(true); setSaveError('')
    try {
      const tabLabel = TABS.find((item) => item.key === tab)?.label
      const response = await partnerConfigApi.save(partnerId, { config, expectedVersion: version, tab: tabLabel })
      setVersion(response.version); setDirty(false)
      setChanges(await partnerConfigApi.changes(partnerId))
      toast.success(response.diffs.length ? `已保存 v${response.version}（${response.diffs.length} 项变更）` : '配置无改动')
    } catch (error: any) {
      if (/冲突|409|CONFLICT/i.test(error?.code || error?.message || '')) {
        const envelope = await partnerConfigApi.get(partnerId)
        setConfig(envelope.config); setVersion(envelope.version); setBaseline(envelope.isBaseline); setDirty(false)
        setSaveError('配置已被他人更新，已刷新到最新版本，请重做改动')
      } else setSaveError(error?.message || '保存失败；草稿仍保留，可核对后重试')
    } finally { setSaving(false) }
  }, [config, partnerId, saving, tab, version])

  const leaveDetail = () => { detailRequest.current += 1; setView('list') }
  const requestLeave = () => dirty
    ? setConfirm({ title: '有未保存改动，确定返回？', desc: '未保存的改动将丢失。', danger: true, confirmLabel: '确认返回', onConfirm: leaveDetail })
    : leaveDetail()

  const discard = () => {
    if (!dirty || !partnerId) return
    setConfirm({ title: '放弃所有未保存改动？', desc: '当前草稿将丢失。', danger: true, confirmLabel: '确认放弃', onConfirm: async () => {
      const envelope = await partnerConfigApi.get(partnerId)
      setConfig(envelope.config); setVersion(envelope.version); setBaseline(envelope.isBaseline); setDirty(false); setSaveError('')
    } })
  }

  const rollback = (targetVersion: number) => {
    if (!partnerId) return
    setConfirm({ title: `回滚到 v${targetVersion}？`, desc: '回滚会生成新版本并保留历史；涉及拆分/诊断口径时仅管理员可执行。', confirmLabel: '确认回滚', onConfirm: async () => {
      const response = await partnerConfigApi.rollback(partnerId, targetVersion)
      const [envelope, history] = await Promise.all([partnerConfigApi.get(partnerId), partnerConfigApi.changes(partnerId)])
      setConfig(envelope.config); setVersion(envelope.version); setBaseline(envelope.isBaseline); setChanges(history); setDirty(false)
      toast.success(`已回滚到 v${targetVersion}（生成新版本 v${response.version}）`)
    } })
  }

  const requestBaseline = () => {
    if (!partnerId) return
    setConfirm({ title: '设为月度导入基线？', desc: `将 v${version} 标记为后续导入核对基线；这不会执行导入。`, confirmLabel: '确认设置', onConfirm: async () => {
      await partnerConfigApi.baseline(partnerId, version)
      setBaseline(true)
      toast.success(`已设 v${version} 为月度导入基线`)
    } })
  }

  if (view === 'list') {
    return (
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <div className="mb-1 flex flex-wrap items-center gap-2"><h1 className="text-[18px] font-semibold text-gray-900">合作医院配置</h1><span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500"><Lock aria-hidden="true" className="h-3 w-3" />仅财务 / 管理员</span></div>
        <p className="mb-4 text-[13px] text-gray-500">每家医院一份版本化配置；失败不按空配置处理，改动可追溯和回滚。</p>
        <div className="relative mb-3 max-w-sm"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input type="search" aria-label="搜索合作医院" className={`${inputClass} pl-9`} placeholder="医院名称 / 编码" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          {listLoading ? <div role="status" className="flex items-center justify-center gap-2 py-16 text-[13px] text-gray-500"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />加载中…</div>
            : listError ? <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center text-[13px] text-gray-600"><AlertCircle aria-hidden="true" className="h-6 w-6 text-amber-500" />{listError}<span className="text-xs">数据未知，不能按没有合作医院处理。</span><button type="button" className={buttonClass} onClick={loadPartners}>重试</button></div>
              : filtered.length === 0 ? <div className="py-16 text-center text-[13px] text-gray-500">查询成功；{query ? '没有匹配医院' : '暂无合作医院'}</div>
                : <div className="overflow-x-auto"><table className="min-w-[620px] w-full text-[13px]"><thead><tr className="border-b border-gray-200 bg-gray-50 text-left text-[12px] text-gray-500"><th className="px-4 py-2.5">医院</th><th className="px-4 py-2.5">编码</th><th className="px-4 py-2.5">服务范围</th><th className="px-4 py-2.5"><span className="sr-only">操作</span></th></tr></thead><tbody>{filtered.map((partner) => <tr key={partner.id} role="button" tabIndex={0} className="cursor-pointer border-t border-gray-100 hover:bg-blue-50/40" onClick={() => openDetail(partner.id, partner.name)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(partner.id, partner.name) } }}><td className="px-4 py-3 font-medium text-gray-900">{partner.name}</td><td className="px-4 py-3 text-gray-500">{partner.code}</td><td className="px-4 py-3 text-gray-500">{partner.serviceScope === 'with_diagnosis' ? '技术 + 诊断' : '仅技术'}</td><td className="px-4 py-3 text-right text-blue-500"><span className="inline-flex items-center">配置<ChevronRight aria-hidden="true" className="h-4 w-4" /></span></td></tr>)}</tbody></table></div>}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} onClick={requestLeave}><ArrowLeft aria-hidden="true" className="h-4 w-4" />返回列表</button>
        <span className="text-[16px] font-semibold text-gray-900">{config?.basic.full || partnerName}</span>
        {config && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11.5px] text-gray-500">{cooperationMode(config)}</span>}
        <span className="text-[12px] text-gray-500">v{version}{baseline ? ' · 基线' : ''}</span>
        {dirty && <span className="text-[12px] text-amber-600">● 有未保存改动</span>}
        <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto"><button type="button" className={buttonClass} onClick={discard} disabled={!dirty}>放弃改动</button><button type="button" className={buttonClass} onClick={requestBaseline} disabled={dirty || !config}>设为导入基线</button><button type="button" className={primaryButton} onClick={save} disabled={saving || !config}>{saving ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Save aria-hidden="true" className="h-4 w-4" />}保存</button></div>
      </div>
      {saveError && <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{saveError}</div>}
      <div role="tablist" aria-label="配置分区" className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200">{TABS.map((item, index) => <button key={item.key} type="button" role="tab" id={`tab-${item.key}`} aria-controls={`panel-${item.key}`} aria-selected={tab === item.key} tabIndex={tab === item.key ? 0 : -1} ref={(element) => { tabRefs.current[index] = element }} onClick={() => setTab(item.key)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length; setTab(TABS[next].key); tabRefs.current[next]?.focus() } }} className={`h-10 shrink-0 rounded-t-md px-3 text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-blue-500/40 ${tab === item.key ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500'}`}>{item.label}</button>)}</div>
      {detailLoading ? <div role="status" className="flex items-center justify-center gap-2 py-20 text-[13px] text-gray-500"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />并行加载配置和历史…</div>
        : detailError ? <div role="alert" className="flex flex-col items-center gap-3 py-20 text-center text-[13px] text-gray-600"><AlertCircle aria-hidden="true" className="h-6 w-6 text-amber-500" />{detailError}<span className="text-xs">配置未知，禁止编辑。</span><button type="button" className={buttonClass} onClick={() => openDetail(partnerId, partnerName)}>重试</button></div>
          : config && <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">{tab === 'basic' && <BasicTab config={config} patch={patch} />}{tab === 'lines' && <LinesTab config={config} patch={patch} askConfirm={setConfirm} />}{tab === 'discount' && <DiscountTab config={config} patch={patch} />}{tab === 'special' && <SpecialTab config={config} patch={patch} />}{tab === 'parse' && <ParseTab config={config} />}{tab === 'changes' && <ChangesTab changes={changes} onRollback={rollback} />}</div>}
      {confirm && <ConfirmDialog key={`${confirm.title}-${version}`} request={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
