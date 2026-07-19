import { useState, type ReactNode } from 'react'
import { History, Lock, Plus, Scissors, X } from 'lucide-react'
import { getRoles, getUserRole } from '@/lib/permissions'
import type { ConfigChange, LineScope, PartnerConfig } from '@/types/partner-config'

export type ConfirmRequest = {
  title: string
  desc?: string
  danger?: boolean
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
}

export type PatchConfig = (change: (config: PartnerConfig) => void) => void

const inputClass = 'h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-900 placeholder:text-gray-400 outline-none transition-colors focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/10 disabled:bg-gray-100 disabled:text-gray-500'
const buttonClass = 'inline-flex h-10 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:ring-[3px] focus-visible:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50'
const fieldLabel = 'mb-1 block text-[12px] font-medium text-gray-500'
const SCOPE_LABEL: Record<LineScope, string> = { in: '计入实验室', out: '外送转出（不计）', split: '拆分（只计制片）', diagnosis: '诊断与报告（不计）' }
const PROCESSING_RATES = [{ rate: 36, label: '¥36 · 组织/冰冻' }, { rate: 75, label: '¥75 · 细胞' }]
const splitPercentage = (rate: number) => Math.round(((rate * 2) / (rate * 2 + 105)) * 100)

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className={fieldLabel}>{label}</span>{children}</label>
}

export function BasicTab({ config, patch }: { config: PartnerConfig; patch: PatchConfig }) {
  const basic = config.basic
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="医院全称"><input className={inputClass} value={basic.full} onChange={(event) => patch((next) => { next.basic.full = event.target.value })} /></Field>
      <Field label="简称"><input className={inputClass} value={basic.short} onChange={(event) => patch((next) => { next.basic.short = event.target.value })} /></Field>
      <Field label="编码"><input className={inputClass} value={basic.code} onChange={(event) => patch((next) => { next.basic.code = event.target.value })} /></Field>
      <Field label="所属集团"><input className={inputClass} value={basic.group} onChange={(event) => patch((next) => { next.basic.group = event.target.value })} /></Field>
      <Field label="院区"><input className={inputClass} value={basic.campus} onChange={(event) => patch((next) => { next.basic.campus = event.target.value })} /></Field>
      <Field label="合作起始（YYYY-MM）"><input className={inputClass} value={basic.start} placeholder="2026-01" onChange={(event) => patch((next) => { next.basic.start = event.target.value })} /></Field>
      <Field label="合作状态"><input className={inputClass} value={basic.status} onChange={(event) => patch((next) => { next.basic.status = event.target.value })} /></Field>
      <Field label="联系人"><input className={inputClass} value={basic.contact} onChange={(event) => patch((next) => { next.basic.contact = event.target.value })} /></Field>
      <div className="mt-1 grid grid-cols-1 gap-4 rounded-md bg-gray-50 p-3 sm:col-span-2 sm:grid-cols-3">
        <Field label="开单计税口径"><select className={inputClass} value={config.amount.bill} onChange={(event) => patch((next) => { next.amount.bill = event.target.value as '未税' | '含税' })}><option>未税</option><option>含税</option></select></Field>
        <Field label="结算计税口径"><select className={inputClass} value={config.amount.settle} onChange={(event) => patch((next) => { next.amount.settle = event.target.value as '未税' | '含税' })}><option>未税</option><option>含税</option></select></Field>
        <Field label="税率（%）"><input type="number" className={`${inputClass} tabular-nums`} value={config.amount.rate} onChange={(event) => patch((next) => { next.amount.rate = Number(event.target.value) })} /></Field>
      </div>
    </div>
  )
}

function Chips({ words, placeholder, disabled, onAdd, onDelete }: { words: string[]; placeholder: string; disabled: boolean; onAdd: (word: string) => void; onDelete: (index: number) => void }) {
  const [draft, setDraft] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {words.map((word, index) => disabled ? (
        <input key={`${word}-${index}`} value={word} disabled aria-label={`只读识别词 ${word}`} className="h-7 w-auto max-w-28 rounded-full border-0 bg-gray-100 px-2 text-[12px] text-gray-500" />
      ) : (
        <span key={`${word}-${index}`} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[12px] text-blue-700">
          {word}<button type="button" aria-label={`删除 ${word}`} className="text-blue-400 hover:text-red-500" onClick={() => onDelete(index)}><X aria-hidden="true" className="h-3 w-3" /></button>
        </span>
      ))}
      <input
        disabled={disabled}
        className="h-7 w-28 rounded-md border border-gray-200 bg-white px-2 text-[12px] outline-none focus:border-blue-500 disabled:bg-gray-100"
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          draft.split(/[，,、\s]+/).map((word) => word.trim()).filter(Boolean).forEach(onAdd)
          setDraft('')
        }}
      />
    </div>
  )
}

export function LinesTab({ config, patch, askConfirm }: { config: PartnerConfig; patch: PatchConfig; askConfirm: (request: ConfirmRequest) => void }) {
  const isAdmin = getRoles().includes('admin') || getUserRole() === 'admin'
  const hasRemark = Boolean(config.parse.colMap && (config.parse.colMap as Record<string, unknown>).remark != null)
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-gray-500">识别词只检索对应列。{!isAdmin && '拆分/诊断口径整行由管理员维护；财务只读。'}</p>
      {config.lines.map((line, index) => {
        const locked = !isAdmin && (line.scope === 'split' || line.scope === 'diagnosis')
        const addWord = (field: 'prefixes' | 'keywords' | 'remarks', word: string) => patch((next) => { if (!next.lines[index][field].includes(word)) next.lines[index][field].push(word) })
        const deleteWord = (field: 'prefixes' | 'keywords' | 'remarks', wordIndex: number) => patch((next) => { next.lines[index][field].splice(wordIndex, 1) })
        return (
          <div key={line.key} className={`rounded-md border border-gray-200 p-3 ${locked ? 'bg-gray-50/60' : ''}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <input aria-label="业务线名称" disabled={locked} className="h-8 w-44 rounded-md border border-gray-200 bg-white px-2 text-[13px] font-medium outline-none focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500" value={line.name} onChange={(event) => patch((next) => { next.lines[index].name = event.target.value })} />
              <button type="button" role="switch" aria-checked={line.on} aria-label={`${line.name} 是否启用`} disabled={locked} onClick={() => patch((next) => { next.lines[index].on = !next.lines[index].on })} className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50 ${line.on ? 'bg-blue-500' : 'bg-gray-300'}`}><span className={`h-4 w-4 rounded-full bg-white transition-transform ${line.on ? 'translate-x-4' : ''}`} /></button>
              <span className="text-[12px] text-gray-500">{line.on ? '启用' : '停用'}</span>
              {locked ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2.5 py-1 text-[12px] text-gray-500"><Lock aria-hidden="true" className="h-3 w-3" />{SCOPE_LABEL[line.scope]} · 管理员设定</span>
              ) : (
                <select aria-label="这项收费怎么归" className="h-8 rounded-md border border-gray-200 bg-white px-2 text-[12px]" value={line.scope} onChange={(event) => patch((next) => {
                  const scope = event.target.value as LineScope
                  next.lines[index].scope = scope
                  if (scope === 'split') { next.lines[index].splitProcRate ||= 36; next.lines[index].splitWorkload ||= 'lis_blk' }
                })}>
                  <option value="in">计入实验室</option>{isAdmin && <option value="split">拆分（只计制片）</option>}{isAdmin && <option value="diagnosis">诊断与报告（不计）</option>}<option value="out">外送转出（不计）</option>
                </select>
              )}
              {!locked && <button type="button" aria-label={`删除业务线 ${line.name}`} className="ml-auto text-gray-300 hover:text-red-500" onClick={() => askConfirm({ title: `删除业务线「${line.name}」？`, desc: '该业务线的识别词与归属设置将一并移除。', danger: true, confirmLabel: '确认删除', onConfirm: () => patch((next) => { next.lines.splice(index, 1) }) })}><X aria-hidden="true" className="h-4 w-4" /></button>}
            </div>
            {line.scope === 'split' && (
              <div className="mb-2 rounded-md bg-blue-50 p-2.5 text-[12px] text-blue-700">
                <div className="mb-2 flex items-center gap-1.5"><Scissors aria-hidden="true" className="h-3.5 w-3.5" />制片按工作量计入，诊断部分不计</div>
                <div className="flex flex-wrap gap-3">
                  <label>处理费（国标）<select className="ml-2 h-8 rounded-md border border-gray-200 bg-white px-2" value={line.splitProcRate ?? 36} disabled={!isAdmin} onChange={(event) => patch((next) => { next.lines[index].splitProcRate = Number(event.target.value) })}>{PROCESSING_RATES.map((option) => <option key={option.rate} value={option.rate}>{option.label}</option>)}</select></label>
                  <label>工作量按<select className="ml-2 h-8 rounded-md border border-gray-200 bg-white px-2" value={line.splitWorkload ?? 'lis_blk'} disabled={!isAdmin} onChange={(event) => patch((next) => { next.lines[index].splitWorkload = event.target.value as 'lis_blk' | 'qty' })}><option value="lis_blk">LIS 蜡块数</option><option value="qty">账单数量</option></select></label>
                </div>
                <div className="mt-2">以 2 蜡块为例：制片约 {splitPercentage(line.splitProcRate ?? 36)}% 计入，诊断约 {100 - splitPercentage(line.splitProcRate ?? 36)}% 不计。</div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div><span className="mb-1 block text-[11.5px] text-gray-400">病理号前缀</span><Chips disabled={locked} words={line.prefixes} placeholder="如 H" onAdd={(word) => addWord('prefixes', word)} onDelete={(wordIndex) => deleteWord('prefixes', wordIndex)} /></div>
              <div><span className="mb-1 block text-[11.5px] text-gray-400">项目名含词</span><Chips disabled={locked} words={line.keywords} placeholder="如 制片" onAdd={(word) => addWord('keywords', word)} onDelete={(wordIndex) => deleteWord('keywords', wordIndex)} /></div>
              {hasRemark && <div><span className="mb-1 block text-[11.5px] text-gray-400">备注含词</span><Chips disabled={locked} words={line.remarks} placeholder="如 远程" onAdd={(word) => addWord('remarks', word)} onDelete={(wordIndex) => deleteWord('remarks', wordIndex)} /></div>}
            </div>
          </div>
        )
      })}
      <button type="button" className={buttonClass} onClick={() => patch((next) => { next.lines.push({ key: `l-${Date.now().toString(36)}`, name: '新业务线', on: true, scope: 'in', prefixes: [], keywords: [], remarks: [] }) })}><Plus aria-hidden="true" className="h-4 w-4" />新增业务线</button>
    </div>
  )
}

export function DiscountTab({ config, patch }: { config: PartnerConfig; patch: PatchConfig }) {
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-gray-500">扣率 = 结算金额 ÷ 医院收费（0–1）；优先级为项目、业务线、默认。</p>
      <Field label="默认扣率"><input type="number" step="0.01" className={`${inputClass} max-w-[140px] tabular-nums`} value={config.discount.def} onChange={(event) => patch((next) => { next.discount.def = Number(event.target.value) })} /></Field>
      <div><span className={fieldLabel}>按业务线扣率</span><div className="space-y-2">{config.discount.byLine.map((entry, index) => <div key={`${entry.key}-${index}`} className="flex flex-wrap items-center gap-2"><select className={`${inputClass} max-w-[200px]`} value={entry.key} onChange={(event) => patch((next) => { next.discount.byLine[index].key = event.target.value })}><option value="">选业务线…</option>{config.lines.map((line) => <option key={line.key} value={line.key}>{line.name}</option>)}</select><input type="number" step="0.01" className={`${inputClass} max-w-[120px]`} value={entry.rate} onChange={(event) => patch((next) => { next.discount.byLine[index].rate = Number(event.target.value) })} /><button type="button" aria-label="删除业务线扣率" onClick={() => patch((next) => { next.discount.byLine.splice(index, 1) })}><X aria-hidden="true" className="h-4 w-4" /></button></div>)}<button type="button" className={buttonClass} onClick={() => patch((next) => { next.discount.byLine.push({ key: '', rate: next.discount.def }) })}><Plus aria-hidden="true" className="h-4 w-4" />加一条</button></div></div>
      <div><span className={fieldLabel}>按项目扣率</span><div className="space-y-2">{config.discount.byItem.map((entry, index) => <div key={`${entry.item}-${index}`} className="flex flex-wrap items-center gap-2"><input className={`${inputClass} max-w-[220px]`} value={entry.item} placeholder="项目名含…" onChange={(event) => patch((next) => { next.discount.byItem[index].item = event.target.value })} /><input type="number" step="0.01" className={`${inputClass} max-w-[120px]`} value={entry.rate} onChange={(event) => patch((next) => { next.discount.byItem[index].rate = Number(event.target.value) })} /><button type="button" aria-label="删除项目扣率" onClick={() => patch((next) => { next.discount.byItem.splice(index, 1) })}><X aria-hidden="true" className="h-4 w-4" /></button></div>)}<button type="button" className={buttonClass} onClick={() => patch((next) => { next.discount.byItem.push({ item: '', rate: next.discount.def }) })}><Plus aria-hidden="true" className="h-4 w-4" />加一条</button></div></div>
    </div>
  )
}

export function SpecialTab({ config, patch }: { config: PartnerConfig; patch: PatchConfig }) {
  const retainer = config.special.retainer
  const joint = config.special.joint
  return <div className="space-y-5"><div className="rounded-md border border-gray-200 p-4"><label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" checked={retainer.on} onChange={(event) => patch((next) => { next.special.retainer.on = event.target.checked })} />每月固定保底费</label>{retainer.on && <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="名目"><input className={inputClass} value={retainer.name} onChange={(event) => patch((next) => { next.special.retainer.name = event.target.value })} /></Field><Field label="每月金额（元）"><input type="number" className={inputClass} value={retainer.amount} onChange={(event) => patch((next) => { next.special.retainer.amount = Number(event.target.value) })} /></Field></div>}</div><div className="rounded-md border border-gray-200 p-4"><label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" checked={joint.on} onChange={(event) => patch((next) => { next.special.joint.on = event.target.checked })} />科室共建分成</label>{joint.on && <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="分成比例（%）"><input type="number" className={inputClass} value={joint.ratio} onChange={(event) => patch((next) => { next.special.joint.ratio = Number(event.target.value) })} /></Field><Field label="分成说明"><input className={inputClass} value={joint.share} onChange={(event) => patch((next) => { next.special.joint.share = event.target.value })} /></Field></div>}</div></div>
}

export function ParseTab({ config }: { config: PartnerConfig }) {
  return <div className="space-y-2 text-[13px] text-gray-600"><p>对账单列识别由导入流程自动完成；本页只显示已经取得的模板事实。</p><div className="rounded-md bg-gray-50 px-3 py-2 text-[12.5px] text-gray-500">当前模板：{config.parse.template || '尚未取得模板证据'}</div></div>
}

function formatValue(value: unknown) {
  if (value == null || value === '') return '（空）'
  if (Array.isArray(value)) return value.join('、') || '（空）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return '（结构化配置）'
  return String(value)
}

export function ChangesTab({ changes, onRollback }: { changes: ConfigChange[]; onRollback: (version: number) => void }) {
  if (!changes.length) return <div className="py-8 text-center text-[13px] text-gray-400">查询成功；暂无变更记录</div>
  return <div className="space-y-3">{changes.map((change) => <div key={change.version} className="border-l-2 border-gray-200 pl-3"><div className="flex flex-wrap items-center gap-2"><span className="text-[12px] text-gray-400">v{change.version}</span><span className="text-[12px] text-gray-500">{change.changedAt}{change.changedBy ? ` · ${change.changedBy}` : ''}{change.tab ? ` · ${change.tab}` : ''}</span><span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{change.kind === 'rollback' ? '回滚' : change.kind === 'seed' ? '建档' : '编辑'}</span>{change.version > 1 && <button type="button" className="ml-auto inline-flex items-center gap-1 text-[12px] text-blue-600 hover:underline" onClick={() => onRollback(change.version)}><History aria-hidden="true" className="h-3.5 w-3.5" />回滚到此版本</button>}</div>{change.diffs?.length > 0 && <ul className="mt-1 space-y-0.5">{change.diffs.map((diff, index) => <li key={`${diff.path}-${index}`} className="text-[12.5px] text-gray-600">{diff.label}：<span className="text-gray-400 line-through">{formatValue(diff.before)}</span> → <span className="text-gray-900">{formatValue(diff.after)}</span></li>)}</ul>}</div>)}</div>
}
